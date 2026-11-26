import type { ChatSession } from "./types.js";
import type { DashboardManager } from "./dashboard.js";
import type { SessionStore } from "./store.js";
import type { TranscriptManager } from "./transcriptmanager.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSettings } from "./settings.js";
import { isEditTool, editStats } from "./editutil.js";
import { contextUsage, esc, isAgentMonologue, markdownToHtml, toolIcon, truncate } from "./util.js";
import { classifyFailure } from "./autoretry.js";

export function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * Render the live partial answer (model streaming buffer). The buffer often
 * contains shell commands / code mid-stream; showing it as a plain paragraph
 * cut mid-token produces unreadable fragments like "…mp -iname …". Instead:
 *  - keep COMPLETE lines from the tail (so a command is never sliced in half),
 *  - render as a code block when it looks like shell/code (no accidental
 *    Telegram markup interpretation), with an explicit truncation marker.
 */
export function renderPartialText(raw: string, max: number): string {
  const text = raw.trim();
  if (!text) return "";
  // Keep the WHOLE text: the answer has priority and must not be truncated.
  const truncated = text.length > max;
  const body = truncated ? text.slice(0, max) : text;
  // Shell/code heuristics: prompt markers, redirections, flags, common verbs.
  const looksLikeCode =
    /(^|\n)\s*[$>]\s/.test(text) ||
    /(^|\n)\s*(cd|ls|find|grep|cat|echo|python3?|node|bun|git|curl|npm|pip)\b/.test(text) ||
    /2>\/dev\/null|--?[a-z][a-z-]*\b|\|\s*\w+/.test(text);
  // No "…" marker: the blockquote is expandable and the answer continues in
  // the transcript; a marker here produced repeated ellipses in the card.
  const marker = "";
  if (looksLikeCode) {
    return `<p><i>💬 escribiendo…</i></p>\n<blockquote expandable><pre><code>${esc(marker + body)}</code></pre></blockquote>`;
  }
  return `<p><i>💬 escribiendo…</i></p>\n<blockquote expandable>${esc(marker + body)}</blockquote>`;
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
    // OpenCode 2.3's `execute` tool runs JS via { code }. Without this the
    // shell rendered just the tool name ("execute") instead of the code.
    if (parsed && typeof parsed.code === "string") return parsed.code;
    if (parsed && typeof parsed.script === "string") return parsed.script;
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
  // Truncated tool results (e.g. "[{\"type\":\"text\",\"text\":\"asy") must
  // still yield their text: do not require a closing quote.
  const matches = [...trimmed.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)/g)];
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

/**
 * Strip harness/tool noise that should never appear in the user-facing virtual
 * shell (e.g. the "There is no bash tool, so this ran as shell" harness notice).
 * Applied to every shell output before rendering.
 */
