import type { ChatSession } from "./types.js";
import type { TelegramClient } from "./telegram.js";
import { clampText, esc } from "./util.js";

export type StatusDeps = {
  tg: TelegramClient;
  threadOptsFor: (s: ChatSession | undefined) => Record<string, unknown>;
};

export type StatusManager = ReturnType<typeof createStatusManager>;

function renderTools(details: ChatSession["toolCallDetails"], limit: number): string {
  return details
    .map((d) => {
      const input = d.input ? "Input: " + esc(d.input.slice(0, limit)) : "";
      const output = d.output ? "Output: " + esc(d.output.slice(0, limit)) : "";
      const status = d.status === "success" ? "✅" : d.status === "failed" ? "❌" : "⏳";
      return status + " " + esc(d.name) + (input ? "\n" + input : "") + (output ? "\n" + output : "");
    })
    .join("\n\n");
}

/**
 * Owns the lifecycle of the single "status" card that accompanies a turn:
 * Working… (thinking, tools, partial text) → Done / Stopped, no Stop button.
 */
export function createStatusManager({ tg, threadOptsFor }: StatusDeps) {
  const flushDraft = async (chatId: number, s: ChatSession | undefined) => {
    if (!s) return;
    s.timer = undefined;
    // Drafts are only available in private chats.
    if (chatId < 0) return;
    try {
      await tg.sendRichMessageDraftMarkdown(chatId, s.draftId, s.buffer || "…", { can_stop: true, ...threadOptsFor(s) });
    } catch (err) {
      console.error("[draft]", err);
    }
  };

  const startStatus = async (chatId: number, s: ChatSession) => {
    const opts = threadOptsFor(s);
    s.statusFinished = false;
    s.statusEditPromise = undefined;
    s.statusEditing = false;
    // A new user prompt starts a new turn: clear the previous turn's artifacts.
    s.buffer = "";
    s.reasoningBuffer = "";
    s.toolCalls = [];
    s.toolCallDetails = [];
    s.stopped = false;
    try {
      const sent = await tg.sendRichMessage(chatId, "⏳ <b>Working…</b>\n<i>Waiting for OpenCode</i>", {
        ...opts,
        reply_markup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: "panel:stop" }]] },
      });
      s.statusMessageId = sent.message_id;
      s.statusLastUpdate = Date.now();
    } catch (err) {
      console.error("[status]", err);
    }
  };

  const updateStatus = async (chatId: number, s: ChatSession, force = false) => {
    if (!s.statusMessageId || s.statusFinished) return;
    if (s.statusEditing) return;
    const now = Date.now();
    if (!force && s.statusLastUpdate && now - s.statusLastUpdate < 4000) return;
    s.statusEditing = true;
    s.statusLastUpdate = now;
    const opts = threadOptsFor(s);
    const lines: string[] = ["⏳ <b>Working…</b>"];
    if (s.reasoningBuffer.trim()) {
      const r = s.reasoningBuffer.trim().slice(0, 300);
      lines.push("<details open><summary>🧠 Thinking</summary>\n<pre>" + esc(r) + "</pre>\n</details>");
    }
    if (s.toolCallDetails.length) {
      const details = renderTools(s.toolCallDetails.slice(-5), 200);
      lines.push("<details><summary>🔧 Tool calls (" + s.toolCallDetails.length + ")</summary>\n<pre><code>" + esc(details) + "</code></pre>\n</details>");
    } else if (s.toolCalls.length) {
      lines.push("🔧 " + esc(s.toolCalls.slice(-5).join(", ")));
    }
    if (s.buffer.trim()) {
      lines.push("<pre>" + esc(s.buffer.trim().slice(0, 300)) + "</pre>");
    }
    try {
      const edit = tg.editRichMessage(chatId, s.statusMessageId, lines.join("\n"), {
        ...opts,
        reply_markup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: "panel:stop" }]] },
      });
      s.statusEditPromise = edit.then(
        () => undefined,
        () => undefined,
      );
      await edit;
    } catch (err) {
      console.error("[status]", err);
    } finally {
      s.statusEditing = false;
      s.statusEditPromise = undefined;
    }
  };

  /** Freeze the status card. Stop disappears; thinking/tools stay collapsible. */
  const finishStatus = async (chatId: number, s: ChatSession) => {
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    s.statusFinished = true;
    if (s.statusEditPromise) {
      await s.statusEditPromise.catch(() => {});
      s.statusEditPromise = undefined;
    }
    if (s.statusMessageId) {
      const lines: string[] = ["✅ <b>Done</b>"];
      if (!s.stopped && s.reasoningBuffer.trim()) {
        const r = s.reasoningBuffer.trim().slice(0, 3500);
        lines.push("<details open><summary>🧠 Thinking</summary>\n<pre>" + esc(r) + "</pre>\n</details>");
      }
      if (!s.stopped && s.toolCallDetails.length) {
        const details = renderTools(s.toolCallDetails, 500);
        lines.push("<details><summary>🔧 Tool calls (" + s.toolCallDetails.length + ")</summary>\n<pre><code>" + esc(details) + "</code></pre>\n</details>");
      }
      await tg
        .editRichMessage(chatId, s.statusMessageId, clampText(lines.join("\n")), {
          ...threadOptsFor(s),
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      s.statusMessageId = undefined;
    }
  };

  return { flushDraft, startStatus, updateStatus, finishStatus };
}
