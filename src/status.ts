import type { ChatSession } from "./types.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSettings } from "./settings.js";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isEditTool, extractEditFile, formatEditDiff, editStats } from "./editutil.js";
import { formatBytes } from "./files/index.js";
import { clampText, esc, sessionHeader, threadOpts, toolIcon, truncate } from "./util.js";

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
function readMemoryPercent(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const total = Number(meminfo.match(/MemTotal:\s+(\d+)/)?.[1]);
    const available = Number(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1]);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(available) && available >= 0) {
      return Math.max(0, Math.min(100, Math.round((1 - available / total) * 100)));
    }
  } catch {
    // Fall back to os.freemem() on non-Linux or permission errors.
  }
  return Math.max(0, Math.min(100, Math.round((1 - os.freemem() / os.totalmem()) * 100)));
}

function readGpuPercent(): number | null {
  const info = readGpuInfo();
  return info ? info.load : null;
}

function progressBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

type GpuInfo = { name: string; usedMB: number; totalMB: number; load: number; temperature: number | null };

function readGpuInfo(): GpuInfo | null {
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
      { timeout: 1500, encoding: "utf8" },
    )
      .trim()
      .split("\n")[0];
    const parts = out.split(",").map((part) => part.trim());
    if (parts.length < 4) return null;
    const name = parts[0] || "GPU";
    const usedMB = Number(parts[1]);
    const totalMB = Number(parts[2]);
    const load = Number(parts[3]);
    const temperature = parts[4] ? Number(parts[4]) : null;
    if (!Number.isFinite(usedMB) || !Number.isFinite(totalMB) || totalMB <= 0 || !Number.isFinite(load)) return null;
    return { name, usedMB, totalMB, load: Math.max(0, Math.min(100, load)), temperature: Number.isFinite(temperature as number) ? temperature : null };
  } catch {
    // No GPU or nvidia-smi unavailable.
  }
  return null;
}

/** Clamp a diff to at most `max` lines, appending a "... +N more" hint. */
function capDiff(diff: string, max: number): string {
  const lines = diff.split("\n");
  if (lines.length <= max) return diff;
  return lines.slice(0, max).join("\n") + `\n… (+${lines.length - max} more lines)`;
}

