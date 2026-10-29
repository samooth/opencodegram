import type { ChatSession } from "./types.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSettings } from "./settings.js";
import { isEditTool, extractEditFile, formatEditDiff } from "./editutil.js";
import { clampText, esc } from "./util.js";

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function parseShellCommand(input: string): string | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed.command === "string") return parsed.command;
  } catch {
    // Not JSON or not a shell command.
  }
  return null;
}

function parseShellOutput(output: string): string | null {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      const texts = parsed
        .map((item: { text?: unknown }) => (typeof item?.text === "string" ? item.text : ""))
        .filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    if (parsed && typeof parsed.text === "string") return parsed.text;
  } catch {
    // Not JSON or not a tool result envelope.
  }
  return null;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export type StatusDeps = {
  tg: TelegramClient;
  threadOptsFor: (s: ChatSession | undefined) => Record<string, unknown>;
  getSettings: (chatId: number) => ChatSettings;
  pendingEdits: Map<number, ChatSession>;
};

export type StatusManager = ReturnType<typeof createStatusManager>;

function renderTools(details: ChatSession["toolCallDetails"], limit: number): string {
  return details
    .map((d) => {
      const status = d.status === "success" ? "✅" : d.status === "failed" ? "❌" : "⏳";
      const lines = [status + " " + d.name];
      if (d.input) {
        const command = parseShellCommand(d.input);
        lines.push(command ? "$ " + command : prettyJson(d.input));
      }
      if (d.output) {
        const output = parseShellOutput(d.output) ?? d.output;
        lines.push(truncateText(output, limit));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function isShellTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "shell" || normalized === "bash" || normalized === "sh" || normalized.includes("shell");
}

function renderShell(details: ChatSession["toolCallDetails"], limit: number): string {
  return details
    .map((d) => {
      const command = parseShellCommand(d.input ?? "") ?? d.input?.trim() ?? d.name;
      const output = (parseShellOutput(d.output ?? "") ?? d.output ?? "").trim();
      const lines = ["$ " + command];
      if (output) lines.push(truncateText(output, limit));
      if (d.status === "failed") lines.push("(failed)");
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Owns the lifecycle of the single "status" card that accompanies a turn:
 * Working… (thinking, tools, partial text) → Done / Stopped, no Stop button.
 */
export function createStatusManager({ tg, threadOptsFor, getSettings, pendingEdits }: StatusDeps) {
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
    const settings = getSettings(chatId);
    s.statusFinished = false;
    s.statusEditPromise = undefined;
    s.statusEditing = false;
    s.buffer = "";
    s.reasoningBuffer = "";
    s.toolCalls = [];
    s.toolCallDetails = [];
    s.stopped = false;
    try {
      const lines: string[] = [];
      if (settings.showThinking && s.cotBuffer?.trim()) {
        const cot = s.cotBuffer.trim().slice(-1500);
        lines.push(`<details><summary>🧾 COT (${s.cotCount ?? 0})</summary>\n<pre>${esc(cot)}</pre>\n</details>`);
      }
      lines.push("⏳ <b>Working…</b>\n<i>Waiting for OpenCode</i>");
      const sent = await tg.sendRichMessage(chatId, clampText(lines.join("\n")), {
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
    const opts = threadOptsFor(s);
    const settings = getSettings(chatId);
    const now = Date.now();
    if (!force && s.statusLastUpdate && now - s.statusLastUpdate < 4000) return;
    s.statusEditing = true;
    s.statusLastUpdate = now;
    const lines: string[] = [];
    if (settings.showThinking && s.cotBuffer?.trim()) {
      const cot = s.cotBuffer.trim().slice(-1500);
      lines.push(`<details><summary>🧾 COT (${s.cotCount ?? 0})</summary>\n<pre>${esc(cot)}</pre>\n</details>`);
    }
    const elapsed = s.promptStartTime ? Math.max(1, Math.round((Date.now() - s.promptStartTime) / 1000)) : 0;
    lines.push("⏳ <b>Working…</b>" + (elapsed ? ` <i>(${elapsed}s)</i>` : ""));
    if (settings.showThinking && s.reasoningBuffer.trim()) {
      const r = s.reasoningBuffer.trim().slice(0, 300);
      lines.push(`<details${settings.thinkingExpanded ? " open" : ""}><summary>🧠 Thinking</summary>\n<pre>` + esc(r) + "</pre>\n</details>");
    }
    const shellDetails = s.toolCallDetails.filter((detail) => isShellTool(detail.name));
    const otherDetails = s.toolCallDetails.filter((detail) => !isShellTool(detail.name));
    if (settings.showTools && shellDetails.length) {
      const shellText = renderShell(shellDetails.slice(-5), 200);
      lines.push(`<details${settings.toolsExpanded ? " open" : ""}><summary>🖥 Shell (` + shellDetails.length + ")</summary>\n<pre>" + esc(shellText) + "</pre>\n</details>");
    }
    if (settings.showTools && otherDetails.length) {
      const details = renderTools(otherDetails.slice(-5), 200);
      lines.push(`<details${settings.toolsExpanded ? " open" : ""}><summary>🔧 Tool calls (` + otherDetails.length + ")</summary>\n<pre><code>" + esc(details) + "</code></pre>\n</details>");
    } else if (settings.showTools && !shellDetails.length && s.toolCalls.length) {
      lines.push("🔧 " + esc(s.toolCalls.slice(-5).join(", ")));
    }
    if (settings.showPartialText && s.buffer.trim()) {
      lines.push("<pre>" + esc(s.buffer.trim().slice(0, 300)) + "</pre>");
    }
    try {
      const edit = tg.editRichMessage(chatId, s.statusMessageId, clampText(lines.join("\n")), {
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
      const settings = getSettings(chatId);
      const previousCot = s.cotBuffer?.trim() ?? "";
      const lines: string[] = [];
      if (settings.showThinking && previousCot) {
        const cot = previousCot.slice(-3500);
        lines.push(`<details><summary>🧾 COT (${s.cotCount ?? 0})</summary>\n<pre>${esc(cot)}</pre>\n</details>`);
      }
      lines.push("✅ <b>Done</b>");
      if (!settings.compactFinal) {
        if (settings.showThinking && !s.stopped && s.reasoningBuffer.trim()) {
          const r = s.reasoningBuffer.trim().slice(0, 3500);
          lines.push(`<details${settings.thinkingExpanded ? " open" : ""}><summary>🧠 Thinking</summary>\n<pre>` + esc(r) + "</pre>\n</details>");
        }
        const shellDetails = s.toolCallDetails.filter((detail) => isShellTool(detail.name));
        const otherDetails = s.toolCallDetails.filter((detail) => !isShellTool(detail.name));
        if (settings.showTools && shellDetails.length) {
          const shellText = renderShell(shellDetails, 500);
          lines.push(`<details${settings.toolsExpanded ? " open" : ""}><summary>🖥 Shell (` + shellDetails.length + ")</summary>\n<pre>" + esc(shellText) + "</pre>\n</details>");
        }
        if (settings.showTools && otherDetails.length) {
          const details = renderTools(otherDetails, 500);
          lines.push(`<details${settings.toolsExpanded ? " open" : ""}><summary>🔧 Tool calls (` + otherDetails.length + ")</summary>\n<pre><code>" + esc(details) + "</code></pre>\n</details>");
        }
      }
      const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name));
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      if (editDetails.length) {
        editDetails.forEach((detail, index) => {
          const file = extractEditFile(detail.input) ?? `edit ${index + 1}`;
          keyboard.push([{ text: `✏️ ${file}`.slice(0, 64), callback_data: `edit:${index}` }]);
        });
      }
      if (s.statusMessageId !== undefined && keyboard.length) {
        pendingEdits.set(s.statusMessageId, s);
      }
      await tg
        .editRichMessage(chatId, s.statusMessageId, clampText(lines.join("\n")), {
          ...threadOptsFor(s),
          reply_markup: { inline_keyboard: keyboard },
        })
        .catch(() => {});
      if (!s.stopped && s.reasoningBuffer.trim()) {
        const chunk = s.reasoningBuffer.trim();
        const prev = s.cotBuffer?.trim() ? s.cotBuffer.trim() + "\n\n---\n\n" : "";
        let next = prev + chunk;
        if (next.length > 4000) next = next.slice(next.length - 4000);
        s.cotBuffer = next;
        s.cotCount = (s.cotCount ?? 0) + 1;
        s.reasoningBuffer = "";
      }
      s.statusMessageId = undefined;
    }
  };

  return { flushDraft, startStatus, updateStatus, finishStatus };
}
