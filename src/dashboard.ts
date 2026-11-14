import type { ChatSession } from "./types.js";
import type { SessionStore } from "./store.js";
import type { SettingsStore } from "./settings.js";
import type { TelegramClient } from "./telegram.js";
import { renderResourceBlock } from "./resources.js";
import { esc, sessionHeader, toolIcon, truncate } from "./util.js";

export type DashboardDeps = {
  tg: TelegramClient;
  store: SessionStore;
  settings: SettingsStore;
  threadOptsFor: (s: ChatSession | undefined) => Record<string, unknown>;
};

export type DashboardManager = ReturnType<typeof createDashboardManager>;

function toolStatsLine(s: ChatSession): string {
  const details = s.toolCallDetails ?? [];
  if (!details.length) return "🔧 <b>Tools</b>: —";
  const ok = details.filter((d) => d.status === "success").length;
  const fail = details.filter((d) => d.status === "failed").length;
  const run = details.filter((d) => d.status === "running" || !d.status).length;
  const parts = [`${details.length} total`];
  if (ok) parts.push(`✅ ${ok}`);
  if (fail) parts.push(`❌ ${fail}`);
  if (run) parts.push(`⏳ ${run}`);
  const last = details[details.length - 1];
  const lastText = last ? `\n<i>Última:</i> ${toolIcon(last.name)} ${esc(truncate(last.name, 40))}` : "";
  return `🔧 <b>Tools (turno)</b>: ${parts.join(" · ")}${lastText}`;
}

/** Turn progress: elapsed time and live token speed while working. */
function turnProgressLine(s: ChatSession): string {
  if (!s.promptStartTime) return "";
  const elapsed = Math.max(1, Math.round((Date.now() - s.promptStartTime) / 1000));
  const elapsedText = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
  const tokens = s.lastOutputTokens ?? 0;
  const speed = tokens && elapsed > 1 ? ` · ⚡ ${(tokens / elapsed).toFixed(1)} tok/s` : "";
  return `⏳ <b>Progreso</b>: ${elapsedText}${speed}`;
}

export function createDashboardManager({ tg, store, settings, threadOptsFor }: DashboardDeps) {
  function render(s: ChatSession, chatId: number, opts?: { working?: boolean }): { html: string; keyboard: any[][] } {
    const st = settings.get(chatId);
    const header = sessionHeader(s).trimEnd();
    const model = s.model
      ? `<code>${esc(s.model.providerID)}/${esc(s.model.id)}${s.model.variant ? ` (${esc(s.model.variant)})` : ""}</code>`
      : "<i>sin modelo</i>";
    const dir = s.directory ? `\n📁 <code>${esc(truncate(s.directory, 80))}</code>` : "";
    const state = s.detached
      ? "🔀 <i>En segundo plano</i>"
      : opts?.working
        ? "⏳ <i>Trabajando…</i>"
        : "✅ <i>Lista</i>";
    const lines: string[] = [
      "📌 <h3>Dashboard de sesión</h3>",
      header,
      `<p>🧠 <b>Modelo</b>: ${model}${dir}</p>`,
      state,
      "",
      toolStatsLine(s),
    ];
    if (opts?.working) {
      const progress = turnProgressLine(s);
      if (progress) lines.push(progress);
    }
    if (st.showResourceUsage) {
      lines.push("", renderResourceBlock(s));
    }
    const html = lines.join("\n").replace(/\n{3,}/g, "\n\n");

    const keyboard: any[][] = [];
    if (opts?.working) keyboard.push([{ text: "⏹ Stop", callback_data: "panel:stop" }]);
    keyboard.push([
      { text: "🧠 Modelos", callback_data: `panel:ms:${s.sessionId}` },
      { text: "⚙️ Settings", callback_data: "panel:settings" },
    ]);
    keyboard.push([
      { text: "📂 Sesiones", callback_data: "panel:sessions" },
      { text: "🏠 Panel", callback_data: "panel:home" },
    ]);
    return { html, keyboard };
  }

  async function ensure(chatId: number, threadId: number | undefined, s: ChatSession, opts?: { working?: boolean }): Promise<void> {
    const st = settings.get(chatId);
    if (st.displayMode !== "unified") return;
    const existing = store.getDashboard(chatId, threadId);
    const rendered = render(s, chatId, opts);
    const tgOpts = { ...threadOptsFor(s), reply_markup: { inline_keyboard: rendered.keyboard } };

    // Reuse if it's already the dashboard for this session.
    if (existing && existing.sessionId === s.sessionId) {
      const ok = await tg
        .editRichMessage(chatId, existing.messageId, rendered.html, tgOpts)
        .then(() => true)
        .catch(() => false);
      if (ok) return;
      // Message gone: fall through to recreate.
    }

    // Replacing another session's dashboard: unpin the old one best-effort.
    if (existing && existing.sessionId !== s.sessionId) {
      await tg.unpinChatMessage(chatId, { message_id: existing.messageId }).catch(() => {});
    }

    // Different session (or missing): create a fresh dashboard message.
    const sent = await tg
      .sendRichMessage(chatId, rendered.html, tgOpts)
      .catch((err) => {
        console.error("[dashboard] send failed", err);
        return undefined;
      });
    if (!sent?.message_id) return;
    store.setDashboard(chatId, threadId, s.sessionId, sent.message_id);
    // Replying to the pinned dashboard must route to its session too.
    store.rememberMessageSession(chatId, sent.message_id, s.sessionId);
    // Best-effort pin.
    await tg.pinChatMessage(chatId, sent.message_id).catch(() => {});
  }

  async function update(chatId: number, threadId: number | undefined, s: ChatSession, opts?: { working?: boolean }): Promise<void> {
    const st = settings.get(chatId);
    if (st.displayMode !== "unified") return;
    const existing = store.getDashboard(chatId, threadId);
    if (!existing || existing.sessionId !== s.sessionId) return;
    const rendered = render(s, chatId, opts);
    await tg
      .editRichMessage(chatId, existing.messageId, rendered.html, {
        ...threadOptsFor(s),
        reply_markup: { inline_keyboard: rendered.keyboard },
      })
      .catch(() => {});
  }

  return { render, ensure, update };
}