export function cleanShellOutput(output: string): string {
  const stripped = output
    .replace(/^\s*\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*/, "")
    .replace(/^\s*\{\s*"output"\s*:\s*/, "");
  return stripped
    .split(/\r?\n/)
    .filter((line) => !/there is no \"?bash\"? tool,? so this ran as \"?shell\"?/i.test(line))
    .join("\n")
    .trim();
}

function parseShellOutput(output: string): string | null {
  const text = parseToolOutput(output);
  return text ? cleanShellOutput(text) || null : null;
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
  /** IDs of sessions actually running in OpenCode (missing = idle). */
  ocActiveSessionIds?: () => Promise<Set<string>>;
};


export function isShellTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "shell" || normalized === "bash" || normalized === "sh" ||
    normalized === "execute" || normalized.includes("shell");
}

/**
 * Turn every tool call into a virtual-shell command line (`$ read file …`),
 * so reads, writes and web fetches read like shell invocations instead of
 * separate "tool" blocks. Consecutive identical commands are collapsed.
 */
export function renderVirtualShell(details: ChatSession["toolCallDetails"], limit: number): string {
  const toCommand = (name: string, input: string | undefined): string => {
    const n = (name || "").toLowerCase();
    const summary = getToolSummary(name, input);
    const arg = (summary.arg ?? "").toString().trim();
    const parsed = input ? parseToolInput(input) : undefined;
    const pathArg = parsed
      ? ["filePath", "file_path", "path", "filename", "file", "url", "uri"].map((k) => parsed[k]).find((v) => typeof v === "string") as string | undefined
      : undefined;
    const target = pathArg ?? arg;
    if (n === "skill") {
      const parsed = parseToolInput(input ?? "");
      const skillName = String(parsed?.name ?? parsed?.id ?? arg ?? "").trim();
      return skillName ? `skill ${skillName}` : "skill";
    }
    if (n === "execute") {
      // Code-execution tool: show the first meaningful line so the shell
      // block displays what ran instead of the bare tool name.
      const code = parseShellCommand(input ?? "");
      const firstLine = code?.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      return firstLine ? `execute ${firstLine}` : "execute";
    }
    if (isShellTool(name)) {
      // A leading "cd /repo && " is noise: strip it so the same command
      // issued in the same repo accumulates into one ($ cmd  (×N)) line.
      const raw = (parseShellCommand(input ?? "") ?? arg ?? name).trim();
      return raw.replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*/i, "");
    }
    if (n.includes("read") || n === "cat") return `read ${target}`.trim();
    if (n.includes("write")) return `write ${target}`.trim();
    // Keep edits distinct from writes: merging both into "$ write <path>" made
    // the virtual shell look like it was dropping tool calls.
    if (n.includes("edit") || n.includes("patch")) return `edit ${target}`.trim();
    if (n.includes("webfetch") || n.includes("fetch") || n.includes("web")) return `fetch ${target}`.trim();
    if (n.includes("grep") || n.includes("search")) return `grep ${target}`.trim();
    if (n.includes("glob") || n.includes("find") || n.includes("list") || n.includes("ls")) return `ls ${target}`.trim();
    return `${n}${target ? ` ${target}` : ""}`.trim();
  };

  // Accumulate identical commands globally (not just consecutive) so the
  // transcript shows one line per distinct command with its total count,
  // instead of overwriting/dropping earlier occurrences.
  const order: string[] = [];
  const counts = new Map<string, { count: number; last: ChatSession["toolCallDetails"][number] }>();
  for (const d of details) {
    // Skills are shown by renderSkillBlock, never as shell commands.
    if ((d.name || "").toLowerCase() === "skill") continue;
    const cmd = toCommand(d.name, d.input);
    const existing = counts.get(cmd);
    if (existing) {
      existing.count += 1;
      existing.last = d; // keep the latest status/output
    } else {
      counts.set(cmd, { count: 1, last: d });
      order.push(cmd);
    }
  }
  // Keep the most recent distinct commands; older ones collapse into a summary.
  const MAX_CMDS = 12;
  const hidden = Math.max(0, order.length - MAX_CMDS);
  const visible = hidden > 0 ? order.slice(-MAX_CMDS) : order;
  const lines: string[] = [];
  if (hidden > 0) lines.push(`… ${hidden} comando${hidden === 1 ? "" : "s"} anteriores`);
  for (const cmd of visible) {
    const entry = counts.get(cmd)!;
    const d = entry.last;
    const failed = d.status === "failed";
    const output = d.output ? cleanShellOutput((parseShellOutput(d.output) ?? d.output)).trim() : "";
    const normalized = cmd.replace(/\s+/g, " ").trim();
    const capped = normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized;
    const header = `$ ${capped}${entry.count > 1 ? `  (×${entry.count})` : ""}${failed ? "  ❌" : ""}`;
    lines.push(header);
    if (output && (failed || isShellTool(d.name))) {
      const outLines = output.split("\n");
      const MAX_OUT_LINES = 6;
      const shown = outLines.length > MAX_OUT_LINES
        ? `${outLines.slice(0, MAX_OUT_LINES).join("\n")}\n<i>… (+${outLines.length - MAX_OUT_LINES} líneas)</i>`
        : output;
      lines.push(truncateText(shown, limit));
    }
  }
  return lines.join("\n");
}

/** Activated skills as their own bottom line, not mixed into the shell. */
export function renderSkillBlock(details: ChatSession["toolCallDetails"]): string {
  const names = new Set<string>();
  for (const d of details) {
    if ((d.name || "").toLowerCase() !== "skill") continue;
    let name = "skill";
    try {
      const parsed = JSON.parse(d.input || "{}") as Record<string, unknown>;
      name = String(parsed.name ?? parsed.id ?? "skill");
    } catch { /* keep fallback */ }
    names.add(name);
  }
  if (!names.size) return "";
  return `<p><i>🧩 ${[...names].map((n) => esc(n)).join(" · ")}</i></p>`;
}

