import type { TelegramClient } from "./telegram.js";
import type { CardView, ChatSession } from "./types.js";
import type { InlineButton, InlineKeyboard } from "./apitypes.js";
import type { SessionStore } from "./store.js";
import { clampText, copyTextButton, esc, markdownToHtml, sessionHeader, truncate } from "./util.js";
import { isShellTool, parseShellCommand } from "./status-render.js";
import { extractEditFile } from "./editutil.js";
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

/** Publish options: card view plus the optional status strips. */
export type PublishOpts = Partial<CardView> & {
  extraTop?: string;
  extraBottom?: string;
  working?: boolean;
};

const DEFAULT_VIEW: CardView = { compact: false, reading: false, showResources: true, unified: false };

const viewOf = (s: ChatSession, opts?: PublishOpts): CardView & PublishOpts => ({ ...DEFAULT_VIEW, ...(s.cardView ?? {}), ...(opts ?? {}) });

export type TranscriptManager = ReturnType<typeof createTranscriptManager>;

/**
 * Telegram allows at most 64 bytes of callback_data per button. Read paths can
 * be far longer, so the keyboard carries a short key and the path lives here.
 */
const activityReadPaths = new Map<string, string>();
/**
 * Last resource-free HTML published per card, for cleaning up old messages.
 * Telegram message ids are unique per chat, not globally, so the key includes
 * the chat id to avoid group/private collisions.
 */
const cardCleanHtml = new Map<string, string>();
const cardKey = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

export function rememberActivityReadPath(key: string, path: string): void {
  activityReadPaths.set(key, path);
  if (activityReadPaths.size > 500) {
    const oldest = activityReadPaths.keys().next().value;
    if (oldest) activityReadPaths.delete(oldest);
  }
}

