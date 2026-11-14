import type { ChatSession } from "./types.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSettings } from "./settings.js";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isEditTool, extractEditFile, formatEditDiff, editStats } from "./editutil.js";
import { formatBytes } from "./files/index.js";
import { clampText, esc, markdownToHtml, sessionHeader, stripRestatedPrompt, threadOpts, toolIcon, truncate } from "./util.js";
import { throttleGap } from "./ratethrottle.js";
import { STATUS_BACKGROUND_GAP_MS, STATUS_MIN_UPDATE_GAP_MS } from "./constants.js";
import type { DashboardManager } from "./dashboard.js";
import type { TranscriptManager } from "./transcriptmanager.js";
import { renderResourceBlock } from "./resources.js";

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function parseShellCommand(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Plain command (not JSON).
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.command === "string") return parsed.command;
    if (parsed && typeof parsed.cmd === "string") return parsed.cmd;
    if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === "string") return parsed.join(" ");
  } catch {
    // Not JSON or not a shell command.
  }
  return null;
}

function parseToolOutput(output: string): string {
  const trimmed = (output || "").trim();
  if (!trimmed) return "";
  // Try full JSON parse (MCP-style [{type:"text",text:"..."}] or {text/content})
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const texts = parsed
        .map((item: unknown) => {
          if (!item || typeof item !== "object") return typeof item === "string" ? item : "";
          const obj = item as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content === "string") return obj.content;
          if (Array.isArray(obj.content)) {
            return (obj.content as Array<Record<string, unknown>>)
              .map((c) => (typeof c?.text === "string" ? c.text : ""))
              .filter(Boolean)
              .join("\n");
          }
          return "";
        })
        .filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.content === "string") return obj.content;
      if (typeof obj.output === "string") return obj.output;
    }
  } catch {
    // Extract text fields from truncated/partial JSON.
  }
  const matches = [...trimmed.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g)];
  if (matches.length) {
    return matches
      .map((match) => {
        try {
          return JSON.parse(`"${match[1]}"`) as string;
        } catch {
          return match[1];
        }
      })
      .join("\n");
  }
  return trimmed;
}