/** Compact toolcall statistics line with per-type icons, meant for the card footer. */
export function renderToolStats(details: ChatSession["toolCallDetails"]): string {
  if (!details.length) return "";
  const count = (pred: (d: ChatSession["toolCallDetails"][number]) => boolean): number =>
    details.filter(pred).length;
  const n = (name: string) => (d: ChatSession["toolCallDetails"][number]) => {
    const l = (d.name || "").toLowerCase();
    return name === "shell" ? isShellTool(d.name)
      : name === "read" ? l.includes("read") || l === "cat"
      : name === "edit" ? l.includes("edit") || l.includes("write") || l.includes("patch")
      : name === "fetch" ? l.includes("fetch") || l.includes("web")
      : name === "search" ? l.includes("grep") || l.includes("glob") || l.includes("search") || l.includes("find")
      : !/shell|read|cat|edit|write|patch|fetch|web|grep|glob|search|find/.test(l);
  };
  const failed = count((d) => d.status === "failed");
  const parts = [
    `🔧 ${details.length}`,
    `⚡${count(n("shell"))}`,
    `📖${count(n("read"))}`,
    `✏️${count(n("edit"))}`,
    `🌐${count(n("fetch"))}`,
    `🔍${count(n("search"))}`,
  ];
  if (failed) parts.push(`❌${failed}`);
  return parts.join(" · ");
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
    // A friendly classification first, then the raw detail: "Provider
    // returned error" alone told the user nothing actionable.
    const failure = classifyFailure(input.error);
    if (failure.kind !== "unknown") lines.push(`<i>${esc(failure.label)}</i>`);
    const line = firstMeaningfulLine(input.error, 180);
    if (line && line !== failure.label) lines.push(`<i>${esc(line)}</i>`);
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


/**
 * Compact one-line turn footer, modeled after OpenCode's own TUI receipt:
 *   Build · Hy4 flash Free · 2m 55s · 164.1 tok/s · 1m 14s ttft
 * Rendered once, at the very bottom of the card (above resources/id).
 */
export function renderTurnFooter(input: {
  mode: string;
  model?: { providerID?: string; id?: string; variant?: string };
  durationMs: number;
  outputTokens: number;
  firstStreamedAt?: number;
  promptStartTime?: number;
  tools: number;
}): string {
  // No state emoji here: the receipt already carries the single "✅ Listo" /
  // "⏹ Detenido" / "⚠️ Error" badge. OpenCode's own footer has no checkmark.
  const model = input.model
    ? `${input.model.providerID ?? ""}/${input.model.id ?? ""}${input.model.variant ? ` (${input.model.variant})` : ""}`
    : "—";
  const dur = input.durationMs > 0 ? formatDuration(input.durationMs) : "—";
  const speed = input.durationMs > 0 && input.outputTokens > 0
    ? `${(input.outputTokens / (input.durationMs / 1000)).toFixed(1)} tok/s`
    : "—";
  const ttft = input.firstStreamedAt && input.promptStartTime && input.firstStreamedAt > input.promptStartTime
    ? formatDuration(input.firstStreamedAt - input.promptStartTime)
    : "—";
  const parts = [
    esc(input.mode),
    esc(model),
    dur,
    speed,
    `ttft ${ttft}`,
    `🔧 ${input.tools}`,
  ];
  return `<p><i>${parts.join(" · ")}</i></p>`;
}

/** Live "thinking" block shown at the bottom while a turn is in progress. */
export function renderThinkingBottom(s: ChatSession, settings: ChatSettings): string {
  if (!settings.showThinking || !settings.showLatestThought || !s.reasoningBuffer.trim() || s.stopped) return "";
  const tail = s.reasoningBuffer.trim().slice(-1600);
  return `💭 <b>Pensando…</b>\n<blockquote expandable><mark>${markdownToHtml(tail)}</mark></blockquote>`;
}

/** Live block with the most recent tool call shown at the bottom of the card. */
export function renderLatestToolBottom(s: ChatSession, settings: ChatSettings): string {
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
  // Keep only the first meaningful line, capped: multi-line heredocs and long
  // pipelines must never be dumped verbatim into the card.
  const firstLine = commandText.split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine.length > 120) commandText = `${firstLine.slice(0, 117)}…`;
  else commandText = firstLine;
  const header = `${statusEmoji} <b>Última herramienta:</b> ${esc(displayName)}`;
  if (!commandText) return header;
  return `${header}\n<pre><code>${esc(commandText)}</code></pre>`;
}

/** Last reasoning chunk accumulated for this turn (COT segments are joined with ---). */
export function lastReasoning(s: ChatSession): string {
  const cot = s.cotBuffer?.trim() ?? "";
  if (!cot) return "";
  const entries = cot.split(/\n\n---\n\n/).map((e) => e.trim()).filter(Boolean);
  // Reuse the shared filter (the old inline regex had literal backspaces).
  // It is reasoning ABOUT the task, not useful context for the card.
  const useful = entries.filter((e) => !isAgentMonologue(e));
  const chosen = useful.length ? useful : entries.filter((e) => !/^(need|todo|note)\b/i.test(e));
  return (chosen.pop() ?? "").trim();
}