export function createStatusManager({ tg, threadOptsFor, getSettings, pendingEdits, rememberCot, rememberStatusMessage, forgetStatusMessage, store }: StatusDeps) {
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
      lines.unshift(sessionHeader(s).trimEnd());
      if (settings.showCot) {
        const cotSrc = s.cotBuffer?.trim() ? s.cotBuffer.trim() : "";
        if (cotSrc) {
          const cot = cotSrc.slice(-1500);
          lines.push(`<blockquote expandable>🧾 COT (${s.cotCount ?? 0})\n${esc(cot)}</blockquote>`);
        }
      }
      lines.push("⏳ <b>Working…</b>\n<i>Waiting for OpenCode</i>");
      const customBtns = store?.getCustomButtons?.(chatId) ?? [];
      const btnRows = customBtns.map((b, i) => [{ text: b.label.slice(0, 64), callback_data: `btn:${i}` }]);
      const keyboard = [
        [{ text: "⏹ Stop", callback_data: "panel:stop" }],
        [{ text: "🧠 Model", callback_data: `panel:ms:${s.sessionId}` }, { text: "📂 Sessions", callback_data: "panel:sessions" }],
        ...btnRows,
      ];
      const sent = await tg.sendRichMessage(chatId, clampText(lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()), {
        ...opts,
        reply_markup: { inline_keyboard: keyboard },
      });
      s.statusMessageId = sent.message_id;
      s.statusLastUpdate = Date.now();
      rememberStatusMessage(s.sessionId, chatId, s.targetThreadId ?? s.threadId, sent.message_id);
    } catch (err) {
      console.error("[status]", err);
    }
  };

  const updateStatus = async (chatId: number, s: ChatSession, force = false) => {
    if (!s.statusMessageId || s.statusFinished) return;
    if (s.statusEditing) { s.statusPendingUpdate = true; return; }
    const opts = threadOptsFor(s);
    const settings = getSettings(chatId);
    const now = Date.now();
    if (!force && s.statusLastUpdate && now - s.statusLastUpdate < 5000) return;
    s.statusEditing = true;
    s.statusLastUpdate = now;
    const lines: string[] = [];
    try {
    const sep = () => { if (lines.length && lines[lines.length - 1] !== "") lines.push(""); };
    lines.unshift(sessionHeader(s).trimEnd());
    if (settings.showCot && s.cotBuffer?.trim()) {
      const cot = s.cotBuffer.trim().slice(-1500);
      lines.push(`<blockquote expandable>🧾 COT (${s.cotCount ?? 0})\n${esc(cot)}</blockquote>`);
    }
    const elapsed = s.promptStartTime ? Math.max(1, Math.round((Date.now() - s.promptStartTime) / 1000)) : 0;
    if (s.stopped) lines.push("<h4>⏹ Stopped</h4>");
    else lines.push("<h4>⏳ Working…" + (elapsed ? ` <i>(${elapsed}s)</i>` : "") + "</h4>");
    if (settings.showThinking && s.reasoningBuffer.trim()) {
      sep();
      const r = s.reasoningBuffer.trim().slice(-800);
      lines.push(`<blockquote${settings.thinkingExpanded ? "" : " expandable"}>🧠 Thinking\n${esc(r)}</blockquote>`);
    }
    const shellDetails = s.toolCallDetails.filter((detail) => isShellTool(detail.name));
    const otherDetails = s.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
    const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
    if (settings.showTools && settings.showShell && shellDetails.length) {
      sep();
      const shellText = renderShell(shellDetails.slice(-5), 200);
      lines.push(`<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell (` + shellDetails.length + ")\n<pre language='bash'>" + esc(shellText) + "</pre></blockquote>");
    }
    if (settings.showTools && otherDetails.length) {
      sep();
      const details = renderTools(otherDetails.slice(-6), 200, settings.showToolInput);
      lines.push(`<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Tool calls (` + otherDetails.length + ")\n" + details + "</blockquote>");
    } else if (settings.showTools && !shellDetails.length && !editDetails.length && s.toolCalls.length) {
      lines.push("🔧 " + esc(s.toolCalls.slice(-5).join(", ")));
    }
    if (settings.showTools && editDetails.length) {
      const stats = editDetails.map((detail) => {
        const { file, added, removed } = editStats(detail.input);
        return `${file.split("/").pop() ?? file} (+${added}/-${removed})`;
      });
      lines.push(`✏️ Edits (${editDetails.length}): ${esc(stats.join(", "))}`);
    }
    if (settings.showPartialText && s.buffer.trim()) {
      lines.push("<pre>" + esc(s.buffer.trim().slice(-settings.partialTextLines)) + "</pre>");
    }
    // Highlight the latest thought and the latest tool call, right above
    // the resource indicators, so the user always sees what the agent is
    // doing now without scrolling.
    if (settings.showThinking && settings.showLatestThought && s.reasoningBuffer.trim()) {
      lines.push("");
      sep();
      const reasoningLines = s.reasoningBuffer.trim().split(/\n+/).filter(Boolean);
      const lastThought = reasoningLines.length ? reasoningLines[reasoningLines.length - 1] : s.reasoningBuffer.trim();
      lines.push(`💭 <b>Latest thought:</b>\n<blockquote><mark>${esc(clampText(lastThought, 240))}</mark></blockquote>`);
    }
    const lastTool = s.toolCallDetails.length ? s.toolCallDetails[s.toolCallDetails.length - 1] : null;
    if (settings.showTools && settings.showLatestTool && lastTool) {
      sep();
      const toolName = lastTool.name;
      const isShell = isShellTool(toolName);
      const statusEmoji = lastTool.status === "success" ? "✅" : lastTool.status === "failed" ? "❌" : "⏳";
      const summary = getToolSummary(toolName, lastTool.input);
      const argPart = summary.arg ? ` <code>${esc(shortToolArg(summary.arg, 70))}</code>` : "";
      lines.push(`${statusEmoji} <b>Latest tool:</b> ${toolIcon(toolName)} <b>${esc(toolName)}</b>${argPart}`);
      if (isShell && summary.arg && settings.showToolInput) {
        lines.push(`<pre language='bash'>$ ${esc(truncate(summary.arg, 220))}</pre>`);
      } else if (!isShell && settings.showToolInput && !summary.arg && lastTool.input) {
        const p = parseToolInput(lastTool.input);
        if (p) {
          const hint = Object.entries(p)
            .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
            .slice(0, 2)
            .map(([k, v]) => `${k}=${truncate(String(v), 50)}`)
            .join(" ");
          if (hint) lines.push(`<i>${esc(hint)}</i>`);
        }
      }
    }
    let resourceBlock = "";
    if (settings.showResourceUsage) {
      sep();
      if (!s.cpuHistory) s.cpuHistory = [];
      if (!s.memHistory) s.memHistory = [];
      const cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
      const memPercent = readMemoryPercent();
      s.cpuHistory.push(cpuPercent);
      s.memHistory.push(memPercent);
      const limit = settings.resourceHistory;
      while (s.cpuHistory.length > limit) s.cpuHistory.shift();
      while (s.memHistory.length > limit) s.memHistory.shift();
      const cpuBar = progressBar(cpuPercent);
      const memBar = progressBar(memPercent);
      const prevCpu = s.cpuHistory.length >= 2 ? s.cpuHistory[s.cpuHistory.length - 2] : cpuPercent;
      const cpuTrend = cpuPercent > prevCpu ? " ↑" : cpuPercent < prevCpu ? " ↓" : "";
      const prevMem = s.memHistory.length >= 2 ? s.memHistory[s.memHistory.length - 2] : memPercent;
      const memTrend = memPercent > prevMem ? " ↑" : memPercent < prevMem ? " ↓" : "";
      const resourceLines: string[] = [];
      resourceLines.push(`CPU ${cpuBar} ${cpuPercent}%${cpuTrend}`);
      resourceLines.push(`RAM ${memBar} ${memPercent}%${memTrend}`);
      const gpu = readGpuInfo();
      if (gpu) {
        const vramPercent = Math.round((gpu.usedMB / gpu.totalMB) * 100);
        const vramBar = progressBar(vramPercent);
        const temp = gpu.temperature === null ? "" : ` · ${gpu.temperature}°C`;
        resourceLines.push(`GPU ${String(gpu.name).slice(0, 18)}`);
        resourceLines.push(`VRAM ${vramBar} ${vramPercent}%`);
        resourceLines.push(`Load ${progressBar(gpu.load)} ${gpu.load}%${temp}`);
      }
      resourceBlock = `<pre>${esc(resourceLines.join("\n"))}</pre>`;
      lines.push(resourceBlock);
    }
    sep();
    if (s.compacting) {
      lines.push("📦 <b>Compacting context…</b>");
    } else if (s.compactionError?.trim()) {
      lines.push(`📦 <b>Compaction failed</b>\n<i>${esc(s.compactionError.trim().slice(0, 240))}</i>`);
    } else if (s.compactionSummary?.trim()) {
      const sum = s.compactionSummary.trim();
      if (sum.length > 220) lines.push(`<blockquote expandable>📦 <b>Compaction</b>\n${esc(sum.slice(0, 1500))}</blockquote>`);
      else lines.push(`📦 <b>Compaction</b>: ${esc(sum)}`);
    }
      const fullText = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
      let finalText = fullText;
      if (fullText.length > 3900 && resourceBlock) {
        const without = fullText.replace(resourceBlock, "").replace(/\n{3,}/g, "\n\n").trimEnd();
        const headMax = 3900 - resourceBlock.length - 5;
        finalText = without.slice(0, Math.max(0, headMax)) + "\n…\n" + resourceBlock;
      }
      const customBtns = store?.getCustomButtons?.(chatId) ?? [];
      const btnRows = customBtns.map((b, i) => [{ text: b.label.slice(0, 64), callback_data: `btn:${i}` }]);
      const editKeyboard = [
        [{ text: "⏹ Stop", callback_data: "panel:stop" }],
        [{ text: "🧠 Model", callback_data: `panel:ms:${s.sessionId}` }, { text: "📂 Sessions", callback_data: "panel:sessions" }],
        ...btnRows,
      ];
      const edit = tg.editRichMessage(chatId, s.statusMessageId, clampText(finalText, 3900), {
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
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    s.statusFinished = true;
    forgetStatusMessage(s.sessionId);
    if (s.statusEditPromise) {
      await s.statusEditPromise.catch(() => {});
      s.statusEditPromise = undefined;
    }
    if (s.statusMessageId) {
      const settings = getSettings(chatId);
      const messageId = s.statusMessageId;
      s.expandedEditIndex = undefined;
      const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
      if (editDetails.length) {
        pendingEdits.set(messageId, s);
        store?.rememberPendingEdits(messageId, s.sessionId);
      }
      const text = clampText(renderFinished(s, undefined, settings));
      const keyboard = finishedKeyboard(editDetails, undefined, s, messageId);
      await tg
        .editRichMessage(chatId, messageId, text, {
          ...threadOptsFor(s),
          reply_markup: { inline_keyboard: keyboard },
        })
        .catch((err) => console.error("[status] finish edit FAILED", messageId, err));
      if (!s.stopped && s.reasoningBuffer.trim()) {
        const chunk = s.reasoningBuffer.trim();
        const prev = s.cotBuffer?.trim() ? s.cotBuffer.trim() + "\n\n---\n\n" : "";
        let next = prev + chunk;
        if (next.length > 4000) next = next.slice(next.length - 4000);
        s.cotBuffer = next;
        s.cotCount = (s.cotCount ?? 0) + 1;
        s.reasoningBuffer = "";
        rememberCot(s.sessionId, next, s.cotCount);
      }
      s.statusMessageId = undefined;
    }
  };

  const renderFinished = (target: ChatSession, expandedEditIndex: number | undefined, settings: ChatSettings): string => {
    const previousCot = target.cotBuffer?.trim() ?? "";
    const lines: string[] = [];
    lines.unshift(sessionHeader(target).trimEnd());
    if (settings.showCot && previousCot) {
      const cot = previousCot.slice(-3500);
      lines.push(`<blockquote expandable>🧾 COT (${target.cotCount ?? 0})\n${esc(cot)}</blockquote>`);
    }
    lines.push("✅ <b>Done</b>");
    if (!settings.compactFinal) {
      if (settings.showThinking && !target.stopped && target.reasoningBuffer.trim()) {
        const r = target.reasoningBuffer.trim().slice(0, 3500);
        lines.push(`<blockquote${settings.thinkingExpanded ? "" : " expandable"}>🧠 Thinking\n` + esc(r) + "</blockquote>");
      }
      const shellDetails = target.toolCallDetails.filter((detail) => isShellTool(detail.name));
      const otherDetails = target.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
      const editDetails = target.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
      if (settings.showTools && settings.showShell && shellDetails.length) {
        const shellText = renderShell(shellDetails, 500);
        lines.push(`<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell (` + shellDetails.length + ")\n<pre language='bash'>" + esc(shellText) + "</pre></blockquote>");
      }
      if (settings.showTools && otherDetails.length) {
        const details = renderTools(otherDetails, 500);
        lines.push(`<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Tool calls (` + otherDetails.length + ")\n" + details + "</blockquote>");
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
      if (sum.length > 220) lines.push(`<blockquote expandable>📦 <b>Compaction</b>\n${esc(sum.slice(0, 2000))}</blockquote>`);
      else lines.push(`📦 <b>Compaction</b>: ${esc(sum)}`);
    }
    let resourceBlock = "";
    if (settings.showResourceUsage) {
      if (!target.cpuHistory) target.cpuHistory = [];
      if (!target.memHistory) target.memHistory = [];
      const cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
      const memPercent = readMemoryPercent();
      target.cpuHistory.push(cpuPercent);
      target.memHistory.push(memPercent);
      const limit = settings.resourceHistory;
      while (target.cpuHistory.length > limit) target.cpuHistory.shift();
      while (target.memHistory.length > limit) target.memHistory.shift();
      const cpuBar = progressBar(cpuPercent);
      const memBar = progressBar(memPercent);
      const prevCpu = target.cpuHistory.length >= 2 ? target.cpuHistory[target.cpuHistory.length - 2] : cpuPercent;
      const cpuTrend = cpuPercent > prevCpu ? " ↑" : cpuPercent < prevCpu ? " ↓" : "";
      const prevMem = target.memHistory.length >= 2 ? target.memHistory[target.memHistory.length - 2] : memPercent;
      const memTrend = memPercent > prevMem ? " ↑" : memPercent < prevMem ? " ↓" : "";
      const resourceLines: string[] = [];
      resourceLines.push(`CPU ${cpuBar} ${cpuPercent}%${cpuTrend}`);
      resourceLines.push(`RAM ${memBar} ${memPercent}%${memTrend}`);
      const gpu = readGpuInfo();
      if (gpu) {
        const vramPercent = Math.round((gpu.usedMB / gpu.totalMB) * 100);
        const vramBar = progressBar(vramPercent);
        const temp = gpu.temperature === null ? "" : ` · ${gpu.temperature}°C`;
        resourceLines.push(`GPU ${String(gpu.name).slice(0, 18)}`);
        resourceLines.push(`VRAM ${vramBar} ${vramPercent}%`);
        resourceLines.push(`Load ${progressBar(gpu.load)} ${gpu.load}%${temp}`);
      }
      resourceBlock = `<pre>${esc(resourceLines.join("\n"))}</pre>`;
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

  const showEditDiff = async (chatId: number, messageId: number, index: number): Promise<boolean> => {
    let s = pendingEdits.get(messageId);
    if (!s && store) {
      const sid = store.getPendingEditsSession(messageId);
      if (sid) s = store.sessionsById.get(sid);
    }
    if (!s) return false;
    pendingEdits.set(messageId, s);
    const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
    if (!editDetails[index]) return false;
    if (s.expandedEditIndex === index) s.expandedEditIndex = undefined;
    else s.expandedEditIndex = index;
    const settings = getSettings(chatId);
    const text = clampText(renderFinished(s, s.expandedEditIndex, settings));
    const keyboard = finishedKeyboard(editDetails, s.expandedEditIndex, s, messageId);
    await tg.editRichMessage(chatId, messageId, text, {
      ...threadOptsFor(s),
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => {});
    return true;
  };

  const sendFullDiffs = async (chatId: number, messageId: number, threadId?: number): Promise<boolean> => {
    let s = pendingEdits.get(messageId);
    if (!s && store) {
      const sid = store.getPendingEditsSession(messageId);
      if (sid) s = store.sessionsById.get(sid);
    }
    if (!s) return false;
    pendingEdits.set(messageId, s);
    const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
    if (!editDetails.length) return false;
    const settings = getSettings(chatId);
    const parts: string[] = [];
    for (const detail of editDetails) {
      const file = relativeEditPath(s, extractEditFile(detail.input) ?? "edit");
      const diff = formatEditDiff(detail.input, settings.diffStyle, s.directory);
      parts.push(`✏️ <b>${esc(file)}</b>\n<blockquote><pre><code class="language-diff">${esc(diff)}</code></pre></blockquote>`);
    }
    const full = parts.join("\n\n");
    const opts = threadOpts(threadId ?? s.targetThreadId ?? s.threadId);
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

  return { flushDraft, startStatus, updateStatus, finishStatus, showEditDiff, sendFullDiffs };
}
