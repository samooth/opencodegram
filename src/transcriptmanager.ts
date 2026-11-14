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
    // Tag blocks with the current turn and mark the first block of the turn so
    // pagination starts a fresh page for it (the card then shows the new turn's
    // content instead of re-showing the previous turn's page).
    const stamp = (piece: TranscriptBlock): TranscriptBlock => {
      if (s.turnSeq !== undefined) {
        piece.turn = s.turnSeq;
        if (!blocksOf(s).some((b) => b.turn === s.turnSeq)) piece.pageBreak = true;
      }
      return piece;
    };
    if (!render) {
      // Already-rendered HTML: keep it as one block.
      if (!text.trim() && !html.trim()) return;
      push(stamp({ kind, html, text, at: Date.now() }));
      return;
    }
    const chunks = splitMarkdown(text, TRANSCRIPT_BLOCK_BUDGET);
    if (!chunks.length) {
      push(stamp({ kind, html, text, at: Date.now() }));
      return;
    }
    chunks.forEach((chunk, i) => {
      const piece: TranscriptBlock = {
        kind,
        html: chunks.length > 1 ? `${render(chunk)}\n<i>(parte ${i + 1}/${chunks.length})</i>` : render(chunk),
        text: chunk,
        at: Date.now(),
      };
      push(stamp(piece));
    });
  };

  /** Render the current page of the transcript. */
  const renderPage = (
    s: ChatSession,
    opts: { extraTop?: string; extraBottom?: string; showResources?: boolean } = {},
  ): { html: string; page: number; total: number } | undefined => {
    const all = blocksOf(s);
    const pages = paginateTranscript(all);
    const header = `<h3>${sessionHeader(s).trimEnd()}</h3>`;
    // System indicators close the message unless explicitly suppressed (e.g. unified mode uses M1).
    const resources = opts.showResources === false ? "" : renderResources ? renderResources(s) : "";
    const extraTop = opts.extraTop ?? "";
    const extraBottom = opts.extraBottom ?? "";

    // While a turn is streaming and the user follows the card, show only the
    // content produced by the current turn. Nothing has been recorded yet at
    // that point, so the card shows the live strip alone instead of repeating
    // the previous turn's page. ◀ still browses the full history via the
    // keyboard, which is built over all pages.
    if (s.transcriptFollow !== false && !s.statusFinished && s.turnSeq !== undefined) {
      const hasTurnBlocks = all.some((b) => b.turn === s.turnSeq);
      if (!hasTurnBlocks) {
        const parts = [header, extraTop, extraBottom, resources ? `<hr/>\n${resources}` : ""].filter(Boolean);
        return { html: clampText(parts.join("\n\n"), 3900), page: Math.max(0, pages.length - 1), total: pages.length };
      }
    }

    if (!pages.length) {
      const parts = [header, extraTop, extraBottom, resources ? `<hr/>\n${resources}` : ""].filter(Boolean);
      return { html: clampText(parts.join("\n\n"), 3900), page: 0, total: 0 };
    }
    const page = resolvePage(pages, s.transcriptPage, s.transcriptFollow !== false);
    if (!page) return undefined;
    const indicator = page.total > 1 ? `<i>📄 ${page.index + 1}/${page.total}</i>` : "";

    // When streaming a bottom section (e.g. live thought), protect it from being truncated.
    if (extraBottom) {
      const tailParts = [extraBottom, resources ? `<hr/>\n${resources}` : ""].filter(Boolean);
      const headParts = [header, indicator, extraTop].filter(Boolean);
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
      const parts = [header, indicator, extraTop, content ? `<hr/>\n${content}` : "", ...tailParts].filter(Boolean);
      return { html: clampText(parts.join("\n\n"), 3900), page: page.index, total: page.total };
    }

    const parts = [header, indicator, extraTop, page.html ? `<hr/>\n${page.html}` : "", resources ? `<hr/>\n${resources}` : ""].filter(Boolean);
    return { html: clampText(parts.join("\n\n"), 3900), page: page.index, total: page.total };
  };

  /** Kind label for the history export. */
  const kindLabel: Record<TranscriptKind, string> = {
    thinking: "💭 Pensamiento",
    tools: "🔧 Herramienta",
    answer: "💬 Respuesta",
    meta: "ℹ️ Meta",
  };

  /**
   * Full transcript as a standalone HTML document, for the 📜 Historial
   * action. Includes every block (even those trimmed from the card pages).
   */
  const exportTranscriptHtml = (s: ChatSession): string => {
    const blocks = blocksOf(s);
    const name = (s.topicTitle || "").trim() || s.directory?.split("/").filter(Boolean).pop() || s.sessionId;
    const title = esc(name);
    const rows = blocks
      .map((b) => {
        const at = new Date(b.at).toLocaleString("es-ES");
        const kind = kindLabel[b.kind] ?? b.kind;
        const body = b.text.trim() ? `<pre style="white-space:pre-wrap;font-family:inherit">${esc(b.text)}</pre>` : "<p>(vacío)</p>";
        return `<section><h2>${kind} <small>· ${esc(at)}</small></h2>${body}</section>`;
      })
      .join("\n");
    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>${title} — historial</title>
<style>
body{max-width:56em;margin:2em auto;padding:0 1em;font-family:system-ui,sans-serif;color:#1a1a1a;line-height:1.5}
h1{font-size:1.4em}h2{font-size:1.02em;margin:1.4em 0 .4em;color:#444}
section{border-bottom:1px solid #eee;padding-bottom:.6em}
pre{margin:.2em 0}small{font-weight:400;color:#888}
</style></head>
<body><h1>📜 ${title}</h1>
<p><i>${esc(s.sessionId)} · ${blocks.length} bloques · exportado ${esc(new Date().toLocaleString("es-ES"))}</i></p>
${rows || "<p>(sin bloques)</p>"}
</body></html>`;
  };

  /**
   * Page picker: a grid with one button per page (rows of 8, up to 56) so the
   * user can jump to any page without pressing ◀ repeatedly. Buttons navigate
   * the card AND close the picker (tpagep). Beyond the cap, intermediate pages
   * collapse into a final "última" button.
   */
  const pagePickerKeyboard = (s: ChatSession, total: number): Array<Array<{ text: string; callback_data: string }>> => {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const maxButtons = 56;
    const perRow = 8;
    const count = Math.min(total, maxButtons);
    for (let i = 0; i < count; i += perRow) {
      const row: Array<{ text: string; callback_data: string }> = [];
      for (let j = i; j < Math.min(i + perRow, count); j++) {
        const pageIdx = count < total && j === count - 1 ? total - 1 : j;
        row.push({ text: `${pageIdx + 1}`, callback_data: `tpagep:${s.sessionId}:${pageIdx}` });
      }
      rows.push(row);
    }
    if (total > maxButtons) {
      rows.push([{ text: `⏭ Última (${total})`, callback_data: `tpagep:${s.sessionId}:${total - 1}` }]);
    }
    rows.push([{ text: "✕ Cerrar", callback_data: `tpick:close:${s.sessionId}` }]);
    return rows;
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
      if (page > 0) nav.push({ text: "◀", callback_data: `tpage:${s.sessionId}:${page - 1}` });
      // Middle button opens the page picker (jump to page N).
      nav.push({ text: `${page + 1}/${total} ⊞`, callback_data: `tpick:${s.sessionId}` });
      if (page < total - 1) nav.push({ text: "▶", callback_data: `tpage:${s.sessionId}:${page + 1}` });
      keyboard.push(nav);
      if (s.transcriptFollow === false && page < total - 1) {
        keyboard.push([{ text: "⏭ Última", callback_data: `tpage:${s.sessionId}:${total - 1}` }]);
      }
    }
    if (opts?.working) keyboard.push([{ text: "⏹ Stop", callback_data: "panel:stop" }]);
    // "View full" escape hatch for long answers; history export always available.
    const tools: Array<{ text: string; callback_data: string }> = [];
    if (s.lastFinalText) tools.push({ text: "📄 Ver completo", callback_data: `viewfull:${s.sessionId}` });
    tools.push({ text: "📥 Exportar", callback_data: `histfmt:${s.sessionId}` });
    keyboard.push(tools);
    // 📝 Diff of this turn's edits: snapshot is registered on the card id when
    // the turn finishes, so the button survives new turns and restarts.
    if (!opts?.working && s.transcriptMessageId) {
      const edits = store.getPendingEditsSnapshot(s.transcriptMessageId)?.edits?.length ?? 0;
      if (edits > 0) {
        keyboard.push([{ text: `📝 Diff (${edits})`, callback_data: `edits:full:${s.transcriptMessageId}` }]);
      }
    }
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
        store.rememberMessageSession(chatId, s.transcriptMessageId, s.sessionId);
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
    if (opts?.keep) {
      // Keep the previous card as history; detach from the live slot.
      s.transcriptMessageId = undefined;
      if (s.statusMessageId === messageId) s.statusMessageId = undefined;
      return;
    }
    // Remove the previous card so the new turn's card appears as a new
    // message (with notification). Deletion is best-effort: if it fails
    // (message too old, rate-limited) the old card stays; the new card is
    // still created below.
    s.transcriptMessageId = undefined;
    if (s.statusMessageId === messageId) s.statusMessageId = undefined;
    await tg.deleteMessage(chatId, messageId).catch(() => {});
  };

  /** Render the transcript as Markdown (for export/training). */
  const exportTranscriptMarkdown = (s: ChatSession): string => {
    const blocks = blocksOf(s);
    const name = (s.topicTitle || "").trim() || s.directory?.split("/").filter(Boolean).pop() || s.sessionId;
    const lines: string[] = [];
    lines.push(`# ${name}`);
    lines.push("");
    lines.push(`- **Session:** \`${s.sessionId}\``);
    if (s.model) lines.push(`- **Model:** ${s.model.providerID}/${s.model.id}${s.model.variant ? ` (${s.model.variant})` : ""}`);
    if (s.directory) lines.push(`- **Directory:** \`${s.directory}\``);
    lines.push(`- **Blocks:** ${blocks.length}`);
    lines.push(`- **Exported:** ${new Date().toISOString()}`);
    lines.push("");
    lines.push("---");
    lines.push("");
    // Group blocks by turn.
    const byTurn = new Map<number, TranscriptBlock[]>();
    const noTurn: TranscriptBlock[] = [];
    for (const b of blocks) {
      if (b.turn !== undefined) {
        const arr = byTurn.get(b.turn) ?? [];
        arr.push(b);
        byTurn.set(b.turn, arr);
      } else {
        noTurn.push(b);
      }
    }
    const turns = [...byTurn.keys()].sort((a, b) => a - b);
    if (turns.length === 0 && noTurn.length) {
      for (const b of noTurn) {
        const label = b.kind === "thinking" ? "💭 Pensamiento" : b.kind === "tools" ? "🔧 Herramientas" : b.kind === "meta" ? "ℹ️ Meta" : "💬 Respuesta";
        lines.push(`## ${label}`);
        lines.push("");
        lines.push(b.text.trim() || "(vacío)");
        lines.push("");
      }
    } else {
      for (const t of turns) {
        lines.push(`## Turno ${t}`);
        lines.push("");
        for (const b of byTurn.get(t) ?? []) {
          const label = b.kind === "thinking" ? "💭 Pensamiento" : b.kind === "tools" ? "🔧 Herramientas" : b.kind === "meta" ? "ℹ️ Meta" : "💬 Respuesta";
          lines.push(`### ${label}`);
          lines.push("");
          lines.push(b.text.trim() || "(vacío)");
          lines.push("");
        }
      }
      if (noTurn.length) {
        lines.push("## Sin turno");
        lines.push("");
        for (const b of noTurn) {
          const label = b.kind === "thinking" ? "💭 Pensamiento" : b.kind === "tools" ? "🔧 Herramientas" : b.kind === "meta" ? "ℹ️ Meta" : "💬 Respuesta";
          lines.push(`### ${label}`);
          lines.push("");
          lines.push(b.text.trim() || "(vacío)");
          lines.push("");
        }
      }
    }
    return lines.join("\n").trimEnd() + "\n";
  };

  /** Render the transcript as JSON-LD dataset (for AI training). */
  const exportTranscriptJsonLd = (s: ChatSession): string => {
    const blocks = blocksOf(s);
    const name = (s.topicTitle || "").trim() || s.directory?.split("/").filter(Boolean).pop() || s.sessionId;
    const byTurn = new Map<number, TranscriptBlock[]>();
    const noTurn: TranscriptBlock[] = [];
    for (const b of blocks) {
      if (b.turn !== undefined) {
        const arr = byTurn.get(b.turn) ?? [];
        arr.push(b);
        byTurn.set(b.turn, arr);
      } else {
        noTurn.push(b);
      }
    }
    const turnKeys = [...byTurn.keys()].sort((a, b) => a - b);
    const turns = turnKeys.map((t) => ({
      "@type": "Conversation",
      "turn": t,
      "messages": (byTurn.get(t) ?? []).map((b, i) => ({
        "@type": "Message",
        "position": i + 1,
        "role": "assistant",
        "kind": b.kind,
        "text": b.text,
        "dateCreated": new Date(b.at).toISOString(),
      })),
    }));
    if (noTurn.length) {
      turns.push({
        "@type": "Conversation",
        "turn": 0,
        "messages": noTurn.map((b, i) => ({
          "@type": "Message",
          "position": i + 1,
          "role": "assistant",
          "kind": b.kind,
          "text": b.text,
          "dateCreated": new Date(b.at).toISOString(),
        })),
      });
    }
    const dataset = {
      "@context": "https://schema.org",
      "@type": "Dataset",
      "name": `${name} — transcript`,
      "description": "Session transcript exported as a conversation dataset for AI training. Blocks are grouped by turn; each message carries its kind (answer/thinking/tools/meta).",
      "identifier": s.sessionId,
      "creator": { "@type": "SoftwareApplication", "name": "opencodegram" },
      "dateCreated": new Date().toISOString(),
      "keywords": ["conversation", "ai-training", "opencode", "transcript"],
      "license": "https://creativecommons.org/licenses/by/4.0/",
      "variableMeasured": ["text", "kind", "turn"],
      "distribution": {
        "@type": "DataDownload",
        "encodingFormat": "application/ld+json",
        "contentUrl": `historial-${s.sessionId.slice(0, 8)}.jsonld`,
      },
      "conversation": turns,
    };
    return JSON.stringify(dataset, null, 2);
  };

  /** Total number of pages currently available. */
  const pageCount = (s: ChatSession): number => paginateTranscript(blocksOf(s)).length;

  return { addBlock, publish, goToPage, renderPage, cardKeyboard, pagePickerKeyboard, exportTranscriptHtml, exportTranscriptMarkdown, exportTranscriptJsonLd, pageCount, blocksOf, refloat };
}

export { esc, TRANSCRIPT_MAX_BLOCKS };
