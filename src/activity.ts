/**
 * Per-turn activity summary for the session card, inspired by OpenCode 2.3.0's
 * compact transcript (`−3 thoughts, 3 reads, 1 tool`). Counters and a bounded
 * list of entries are kept in memory per turn; the renderer produces one
 * compact line plus a single native Telegram `<blockquote expandable>` so no
 * extra messages or callbacks are needed.
 */
import { isBusCallText, isBusToolName } from "./busplugin.js";
import { esc, executeCodeSummary, isFormTool, stripAgentMonologue } from "./util.js";
import { describeToolInput } from "./editutil.js";
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
  /** Original tool name, needed to recognize forms after labelFor(). */
  toolName?: string;
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
    case "thought": return "Pensamiento";
    case "read": return "Lectura";
    case "search": return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Búsqueda";
    case "edit": return "Edición";
    case "shell": return "Shell";
    default: return isFormTool(name) ? "Formulario" : (name || "Herramienta");
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
  const id = push(a, { kind: "thought", label: "Pensamiento", detail, at, open: true });
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
    detail: isFormTool(name) ? input : toolDetail(kind, input),
    at,
    open: true,
    toolId: opts.toolId,
    toolName: name,
  });
}

/** Pull the actual command out of a shell tool's JSON/array input. */
function shellCommand(input: string): string {
  const trimmed = (input || "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["command", "cmd"]) {
        if (typeof obj[key] === "string") return obj[key] as string;
      }
    }
    if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === "string") return parsed.join(" ");
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return trimmed;
}

/** Turn a tool's raw input into a short human-readable detail. */
function toolDetail(kind: ActivityKind, input: string): string {
  if (kind === "shell") return shellCommand(input);
  if (kind === "read" || kind === "edit" || kind === "search") {
    const target = describeToolInput(input);
    if (kind === "search") return target.hint || target.file || input;
    return target.file ? (target.hint ? `${target.file}:${target.hint}` : target.file) : input;
  }
  const code = executeCodeSummary(input);
  return code || input;
}

type FormQuestion = { header?: unknown; question?: unknown; options?: unknown };

function parseFormQuestions(input: string): FormQuestion[] | undefined {
  try {
    const parsed = JSON.parse(input) as { questions?: unknown };
    if (Array.isArray(parsed?.questions)) return parsed.questions as FormQuestion[];
  } catch {
    // Not JSON — fall through to the generic tool detail.
  }
  return undefined;
}

/** Rich HTML for the form question and its options (already escaped inside). */
function formDetailHtml(input: string, cap: number): string {
  const qs = parseFormQuestions(input);
  if (!qs?.length) return "";
  const lines: string[] = [];
  for (const q of qs.slice(0, 3)) {
    const header = String(q.header ?? "").trim();
    const text = String(q.question ?? "").trim();
    lines.push(`<p>${header ? `<b>${esc(truncate(header, 60))}</b> · ` : ""}<i>${esc(truncate(text, Math.max(cap, 160)))}</i></p>`);
    const options = Array.isArray(q.options) ? q.options : [];
    for (const o of options.slice(0, 5)) {
      const opt = o as { label?: unknown; description?: unknown };
      const label = String(opt?.label ?? "").trim();
      if (!label) continue;
      const desc = String(opt?.description ?? "").trim();
      lines.push(`<p>• ${esc(truncate(label, Math.max(cap, 140)))}${desc ? ` — ${esc(truncate(desc, 70))}` : ""}</p>`);
    }
  }
  return lines.join("");
}