export function getActivityReadPath(key: string): string | undefined {
  return activityReadPaths.get(key);
}

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
    toolCalls?: TranscriptBlock["toolCalls"],
  ): void => {
    // The store owns the block list; `s.transcript` is only a view of it.
    // Pushing to both would duplicate every block.
    const push = (piece: TranscriptBlock) => {
      if (toolCalls?.length) piece.toolCalls = toolCalls.map((c) => ({ ...c }));
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

  /** Distinct turns present in the transcript, oldest first. */
  const turnsOf = (s: ChatSession): number[] => [...new Set(blocksOf(s)
    .map((b) => b.turn)
    .filter((t): t is number => typeof t === "number"))].sort((a, b) => a - b);

  const turnOfPage = (page: { blocks: TranscriptBlock[] } | undefined): number | undefined =>
    page?.blocks.find((b) => typeof b.turn === "number")?.turn;

  /** P1.3: one-line summary for the turn picker and the "antes…" recap. */
  const turnSummary = (s: ChatSession, turn?: number): string => {
    const wanted = turn ?? s.turnSeq;
    const blocks = blocksOf(s).filter((b) => wanted === undefined || b.turn === wanted);
    const answer = blocks.find((b) => b.kind === "answer")?.text.trim().split(/\r?\n/).filter(Boolean)[0];
    if (answer) return truncate(answer.replace(/[*_`>#]/g, ""), 100);
    const names = [...new Set(blocks.flatMap((b) => (b.toolCalls ?? []).map((t) => t.name)))];
    if (names.length) return `Herramientas: ${names.slice(0, 3).join(", ")}`;
    const prompt = store.lastPromptBySession.get(s.sessionId);
    return prompt ? truncate(prompt, 100) : "sin detalle";
  };

  /** Render the current page of the transcript, with the optional status strip. */
  const renderPage = (
    s: ChatSession,
    opts: PublishOpts = {},
  ): { html: string; page: number; total: number } | undefined => {
    const view = viewOf(s, opts);
    // P1.1: compact cards fit a phone screen (≤1.200 chars); reading mode and
    // the expanded view keep the original 3.900-char budget.
    const LAYOUT_LIMIT = view.compact ? 1200 : 3900;
    const all = blocksOf(s);
    const pages = paginateTranscript(all);
    const header = `<h3>${sessionHeader(s).trimEnd()}</h3>`;
    // System indicators close the message unless explicitly suppressed (e.g. unified mode uses M1).
    const resources = !view.showResources || s.resourcesCollapsed ? "" : renderResources ? renderResources(s) : "";
    const extraTop = view.compact ? clampText(opts.extraTop ?? "", 600) : (opts.extraTop ?? "");
    const extraBottom = opts.extraBottom ?? "";

    /**
     * Join the fixed sections with the page content, trimming the CONTENT when
     * the header/live strip/resources take too much room. The newest blocks
     * (the tail of the page) are kept: the latest output must stay visible.
     */
    const fit = (headParts: string[], blocks: TranscriptBlock[]): string => {
      const tailParts = [extraBottom, resources ? `<hr/>\n${resources}` : ""].filter(Boolean);
      const headFixed = [...headParts, extraTop].filter(Boolean).join("\n\n");
      const tailFixed = tailParts.join("\n\n");
      // Account for the joins, the `<hr/>` separator and the truncation ellipsis.
      const budget = Math.max(0, LAYOUT_LIMIT - headFixed.length - tailFixed.length - 20);
      let content = blocks.map((b) => b.html).join("\n\n");
      if (content.length > budget) {
        const kept: TranscriptBlock[] = [];
        let used = 0;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const len = blocks[i].html.length + 2;
          if (kept.length && used + len > budget) break;
          kept.unshift(blocks[i]);
          used += len;
        }
        content = (kept.length < blocks.length ? "<i>…</i>\n\n" : "") + kept.map((b) => b.html).join("\n\n");
        // A single block bigger than the budget: cut it safely.
        if (content.length > budget) content = clampText(content, budget);
      }
      const parts = [headFixed, content ? `<hr/>\n${content}` : "", ...tailParts].filter(Boolean);
      return clampText(parts.join("\n\n"), LAYOUT_LIMIT);
    };

    // While a turn is streaming and the user follows the card, show only the
    // content produced by the current turn. Nothing has been recorded yet at
    // that point, so the card shows the live strip alone instead of repeating
    // the previous turn's page. ◀ still browses the full history via the
    // keyboard, which is built over all pages.
    if (!view.reading && s.transcriptFollow !== false && !s.statusFinished && s.turnSeq !== undefined) {
      const hasTurnBlocks = all.some((b) => b.turn === s.turnSeq);
      if (!hasTurnBlocks) {
        return { html: fit([header], []), page: Math.max(0, pages.length - 1), total: pages.length };
      }
    }

    if (!pages.length) {
      return { html: fit([header], []), page: 0, total: 0 };
    }
    const page = resolvePage(pages, s.transcriptPage, s.transcriptFollow !== false);
    if (!page) return undefined;
    // P1.3: navigate by turn, not by raw block-page count.
    const turns = turnsOf(s);
    const pageTurn = turnOfPage(page);
    const totalTurns = turns.length || (s.turnSeq ?? 0);
    const indicator = pageTurn && totalTurns
      ? `<i>🎯 Turno ${pageTurn}/${totalTurns}</i>`
      : page.total > 1 ? `<i>📄 ${page.index + 1}/${page.total}</i>` : "";
    // Mini "previously on…" (two lines) when the user jumps to another turn.
    let recap = "";
    if (s.lastViewedTurn !== undefined && pageTurn && s.lastViewedTurn !== pageTurn) {
      const previous = turnSummary(s, s.lastViewedTurn);
      if (previous && previous !== "sin detalle") {
        recap = `<blockquote expandable>📺 <b>Antes…</b> ${esc(previous)}</blockquote>`;
      }
    }
    return {
      html: fit([header, indicator, recap].filter(Boolean), page.blocks),
      page: page.index,
      total: page.total,
    };
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
   * action. Includes every block (even those trimmed from the card pages) and,
   * when available, the user prompt that started each turn. Markdown is
   * rendered to HTML (code blocks stay escaped) so the document is readable
   * in any browser.
   */
  const exportTranscriptHtml = (s: ChatSession, userPrompts: string[] = []): string => {
    const blocks = blocksOf(s);
    const name = (s.topicTitle || "").trim() || s.directory?.split("/").filter(Boolean).pop() || s.sessionId;
    const title = esc(name);
    // Group blocks by turn, mirroring the Markdown/JSON-LD exporters.
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
    const lastPrompt = store?.lastPromptBySession?.get?.(s.sessionId);
    const kindLabel: Record<TranscriptKind, string> = { thinking: "💭 Pensamiento", tools: "🔧 Herramientas", answer: "💬 Respuesta", meta: "ℹ️ Meta" };
    const renderBlocks = (bs: TranscriptBlock[]) =>
      bs.map((b) => {
        const kind = kindLabel[b.kind] ?? b.kind;
        const body = b.text.trim() ? markdownToHtml(b.text) : "<p><i>(vacío)</i></p>";
        return `<section class="block"><h3>${esc(kind)}</h3>${body}</section>`;
      }).join("\n");
    const sections: string[] = [];
    turnKeys.forEach((t, idx) => {
      const bs = byTurn.get(t) ?? [];
      const prompt = userPrompts[idx] ?? store?.getTurnPrompt?.(s.sessionId, t) ?? (idx === turnKeys.length - 1 ? lastPrompt : undefined);
      const parts: string[] = [`<h2>Turno ${t}</h2>`];
      if (prompt && prompt.trim()) {
        parts.push(`<section class="prompt"><h3>👤 Usuario</h3>${markdownToHtml(prompt)}</section>`);
      }
      parts.push(renderBlocks(bs));
      sections.push(parts.join("\n"));
    });
    if (noTurn.length) {
      const parts: string[] = ["<h2>Sin turno</h2>"];
      // Best-effort: a single leading prompt if available.
      if (userPrompts.length && turnKeys.length === 0) {
        parts.push(`<section class="prompt"><h3>👤 Usuario</h3>${markdownToHtml(userPrompts[0])}</section>`);
      }
      parts.push(renderBlocks(noTurn));
      sections.push(parts.join("\n"));
    }
    const body = sections.join("\n<hr/>\n") || "<p>(sin bloques)</p>";
    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>${title} — historial</title>
<style>
body{max-width:60em;margin:2em auto;padding:0 1em;font-family:system-ui,sans-serif;color:#1a1a1a;line-height:1.6}
h1{font-size:1.5em}h2{font-size:1.2em;margin:1.6em 0 .4em;color:#222;border-bottom:1px solid #eee;padding-bottom:.2em}
h3{font-size:1em;margin:1em 0 .3em;color:#555}
section.block{margin:.6em 0 1em}
section.prompt{background:#f4f7fb;border-left:3px solid #4a90d9;padding:.6em 1em;margin:.6em 0;border-radius:4px}
pre,code{font-family:ui-monospace,monospace;font-size:.9em}
pre{background:#f6f6f6;padding:.6em .8em;border-radius:4px;overflow-x:auto}
blockquote{border-left:3px solid #ccc;padding:.2em .8em;color:#444;margin:.4em 0}
table{border-collapse:collapse;margin:.4em 0}th,td{border:1px solid #ddd;padding:.3em .6em}
hr{border:none;border-top:1px solid #eee;margin:1.2em 0}
small{color:#888}
</style></head>
<body><h1>📜 ${title}</h1>
<p><i>${esc(s.sessionId)} · ${blocks.length} bloques · exportado ${esc(new Date().toLocaleString("es-ES"))}</i></p>
${body}
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
  const navRow = (s: ChatSession, page: number, total: number): InlineButton[] => {
    const nav: InlineButton[] = [];
    if (page > 0) nav.push({ text: "◀", callback_data: `tpage:${s.sessionId}:${page - 1}` });
    // Middle button opens the page picker (jump to page N).
    nav.push({ text: `${page + 1}/${total} ⊞`, callback_data: `tpick:${s.sessionId}` });
    if (page < total - 1) nav.push({ text: "▶", callback_data: `tpage:${s.sessionId}:${page + 1}` });
    return nav;
  };

  const cardKeyboard = (
    chatId: number,
    s: ChatSession,
    page: number,
    total: number,
    opts?: PublishOpts,
  ): InlineKeyboard => {
    const keyboard: InlineKeyboard = [];
    const view = viewOf(s, opts);
    const activity = s.activity;
    const hasActivity = !!activity && activity.thoughts + activity.reads + activity.searches + activity.edits + activity.shells + activity.tools > 0;
    if (total > 1) {
      keyboard.push(navRow(s, page, total));
      // P1.3: once the user is away from the latest page, offer a jump back.
      if (page < total - 1) {
        keyboard.push([{ text: "⏭ Última", callback_data: `tpage:${s.sessionId}:${total - 1}` }]);
      }
    }

    // Edits live inside the card; the snapshot survives turns and restarts.
    const edits = !view.working && s.transcriptMessageId
      ? store.getPendingEditsSnapshot(chatId, s.transcriptMessageId)?.edits ?? []
      : [];

    // 1) Primary action for the current state. This is always the first row so
    // the user never has to scroll to act on a long answer.
    const primary: InlineButton[] = [];
    if (view.working) {
      primary.push({ text: "⏹ Detener", callback_data: "panel:stop" });
      if (hasActivity) primary.push({
        text: s.activityExpanded ? "▴ Ocultar" : "▾ Detalles",
        callback_data: `activity:${s.sessionId}`,
      });
    } else if (s.lastTurnError) {
      primary.push({ text: "🔁 Reintentar", callback_data: `retry:${s.sessionId}` });
      primary.push({ text: "🧠 Cambiar modelo", callback_data: `panel:ms:${s.sessionId}` });
    } else if (s.stopped) {
      primary.push({ text: "▶️ Continuar", callback_data: `retry:${s.sessionId}` });
      primary.push({ text: "📥 Historial", callback_data: `histfmt:${s.sessionId}` });
    } else {
      if (s.lastFinalText) primary.push({ text: "📄 Respuesta", callback_data: `viewfull:${s.sessionId}` });
      if (edits.length && s.transcriptMessageId) {
        primary.push({ text: "✏️ Cambios", callback_data: `edits:full:${s.transcriptMessageId}` });
      }
      const copy = copyTextButton(chatId, "📋 Copiar", s.lastFinalText);
      if (copy) primary.push(copy);
    }
    if (primary.length) keyboard.push(primary);

    // 2) Secondary toggles: detail and resources. The activity toggle moves to
    // the primary row while working; finished cards keep it here.
    if (!(view.working && hasActivity) && hasActivity) {
      keyboard.push([{
        text: s.activityExpanded ? "▴ Ocultar detalles" : "▾ Ver detalles",
        callback_data: `activity:${s.sessionId}`,
      }]);
    }
    if (!view.unified) {
      keyboard.push([{
        text: s.resourcesCollapsed ? "📊 Recursos ▴" : "📊 Recursos ▾",
        callback_data: `resources:${s.sessionId}`,
      }]);
    }

    // 3) Copy prompt and the last shell command (private clipboard button only
    // when it fits; groups and long texts fall back to a code block).
    if (!view.working) {
      const copyPrompt = copyTextButton(chatId, "📋 Copiar prompt", store.lastPromptBySession.get(s.sessionId));
      if (copyPrompt) keyboard.push([copyPrompt]);
      const lastShell = [...(s.toolCallDetails ?? [])].reverse().find((d) => isShellTool(d.name));
      const lastCommand = lastShell ? parseShellCommand(lastShell.input ?? "") ?? lastShell.input?.trim() : undefined;
      if (lastCommand) {
        const copyCommand = copyTextButton(chatId, "📋 Copiar comando", lastCommand);
        keyboard.push([copyCommand ?? { text: "📋 Copiar comando", callback_data: `copy:command:${s.sessionId}` }]);
      }
    }

    // 📖 Files read this turn: open the actual content instead of a bare name.
    const readPaths = (s.activity?.entries ?? [])
      .filter((e) => e.kind === "read" && e.detail.trim())
      .slice(-3)
      .map((e) => e.detail.trim().replace(/[\r\n]/g, " ").slice(0, 160));
    for (const key of [...activityReadPaths.keys()]) {
      if (key.startsWith(`${s.sessionId}:`)) activityReadPaths.delete(key);
    }
    const seenReads = new Set<string>();
    const readButtons: InlineButton[] = [];
    for (const path of readPaths) {
      if (seenReads.has(path)) continue;
      seenReads.add(path);
      const key = `${s.sessionId}:${seenReads.size - 1}`;
      // The label keeps the line range; the stored path must not include it.
      rememberActivityReadPath(key, path.replace(/:\d+(?:-\d+)?$/, ""));
      readButtons.push({ text: `📖 ${path.split("/").pop() ?? path}`.slice(0, 64), callback_data: `readfile:${key}` });
    }
    if (readButtons.length) keyboard.push(readButtons);

    // 4) Per-file edit buttons + the full diff entry point.
    if (!view.working) {
      for (let idx = Math.max(0, edits.length - 3); idx < edits.length; idx++) {
        const raw = extractEditFile(edits[idx]?.input) ?? `edit ${idx + 1}`;
        const label = raw.split("/").pop() ?? raw;
        keyboard.push([
          { text: `✏️ ${label}`.slice(0, 64), callback_data: `edit:${idx}` },
          { text: `📄 ${label}`.slice(0, 64), callback_data: `editfile:${idx}` },
        ]);
      }
      if (edits.length) {
        keyboard.push([{ text: `📝 Diff (${edits.length})`, callback_data: `edits:full:${s.transcriptMessageId}` }]);
      }
    }

    // 5) Export always available; copy fallback for groups or long answers.
    if (!view.working) {
      const tools: InlineButton[] = [];
      const nativeCopy = copyTextButton(chatId, "📋 Copiar", s.lastFinalText);
      if (s.lastFinalText && !nativeCopy) {
        tools.push({ text: "📋 Copiar respuesta", callback_data: `copy:answer:${s.sessionId}` });
      }
      tools.push({ text: "📥 Exportar", callback_data: `histfmt:${s.sessionId}` });
      keyboard.push(tools);
    }

    if (!view.unified) {
      keyboard.push([
        { text: "🧠 Modelos", callback_data: `panel:ms:${s.sessionId}` },
        { text: "📂 Sesiones", callback_data: "panel:sessions" },
        { text: "🏠 Panel", callback_data: "panel:home" },
      ]);
    } else {
      keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    }

    return keyboard;
  };

  /**
   * P1.1: the default card is compact — primary action, turn navigation and a
   * single ▾ Más entry point (≤3 rows). ▾ Más reveals the full keyboard, and
   * 📖 Leer switches the same message to a clean, paginated reading view.
   */
  const compactCardKeyboard = (
    chatId: number,
    s: ChatSession,
    page: number,
    total: number,
    opts?: PublishOpts,
  ): InlineKeyboard => {
    const view = viewOf(s, opts);
    if (view.reading) {
      const rows: InlineKeyboard = [[{ text: "⬅ Volver", callback_data: `back:${s.sessionId}` }]];
      if (total > 1) {
        const nav = navRow(s, page, total);
        if (page < total - 1) nav.push({ text: "⏭ Última", callback_data: `tpage:${s.sessionId}:${total - 1}` });
        rows.push(nav);
      }
      return rows;
    }
    if (!view.compact || s.cardMenuExpanded) {
      if (!view.compact || view.reading) return cardKeyboard(chatId, s, page, total, opts);
      const expanded = cardKeyboard(chatId, s, page, total, opts);
      expanded.push([{ text: "▴ Menos", callback_data: `menu:${s.sessionId}` }]);
      return expanded;
    }
    const full = cardKeyboard(chatId, s, page, total, opts);
    // cardKeyboard starts with navigation; lift the state's primary row to the
    // top so the compact card still follows "one obvious action first".
    const primary = full.find((row) => row.some((b) =>
      b.callback_data === "panel:stop" ||
      b.callback_data === `retry:${s.sessionId}` ||
      b.callback_data === `viewfull:${s.sessionId}` ||
      b.callback_data === `edits:full:${s.transcriptMessageId}` ||
      b.callback_data === `panel:ms:${s.sessionId}` ||
      b.copy_text !== undefined,
    )) ?? [];
    const rows: InlineKeyboard = [primary];
    if (total > 1) {
      const nav = navRow(s, page, total);
      if (page < total - 1) nav.push({ text: "⏭ Última", callback_data: `tpage:${s.sessionId}:${total - 1}` });
      rows.push(nav);
    }
    const more: InlineButton[] = [];
    // P1.1 regresion fix: the two everyday toggles stay one tap away in the
    // compact card; only the long tail lives behind ▾ Más.
    const a = s.activity;
    const hasActivity = !!a && a.thoughts + a.reads + a.searches + a.edits + a.shells + a.tools > 0;
    if (hasActivity) {
      more.push({
        text: s.activityExpanded ? "▴ Ocultar" : "▾ Detalles",
        callback_data: `activity:${s.sessionId}`,
      });
    }
    if (!view.unified) {
      more.push({
        text: s.resourcesCollapsed ? "📊 Recursos ▴" : "📊 Recursos ▾",
        callback_data: `resources:${s.sessionId}`,
      });
    }
    if (s.lastFinalText) more.push({ text: "📖 Leer", callback_data: `read:${s.sessionId}` });
    more.push({ text: "▾ Más", callback_data: `menu:${s.sessionId}` });
    rows.push(more);
    return rows.filter((row) => row.length > 0);
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
    opts?: PublishOpts,
  ): Promise<void> => {
    const rendered = renderPage(s, opts);
    if (!rendered) return;
    const cleanHtml = renderPage(s, { ...opts, showResources: false })?.html ?? rendered.html;
    const tgOpts = threadOptsFor(s);
    const keyboard = { inline_keyboard: compactCardKeyboard(chatId, s, rendered.page, rendered.total, opts) };
    if (s.transcriptMessageId) {
      const ok = await tg
        .editRichMessage(chatId, s.transcriptMessageId, rendered.html, { ...tgOpts, reply_markup: keyboard })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        s.transcriptPage = rendered.page;
        s.statusMessageId = s.transcriptMessageId;
        cardCleanHtml.set(cardKey(chatId, s.transcriptMessageId), cleanHtml);
        store.rememberMessageSession(chatId, s.transcriptMessageId, s.sessionId);
        return;
      }
      // The card is gone or can't be edited: strip its keyboard (if it still
      // exists) so only the newest card keeps interactive buttons.
      const previousId = s.transcriptMessageId;
      if (previousId) await cleanupCard(chatId, previousId);
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
      cardCleanHtml.set(cardKey(chatId, sent.message_id), cleanHtml);
      s.transcriptPage = rendered.page;
      store.rememberMessageSession(chatId, sent.message_id, s.sessionId);
    }
  };

  /** Serialized publish: one card update at a time per session. */
  const publish = async (
    chatId: number,
    s: ChatSession,
    opts?: PublishOpts,
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
    const shownTurn = turnOfPage(pages[clamped]);
    if (shownTurn !== undefined) s.lastViewedTurn = shownTurn;
    // Keep the compact/reading view when navigating: goToPage must not replace
    // the status strip with a bare working card.
    await publish(chatId, s, { ...s.cardView });
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
      // Keep the previous card as history but remove its buttons: only the
      // newest card should carry interactive controls.
      s.transcriptMessageId = undefined;
      if (s.statusMessageId === messageId) s.statusMessageId = undefined;
      await cleanupCard(chatId, messageId);
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
  const exportTranscriptMarkdown = (s: ChatSession, userPrompts: string[] = []): string => {
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
      turns.forEach((t, idx) => {
        lines.push(`## Turno ${t}`);
        lines.push("");
        const prompt = userPrompts[idx] ?? store?.getTurnPrompt?.(s.sessionId, t) ?? (idx === turns.length - 1 ? store?.lastPromptBySession?.get?.(s.sessionId) : undefined);
        if (prompt && prompt.trim()) {
          lines.push("### 👤 Usuario");
          lines.push("");
          lines.push(prompt.trim());
          lines.push("");
        }
        for (const b of byTurn.get(t) ?? []) {
          const label = b.kind === "thinking" ? "💭 Pensamiento" : b.kind === "tools" ? "🔧 Herramientas" : b.kind === "meta" ? "ℹ️ Meta" : "💬 Respuesta";
          lines.push(`### ${label}`);
          lines.push("");
          lines.push(b.text.trim() || "(vacío)");
          lines.push("");
        }
      });
      if (noTurn.length) {
        lines.push("## Sin turno");
        lines.push("");
        if (userPrompts.length && turns.length === 0) {
          lines.push("### 👤 Usuario");
          lines.push("");
          lines.push(userPrompts[0].trim());
          lines.push("");
        }
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
  const exportTranscriptJsonLd = (s: ChatSession, userPrompts: string[] = []): string => {
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
    const lastPrompt = store?.lastPromptBySession?.get?.(s.sessionId);
    const turns = turnKeys.map((t, idx) => {
      const msgs = byTurn.get(t) ?? [];
      const answerBlocks = msgs.filter((b) => b.kind === "answer");
      const thinkingBlocks = msgs.filter((b) => b.kind === "thinking");
      const toolsBlocks = msgs.filter((b) => b.kind === "tools");
      const metaBlocks = msgs.filter((b) => b.kind === "meta");
      const isLast = idx === turnKeys.length - 1;
      const turnPrompt = userPrompts[idx] ?? store?.getTurnPrompt?.(s.sessionId, t) ?? null;
      const userPrompt = turnPrompt ?? (isLast ? (lastPrompt ?? null) : null);
      const assistantText = answerBlocks.map((b) => b.text).join("\\n\\n").trim();
      const thinkingText = thinkingBlocks.map((b) => b.text).join("\\n\\n").trim();
      const toolsText = toolsBlocks.map((b) => b.text).join("\\n\\n").trim();
      const metaText = metaBlocks.map((b) => b.text).join("\\n\\n").trim();
      const toolCalls = toolsBlocks.flatMap((b) => b.toolCalls ?? []);
      return {
        "@type": "Conversation",
        "turn": t,
        "userPrompt": userPrompt,
        "assistantAnswer": assistantText || null,
        "thinking": thinkingText || null,
        "tools": toolsText || null,
        "toolCalls": toolCalls.length ? toolCalls : undefined,
        "meta": metaText || null,
        "messages": msgs.map((b, i) => ({
          "@type": "Message",
          "position": i + 1,
          "role": "assistant",
          "kind": b.kind,
          "text": b.text,
          ...(b.toolCalls?.length ? { "toolCalls": b.toolCalls } : {}),
          "dateCreated": new Date(b.at).toISOString(),
        })),
      };
    });
    if (noTurn.length) {
      turns.push({
        "@type": "Conversation",
        "turn": 0,
        "userPrompt": (userPrompts[0] ?? null),
        "assistantAnswer": noTurn.filter((b) => b.kind === "answer").map((b) => b.text).join("\\n\\n").trim() || null,
        "thinking": noTurn.filter((b) => b.kind === "thinking").map((b) => b.text).join("\\n\\n").trim() || null,
        "tools": noTurn.filter((b) => b.kind === "tools").map((b) => b.text).join("\\n\\n").trim() || null,
        "toolCalls": noTurn.flatMap((b) => b.toolCalls ?? []).length
          ? noTurn.flatMap((b) => b.toolCalls ?? [])
          : undefined,
        "meta": noTurn.filter((b) => b.kind === "meta").map((b) => b.text).join("\\n\\n").trim() || null,
        "messages": noTurn.map((b, i) => ({
          "@type": "Message",
          "position": i + 1,
          "role": "assistant",
          "kind": b.kind,
          "text": b.text,
          ...(b.toolCalls?.length ? { "toolCalls": b.toolCalls } : {}),
          "dateCreated": new Date(b.at).toISOString(),
        })),
      });
    }

    // Training pairs in OpenAI chat format (only where a user prompt exists).
    const trainingPairs = turns
      .filter((t) => t.userPrompt)
      .map((t) => ({
        "turn": t.turn,
        "messages": [
          { "role": "user", "content": t.userPrompt },
          ...(t.thinking ? [{ "role": "assistant", "content": `<think>\\n${t.thinking}\\n</think>` }] : []),
          ...(t.assistantAnswer ? [{ "role": "assistant", "content": t.assistantAnswer }] : []),
        ],
        ...(t.toolCalls?.length ? { "toolCalls": t.toolCalls } : {}),
      }));

    const dataset = {
      "@context": "https://schema.org",
      "@type": "Dataset",
      "name": `${name} — transcript`,
      "description": "Session transcript exported as a conversation dataset for AI training. Blocks are grouped by turn; each turn carries userPrompt (when available), assistantAnswer, thinking, tools and meta. Includes trainingPairs in OpenAI chat format.",
      "identifier": s.sessionId,
      "session": {
        "sessionId": s.sessionId,
        "topicTitle": s.topicTitle ?? null,
        "directory": s.directory ?? null,
        "model": s.model
          ? { "providerID": s.model.providerID, "id": s.model.id, "variant": s.model.variant ?? null }
          : null,
        "contextWindow": s.contextWindow ?? null,
        "lastContextTokens": s.lastContextTokens ?? null,
        "currentToolCalls": s.toolCallDetails.length
          ? s.toolCallDetails.map((d) => ({ name: d.name, input: d.input ?? null, output: d.output ?? null, status: d.status ?? null }))
          : null,
      },
      "creator": { "@type": "SoftwareApplication", "name": "opencodegram" },
      "dateCreated": new Date().toISOString(),
      "keywords": ["conversation", "ai-training", "opencode", "transcript", "tool-calls", "reasoning"],
      "license": "https://creativecommons.org/licenses/by/4.0/",
      "variableMeasured": ["text", "kind", "turn", "userPrompt", "assistantAnswer", "thinking", "tools"],
      "stats": {
        "blocks": blocks.length,
        "turns": turnKeys.length,
        "trainingPairs": trainingPairs.length,
      },
      "distribution": {
        "@type": "DataDownload",
        "encodingFormat": "application/ld+json",
        "contentUrl": `dataset-${s.sessionId.slice(0, 8)}.jsonld`,
      },
      "conversation": turns,
      "trainingPairs": trainingPairs,
      ...(store?.getTodos?.(s.sessionId)?.length ? { "todos": store.getTodos(s.sessionId) } : {}),
    };
    return JSON.stringify(dataset, null, 2);
  };

  /** Render the transcript as JSONL (one JSON object per turn, OpenAI chat format). */
  const exportTranscriptJsonl = (s: ChatSession, userPrompts: string[] = []): string => {
    const blocks = blocksOf(s);
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
    const lastPrompt = store?.lastPromptBySession?.get?.(s.sessionId);
    const lines: string[] = [];
    turnKeys.forEach((t, idx) => {
      const msgs = byTurn.get(t) ?? [];
      const answerBlocks = msgs.filter((b) => b.kind === "answer");
      const thinkingBlocks = msgs.filter((b) => b.kind === "thinking");
      const toolsBlocks = msgs.filter((b) => b.kind === "tools");
      const assistantText = answerBlocks.map((b) => b.text).join("\n\n").trim();
      const thinkingText = thinkingBlocks.map((b) => b.text).join("\n\n").trim();
      const toolCalls = toolsBlocks.flatMap((b) => b.toolCalls ?? []);
      const userPrompt = userPrompts[idx] ?? store?.getTurnPrompt?.(s.sessionId, t) ?? (idx === turnKeys.length - 1 ? lastPrompt : undefined);
      const messages: Array<{ role: string; content: string }> = [];
      if (userPrompt && userPrompt.trim()) messages.push({ role: "user", content: userPrompt.trim() });
      if (thinkingText) messages.push({ role: "assistant", content: `<think>\n${thinkingText}\n</think>` });
      if (assistantText) messages.push({ role: "assistant", content: assistantText });
      const entry: Record<string, unknown> = { messages };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      if (idx === 0 && store?.getTodos?.(s.sessionId)?.length) entry.todos = store.getTodos(s.sessionId);
      if (entry.messages && (entry.messages as unknown[]).length) lines.push(JSON.stringify(entry));
    });
    if (noTurn.length) {
      const answerText = noTurn.filter((b) => b.kind === "answer").map((b) => b.text).join("\n\n").trim();
      const thinkingText = noTurn.filter((b) => b.kind === "thinking").map((b) => b.text).join("\n\n").trim();
      const toolCalls = noTurn.flatMap((b) => b.toolCalls ?? []);
      const messages: Array<{ role: string; content: string }> = [];
      if (thinkingText) messages.push({ role: "assistant", content: `<think>\n${thinkingText}\n</think>` });
      if (answerText) messages.push({ role: "assistant", content: answerText });
      if (messages.length) {
        const entry: Record<string, unknown> = { messages };
        if (toolCalls.length) entry.tool_calls = toolCalls;
        lines.push(JSON.stringify(entry));
      }
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  };

  /** Total number of pages currently available. */
  const pageCount = (s: ChatSession): number => paginateTranscript(blocksOf(s)).length;

  /** Strip resources and buttons from a card that is no longer the active one. */
  const cleanupCard = async (chatId: number, messageId: number): Promise<void> => {
    const key = cardKey(chatId, messageId);
    const clean = cardCleanHtml.get(key);
    if (clean) {
      await tg.editRichMessage(chatId, messageId, clean).catch(() => {});
      cardCleanHtml.delete(key);
    }
    await tg.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
  };

  return { addBlock, publish, goToPage, renderPage, cardKeyboard, compactCardKeyboard, pagePickerKeyboard, turnSummary, exportTranscriptHtml, exportTranscriptMarkdown, exportTranscriptJsonLd, exportTranscriptJsonl, pageCount, blocksOf, refloat, cleanupCard };
}

export { esc, TRANSCRIPT_MAX_BLOCKS };
