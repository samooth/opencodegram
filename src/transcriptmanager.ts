import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { SessionStore } from "./store.js";
import { clampText, esc, sessionHeader } from "./util.js";
import {
  paginateTranscript,
  resolvePage,
  splitMarkdown,
  TRANSCRIPT_BLOCK_BUDGET,
  TRANSCRIPT_MAX_BLOCKS,
  type TranscriptBlock,
  type TranscriptKind,
} from "./transcript.js";

/**
 * Session card: ONE Telegram message per session that holds the whole output.
 *
 * Every block produced by the session (answer, thinking, tools) is appended to
 * the transcript. The card is then edited in place showing one page at a time,
 * with ◀/▶ navigation, so the number of messages per session stays at one
 * while every piece of output remains reachable.
 *
 * While the session is working, the card also shows a compact live strip
 * (status, latest tool, latest thought) above the transcript page.
 */

export type TranscriptDeps = {
  tg: TelegramClient;
  store: SessionStore;
  threadOptsFor: (s: ChatSession | undefined) => Record<string, unknown>;
  /** System indicators rendered at the bottom of every message. */
  renderResources?: (s: ChatSession) => string;
};

export type TranscriptManager = ReturnType<typeof createTranscriptManager>;

export function createTranscriptManager({ tg, store, threadOptsFor, renderResources }: TranscriptDeps) {
  /**
   * Telegram cancels an edit when a newer one arrives for the same message.
   * Since every update of a session now targets the same card, publishes must
   * be serialized per session to avoid losing content.
   */
  const publishQueue = new Map<string, Promise<void>>();

  /** Blocks of a session, persisted in the store so they survive restarts. */
  const blocksOf = (s: ChatSession): TranscriptBlock[] => {
    const stored = store.getTranscript(s.sessionId);
    if (s.transcript !== stored) s.transcript = stored;
    return stored;
  };

  /**
   * Append a block of content to the session transcript.
   *
   * `render` converts a chunk of raw text into HTML. Long content is split so
   * a single page never overflows, and EVERY chunk is rendered on its own:
   * the HTML is never lost and never mixed with raw markdown.
   */
  const addBlock = (
    s: ChatSession,
    kind: TranscriptKind,
    html: string,
    text: string,
    render?: (chunk: string) => string,
  ): void => {
    // The store owns the block list; `s.transcript` is only a view of it.
    // Pushing to both would duplicate every block.
    const push = (piece: TranscriptBlock) => {
      store.appendTranscript(s.sessionId, piece);
    };
    if (!render) {
      // Already-rendered HTML: keep it as one block.
      if (!text.trim() && !html.trim()) return;
      push({ kind, html, text, at: Date.now() });
      return;
    }
    const chunks = splitMarkdown(text, TRANSCRIPT_BLOCK_BUDGET);
    if (!chunks.length) {
      push({ kind, html, text, at: Date.now() });
      return;
    }
    chunks.forEach((chunk, i) => {
      const piece: TranscriptBlock = {
        kind,
        html: chunks.length > 1 ? `${render(chunk)}\n<i>(parte ${i + 1}/${chunks.length})</i>` : render(chunk),
        text: chunk,
        at: Date.now(),
      };
      push(piece);
    });
  };

  /** Render the current page of the transcript. */
  const renderPage = (
    s: ChatSession,
    opts: { extraTop?: string; extraBottom?: string; showResources?: boolean } = {},
  ): { html: string; page: number; total: number } | undefined => {
    const pages = paginateTranscript(blocksOf(s));
    const header = sessionHeader(s).trimEnd();
    // System indicators close the message unless explicitly suppressed (e.g. unified mode uses M1).
    const resources = opts.showResources === false ? "" : renderResources ? renderResources(s) : "";
    const extraTop = opts.extraTop ?? "";
    const extraBottom = opts.extraBottom ?? "";

    if (!pages.length) {
      const parts = [header, extraTop, extraBottom, resources].filter(Boolean);
      return { html: clampText(parts.join("\n\n"), 3900), page: 0, total: 0 };
    }
    const page = resolvePage(pages, s.transcriptPage, s.transcriptFollow !== false);
    if (!page) return undefined;
    const indicator = page.total > 1 ? `<i>📄 ${page.index + 1}/${page.total}</i>` : "";

    // When streaming a bottom section (e.g. live thought), protect it from being truncated.
    if (extraBottom) {
      const tailParts = [indicator, extraBottom, resources].filter(Boolean);
      const headParts = [header, extraTop].filter(Boolean);
      const overhead = headParts.join("\n\n").length + (headParts.length ? 2 : 0) + tailParts.join("\n\n").length + (tailParts.length ? 2 : 0);
      let budget = 3900 - overhead - 2;
      let content = page.html;
      if (content.length > budget && page.blocks.length > 1) {
        let kept = [] as typeof page.blocks;
        let used = 0;
        for (let i = page.blocks.length - 1; i >= 0; i--) {
          const len = page.blocks[i].html.length + 2;
          if (kept.length && used + len > budget) break;
          kept.unshift(page.blocks[i]);
          used += len;
        }
        content = (kept.length < page.blocks.length ? "<i>…</i>\n\n" : "") + kept.map((b) => b.html).join("\n\n");
      }
      if (content.length > budget) content = content.slice(0, Math.max(0, budget)) + "\n…";
      const parts = [header, extraTop, content, ...tailParts].filter(Boolean);
      return { html: clampText(parts.join("\n\n"), 3900), page: page.index, total: page.total };
    }

    const parts = [header, extraTop, page.html, indicator, resources].filter(Boolean);
    return { html: clampText(parts.join("\n\n"), 3900), page: page.index, total: page.total };
  };

  /** Keyboard for the session card. */
  const cardKeyboard = (
    s: ChatSession,
    page: number,
    total: number,
    opts?: { working?: boolean; unified?: boolean },
  ): Array<Array<{ text: string; callback_data: string }>> => {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    if (total > 1) {
      const nav: Array<{ text: string; callback_data: string }> = [];
      if (page > 0) nav.push({ text: "◀ Prev", callback_data: `tpage:${s.sessionId}:${page - 1}` });
      if (page < total - 1) nav.push({ text: "Next ▶", callback_data: `tpage:${s.sessionId}:${page + 1}` });
      if (nav.length) keyboard.push(nav);
      if (s.transcriptFollow === false && page < total - 1) {
        keyboard.push([{ text: "⏭ Latest", callback_data: `tpage:${s.sessionId}:${total - 1}` }]);
      }
    }
    if (opts?.working) keyboard.push([{ text: "⏹ Stop", callback_data: "panel:stop" }]);
    // "View full" escape hatch for long answers.
    if (s.lastFinalText) keyboard.push([{ text: "📄 Ver completo", callback_data: `viewfull:${s.sessionId}` }]);
    if (!opts?.unified) {
      keyboard.push([
        { text: "🧠 Models", callback_data: `panel:ms:${s.sessionId}` },
        { text: "📂 Sessions", callback_data: "panel:sessions" },
        { text: "🏠 Panel", callback_data: "panel:home" },
      ]);
    } else {
      keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    }
    return keyboard;
  };

  /**
   * Push the current page to Telegram, editing the existing card when
   * possible so no new message is created.
   * Publishes are serialized per session: Telegram cancels an edit when a
   * newer one arrives for the same message.
   */
  const publishNow = async (
    chatId: number,
    s: ChatSession,
    opts?: { extraTop?: string; extraBottom?: string; working?: boolean; showResources?: boolean; unified?: boolean },
  ): Promise<void> => {
    const rendered = renderPage(s, { extraTop: opts?.extraTop, extraBottom: opts?.extraBottom, showResources: opts?.showResources });
    if (!rendered) return;
    const tgOpts = threadOptsFor(s);
    const keyboard = { inline_keyboard: cardKeyboard(s, rendered.page, rendered.total, opts) };
    if (s.transcriptMessageId) {
      const ok = await tg
        .editRichMessage(chatId, s.transcriptMessageId, rendered.html, { ...tgOpts, reply_markup: keyboard })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        s.transcriptPage = rendered.page;
        s.statusMessageId = s.transcriptMessageId;
        return;
      }
      // The card is gone (deleted or too old): fall back to a new message.
      s.transcriptMessageId = undefined;
    }
    const sent = await tg
      .sendRichMessage(chatId, rendered.html, { ...tgOpts, reply_markup: keyboard })
      .catch((err) => {
        console.error("[transcript] send failed", err);
        return undefined;
      });
    if (sent?.message_id) {
      s.transcriptMessageId = sent.message_id;
      s.statusMessageId = sent.message_id;
      s.transcriptPage = rendered.page;
      store.rememberMessageSession(chatId, sent.message_id, s.sessionId);
    }
  };

  /** Serialized publish: one card update at a time per session. */
  const publish = async (
    chatId: number,
    s: ChatSession,
    opts?: { extraTop?: string; extraBottom?: string; working?: boolean; showResources?: boolean; unified?: boolean },
  ): Promise<void> => {
    const key = s.sessionId;
    const previous = publishQueue.get(key) ?? Promise.resolve();
    // Chain on the previous publish and swallow its errors.
    const next = previous.then(() => publishNow(chatId, s, opts)).catch(() => {});
    publishQueue.set(key, next);
    try {
      await next;
    } finally {
      if (publishQueue.get(key) === next) publishQueue.delete(key);
    }
  };

  /** Navigate to a specific page of the transcript. */
  const goToPage = async (chatId: number, s: ChatSession, page: number): Promise<void> => {
    const pages = paginateTranscript(blocksOf(s));
    if (!pages.length) return;
    const clamped = Math.min(Math.max(0, page), pages.length - 1);
    s.transcriptPage = clamped;
    s.transcriptFollow = clamped === pages.length - 1;
    await publish(chatId, s);
  };

  /**
   * "Refloat" the session card: detach it so the next publish sends a fresh
   * one at the bottom of the chat, keeping it visible near the latest
   * activity. By default the previous message is deleted; pass `keep: true`
   * to leave it in place as preserved history. Call only at turn boundaries
   * (never during streaming).
   */
  const refloat = async (chatId: number, s: ChatSession, opts?: { keep?: boolean }): Promise<void> => {
    const messageId = s.transcriptMessageId;
    if (!messageId) return;
    // Clear first so a concurrent publish cannot edit the message we are about to detach/remove.
    s.transcriptMessageId = undefined;
    if (s.statusMessageId === messageId) s.statusMessageId = undefined;
    if (!opts?.keep) {
      await tg.deleteMessage(chatId, messageId).catch(() => {});
    }
  };

  /** Total number of pages currently available. */
  const pageCount = (s: ChatSession): number => paginateTranscript(blocksOf(s)).length;

  return { addBlock, publish, goToPage, renderPage, cardKeyboard, pageCount, blocksOf, refloat };
}

export { esc, TRANSCRIPT_MAX_BLOCKS };