/** Replace the placeholder detail with the real input from session.tool.called. */
export function updateToolDetail(a: TurnActivity, toolId: string, detail: string): void {
  const entry = [...a.entries].reverse().find((e) => e.toolId === toolId);
  if (entry) entry.detail = toolDetail(entry.kind, detail);
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

type ActivityBlock = { head: string; detail: string; expandable?: boolean };

function entryHead(e: ActivityEntry, now: number, showOpen = true): string {
  const status = e.ok === true ? " ✅" : e.ok === false ? " ❌" : e.open && showOpen ? " ⏳" : "";
  const duration = fmtDuration(e.durationMs ?? Math.max(0, now - e.at));
  const icon = isFormTool(e.toolName ?? e.label) ? "📋" : ICONS[e.kind];
  return `${icon} <b>${esc(e.label)}</b> · ${duration}${status}`;
}

function detailPara(text: string, detailCap: number): string {
  const clean = stripAgentMonologue(text.trim());
  if (!clean || detailCap <= 0) return "";
  return `<p><i>${esc(truncate(clean, detailCap))}</i></p>`;
}

/** Render the compact summary line plus one native expandable detail block. */
export function renderActivity(a: TurnActivity | undefined, verbosity: CardVerbosity, _finished: boolean, now = Date.now(), expanded = false, hideShells = false): string {
  if (!a) return "";
  // The counters live in the single final stats line of the card, never as
  // a loose summary row under the thought blocks.
  const detailCap = verbosity === "low" ? 0 : verbosity === "high" ? 360 : 90;
  // Collapsed stays compact (a handful of rows); the toggle reveals the rest.
  const maxEntries = expanded
    ? (verbosity === "low" ? 8 : verbosity === "high" ? MAX_ENTRIES : 12)
    : (verbosity === "low" ? 3 : verbosity === "high" ? 6 : 5);
  const visible = a.entries.slice(-maxEntries);
  const blocks: ActivityBlock[] = [];

  // Every thought of the turn goes into ONE native collapsible blockquote, so
  // the user taps to read them instead of scrolling a wall of text.
  const thoughts = visible.filter((e) => e.kind === "thought");
  if (thoughts.length) {
    const thoughtStatus = (t: ActivityEntry) => expanded
      ? (t.ok === true ? " ✅" : t.ok === false ? " ❌" : t.open ? " ⏳" : "")
      : "";
    const lines = thoughts.map((t) => `<p>💭 <b>${esc(t.label)}</b> · ${fmtDuration(t.durationMs ?? Math.max(0, now - t.at))}${thoughtStatus(t)}</p>${detailPara(t.detail, detailCap)}`);
    const thoughtBudget = expanded ? 1800 : 1400;
    let kept = lines;
    while (kept.length > 1 && kept.join("").length > thoughtBudget) kept = kept.slice(1);
    const detail = (kept.length !== lines.length ? "<p><i>Más anteriores</i></p>" : "") + kept.join("");
    blocks.push({ head: `💭 Pensamientos (${thoughts.length})`, detail, expandable: true });
  }

  // Every shell call of the turn goes into ONE terminal-like block, no matter
  // where it happened, so the card reads like a session transcript.
  const shells = visible.filter((e) => e.kind === "shell");

  let i = 0;
  while (i < visible.length) {
    const e = visible[i];
    if (e.kind === "shell" || e.kind === "thought" || e.kind === "edit" || e.label === "skill" || isBusCallText(e.detail) || isBusToolName(e.label)) { i++; continue; }
    if (e.kind === "read" || e.kind === "search") { i++; continue; }
    if (isFormTool(e.toolName ?? e.label)) {
      // Forms arrive as a JSON `questions` array: render the question and its
      // options instead of dumping the raw payload into the card.
      const form = formDetailHtml(e.detail, detailCap);
      blocks.push({ head: entryHead(e, now, expanded), detail: form || detailPara(e.detail, detailCap) });
      i++;
      continue;
    }
    blocks.push({ head: entryHead(e, now, expanded), detail: detailPara(e.detail, detailCap) });
    i++;
  }
  if (shells.length && !hideShells) {
    const last = shells[shells.length - 1];
    const status = last.ok === true ? " ✅" : last.ok === false ? " ❌" : expanded && shells.some((x) => x.open) ? " ⏳" : "";
    const duration = fmtDuration(last.durationMs ?? Math.max(0, now - last.at));
    const commands = shells
      .map((r) => `<p><code>$ ${esc(truncate(r.detail.trim() || r.label, detailCap || 80))}</code></p>`)
      .join("");
    blocks.push({ head: `${ICONS.shell} Shell (${shells.length}) · ${duration}${status}`, detail: commands });
  }

  // One expandable block per row gives a native +/- affordance for each thought,
  // edit and tool — the OpenCode 2.3.0 transcript behavior. The global toggle
  // switches every row at once for clients without native expandables.
  // Collapsed shows headers only: the global toggle reveals details inline, so
  // pressing it always produces a visible change even on clients that ignore
  // Telegram's native expandable blockquote.
  // expandable blocks (thoughts) are ALWAYS native collapsibles. Non-expandable
  // blocks (shell, reads, edits, tools) become native collapsibles too when
  // collapsed, so the user can tap to read their detail without pressing the
  // global "▾ Detalles" toggle.
  const renderBlock = (b: ActivityBlock): string =>
    b.expandable
      ? `<blockquote expandable>${b.head}${b.detail}</blockquote>`
      : expanded
        ? `<blockquote>${b.head}${b.detail}</blockquote>`
        : b.detail
          ? `<blockquote expandable>${b.head}${b.detail}</blockquote>`
          : `<blockquote>${b.head}</blockquote>`;
  const renderBody = (bs: ActivityBlock[]) => bs.map(renderBlock).join("\n");
  const budget = expanded ? 1800 : 1400;
  let kept = blocks;
  while (kept.length > 1 && renderBody(kept).length > budget) kept = kept.slice(1);
  if (kept.length !== blocks.length) kept = [{ head: "<i>Más anteriores</i>", detail: "" }, ...kept];

  return renderBody(kept);
}

/**
 * P1.2: a three-line pipeline of the latest real actions. Durations and the
 * spinner come from the same entries as the expandable detail, so the rail
 * never invents progress. The full detail stays behind ▾ Detalles.
 */
export function renderActionRail(a: TurnActivity | undefined, now = Date.now()): string {
  const entries = (a?.entries ?? []).filter((e) => e.kind !== "thought").slice(-3);
  if (!entries.length) return "";
  const lines = entries.map((e) => {
    const status = e.ok === true ? "✅" : e.ok === false ? "❌" : e.open ? "⏳" : "·";
    const detail = e.detail.trim() ? ` <code>${esc(truncate(e.detail.trim().replace(/[\r\n]/g, " "), 48))}</code>` : "";
    return `${status} ${ICONS[e.kind]} <b>${esc(e.label)}</b>${detail} · ${fmtDuration(e.durationMs ?? Math.max(0, now - e.at))}`;
  });
  return `⚡ <b>Últimas acciones</b><br/>${lines.join("<br/>")}`;
}
