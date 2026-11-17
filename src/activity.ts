/**
 * Per-turn activity summary for the session card, inspired by OpenCode 2.3.0's
 * compact transcript (`−3 thoughts, 3 reads, 1 tool`). Counters and a bounded
 * list of entries are kept in memory per turn; the renderer produces one
 * compact line plus a single native Telegram `<blockquote expandable>` so no
 * extra messages or callbacks are needed.
 */
import { esc } from "./util.js";
import type { CardVerbosity } from "./settings.js";

export type ActivityKind = "thought" | "read" | "search" | "edit" | "shell" | "tool";

export type ActivityEntry = {
  id: number;
  kind: ActivityKind;
  label: string;
  detail: string;
  at: number;
  durationMs?: number;
  ok?: boolean;
  open: boolean;
  toolId?: string;
};

export type TurnActivity = {
  thoughts: number;
  reads: number;
  searches: number;
  edits: number;
  shells: number;
  tools: number;
  entries: ActivityEntry[];
  nextId: number;
  openThoughtId?: number;
};

const MAX_ENTRIES = 40;

export function createTurnActivity(): TurnActivity {
  return { thoughts: 0, reads: 0, searches: 0, edits: 0, shells: 0, tools: 0, entries: [], nextId: 1 };
}

/** Classify a tool name into a compact counter bucket. */
export function toolCategory(name: string): ActivityKind {
  const n = (name || "").toLowerCase();
  if (n.includes("read") || n.includes("webfetch") || n.includes("fetch") || n === "cat") return "read";
  if (n.includes("grep") || n.includes("glob") || n.includes("search") || n.includes("find")) return "search";
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) return "edit";
  if (n.includes("shell") || n.includes("bash") || n === "sh") return "shell";
  return "tool";
}

function labelFor(name: string, kind: ActivityKind): string {
  switch (kind) {
    case "thought": return "Thought";
    case "read": return "Read";
    case "search": return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Search";
    case "edit": return "Edit";
    case "shell": return "Shell";
    default: return name || "Tool";
  }
}

function trim(a: TurnActivity): void {
  if (a.entries.length > MAX_ENTRIES) a.entries.splice(0, a.entries.length - MAX_ENTRIES);
}

function push(a: TurnActivity, entry: Omit<ActivityEntry, "id">): number {
  const id = a.nextId++;
  a.entries.push({ ...entry, id });
  trim(a);
  return id;
}

export function recordThought(a: TurnActivity, detail: string, opts: { at?: number } = {}): number {
  const at = opts.at ?? Date.now();
  const id = push(a, { kind: "thought", label: "Thought", detail, at, open: true });
  a.thoughts += 1;
  a.openThoughtId = id;
  return id;
}

export function recordThoughtDelta(a: TurnActivity, delta: string, opts: { at?: number } = {}): void {
  const at = opts.at ?? Date.now();
  let entry = a.openThoughtId === undefined ? undefined : a.entries.find((e) => e.id === a.openThoughtId);
  if (!entry) {
    recordThought(a, "", { at });
    entry = a.entries.find((e) => e.id === a.openThoughtId);
  }
  if (!entry) return;
  entry.detail += delta;
  entry.durationMs = Math.max(0, at - entry.at);
}

/** Close only thought entries, leaving running tools untouched. */
export function closeThoughts(a: TurnActivity, at = Date.now()): void {
  for (const e of a.entries) {
    if (e.kind !== "thought" || !e.open) continue;
    e.open = false;
    e.durationMs = Math.max(0, at - e.at);
  }
  a.openThoughtId = undefined;
}

/** Close every in-progress entry so finished cards show stable durations. */
export function closeOpen(a: TurnActivity, at = Date.now()): void {
  for (const e of a.entries) {
    if (!e.open) continue;
    e.open = false;
    e.durationMs = Math.max(0, at - e.at);
  }
  a.openThoughtId = undefined;
}