function parseShellOutput(output: string): string | null {
  const text = parseToolOutput(output);
  return text || null;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function parseToolInput(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type ToolSummary = { arg: string; detail?: string };

function getToolSummary(name: string, input: string | undefined): ToolSummary {
  const lower = (name || "").toLowerCase();
  const p = parseToolInput(input);
  const pick = (...keys: string[]) => {
    if (!p) return "";
    for (const k of keys) {
      const v = p[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  if (lower.includes("read")) return { arg: pick("path", "file", "filePath", "target", "file_path") };
  if (lower.includes("webfetch") || lower.includes("fetch") || lower.includes("web_search") || lower.includes("websearch")) {
    return { arg: pick("url", "uri", "query", "q") };
  }
  if (lower.includes("edit") || lower.includes("write") || lower.includes("patch")) {
    return { arg: pick("filePath", "path", "file", "target", "file_path") };
  }
  if (lower.includes("grep")) {
    const pattern = pick("pattern", "query", "regex");
    const path = pick("path", "include", "glob");
    return { arg: pattern, detail: path };
  }
  if (lower.includes("glob")) return { arg: pick("pattern", "path", "glob") };
  if (lower.includes("ls") || lower.includes("list")) return { arg: pick("path", "directory", "dir") };
  if (lower.includes("bash") || lower.includes("shell")) return { arg: pick("command", "cmd") };
  if (lower.includes("skill")) return { arg: pick("skill", "name", "id") };
  if (lower.includes("task") || lower.includes("agent")) return { arg: pick("description", "prompt", "subagent_type") };
  // Generic fallback: first short string value
  if (p) {
    for (const v of Object.values(p)) {
      if (typeof v === "string" && v.trim() && v.length < 200) return { arg: v.trim() };
    }
  }
  if (input && !input.trim().startsWith("{")) return { arg: input.trim() };
  return { arg: "" };
}

function shortToolArg(arg: string, max = 90): string {
  if (!arg) return "";
  // For paths, prefer showing a meaningful tail if very long
  if (arg.length > max && (arg.includes("/") || arg.includes("\\"))) {
    const parts = arg.split(/[/\\]/).filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return "…/" + truncate(tail, max - 2);
  }
  return truncate(arg, max);
}

function firstMeaningfulLine(text: string, max = 140): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Skip noisy preamble from read tool responses
    if (/^\[?\{"type"\s*:\s*"text"/.test(line)) continue;
    return truncate(line, max);
  }
  return "";
}

export type StatusDeps = {
  tg: TelegramClient;
  threadOptsFor: (s: ChatSession | undefined) => Record<string, unknown>;
  getSettings: (chatId: number) => ChatSettings;
  pendingEdits: Map<number, ChatSession>;
  rememberCot: (sessionId: string, buffer: string, count: number) => void;
  rememberStatusMessage: (sessionId: string, chatId: number, threadId: number | undefined, messageId: number) => void;
  forgetStatusMessage: (sessionId: string) => void;
  store?: SessionStore;
  /** Session card: one paginated message per session. */
  transcript?: TranscriptManager;
  /** Pinned dashboard (M1) in unified mode. */
  dashboard?: DashboardManager;
};

export type StatusManager = ReturnType<typeof createStatusManager>;

function renderTools(details: ChatSession["toolCallDetails"], _limit: number, showToolInput = true): string {
  // Collapse consecutive calls only when name + key arg are identical.
  const compact: Array<{ d: ChatSession["toolCallDetails"][number]; count: number; summary: ToolSummary }> = [];
  for (const d of details) {
    const summary = getToolSummary(d.name, d.input);
    const last = compact[compact.length - 1];
    if (last && last.d.name === d.name && last.summary.arg === summary.arg && last.summary.detail === summary.detail) {
      last.count += 1;
      last.d = d; // keep latest status/output
    } else {
      compact.push({ d, count: 1, summary });
    }
  }
  return compact
    .map(({ d, count, summary }) => {
      const failed = d.status === "failed";
      const status = d.status === "success" ? "✅" : failed ? "❌" : "⏳";
      const icon = toolIcon(d.name);
      const countSuffix = count > 1 ? ` <i>×${count}</i>` : "";
      const arg = summary.arg ? ` <code>${esc(shortToolArg(summary.arg))}</code>` : "";
      const detail = summary.detail ? ` <i>${esc(truncate(summary.detail, 40))}</i>` : "";
      const head = `${status} ${icon} <b>${esc(d.name)}</b>${arg}${detail}${countSuffix}`;
      if (!showToolInput && !failed) return head;

      const output = d.output ? parseToolOutput(d.output) : "";
      if (failed && output) {
        return `${head}\n   <i>${esc(firstMeaningfulLine(output, 160))}</i>`;
      }
      // For read/webfetch success, a short status line is enough; avoid dumping content.
      const lower = (d.name || "").toLowerCase();
      if (!failed && (lower.includes("read") || lower.includes("webfetch") || lower.includes("fetch"))) {
        const brief = firstMeaningfulLine(output, 100);
        if (brief && !/^Read file\b/i.test(brief)) return `${head}\n   <i>${esc(brief)}</i>`;
        return head;
      }
      if (!failed && (lower.includes("grep") || lower.includes("glob"))) {
        // Show a compact result hint (e.g. number of matches / first line)
        const brief = firstMeaningfulLine(output, 120);
        if (brief) return `${head}\n   <i>${esc(brief)}</i>`;
        return head;
      }
      if (output) {
        const brief = firstMeaningfulLine(output, 140);
        if (brief) return `${head}\n   <i>${esc(brief)}</i>`;
      }
      if (!summary.arg && d.input) {
        // Last resort: compact key=value hint instead of raw JSON dump
        const p = parseToolInput(d.input);
        if (p) {
          const hint = Object.entries(p)
            .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
            .slice(0, 2)
            .map(([k, v]) => `${k}=${truncate(String(v), 40)}`)
            .join(" ");
          if (hint) return `${head}\n   <i>${esc(hint)}</i>`;
        }
      }
      return head;
    })
    .join("\n");
}

function isShellTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "shell" || normalized === "bash" || normalized === "sh" || normalized.includes("shell");
}

function renderShell(details: ChatSession["toolCallDetails"], limit: number): string {
  // Collapse consecutive identical commands.
  const compact: Array<{ d: ChatSession["toolCallDetails"][number]; count: number }> = [];
  for (const d of details) {
    const cmd = parseShellCommand(d.input ?? "") ?? d.input?.trim() ?? d.name;
    const last = compact[compact.length - 1];
    const lastCmd = last ? (parseShellCommand(last.d.input ?? "") ?? last.d.input?.trim() ?? last.d.name) : "";
    if (last && lastCmd === cmd) {
      last.count += 1;
      last.d = d;
    } else {
      compact.push({ d, count: 1 });
    }
  }
  return compact
    .map(({ d, count }) => {
      const command = parseShellCommand(d.input ?? "") ?? d.input?.trim() ?? d.name;
      const output = (parseShellOutput(d.output ?? "") ?? d.output ?? "").trim();
      const lines = ["$ " + command + (count > 1 ? `  (×${count})` : "")];
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
/** Clamp a diff to at most `max` lines, appending a "... +N more" hint. */
function capDiff(diff: string, max: number): string {
  const lines = diff.split("\n");
  if (lines.length <= max) return diff;
  return lines.slice(0, max).join("\n") + `\n… (+${lines.length - max} more lines)`;
}

export function createStatusManager({ tg, threadOptsFor, getSettings, pendingEdits, rememberCot, rememberStatusMessage, forgetStatusMessage, store, transcript, dashboard }: StatusDeps) {
  const resolveSessionName = (s: ChatSession): string => {
    let name = (s.topicTitle || "").trim();
    if (!name && store) name = (store.topicTitleBySession.get(s.sessionId) || "").trim();
    if (!name && store) {
      const prompt = store.lastPromptBySession.get(s.sessionId);
      if (prompt) name = prompt.trim().slice(0, 40);
    }
    if (!name && s.directory) name = s.directory.split("/").filter(Boolean).pop() || "";
    if (!name) name = s.sessionId.slice(0, 12);
    return name;
  };
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

  const renderThinkingBottom = (s: ChatSession, settings: ChatSettings): string => {
    if (!settings.showThinking || !settings.showLatestThought || !s.reasoningBuffer.trim() || s.stopped) return "";
    const tail = s.reasoningBuffer.trim().slice(-1600);
    return `💭 <b>Pensando…</b>\n<blockquote expandable><mark>${markdownToHtml(tail)}</mark></blockquote>`;
  };

  const renderLatestToolBottom = (s: ChatSession, settings: ChatSettings): string => {
    if (!settings.showTools || !settings.showLatestTool || !s.toolCallDetails.length) return "";
    const lastTool = s.toolCallDetails[s.toolCallDetails.length - 1];
    const statusEmoji = lastTool.status === "success" ? "✅" : lastTool.status === "failed" ? "❌" : "⏳";
    const shell = isShellTool(lastTool.name);
    const summary = getToolSummary(lastTool.name, lastTool.input);
    let displayName = shell ? "Shell" : (lastTool.name || "Herramienta");
    if (shell || /^bash$/i.test(lastTool.name)) displayName = "Shell";

    let commandText = "";
    if (shell) {
      commandText = parseShellCommand(lastTool.input ?? "") ?? (lastTool.input ?? "").trim() ?? lastTool.name;
    } else {
      commandText = (summary?.arg ?? (lastTool.input ?? "").trim() ?? lastTool.name).toString();
    }
    commandText = commandText.trim();
    if (commandText.length > 1200) commandText = `${commandText.slice(0, 1200)}\n…`;

    const header = `${statusEmoji} <b>Última herramienta:</b> ${esc(displayName)}`;
    if (!commandText) return header;
    return `${header}\n<pre><code>${esc(commandText)}</code></pre>`;
  };

  /**
   * Live strip for the session card. Latest tool and thought are shown at the
   * bottom of the message (above resource indicators) for readability.
   */
  const renderLiveParts = (s: ChatSession, settings: ChatSettings, unified: boolean): { top: string; bottom: string } => {
    const lines: string[] = [];
    const elapsed = s.promptStartTime ? Math.max(1, Math.round((Date.now() - s.promptStartTime) / 1000)) : 0;
    lines.push(
      s.stopped
        ? "<h4>⏹ Stopped</h4>"
        : `<h4>⏳ Working…${elapsed ? ` <i>(${elapsed}s)</i>` : ""}</h4>`,
    );
    if (s.detached && !s.stopped) {
      lines.push("<i>🔀 En segundo plano: otra sesión ocupa la pestaña, esta sigue actualizando.</i>");
    }
    // Show the prompt being processed so the fresh card confirms what was sent.
    const prompt = store?.lastPromptBySession.get(s.sessionId);
    if (prompt?.trim()) {
      lines.push(`<i>📝 ${esc(clampText(prompt.trim(), 160))}</i>`);
    }
    // Turn progress: tools executed this turn (with failures) and live token
    // speed when usage has arrived. Elapsed time is already in the header.
    const tools = s.toolCallDetails.length;
    const failedTools = s.toolCallDetails.filter((detail) => detail.status === "failed").length;
    const tokens = s.lastOutputTokens ?? 0;
    const progressParts: string[] = [];
    if (tools) progressParts.push(`🔧 ${tools}${failedTools ? ` (${failedTools} ✗)` : ""}`);
    if (tokens && elapsed > 1 && settings.showTokenSpeed) {
      progressParts.push(`⚡ ${(tokens / elapsed).toFixed(1)} tok/s · ${tokens.toLocaleString()} tok`);
    }
    if (progressParts.length) lines.push(`<i>${esc(progressParts.join(" · "))}</i>`);
    if (settings.showPartialText && s.buffer.trim()) {
      const tail = s.buffer.trim().slice(-(unified ? 600 : 400));
      lines.push(`<pre>${esc(tail)}</pre>`);
    }
    if (!unified && settings.showCot && s.cotBuffer?.trim()) {
      lines.push(`<blockquote expandable>🧾 COT (${s.cotCount ?? 0})
${esc(s.cotBuffer.trim().slice(-800))}</blockquote>`);
    }
    const bottomParts = [renderThinkingBottom(s, settings), renderLatestToolBottom(s, settings)].filter(Boolean);
    return {
      top: lines.join("\n\n"),
      bottom: bottomParts.join("\n\n"),
    };
  };

  const renderLiveStrip = (s: ChatSession, settings: ChatSettings): string => renderLiveParts(s, settings, false).top;

  /** Summary shown once the turn is over. */
  const renderDoneStrip = (s: ChatSession, settings: ChatSettings): string => {
    const lines: string[] = ["✅ <b>Done</b>"];
    if (s.detached) lines.push("<i>🔀 Esta sesión quedó en segundo plano.</i>");
    if (settings.showTools && s.toolCallDetails.length) {
      const shell = s.toolCallDetails.filter((d) => isShellTool(d.name)).length;
      const other = s.toolCallDetails.length - shell;
      const parts: string[] = [];
      if (shell) parts.push(`${shell} shell`);
      if (other) parts.push(`${other} tools`);
      lines.push(`<i>🔧 ${parts.join(" · ")}</i>`);
    }
    return lines.join("\n");
  };

  /**
   * Publish the session card (M2). In unified mode the card carries the live
   * content without resource indicators (those live in M1) and streams the
   * latest thought at the bottom for readability.
   */
  const publishCard = async (chatId: number, s: ChatSession): Promise<void> => {
    // Linear mode (private chats): no transcript card.
    if (chatId >= 0) return;
    if (!transcript) return;
    const settings = getSettings(chatId);
    const unified = settings.displayMode === "unified";
    if (s.statusFinished) {
      await transcript.publish(chatId, s, {
        extraTop: renderDoneStrip(s, settings),
        working: false,
        showResources: !unified,
        unified,
      });
    } else {
      const parts = renderLiveParts(s, settings, unified);
      await transcript.publish(chatId, s, {
        extraTop: parts.top,
        extraBottom: parts.bottom,
        working: true,
        showResources: !unified,
        unified,
      });
    }
    if (unified && dashboard) {
      const now = Date.now();
      if (!s.dashboardLastUpdate || now - s.dashboardLastUpdate > 6000) {
        s.dashboardLastUpdate = now;
        await dashboard.update(chatId, s.targetThreadId ?? s.threadId, s, { working: !s.statusFinished }).catch(() => {});
      }
    }
  };

  const startStatus = async (chatId: number, s: ChatSession) => {
    const settings = getSettings(chatId);
    const unified = settings.displayMode === "unified";
    s.statusFinished = false;
    s.statusEditPromise = undefined;
    s.statusEditing = false;
    s.buffer = "";
    s.reasoningBuffer = "";
    s.toolCalls = [];
    s.toolCallDetails = [];
    s.stopped = false;
    s.transcriptPage = undefined;
    // Clear the previous turn's final answer so the new card does not
    // carry the old response's tail (Ver completo button, etc.).
    s.lastFinalText = undefined;
    s.lastFinalMessageId = undefined;
    s.lastFinalTelegramMessageId = undefined;
    s.statusLastUpdate = Date.now();
    // Keep the previous final-answer message id for rapid-final editing; do
    // not delete it here (deleting on new turn surprised users and removed
    // content they wanted to keep). The new turn's card starts fresh via
    // refloat + pageBreak, so the old tail does not linger in the live view.
    try {
      if (unified && dashboard) {
        await dashboard.ensure(chatId, s.targetThreadId ?? s.threadId, s, { working: true }).catch(() => {});
      }
      // Linear mode (private chats): no transcript card. Just a transient
      // "Working…" message that is updated in place and removed at the end;
      // the final answer is delivered as a normal message (events.ts).
      const linear = chatId >= 0;
      if (linear) {
        const opts = threadOptsFor(s);
        const lines: string[] = [];
        lines.unshift(sessionHeader(s).trimEnd());
        lines.push("⏳ <b>Working…</b>\n<i>Waiting for OpenCode</i>");
        const customBtns = store?.getCustomButtons?.(chatId) ?? [];
        const btnRows = customBtns.map((b, i) => [{ text: b.label.slice(0, 64), callback_data: `btn:${i}` }]);
        const keyboard = [
          [{ text: "⏹ Stop", callback_data: "panel:stop" }],
          ...btnRows,
        ];
        const sent = await tg.sendRichMessage(chatId, clampText(lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()), {
          ...opts,
          reply_markup: { inline_keyboard: keyboard },
        });
        s.statusMessageId = sent.message_id;
        s.transcriptMessageId = undefined;
        if (sent?.message_id) {
          rememberStatusMessage(s.sessionId, chatId, s.targetThreadId ?? s.threadId, sent.message_id);
          store?.rememberMessageSession(chatId, sent.message_id, s.sessionId);
        }
        if (unified && dashboard) {
          await dashboard.ensure(chatId, s.targetThreadId ?? s.threadId, s, { working: true }).catch(() => {});
        }
        return;
      }
      if (transcript) {
        // Every turn gets its own card created immediately at the bottom, with
        // live streaming while working. Unified and "única" (refloat) replace
        // the previous card (single message per session); "conservar" keeps the
        // finished card as history; "fija" keeps editing the same card in place.
        s.turnSeq = (s.turnSeq ?? 0) + 1;
        s.transcriptFollow = true;
        if (unified || settings.cardBehavior !== "fixed") {
          await transcript.refloat(chatId, s, { keep: settings.cardBehavior === "refloat_keep" });
        }
        await publishCard(chatId, s);
        if (s.transcriptMessageId) {
          s.statusMessageId = s.transcriptMessageId;
          rememberStatusMessage(s.sessionId, chatId, s.targetThreadId ?? s.threadId, s.transcriptMessageId);
        }
        return;
      }
      const opts = threadOptsFor(s);
      const lines: string[] = [];
      lines.unshift(sessionHeader(s).trimEnd());
      lines.push("⏳ <b>Working…</b>\n<i>Waiting for OpenCode</i>");
      if (settings.showResourceUsage) lines.push("<hr/>", renderResourceBlock(s));
      const customBtns = store?.getCustomButtons?.(chatId) ?? [];
      const btnRows = customBtns.map((b, i) => [{ text: b.label.slice(0, 64), callback_data: `btn:${i}` }]);
      const keyboard = [
        [{ text: "⏹ Stop", callback_data: "panel:stop" }],
        ...btnRows,
      ];
      const sent = await tg.sendRichMessage(chatId, clampText(lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()), {
        ...opts,
        reply_markup: { inline_keyboard: keyboard },
      });
      s.statusMessageId = sent.message_id;
      rememberStatusMessage(s.sessionId, chatId, s.targetThreadId ?? s.threadId, sent.message_id);
    } catch (err) {
      console.error("[status]", err);
    }
  };

  const updateStatus = async (chatId: number, s: ChatSession, force = false) => {
    if (s.statusFinished) return;
    if (!s.statusMessageId && !s.transcriptMessageId) return;
    if (s.statusEditing) { s.statusPendingUpdate = true; return; }
    const opts = threadOptsFor(s);
    const settings = getSettings(chatId);
    const now = Date.now();
    // A session that lost its route (another session took over the tab) keeps
    // updating its card, but at a slower cadence to avoid Telegram rate limits.
    // Forced updates are throttled too in that case. The gap also scales up
    // adaptively while Telegram is rate-limiting this chat (429s).
    const baseGap = s.detached ? STATUS_BACKGROUND_GAP_MS : STATUS_MIN_UPDATE_GAP_MS;
    const minGap = throttleGap(chatId, baseGap);
    if (s.statusLastUpdate && now - s.statusLastUpdate < minGap) {
      if (s.detached || !force) return;
    }
    s.statusEditing = true;
    s.statusLastUpdate = now;
    // Draft keep-alive: drafts expire ~30s; refresh while turn is active (private chats).
    if (!s.stopped && s.draftId) {
      void flushDraft(chatId, s);
    }
    try {
      // Linear mode (private chats): update the transient "Working…" message.
      if (chatId >= 0) {
        const settings = getSettings(chatId);
        const opts = threadOptsFor(s);
        const lines: string[] = [];
        lines.unshift(sessionHeader(s).trimEnd());
        const elapsed = s.promptStartTime ? Math.max(1, Math.round((Date.now() - s.promptStartTime) / 1000)) : 0;
        lines.push(s.stopped ? "<h4>⏹ Stopped</h4>" : `<h4>⏳ Working…${elapsed ? ` <i>(${elapsed}s)</i>` : ""}</h4>`);
        const prompt = store?.lastPromptBySession.get(s.sessionId);
        if (prompt?.trim()) lines.push(`<i>📝 ${esc(clampText(prompt.trim(), 160))}</i>`);
        // Streaming thinking (linear mode): show reasoning if configured.
        if (settings.showThinking && s.reasoningBuffer?.trim()) {
          const r = s.reasoningBuffer.trim().slice(-Math.min(settings.partialTextLines ?? 500, 800));
          lines.push(`<blockquote${settings.thinkingExpanded ? "" : " expandable"}>🧠 Thinking
${markdownToHtml(r)}</blockquote>`);
        }
        // Streaming partial text (linear mode): show the response as it grows.
        if (settings.showPartialText && s.buffer?.trim()) {
          const txt = s.buffer.trim().slice(-Math.min(settings.partialTextLines ?? 500, 1200));
          lines.push(`<blockquote>${markdownToHtml(txt)}</blockquote>`);
        }
        const tools = s.toolCallDetails.length;
        const failedTools = s.toolCallDetails.filter((d) => d.status === "failed").length;
        if (tools) lines.push(`<i>🔧 ${tools}${failedTools ? ` (${failedTools} ✗)` : ""}</i>`);
        const tokens = s.lastOutputTokens ?? 0;
        if (tokens && elapsed > 1) lines.push(`<i>⚡ ${(tokens / elapsed).toFixed(1)} tok/s · ${tokens.toLocaleString()} tok</i>`);
        if (settings.showResourceUsage) lines.push("<hr/>", renderResourceBlock(s));
        await tg.editRichMessage(chatId, s.statusMessageId!, clampText(lines.join("\n"), 3900), {
          ...opts,
          reply_markup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: "panel:stop" }]] },
        }).catch(() => {});
        return;
      }
      if (transcript) {
        await publishCard(chatId, s);
        return;
      }
      const MAX = 3800;
      const header = sessionHeader(s).trimEnd();
      const elapsed = s.promptStartTime ? Math.max(1, Math.round((Date.now() - s.promptStartTime) / 1000)) : 0;
      const statusLine = s.stopped ? "<h4>⏹ Stopped</h4>" : `<h4>⏳ Working…${elapsed ? ` <i>(${elapsed}s)</i>` : ""}</h4>`;
      const backgroundNote = s.detached && !s.stopped
        ? "<i>🔀 Esta sesión sigue en segundo plano (otra sesión ocupa la pestaña).</i>"
        : "";

      const shellDetails = s.toolCallDetails.filter((detail) => isShellTool(detail.name));
      const otherDetails = s.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
      const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));

      let latestToolBlock = "";
      const lastTool = s.toolCallDetails.length ? s.toolCallDetails[s.toolCallDetails.length - 1] : null;
      if (settings.showTools && settings.showLatestTool && lastTool) {
        const toolName = lastTool.name;
        const shell = isShellTool(toolName);
        const statusEmoji = lastTool.status === "success" ? "✅" : lastTool.status === "failed" ? "❌" : "⏳";
        const summary = getToolSummary(toolName, lastTool.input);
        const argPart = summary.arg ? ` <code>${esc(shortToolArg(summary.arg, 70))}</code>` : "";
        const parts = [`${statusEmoji} <b>Latest tool:</b> ${toolIcon(toolName)} <b>${esc(toolName)}</b>${argPart}`];
        if (shell && summary.arg && settings.showToolInput) {
          parts.push(`<pre language='bash'>$ ${esc(truncate(summary.arg, 220))}</pre>`);
        } else if (!shell && settings.showToolInput && !summary.arg && lastTool.input) {
          const p = parseToolInput(lastTool.input);
          if (p) {
            const hint = Object.entries(p)
              .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
              .slice(0, 2)
              .map(([k, v]) => `${k}=${truncate(String(v), 50)}`)
              .join(" ");
            if (hint) parts.push(`<i>${esc(hint)}</i>`);
          }
        }
        latestToolBlock = parts.join("\n");
      }

      let latestThoughtBlock = "";
      if (settings.showThinking && settings.showLatestThought && s.reasoningBuffer.trim()) {
        const reasoningLines = s.reasoningBuffer.trim().split(/\n+/).filter(Boolean);
        const lastThought = reasoningLines.length ? reasoningLines[reasoningLines.length - 1] : s.reasoningBuffer.trim();
        latestThoughtBlock = `💭 <b>Latest thought:</b>\n<blockquote><mark>${esc(clampText(lastThought, 240))}</mark></blockquote>`;
      }

      let shellBlock = "";
      if (settings.showTools && settings.showShell && shellDetails.length) {
        const shellText = renderShell(shellDetails.slice(-5), 180);
        shellBlock = `<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell (${shellDetails.length})\n<pre language='bash'>${esc(shellText)}</pre></blockquote>`;
      }

      let toolsBlock = "";
      if (settings.showTools && otherDetails.length) {
        const details = renderTools(otherDetails.slice(-6), 180, settings.showToolInput);
        toolsBlock = `<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Tool calls (${otherDetails.length})\n${details}</blockquote>`;
      } else if (settings.showTools && !shellDetails.length && !editDetails.length && s.toolCalls.length) {
        toolsBlock = "🔧 " + esc(s.toolCalls.slice(-6).join(", "));
      }

      let editsLine = "";
      if (settings.showTools && editDetails.length) {
        const stats = editDetails.map((detail) => {
          const { file, added, removed } = editStats(detail.input);
          return `${file.split("/").pop() ?? file} (+${added}/-${removed})`;
        });
        editsLine = `✏️ Edits (${editDetails.length}): ${esc(stats.join(", "))}`;
      }

      let partialBlock = "";
      if (settings.showPartialText && s.buffer.trim()) {
        const txt = s.buffer.trim().slice(-Math.min(settings.partialTextLines, 1000));
        partialBlock = "<pre>" + esc(txt) + "</pre>";
      }

      const parts = [
        header,
        statusLine,
        backgroundNote,
        latestToolBlock,
        latestThoughtBlock,
        shellBlock,
        toolsBlock,
        editsLine,
        partialBlock,
      ].filter(Boolean);

      const finalText = clampText(parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd(), 3900);

      const customBtns = store?.getCustomButtons?.(chatId) ?? [];
      const btnRows = customBtns.map((b, i) => [{ text: b.label.slice(0, 64), callback_data: `btn:${i}` }]);
      const editKeyboard = [
        [{ text: "⏹ Stop", callback_data: "panel:stop" }],
        ...btnRows,
      ];
      const edit = tg.editRichMessage(chatId, s.statusMessageId!, finalText, {
        ...opts,
        reply_markup: { inline_keyboard: editKeyboard },
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
      if (s.statusPendingUpdate) {
        s.statusPendingUpdate = false;
        // Coalesce queued edits instead of dropping them.
        void updateStatus(chatId, s, true).catch(() => {});
      }
    }
  };

  /** Freeze the status card. Stop disappears; thinking/tools stay collapsible. */
  const finishStatus = async (chatId: number, s: ChatSession) => {
    if (s.statusFinished) {
      // Idempotent: step.ended and text.ended may both close the same turn.
      if (s.statusTimer) {
        clearInterval(s.statusTimer);
        s.statusTimer = undefined;
      }
      return;
    }
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    s.statusFinished = true;
    if (s.statusEditPromise) {
      await s.statusEditPromise.catch(() => {});
      s.statusEditPromise = undefined;
    }
    const settings = getSettings(chatId);
    const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));

    if (transcript) {
      // Append the turn output to the session transcript: the card is edited
      // in place, so no extra message is sent for thinking or tools.
      const fullThinking = !s.stopped && s.reasoningBuffer.trim() ? s.reasoningBuffer.trim() : "";
      if (fullThinking) {
        // The reasoning is markdown: render it so code blocks and emphasis
        // keep their rich text inside the card.
        const renderThinking = (chunk: string) =>
          `<blockquote${settings.thinkingExpanded ? "" : " expandable"}>🧠 Thinking
${markdownToHtml(chunk)}</blockquote>`;
        // Models often restate the prompt inside their reasoning; showing it
        // again duplicates information the user already sent.
        const cleanThinking = stripRestatedPrompt(fullThinking, store?.lastPromptBySession.get(s.sessionId));
        transcript.addBlock(s, "thinking", renderThinking(cleanThinking), cleanThinking, renderThinking);
        // Persist as COT history (larger cap to avoid losing context).
        const prev = s.cotBuffer?.trim() ? s.cotBuffer.trim() + "\n\n---\n\n" : "";
        let next = prev + fullThinking;
        if (next.length > 16000) next = next.slice(next.length - 16000);
        s.cotBuffer = next;
        s.cotCount = (s.cotCount ?? 0) + 1;
        rememberCot(s.sessionId, next, s.cotCount);
        s.reasoningBuffer = "";
      }
      if (settings.showTools && s.toolCallDetails.length) {
        const shellDetails = s.toolCallDetails.filter((detail) => isShellTool(detail.name));
        const otherDetails = s.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
        if (shellDetails.length) {
          const shellText = renderShell(shellDetails, 800);
          transcript.addBlock(
            s,
            "tools",
            `<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell (${shellDetails.length})\n<pre language='bash'>${esc(shellText)}</pre></blockquote>`,
            shellText,
            (chunk) => `<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell
<pre language=\'bash\'>${esc(chunk)}</pre></blockquote>`,
          );
        }
        if (otherDetails.length) {
          const details = renderTools(otherDetails, 1200, settings.showToolInput);
          transcript.addBlock(
            s,
            "tools",
            `<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Tool calls (${otherDetails.length})\n${details}</blockquote>`,
            details,
            (chunk) => `<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Tool calls
${chunk}</blockquote>`,
          );
        }
      }
      s.transcriptFollow = true;
      const unified = settings.displayMode === "unified";
      // Keep the finished card attached: it holds the final answer and stays
      // navigable (pagination). The next turn start decides whether it is
      // replaced (única), preserved (conservar) or kept editing in place (fija).
      const linear = chatId >= 0;
      const finishedCardId = s.transcriptMessageId;
      if (!linear) await publishCard(chatId, s);
      // The card stays alive for pagination; only the live status ends.
      if (linear) {
        // Linear mode: keep the transient message so events.ts can turn it
        // into the final answer (no flicker / no "deleted" gap).
      } else {
        s.statusMessageId = undefined;
      }
      forgetStatusMessage(s.sessionId);
      if (unified && dashboard) {
        await dashboard.update(chatId, s.targetThreadId ?? s.threadId, s, { working: false }).catch(() => {});
      }
      // Edits are offered in their own message so the session card keeps its
      // paginated content intact. A snapshot of this turn's edit details is
      // persisted under BOTH message ids so the buttons and the 📝 Diff card
      // button keep working after new turns and restarts.
      if (editDetails.length && (finishedCardId || linear)) {
        const editMessageId = finishedCardId ?? 0;
        const editLines: string[] = [];
        const tableRows: string[] = [];
        for (const detail of editDetails) {
          const file = relativeEditPath(s, extractEditFile(detail.input) ?? `edit ${editLines.length + 1}`);
          const { added, removed } = editStats(detail.input);
          tableRows.push(`<tr><td><code>${esc(file)}</code></td><td>+${added}</td><td>-${removed}</td></tr>`);
          const diff = formatEditDiff(detail.input, settings.diffStyle, s.directory);
          const capped = capDiff(diff, 12);
          editLines.push(`✏️ <b>${esc(file)}</b>${diff.trim() ? `\n<blockquote expandable><pre><code class="language-diff">${esc(capped)}</code></pre></blockquote>` : ""}`);
        }
        const table = `<table><tr><th>Archivo</th><th>+</th><th>-</th></tr>${tableRows.join("")}</table>`;
        try {
          const linear = chatId >= 0;
          const text = `${sessionHeader(s)}<h4>Edits (${editDetails.length})</h4>\n${table}\n${editLines.join("\n")}`;
          if (linear) {
            // Standalone edits message: its own id is the reference for the
            // ✏️/Full diffs buttons and the persisted snapshot.
            const sent = await tg.sendRichMessage(chatId, text, { ...threadOptsFor(s) });
            const snapshot = editDetails.map((d) => ({ ...d }));
            if (sent?.message_id) {
              pendingEdits.set(sent.message_id, s);
              store?.rememberPendingEdits(sent.message_id, s.sessionId, snapshot);
              store?.rememberMessageSession(chatId, sent.message_id, s.sessionId);
              await tg.editRichMessage(chatId, sent.message_id, text, {
                ...threadOptsFor(s),
                reply_markup: { inline_keyboard: finishedKeyboard(editDetails, undefined, s, sent.message_id) },
              }).catch(() => {});
            }
          } else {
            const sent = await tg.sendRichMessage(chatId, text, {
              ...threadOptsFor(s),
              reply_markup: { inline_keyboard: finishedKeyboard(editDetails, undefined, s, editMessageId) },
            });
            const snapshot = editDetails.map((d) => ({ ...d }));
            if (sent?.message_id) {
              pendingEdits.set(sent.message_id, s);
              store?.rememberPendingEdits(sent.message_id, s.sessionId, snapshot);
              // Replying to the edits message must route to its session.
              store?.rememberMessageSession(chatId, sent.message_id, s.sessionId);
            }
            if (finishedCardId) store?.rememberPendingEdits(finishedCardId, s.sessionId, snapshot);
          }
        } catch (err) {
          console.error("[status] edits message failed", err);
        }
      }
      return;
    }

    forgetStatusMessage(s.sessionId);
    if (s.statusMessageId) {
      const messageId = s.statusMessageId;
      s.expandedEditIndex = undefined;
      if (editDetails.length) {
        pendingEdits.set(messageId, s);
        store?.rememberPendingEdits(messageId, s.sessionId, editDetails.map((d) => ({ ...d })));
      }
      const fullThinking = (!s.stopped && s.reasoningBuffer.trim()) ? s.reasoningBuffer.trim() : "";
      const text = clampText(renderFinished(s, undefined, settings, !fullThinking || !settings.showThinking));
      const keyboard = finishedKeyboard(editDetails, undefined, s, messageId);
      await tg
        .editRichMessage(chatId, messageId, text, {
          ...threadOptsFor(s),
          reply_markup: { inline_keyboard: keyboard },
        })
        .catch((err) => console.error("[status] finish edit FAILED", messageId, err));
      if (fullThinking) {
        const prev = s.cotBuffer?.trim() ? s.cotBuffer.trim() + "\n\n---\n\n" : "";
        let next = prev + fullThinking;
        if (next.length > 16000) next = next.slice(next.length - 16000);
        s.cotBuffer = next;
        s.cotCount = (s.cotCount ?? 0) + 1;
        rememberCot(s.sessionId, next, s.cotCount);
        s.reasoningBuffer = "";
      }
      s.statusMessageId = undefined;
    }
  };

  const renderFinished = (target: ChatSession, expandedEditIndex: number | undefined, settings: ChatSettings, inlineThinking = true): string => {
    const previousCot = target.cotBuffer?.trim() ?? "";
    const lines: string[] = [];
    lines.unshift(sessionHeader(target).trimEnd());
    if (settings.showCot && previousCot) {
      const cot = previousCot.slice(-3500);
      lines.push(`<blockquote expandable>🧾 COT (${target.cotCount ?? 0})
${esc(cot)}</blockquote>`);
    }
    lines.push("✅ <b>Done</b>");
    if (!settings.compactFinal) {
      if (inlineThinking && settings.showThinking && !target.stopped && target.reasoningBuffer.trim()) {
        const r = target.reasoningBuffer.trim();
        lines.push(`<blockquote${settings.thinkingExpanded ? "" : " expandable"}>🧠 Thinking
${esc(r)}</blockquote>`);
      }
      const shellDetails = target.toolCallDetails.filter((detail) => isShellTool(detail.name));
      const otherDetails = target.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
      const editDetails = target.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
      if (settings.showTools && settings.showShell && shellDetails.length) {
        const shellText = renderShell(shellDetails, 500);
        lines.push(`<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell (${shellDetails.length})\n<pre language='bash'>${esc(shellText)}</pre></blockquote>`);
      }
      if (settings.showTools && otherDetails.length) {
        const details = renderTools(otherDetails, 500);
        lines.push(`<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Tool calls (${otherDetails.length})\n${details}</blockquote>`);
      }
      if (settings.showTools && editDetails.length) {
        const editLines = [`✏️ Edits: ${editDetails.length}`];
        for (const detail of editDetails) {
          const file = relativeEditPath(target, extractEditFile(detail.input) ?? "edit");
          const diff = formatEditDiff(detail.input, settings.diffStyle, target.directory);
          const capped = capDiff(diff, 15);
          editLines.push(`✏️ <b>${esc(file)}</b>`);
          if (diff.trim()) {
            editLines.push(`<blockquote expandable><pre><code class="language-diff">${esc(capped)}</code></pre></blockquote>`);
          }
        }
        lines.push(editLines.join("\n"));
      }
    }
    if (target.compacting) {
      lines.push("📦 <b>Compacting context…</b>");
    } else if (target.compactionError?.trim()) {
      lines.push(`📦 <b>Compaction failed</b>\n<i>${esc(target.compactionError.trim().slice(0, 240))}</i>`);
    } else if (target.compactionSummary?.trim()) {
      const sum = target.compactionSummary.trim();
      if (sum.length > 220) lines.push(`<blockquote expandable>📦 <b>Compaction</b>
${esc(sum.slice(0, 2000))}</blockquote>`);
      else lines.push(`📦 <b>Compaction</b>: ${esc(sum)}`);
    }
    let resourceBlock = "";
    if (settings.showResourceUsage) {
      resourceBlock = renderResourceBlock(target);
      lines.push(resourceBlock);
      const full = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
      if (full.length > 3900 && resourceBlock) {
        const without = full.replace(resourceBlock, "").replace(/\n{3,}/g, "\n\n").trimEnd();
        const headMax = 3900 - resourceBlock.length - 5;
        return without.slice(0, Math.max(0, headMax)) + "\n…\n" + resourceBlock;
      }
      return full;
    }
    return lines.join("\n");
  };

  const finishedKeyboard = (editDetails: ChatSession["toolCallDetails"], expandedEditIndex: number | undefined, target: ChatSession, messageId?: number): Array<Array<{ text: string; callback_data: string }>> => {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    editDetails.forEach((detail, index) => {
      const file = relativeEditPath(target, extractEditFile(detail.input) ?? `edit ${index + 1}`);
      const label = expandedEditIndex === index ? `✏️ ${file} ▾` : `✏️ ${file}`;
      keyboard.push([{ text: label.slice(0, 64), callback_data: `edit:${index}` }]);
    });
    if (editDetails.length && messageId !== undefined) {
      keyboard.push([{ text: "📄 Full diffs", callback_data: `edits:full:${messageId}` }]);
    }
    keyboard.push([
      { text: "🧠 Model", callback_data: `panel:ms:${target.sessionId}` },
      { text: "📂 Sessions", callback_data: "panel:sessions" },
    ]);
    return keyboard;
  };

  const relativeEditPath = (target: ChatSession, file: string | null): string => {
    if (!file) return "edit";
    if (!target.directory) return file.split("/").pop() ?? file;
    const prefix = target.directory.endsWith("/") ? target.directory : target.directory + "/";
    if (file.startsWith(prefix)) return file.slice(prefix.length);
    return file.split("/").pop() ?? file;
  };

  /** Expanded-file toggle for edit messages, keyed by chatId:messageId. */
  const editToggles = new Map<string, number | undefined>();

  /**
   * Resolve the edit snapshot for a message: the live session when available,
   * otherwise the persisted snapshot (survives new turns and restarts).
   */
  const resolveEditsFor = (messageId: number): { s?: ChatSession; edits: Array<ChatSession["toolCallDetails"][number]>; directory?: string; header: string; threadId?: number; snapshotId?: string } | undefined => {
    const snap = store?.getPendingEditsSnapshot(messageId);
    if (!snap) return undefined;
    let s = pendingEdits.get(messageId) ?? store?.findSessionById(snap.sessionId);
    if (s) pendingEdits.set(messageId, s);
    const edits = (snap.edits?.length ? snap.edits : s?.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input)) ?? []) as Array<ChatSession["toolCallDetails"][number]>;
    if (!edits.length) return undefined;
    const header = s ? sessionHeader(s).trimEnd() : `📌 <code>${esc(snap.sessionId.slice(0, 12))}</code>\n`;
    return { s, edits, directory: s?.directory, header, threadId: s?.targetThreadId ?? s?.threadId, snapshotId: snap.sessionId };
  };

  const showEditDiff = async (chatId: number, messageId: number, index: number): Promise<boolean> => {
    const resolved = resolveEditsFor(messageId);
    if (!resolved || !resolved.edits[index]) return false;
    const toggleKey = `${chatId}:${messageId}`;
    const next = editToggles.get(toggleKey) === index ? undefined : index;
    editToggles.set(toggleKey, next);
    if (resolved.s) resolved.s.expandedEditIndex = next;
    const settings = getSettings(chatId);
    const lines: string[] = [resolved.header, `<h4>Edits (${resolved.edits.length})</h4>`];
    resolved.edits.forEach((detail, i) => {
      const file = relativeEditPath(resolved.s as ChatSession, extractEditFile(detail.input) ?? `edit ${i + 1}`);
      const diff = formatEditDiff(detail.input, settings.diffStyle, resolved.directory);
      const expanded = next === i;
      lines.push(`✏️ <b>${esc(file)}</b>${expanded ? " ▾" : ""}`);
      if (diff.trim()) {
        // The expanded file shows the full diff; the rest stay capped.
        lines.push(`<blockquote expandable><pre><code class="language-diff">${esc(expanded ? diff : capDiff(diff, 12))}</code></pre></blockquote>`);
      }
    });
    const keyboard = finishedKeyboard(resolved.edits, next, (resolved.s ?? ({ sessionId: resolved.snapshotId ?? "unknown", directory: resolved.directory } as unknown as ChatSession)), messageId);
    const opts = resolved.s ? threadOptsFor(resolved.s) : threadOpts(resolved.threadId);
    await tg.editRichMessage(chatId, messageId, clampText(lines.join("\n"), 3900), {
      ...opts,
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => {});
    return true;
  };

  const sendFullDiffs = async (chatId: number, messageId: number, threadId?: number): Promise<boolean> => {
    const resolved = resolveEditsFor(messageId);
    if (!resolved) return false;
    const settings = getSettings(chatId);
    const parts: string[] = [];
    for (const detail of resolved.edits) {
      const file = relativeEditPath(resolved.s as ChatSession, extractEditFile(detail.input) ?? "edit");
      const diff = formatEditDiff(detail.input, settings.diffStyle, resolved.directory);
      parts.push(`✏️ <b>${esc(file)}</b>\n<blockquote><pre><code class="language-diff">${esc(diff)}</code></pre></blockquote>`);
    }
    const full = `${resolved.header}\n<b>Full diffs</b> (${resolved.edits.length})\n\n${parts.join("\n\n")}`;
    const opts = threadOpts(threadId ?? resolved.threadId);
    if (full.length <= 3800) {
      await tg.sendRichMessage(chatId, full, opts).catch(() => {});
    } else {
      let remaining = full;
      while (remaining.length > 3800) {
        let cut = remaining.lastIndexOf("\n", 3800);
        if (cut < 1900) cut = 3800;
        await tg.sendRichMessage(chatId, remaining.slice(0, cut), opts).catch(() => {});
        remaining = remaining.slice(cut).trimStart();
      }
      if (remaining) await tg.sendRichMessage(chatId, remaining, opts).catch(() => {});
    }
    return true;
  };

  return { flushDraft, startStatus, updateStatus, finishStatus, publishCard, showEditDiff, sendFullDiffs };
}
