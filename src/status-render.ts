import type { ChatSession } from "./types.js";
import type { DashboardManager } from "./dashboard.js";
import type { SessionStore } from "./store.js";
import type { TranscriptManager } from "./transcriptmanager.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSettings } from "./settings.js";
import { isEditTool, extractEditFile, formatEditDiff, editStats } from "./editutil.js";
import { clampText, contextUsage, esc, markdownToHtml, sessionHeader, stripRestatedPrompt, threadOpts, toolIcon, truncate } from "./util.js";

export function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function parseShellCommand(input: string): string | null {
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

export function parseToolInput(input: string | undefined): Record<string, unknown> | null {
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

export type ToolSummary = { arg: string; detail?: string };

export function getToolSummary(name: string, input: string | undefined): ToolSummary {
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

export function shortToolArg(arg: string, max = 90): string {
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
  pendingEdits: Map<string, ChatSession>;
  rememberCot: (sessionId: string, buffer: string, count: number) => void;
  rememberStatusMessage: (sessionId: string, chatId: number, threadId: number | undefined, messageId: number) => void;
  forgetStatusMessage: (sessionId: string) => void;
  store?: SessionStore;
  /** Session card: one paginated message per session. */
  transcript?: TranscriptManager;
  /** Pinned dashboard (M1) in unified mode. */
  dashboard?: DashboardManager;
  /** Recent MCP events per session (experimental, 2.3.0). */
  mcpEvents?: Map<string, Array<{ at: number; server: string; text: string }>>;
};


export function renderTools(details: ChatSession["toolCallDetails"], _limit: number, showToolInput = true): string {
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

export function isShellTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "shell" || normalized === "bash" || normalized === "sh" || normalized.includes("shell");
}

export function renderShell(details: ChatSession["toolCallDetails"], limit: number): string {
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
export function capDiff(diff: string, max: number): string {
  const lines = diff.split("\n");
  if (lines.length <= max) return diff;
  return lines.slice(0, max).join("\n") + `\n… (+${lines.length - max} more lines)`;
}


export function relativeEditPath(target: ChatSession, file: string | null): string {
  if (!file) return "edit";
  if (!target.directory) return file.split("/").pop() ?? file;
  const prefix = target.directory.endsWith("/") ? target.directory : target.directory + "/";
  if (file.startsWith(prefix)) return file.slice(prefix.length);
  return file.split("/").pop() ?? file;
}

/** Stable human duration for cards and receipts: 42s · 1m 42s · 2h 05m. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export type TestRunSummary = { command: string; ok: boolean; count?: number };

const TEST_COMMAND_RE =
  /(?:^|[\s;&|])(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|pytest|vitest|jest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|make\s+test/i;

/** Pick the last test command run this turn and guess whether it passed. */
export function detectTestRun(details: ChatSession["toolCallDetails"]): TestRunSummary | undefined {
  let found: TestRunSummary | undefined;
  for (const detail of details) {
    const command = parseShellCommand(detail.input ?? "") ?? detail.input?.trim() ?? "";
    if (!command || !TEST_COMMAND_RE.test(command)) continue;
    const output = parseToolOutput(detail.output ?? "");
    const count =
      output.match(/Tests:\s+(\d+)\s+passed/i)?.[1] ??
      output.match(/(\d+)\s+passed\b/i)?.[1] ??
      output.match(/(\d+)\s+pass\b/i)?.[1];
    const failures = Number(output.match(/(\d+)\s+fail(?:ed|s|ures?)?\b/i)?.[1] ?? 0);
    found = {
      command: truncate(command.replace(/\s+/g, " ").trim(), 60),
      ok: detail.status !== "failed" && failures === 0,
      count: count ? Number(count) : undefined,
    };
  }
  return found;
}

export function summarizeEdits(
  target: ChatSession,
  details: ChatSession["toolCallDetails"],
): { files: number; added: number; removed: number } {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const detail of details) {
    if (!isEditTool(detail.name, detail.input)) continue;
    const stats = editStats(detail.input);
    files.add(relativeEditPath(target, stats.file));
    added += stats.added;
    removed += stats.removed;
  }
  return { files: files.size, added, removed };
}

/** One telemetry line shared by the live card and the finished receipt. */
export function turnTelemetry(s: ChatSession, now = Date.now(), showSpeed = true): string[] {
  const parts: string[] = [];
  const start = s.promptStartTime;
  const end = s.statusFinished ? (s.turnFinishedAt ?? now) : now;
  if (start && end >= start) parts.push(`⏱ ${formatDuration(end - start)}`);
  const tokens = s.turnOutputTokens ?? s.lastOutputTokens ?? 0;
  if (showSpeed && tokens && s.turnFirstStreamedAt) {
    const seconds = Math.max(0.5, (end - s.turnFirstStreamedAt) / 1000);
    if (tokens >= 100) parts.push(`⚡ ${(tokens / seconds).toFixed(1)} tok/s`);
  }
  if (tokens) parts.push(`${formatTokenCount(tokens)} tok`);
  const usage = contextUsage(s.lastContextTokens, s.contextWindow);
  if (usage) parts.push(`${usage.over ? "⚠ " : ""}${usage.percent}% ctx`);
  return parts;
}

export type TurnReceiptInput = {
  stopped: boolean;
  error?: string;
  prompt?: string;
  edits?: { files: number; added: number; removed: number };
  test?: TestRunSummary;
  telemetry: string[];
};

/**
 * Turn receipt: what happened, what it cost and what changed. Rendered as the
 * first block of the finished card, so the user does not need to open details.
 */
export function renderTurnReceipt(input: TurnReceiptInput): string {
  const lines: string[] = [];
  lines.push(
    input.error
      ? "⚠️ <b>Turno interrumpido</b>"
      : input.stopped
        ? "⏹ <b>Detenido</b>"
        : "✅ <b>Listo</b>",
  );
  if (input.error?.trim()) {
    const line = firstMeaningfulLine(input.error, 180);
    if (line) lines.push(`<i>${esc(line)}</i>`);
  }
  if (input.telemetry.length) lines.push(`<i>${input.telemetry.join(" · ")}</i>`);
  if (input.prompt?.trim()) lines.push(`📝 <i>“${esc(truncate(input.prompt.trim(), 80))}”</i>`);
  if (input.edits && input.edits.files > 0) {
    const files = input.edits.files === 1 ? "1 archivo" : `${input.edits.files} archivos`;
    lines.push(`✏️ <b>${files}</b> · +${input.edits.added} −${input.edits.removed}`);
  }
  if (input.test) {
    const mark = input.test.ok ? "✓" : "✗";
    const count = input.test.count !== undefined ? ` · ${input.test.count} ${mark}` : ` ${mark}`;
    lines.push(`🧪 <code>${esc(input.test.command)}</code>${count}`);
  }
  return `<p>${lines.join("<br/>")}</p>`;
}