export function recordTool(a: TurnActivity, name: string, input: string, opts: { toolId?: string; at?: number } = {}): number {
  const at = opts.at ?? Date.now();
  const kind = toolCategory(name);
  switch (kind) {
    case "read": a.reads += 1; break;
    case "search": a.searches += 1; break;
    case "edit": a.edits += 1; break;
    case "shell": a.shells += 1; break;
    default: a.tools += 1; break;
  }
  return push(a, {
    kind,
    label: labelFor(name, kind),
    detail: input,
    at,
    open: true,
    toolId: opts.toolId,
  });
}

export function finishTool(a: TurnActivity, toolId: string, ok: boolean, opts: { at?: number } = {}): void {
  const at = opts.at ?? Date.now();
  const entry = [...a.entries].reverse().find((e) => e.toolId === toolId);
  if (!entry) return;
  entry.open = false;
  entry.ok = ok;
  entry.durationMs = Math.max(0, at - entry.at);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const ICONS: Record<ActivityKind, string> = {
  thought: "💭",
  read: "📖",
  search: "🔍",
  edit: "✏️",
  shell: "🖥",
  tool: "🔧",
};

function renderEntry(e: ActivityEntry, detailCap: number, now: number): string {
  const status = e.ok === true ? " ✅" : e.ok === false ? " ❌" : e.open ? " ⏳" : "";
  const duration = fmtDuration(e.durationMs ?? Math.max(0, now - e.at));
  const head = `${ICONS[e.kind]} <b>${esc(e.label)}</b> · ${duration}${status}`;
  const detail = e.detail.trim() && detailCap > 0 ? `\n   <i>${esc(truncate(e.detail.trim(), detailCap))}</i>` : "";
  return head + detail;
}

/** Render the compact summary line plus one native expandable detail block. */
export function renderActivity(a: TurnActivity | undefined, verbosity: CardVerbosity, finished: boolean, now = Date.now()): string {
  if (!a) return "";
  const parts: string[] = [];
  if (a.thoughts) parts.push(`${a.thoughts} ${a.thoughts === 1 ? "thought" : "thoughts"}`);
  if (a.reads) parts.push(`${a.reads} ${a.reads === 1 ? "read" : "reads"}`);
  if (a.searches) parts.push(`${a.searches} ${a.searches === 1 ? "search" : "searches"}`);
  if (a.edits) parts.push(`${a.edits} ${a.edits === 1 ? "edit" : "edits"}`);
  if (a.shells) parts.push(`${a.shells} ${a.shells === 1 ? "shell" : "shells"}`);
  if (a.tools) parts.push(`${a.tools} ${a.tools === 1 ? "tool" : "tools"}`);
  if (!parts.length) return "";

  const detailCap = verbosity === "low" ? 0 : verbosity === "high" ? 360 : 90;
  const maxEntries = verbosity === "low" ? 8 : verbosity === "high" ? MAX_ENTRIES : 12;
  const visible = a.entries.slice(-maxEntries);
  const lines: string[] = [];

  let i = 0;
  while (i < visible.length) {
    const e = visible[i];
    if (e.kind === "read" || e.kind === "search") {
      const run: ActivityEntry[] = [];
      while (i < visible.length && (visible[i].kind === "read" || visible[i].kind === "search")) run.push(visible[i++]);
      const reads = run.filter((r) => r.kind === "read").length;
      const searches = run.length - reads;
      const grouped: string[] = [];
      if (reads) grouped.push(`${reads} ${reads === 1 ? "read" : "reads"}`);
      if (searches) grouped.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
      lines.push(`→ Explored: ${grouped.join(", ")}`);
      for (const r of run) lines.push(renderEntry(r, detailCap, now));
    } else {
      lines.push(renderEntry(e, detailCap, now));
      i++;
    }
  }

  const prefix = finished ? "−" : "+";
  return `${prefix}${parts.join(" · ")}\n<blockquote expandable>\n${lines.join("\n")}\n</blockquote>`;
}
