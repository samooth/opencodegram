import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { SessionStore } from "./store.js";
import { clampText, esc, sessionHeader } from "./util.js";
import {
  appendTranscript,
  paginateTranscript,
  resolvePage,
  splitText,
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
};

export type TranscriptManager = ReturnType<typeof createTranscriptManager>;

export function createTranscriptManager({ tg, store, threadOptsFor }: TranscriptDeps) {
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
   * Long texts are split so a single page never overflows.
   */
  const addBlock = (s: ChatSession, kind: TranscriptKind, html: string, text: string): void => {
    const chunks = splitText(text, TRANSCRIPT_BLOCK_BUDGET);
    if (!chunks.length) {
      const piece: TranscriptBlock = { kind, html, text, at: Date.now() };
      appendTranscript(s, piece);
      store.appendTranscript(s.sessionId, piece);
      return;
    }
    chunks.forEach((chunk, i) => {
      const piece: TranscriptBlock = {
        kind,
        html: chunks.length > 1 ? `${chunk}\n<i>(parte ${i + 1}/${chunks.length})</i>` : chunk,
        text: chunk,
        at: Date.now(),
      };
      appendTranscript(s, piece);
      store.appendTranscript(s.sessionId, piece);
    });
  };

  /** Render the current page of the transcript. */
  const renderPage = (s: ChatSession, extraTop: string = ""): { html: string; page: number; total: number } | undefined => {
    const pages = paginateTranscript(blocksOf(s));
    const header = sessionHeader(s).trimEnd();
    if (!pages.length) {
      return { html: clampText(`${header}${extraTop}`, 3900), page: 0, total: 0 };
    }
    const page = resolvePage(pages, s.transcriptPage, s.transcriptFollow !== false);
    if (!page) return undefined;
    const nav = page.total > 1 ? `\n<i>📄 ${page.index + 1}/${page.total}</i>` : "";
    const html = clampText(`${header}${extraTop}\n${page.html}${nav}`, 3900);
    return { html, page: page.index, total: page.total };
  };

  /** Keyboard for the session card. */
  const cardKeyboard = (
    s: ChatSession,
    page: number,
    total: number,
    opts?: { working?: boolean },
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
    keyboard.push([
      { text: "🧠 Models", callback_data: `panel:ms:${s.sessionId}` },
      { text: "📂 Sessions", callback_data: "panel:sessions" },
      { text: "🏠 Panel", callback_data: "panel:home" },
    ]);
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
    opts?: { extraTop?: string; working?: boolean },
  ): Promise<void> => {
    const rendered = renderPage(s, opts?.extraTop);
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
    opts?: { extraTop?: string; working?: boolean },
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

  /** Total number of pages currently available. */
  const pageCount = (s: ChatSession): number => paginateTranscript(blocksOf(s)).length;

  return { addBlock, publish, goToPage, renderPage, cardKeyboard, pageCount, blocksOf };
}

export { esc, TRANSCRIPT_MAX_BLOCKS };
