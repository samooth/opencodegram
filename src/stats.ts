import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase } from "./db.js";
import type { ChatSession } from "./types.js";
import { detectTestRun, summarizeEdits } from "./status-render.js";
import { esc } from "./util.js";
import { toolCategory } from "./activity.js";

/**
 * Model/provider performance statistics.
 *
 * Every finished turn is written once to `turn_stats` (UPSERT keyed by
 * session+turn+start, so the final-answer update can enrich the row). The data
 * powers `/stats` and a self-contained responsive HTML report with no external
 * assets, so it can be shared or archived as a single file.
 */

export type StatsPeriod = "7d" | "30d" | "all";
export type StatsScope = "chat" | "all";
export type TurnStatStatus = "ok" | "error" | "stopped";

/** Counts and failures grouped by tool category. */
export type ToolCounts = {
  shell: { calls: number; failures: number };
  edit: { calls: number; failures: number };
  read: { calls: number; failures: number };
  search: { calls: number; failures: number };
  other: { calls: number; failures: number };
};

const emptyToolCounts = (): ToolCounts => ({
  shell: { calls: 0, failures: 0 },
  edit: { calls: 0, failures: 0 },
  read: { calls: 0, failures: 0 },
  search: { calls: 0, failures: 0 },
  other: { calls: 0, failures: 0 },
});

/** Classify a turn's tool calls into shell/edit/read/search/other with failures. */
export function countTools(details: Array<{ name: string; status?: string }> | undefined): ToolCounts {
  const out = emptyToolCounts();
  for (const d of details ?? []) {
    const kind = toolCategory(d.name);
    const bucket = kind === "shell" || kind === "edit" || kind === "read" || kind === "search"
      ? out[kind]
      : out.other;
    bucket.calls += 1;
    if (d.status === "failed") bucket.failures += 1;
  }
  return out;
}

export type TurnStatInput = {
  sessionId: string;
  turnSeq: number;
  chatId: number;
  threadId?: number;
  providerID: string;
  modelID: string;
  variant?: string;
  status: TurnStatStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  toolCalls?: number;
  toolFailures?: number;
  toolCounts?: ToolCounts;
  editFiles?: number;
  addedLines?: number;
  removedLines?: number;
  testRuns?: number;
  testOk?: number;
  promptChars?: number;
  outputChars?: number;
};

export type TurnStatRow = {
  id: number;
  session_id: string;
  turn_seq: number;
  started_at: number;
  finished_at: number;
  chat_id: number;
  thread_id: number | null;
  provider_id: string;
  model_id: string;
  variant: string | null;
  status: TurnStatStatus;
  duration_ms: number;
  first_token_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  tool_calls: number;
  tool_failures: number;
  shell_calls: number;
  shell_failures: number;
  edit_calls: number;
  edit_failures: number;
  read_calls: number;
  read_failures: number;
  search_calls: number;
  search_failures: number;
  other_calls: number;
  other_failures: number;
  edit_files: number;
  added_lines: number;
  removed_lines: number;
  test_runs: number;
  test_ok: number;
  prompt_chars: number;
  output_chars: number;
};

export type StatsSummary = {
  turns: number;
  ok: number;
  errors: number;
  stopped: number;
  /** 0..100 */
  successRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  toolCalls: number;
  toolFailures: number;
  tools: ToolCounts;
  /** Total wall-clock time across turns (ms) — the denominator for tool rates. */
  activeMs: number;
  /** Tool calls per minute of turn wall time. */
  toolsPerMin: number;
  editFiles: number;
  addedLines: number;
  removedLines: number;
  testRuns: number;
  testOk: number;
  /** Output tokens per second over turns that reported a duration. */
  tokPerSec: number;
  avgTokensPerTurn: number;
  costPerTurn: number;
  avgFirstTokenMs: number;
};

export type ModelStats = StatsSummary & {
  key: string;
  providerID: string;
  modelID: string;
  variant?: string;
};

export type ProviderStats = StatsSummary & { providerID: string };

export type DayStats = {
  date: string;
  turns: number;
  ok: number;
  outputTokens: number;
  cost: number;
};

export type StatsData = {
  totals: StatsSummary;
  models: ModelStats[];
  providers: ProviderStats[];
  days: DayStats[];
  recent: TurnStatRow[];
  generatedAt: number;
  firstAt?: number;
  lastAt?: number;
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Insert or enrich the row for one finished turn. Safe to call twice. */
export function recordTurnStat(input: TurnStatInput, dataDir?: string): void {
  const db = getDatabase(dataDir);
  const startedAt = input.startedAt;
  const tc = input.toolCounts ?? emptyToolCounts();
  db.run(
    `INSERT INTO turn_stats (
      session_id, turn_seq, started_at, finished_at, chat_id, thread_id,
      provider_id, model_id, variant, status, duration_ms, first_token_ms,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
      cost, tool_calls, tool_failures,
      shell_calls, shell_failures, edit_calls, edit_failures, read_calls, read_failures,
      search_calls, search_failures, other_calls, other_failures,
      edit_files, added_lines, removed_lines,
      test_runs, test_ok, prompt_chars, output_chars
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_seq, started_at) DO UPDATE SET
      finished_at = excluded.finished_at,
      status = excluded.status,
      duration_ms = excluded.duration_ms,
      first_token_ms = COALESCE(excluded.first_token_ms, turn_stats.first_token_ms),
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cost = excluded.cost,
      tool_calls = excluded.tool_calls,
      tool_failures = excluded.tool_failures,
      shell_calls = excluded.shell_calls,
      shell_failures = excluded.shell_failures,
      edit_calls = excluded.edit_calls,
      edit_failures = excluded.edit_failures,
      read_calls = excluded.read_calls,
      read_failures = excluded.read_failures,
      search_calls = excluded.search_calls,
      search_failures = excluded.search_failures,
      other_calls = excluded.other_calls,
      other_failures = excluded.other_failures,
      edit_files = excluded.edit_files,
      added_lines = excluded.added_lines,
      removed_lines = excluded.removed_lines,
      test_runs = excluded.test_runs,
      test_ok = excluded.test_ok,
      prompt_chars = excluded.prompt_chars,
      output_chars = excluded.output_chars`,
    input.sessionId,
    input.turnSeq,
    startedAt,
    input.finishedAt,
    input.chatId,
    input.threadId ?? null,
    input.providerID || "unknown",
    input.modelID || "unknown",
    input.variant ?? null,
    input.status,
    Math.max(0, Math.round(input.durationMs)),
    input.firstTokenMs !== undefined ? Math.max(0, Math.round(input.firstTokenMs)) : null,
    Math.max(0, Math.round(num(input.inputTokens))),
    Math.max(0, Math.round(num(input.outputTokens))),
    Math.max(0, Math.round(num(input.reasoningTokens))),
    Math.max(0, Math.round(num(input.cacheReadTokens))),
    Math.max(0, Math.round(num(input.cacheWriteTokens))),
    Math.max(0, num(input.cost)),
    Math.max(0, Math.round(num(input.toolCalls))),
    Math.max(0, Math.round(num(input.toolFailures))),
    Math.max(0, Math.round(num(tc.shell.calls))),
    Math.max(0, Math.round(num(tc.shell.failures))),
    Math.max(0, Math.round(num(tc.edit.calls))),
    Math.max(0, Math.round(num(tc.edit.failures))),
    Math.max(0, Math.round(num(tc.read.calls))),
    Math.max(0, Math.round(num(tc.read.failures))),
    Math.max(0, Math.round(num(tc.search.calls))),
    Math.max(0, Math.round(num(tc.search.failures))),
    Math.max(0, Math.round(num(tc.other.calls))),
    Math.max(0, Math.round(num(tc.other.failures))),
    Math.max(0, Math.round(num(input.editFiles))),
    Math.max(0, Math.round(num(input.addedLines))),
    Math.max(0, Math.round(num(input.removedLines))),
    Math.max(0, Math.round(num(input.testRuns))),
    Math.max(0, Math.round(num(input.testOk))),
    Math.max(0, Math.round(num(input.promptChars))),
    Math.max(0, Math.round(num(input.outputChars))),
  );
}

export function periodStart(period: StatsPeriod, now = Date.now()): number | undefined {
  if (period === "all") return undefined;
  const days = period === "7d" ? 7 : 30;
  return now - days * 86_400_000;
}

export type StatsFilter = {
  period?: StatsPeriod;
  scope?: StatsScope;
  chatId?: number;
  now?: number;
  dataDir?: string;
};

type Mutable = {
  key: string;
  providerID: string;
  modelID?: string;
  variant?: string;
  turns: number;
  ok: number;
  errors: number;
  stopped: number;
  durationMs: number;
  durations: number[];
  firstTokens: number[];
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolCalls: number;
  toolFailures: number;
  tools: ToolCounts;
  editFiles: number;
  added: number;
  removed: number;
  testRuns: number;
  testOk: number;
  speedMs: number;
  speedOutput: number;
  /** Wall time from first streamed token to finish (the generation window). */
  genMs: number;
  genOutput: number;
  activeMs: number;
};

function mutable(key: string, providerID: string, modelID?: string, variant?: string): Mutable {
  return {
    key, providerID, modelID, variant,
    turns: 0, ok: 0, errors: 0, stopped: 0,
    durationMs: 0, durations: [], firstTokens: [],
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    toolCalls: 0, toolFailures: 0, tools: emptyToolCounts(), editFiles: 0, added: 0, removed: 0,
    testRuns: 0, testOk: 0, speedMs: 0, speedOutput: 0, genMs: 0, genOutput: 0, activeMs: 0,
  };
}

function addRow(bucket: Mutable, row: TurnStatRow): void {
  bucket.turns += 1;
  if (row.status === "ok") bucket.ok += 1;
  else if (row.status === "stopped") bucket.stopped += 1;
  else bucket.errors += 1;
  const duration = Math.max(0, num(row.duration_ms));
  if (duration > 0) {
    bucket.durationMs += duration;
    bucket.durations.push(duration);
  }
  if (timeFinite(row.first_token_ms) && num(row.first_token_ms) > 0) bucket.firstTokens.push(num(row.first_token_ms));
  bucket.input += num(row.input_tokens);
  bucket.output += num(row.output_tokens);
  bucket.reasoning += num(row.reasoning_tokens);
  bucket.cacheRead += num(row.cache_read_tokens);
  bucket.cacheWrite += num(row.cache_write_tokens);
  bucket.cost += num(row.cost);
  const rowCalls = {
    shell: num(row.shell_calls), edit: num(row.edit_calls), read: num(row.read_calls),
    search: num(row.search_calls), other: num(row.other_calls),
  };
  const rowFails = {
    shell: num(row.shell_failures), edit: num(row.edit_failures), read: num(row.read_failures),
    search: num(row.search_failures), other: num(row.other_failures),
  };
  // Old rows have a legacy total but no per-category data. Fold the difference
  // into "other" so the breakdown always adds up (these calls predate
  // categorization, so their type is genuinely unknown).
  const categorizedCalls = rowCalls.shell + rowCalls.edit + rowCalls.read + rowCalls.search + rowCalls.other;
  const categorizedFails = rowFails.shell + rowFails.edit + rowFails.read + rowFails.search + rowFails.other;
  const totalCalls = Math.max(num(row.tool_calls), categorizedCalls);
  const totalFails = Math.max(num(row.tool_failures), categorizedFails);
  rowCalls.other += Math.max(0, totalCalls - categorizedCalls);
  rowFails.other += Math.max(0, totalFails - categorizedFails);
  bucket.toolCalls += totalCalls;
  bucket.toolFailures += totalFails;
  bucket.tools.shell.calls += rowCalls.shell;
  bucket.tools.shell.failures += rowFails.shell;
  bucket.tools.edit.calls += rowCalls.edit;
  bucket.tools.edit.failures += rowFails.edit;
  bucket.tools.read.calls += rowCalls.read;
  bucket.tools.read.failures += rowFails.read;
  bucket.tools.search.calls += rowCalls.search;
  bucket.tools.search.failures += rowFails.search;
  bucket.tools.other.calls += rowCalls.other;
  bucket.tools.other.failures += rowFails.other;
  // Wall time of the turn: prefer the persisted duration, fall back to the
  // finished−started delta for old rows.
  bucket.activeMs += duration > 0 ? duration : Math.max(0, num(row.finished_at) - num(row.started_at));
  bucket.editFiles += num(row.edit_files);
  bucket.added += num(row.added_lines);
  bucket.removed += num(row.removed_lines);
  bucket.testRuns += num(row.test_runs);
  bucket.testOk += num(row.test_ok);
  if (duration > 0 && num(row.output_tokens) > 0) {
    bucket.speedMs += duration;
    bucket.speedOutput += num(row.output_tokens);
    // Generation speed uses the same window as the live card: first token →
    // finish. Rows without a first-token timestamp are excluded (their window
    // is unknowable), so the rate stays comparable across models.
    if (timeFinite(row.first_token_ms)) {
      const genWindow = Math.max(500, duration - num(row.first_token_ms));
      bucket.genMs += genWindow;
      bucket.genOutput += num(row.output_tokens);
    }
  }
}

function timeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)));
  return sorted[idx];
}

function finalize(bucket: Mutable): StatsSummary {
  const durations = [...bucket.durations].sort((a, b) => a - b);
  const firstTokens = [...bucket.firstTokens].sort((a, b) => a - b);
  return {
    turns: bucket.turns,
    ok: bucket.ok,
    errors: bucket.errors,
    stopped: bucket.stopped,
    successRate: bucket.turns ? (bucket.ok / bucket.turns) * 100 : 0,
    avgMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    inputTokens: bucket.input,
    outputTokens: bucket.output,
    reasoningTokens: bucket.reasoning,
    cacheReadTokens: bucket.cacheRead,
    cacheWriteTokens: bucket.cacheWrite,
    cost: bucket.cost,
    toolCalls: bucket.toolCalls,
    toolFailures: bucket.toolFailures,
    tools: bucket.tools,
    activeMs: bucket.activeMs,
    toolsPerMin: bucket.activeMs > 0 ? (bucket.toolCalls / (bucket.activeMs / 60000)) : 0,
    editFiles: bucket.editFiles,
    addedLines: bucket.added,
    removedLines: bucket.removed,
    testRuns: bucket.testRuns,
    testOk: bucket.testOk,
    // Matches the live card: output tokens / (first-token → finish window).
    tokPerSec: bucket.genMs > 0 ? bucket.genOutput / (bucket.genMs / 1000) : 0,
    avgTokensPerTurn: bucket.turns ? bucket.output / bucket.turns : 0,
    costPerTurn: bucket.turns ? bucket.cost / bucket.turns : 0,
    avgFirstTokenMs: firstTokens.length ? firstTokens.reduce((a, b) => a + b, 0) / firstTokens.length : 0,
  };
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Read and aggregate the turn history. */
export function collectStats(filter: StatsFilter = {}): StatsData {
  const db = getDatabase(filter.dataDir);
  const period = filter.period ?? "7d";
  const scope = filter.scope ?? "chat";
  const since = periodStart(period, filter.now);
  const where: string[] = [];
  const params: Array<number | string> = [];
  if (since !== undefined) {
    where.push("finished_at >= ?");
    params.push(since);
  }
  if (scope === "chat" && filter.chatId !== undefined) {
    where.push("chat_id = ?");
    params.push(filter.chatId);
  }
  const sql = `SELECT * FROM turn_stats ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY finished_at DESC LIMIT 20000`;
  const rows = db.query(sql).all(...params) as TurnStatRow[];

  const modelBuckets = new Map<string, Mutable>();
  const providerBuckets = new Map<string, Mutable>();
  const dayBuckets = new Map<string, DayStats>();
  const totals = mutable("all", "all");

  for (const row of rows) {
    const providerID = row.provider_id || "unknown";
    const modelID = row.model_id || "unknown";
    const variant = row.variant ?? undefined;
    const key = `${providerID}/${modelID}${variant ? `#${variant}` : ""}`;
    let model = modelBuckets.get(key);
    if (!model) {
      model = mutable(key, providerID, modelID, variant);
      modelBuckets.set(key, model);
    }
    addRow(model, row);
    let provider = providerBuckets.get(providerID);
    if (!provider) {
      provider = mutable(providerID, providerID);
      providerBuckets.set(providerID, provider);
    }
    addRow(provider, row);
    addRow(totals, row);

    const date = dayKey(num(row.finished_at));
    const day = dayBuckets.get(date) ?? { date, turns: 0, ok: 0, outputTokens: 0, cost: 0 };
    day.turns += 1;
    if (row.status === "ok") day.ok += 1;
    day.outputTokens += num(row.output_tokens);
    day.cost += num(row.cost);
    dayBuckets.set(date, day);
  }

  const models = [...modelBuckets.values()]
    .map((bucket) => ({ ...finalize(bucket), key: bucket.key, providerID: bucket.providerID, modelID: bucket.modelID ?? "unknown", variant: bucket.variant }))
    .sort((a, b) => b.turns - a.turns || b.successRate - a.successRate);
  const providers = [...providerBuckets.values()]
    .map((bucket) => ({ ...finalize(bucket), providerID: bucket.providerID }))
    .sort((a, b) => b.turns - a.turns);

  // Continuous timeline (fills inactive days with zero) capped to 120 days.
  const dayList: DayStats[] = [];
  if (rows.length) {
    const timestamps = rows.map((r) => num(r.finished_at)).filter((n) => n > 0);
    const newest = Math.max(...timestamps);
    const oldest = Math.min(...timestamps);
    const start = new Date(oldest);
    start.setHours(0, 0, 0, 0);
    const end = new Date(newest);
    end.setHours(0, 0, 0, 0);
    const first = Math.max(start.getTime(), end.getTime() - 119 * 86_400_000);
    for (let t = first; t <= end.getTime(); t += 86_400_000) {
      const key = dayKey(t);
      dayList.push(dayBuckets.get(key) ?? { date: key, turns: 0, ok: 0, outputTokens: 0, cost: 0 });
    }
  }

  return {
    totals: finalize(totals),
    models,
    providers,
    days: dayList,
    recent: rows.slice(0, 40),
    generatedAt: Date.now(),
    firstAt: rows.length ? Math.min(...rows.map((r) => num(r.finished_at)).filter((n) => n > 0)) : undefined,
    lastAt: rows.length ? Math.max(...rows.map((r) => num(r.finished_at)).filter((n) => n > 0)) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const int = (n: number): string => Math.round(n).toLocaleString("es-ES");

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return int(n);
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function fmtCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

const pct = (n: number): string => `${n.toFixed(n >= 99.95 || n === 0 ? 0 : 1)}%`;

function modelName(m: { providerID: string; modelID: string; variant?: string }): string {
  return `${m.providerID}/${m.modelID}${m.variant ? ` (${m.variant})` : ""}`;
}

function periodLabel(period: StatsPeriod): string {
  return period === "7d" ? "últimos 7 días" : period === "30d" ? "últimos 30 días" : "histórico completo";
}

// ---------------------------------------------------------------------------
// Telegram panel
// ---------------------------------------------------------------------------

const MEDALS = ["🥇", "🥈", "🥉"];

export type StatsPanelOpts = {
  period: StatsPeriod;
  scope: StatsScope;
  isAdmin: boolean;
};

export function renderStatsPanel(data: StatsData, opts: StatsPanelOpts): {
  html: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const bar = (value: number, width = 8): string => {
    const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
    return "▰".repeat(filled) + "▱".repeat(width - filled);
  };
  const scopeLabel = opts.scope === "all" ? "todos los chats" : "este chat";
  const turnsLabel = (n: number): string => `${int(n)} ${n === 1 ? "turno" : "turnos"}`;
  const lines: string[] = [
    "📊 <b>Rendimiento de modelos</b>",
    `<i>${periodLabel(opts.period)} · ${scopeLabel}</i>`,
  ];
  if (!data.totals.turns) {
    lines.push(
      "",
      "<blockquote>Todavía no hay turnos registrados.\n<i>En cuanto termine el próximo turno aparecerán aquí latencia, tokens, coste y tasa de éxito por modelo.</i></blockquote>",
    );
  } else {
    const t = data.totals;
    lines.push(
      "",
      "<b>Indicadores</b>",
      "<table compact striped>",
      `<tr><td>✅ Éxito</td><td><b>${pct(t.successRate)}</b></td><td>🔄 Turnos</td><td><b>${int(t.turns)}</b></td></tr>`,
      `<tr><td>⏱ Media</td><td><b>${fmtMs(t.avgMs)}</b></td><td>p95</td><td><b>${fmtMs(t.p95Ms)}</b></td></tr>`,
      `<tr><td>⚡ Velocidad</td><td><b>${t.tokPerSec.toFixed(1)} tok/s</b></td><td>💵 Coste</td><td><b>${fmtCost(t.cost)}</b></td></tr>`,
      `<tr><td>🧠 Salida</td><td><b>${fmtTokens(t.outputTokens)}</b></td><td>🔧 Herram.</td><td><b>${int(t.toolCalls)}${t.toolFailures ? ` (${int(t.toolFailures)}✗)` : ""}</b></td></tr>`,
      "</table>",
      "",
      "<b>Herramientas por modelo</b>",
      "<i>Sh=shell · Ed=edit · Le=read · Bu=búsqueda · Ot=otras. El número es el total de llamadas; <code>✗N</code> son fallos. /min = llamadas por minuto de turno.</i>",
      "<table compact striped>",
      "<tr><td>Modelo</td><td>tok/s</td><td>Sh</td><td>Ed</td><td>Le</td><td>Bu</td><td>Ot</td><td>/min</td></tr>",
    );
    const toolCell = (calls: number, failures: number): string =>
      calls === 0 && failures === 0 ? "—" : `${int(calls)}${failures ? `<small>✗${int(failures)}</small>` : ""}`;
    const shortName = (m: ModelStats): string => {
      const full = `${m.providerID}/${m.modelID}`;
      return full.length > 22 ? `${full.slice(0, 21)}…` : full;
    };
    for (const m of data.models.slice(0, 6)) {
      lines.push(
        `<tr><td><code>${esc(shortName(m))}</code></td>`,
        `<td>${m.tokPerSec ? m.tokPerSec.toFixed(0) : "—"}</td>`,
        `<td>${toolCell(m.tools.shell.calls, m.tools.shell.failures)}</td>`,
        `<td>${toolCell(m.tools.edit.calls, m.tools.edit.failures)}</td>`,
        `<td>${toolCell(m.tools.read.calls, m.tools.read.failures)}</td>`,
        `<td>${toolCell(m.tools.search.calls, m.tools.search.failures)}</td>`,
        `<td>${toolCell(m.tools.other.calls, m.tools.other.failures)}</td>`,
        `<td>${m.toolsPerMin ? m.toolsPerMin.toFixed(1) : "—"}</td></tr>`,
      );
    }
    // Totals row so the breakdown always reconciles with the KPIs above.
    lines.push(
      `<tr><td><b>TOTAL</b></td>`,
      `<td><b>${t.tokPerSec ? t.tokPerSec.toFixed(0) : "—"}</b></td>`,
      `<td>${toolCell(t.tools.shell.calls, t.tools.shell.failures)}</td>`,
      `<td>${toolCell(t.tools.edit.calls, t.tools.edit.failures)}</td>`,
      `<td>${toolCell(t.tools.read.calls, t.tools.read.failures)}</td>`,
      `<td>${toolCell(t.tools.search.calls, t.tools.search.failures)}</td>`,
      `<td>${toolCell(t.tools.other.calls, t.tools.other.failures)}</td>`,
      `<td>${t.toolsPerMin ? t.toolsPerMin.toFixed(1) : "—"}</td></tr>`,
    );
    lines.push("</table>");
    lines.push("", "<b>Detalle por modelo</b>");
    for (const [idx, m] of data.models.slice(0, 5).entries()) {
      const medal = MEDALS[idx] ?? `${idx + 1}.`;
      lines.push(
        `<blockquote expandable>${medal} <code>${esc(modelName(m))}</code>`,
        `<b>${pct(m.successRate)}</b> ${bar(m.successRate)} · ${turnsLabel(m.turns)}`,
        `<i>⏱ ${fmtMs(m.avgMs)} (p95 ${fmtMs(m.p95Ms)}) · ⚡ ${m.tokPerSec.toFixed(0)} tok/s · 💵 ${fmtCost(m.cost)}</i>`,
        `<i>✏️ ${int(m.editFiles)} archivos · +${int(m.addedLines)}/−${int(m.removedLines)} líneas · 🧪 ${int(m.testOk)}/${int(m.testRuns)} tests</i></blockquote>`,
      );
    }
    if (data.models.length > 5) lines.push(`<i>… y ${data.models.length - 5} modelos más en el reporte HTML.</i>`);
    if (data.providers.length) {
      lines.push("", "<b>🌐 Proveedores</b>");
      for (const p of data.providers.slice(0, 5)) {
        const share = t.turns ? (p.turns / t.turns) * 100 : 0;
        const models = data.models.filter((m) => m.providerID === p.providerID).length;
        lines.push(
          `<blockquote expandable><b>${esc(p.providerID)}</b> · ${models} ${models === 1 ? "modelo" : "modelos"}`,
          `${bar(share)} <b>${pct(share)}</b> del tráfico · ${turnsLabel(p.turns)}`,
          `<i>✅ ${pct(p.successRate)} · ⏱ ${fmtMs(p.avgMs)} (p95 ${fmtMs(p.p95Ms)}) · ⚡ ${p.tokPerSec.toFixed(1)} tok/s · 💵 ${fmtCost(p.cost)}</i>`,
          `<i>🧠 ${fmtTokens(p.outputTokens)} salida · ${fmtTokens(p.inputTokens)} entrada · 🔧 ${int(p.toolCalls)}${p.toolFailures ? ` (${int(p.toolFailures)}✗)` : ""}</i></blockquote>`,
        );
      }
      if (data.providers.length > 5) lines.push(`<i>… y ${data.providers.length - 5} proveedores más en el reporte HTML.</i>`);
    }
  }
  lines.push("", "<i>📄 El reporte HTML es un archivo único, responsive y sin dependencias externas.</i>");

  const mark = (v: boolean) => (v ? "• " : "");
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
    [
      { text: `${mark(opts.period === "7d")}7 días`, callback_data: "stats:period:7d" },
      { text: `${mark(opts.period === "30d")}30 días`, callback_data: "stats:period:30d" },
      { text: `${mark(opts.period === "all")}Todo`, callback_data: "stats:period:all" },
    ],
    [
      { text: "📄 Reporte HTML", callback_data: `stats:export:${opts.period}:${opts.scope}` },
      { text: "🔄 Actualizar", callback_data: `stats:refresh:${opts.period}:${opts.scope}` },
    ],
  ];
  if (opts.isAdmin) {
    keyboard.push([
      opts.scope === "all"
        ? { text: "💬 Solo este chat", callback_data: `stats:scope:chat:${opts.period}` }
        : { text: "🌐 Todos los chats", callback_data: `stats:scope:all:${opts.period}` },
    ]);
  }
  keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
  return { html: lines.join("\n"), keyboard };
}

// ---------------------------------------------------------------------------
// Portable HTML report
// ---------------------------------------------------------------------------

function h(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PALETTE = ["#7c5cff", "#22d3ee", "#34d399", "#fbbf24", "#fb7185", "#a78bfa", "#38bdf8", "#fb923c", "#4ade80", "#f472b6"];

function colorFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const step = value / base <= 2 ? 0.5 : value / base <= 5 ? 1 : 2;
  return Math.ceil(value / (step * base)) * step * base;
}

function dateLabel(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("es-ES", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shortDate(date: string): string {
  const [, m, d] = date.split("-");
  return `${d}/${m}`;
}

function kpi(label: string, value: string, detail: string, tone = ""): string {
  return `<article class="kpi ${tone}">
    <span class="kpi-label">${h(label)}</span>
    <strong class="kpi-value">${h(value)}</strong>
    <span class="kpi-detail">${h(detail)}</span>
  </article>`;
}

function scatterSvg(models: ModelStats[]): string {
  const points = models.filter((m) => m.turns > 0 && m.outputTokens > 0 && m.tokPerSec > 0);
  if (!points.length) {
    return `<div class="empty">Aún no hay suficientes turnos con tokens para dibujar el mapa de rendimiento.</div>`;
  }
  const W = 820;
  const H = 360;
  const PL = 54;
  const PR = 24;
  const PT = 22;
  const PB = 48;
  const maxSpeed = niceMax(Math.max(...points.map((p) => p.tokPerSec), 1));
  const maxTurns = Math.max(...points.map((p) => p.turns), 1);
  const x = (v: number) => PL + (v / maxSpeed) * (W - PL - PR);
  const y = (v: number) => H - PB - (Math.max(0, Math.min(100, v)) / 100) * (H - PT - PB);
  const grid: string[] = [];
  for (const value of [0, 25, 50, 75, 100]) {
    grid.push(
      `<line x1="${PL}" x2="${W - PR}" y1="${y(value)}" y2="${y(value)}" class="grid"/>`,
      `<text x="${PL - 10}" y="${y(value) + 4}" text-anchor="end" class="axis">${value}%</text>`,
    );
  }
  for (let i = 0; i <= 5; i++) {
    const value = (maxSpeed / 5) * i;
    grid.push(
      `<line x1="${x(value)}" x2="${x(value)}" y1="${PT}" y2="${H - PB}" class="grid"/>`,
      `<text x="${x(value)}" y="${H - PB + 20}" text-anchor="middle" class="axis">${value.toFixed(0)}</text>`,
    );
  }
  const dots = [...points]
    .sort((a, b) => a.turns - b.turns)
    .map((p) => {
      const cx = x(p.tokPerSec);
      const cy = y(p.successRate);
      const r = 6 + Math.sqrt(p.turns / maxTurns) * 18;
      const color = colorFor(p.providerID);
      return `<g class="dot" tabindex="0">
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity=".7" stroke="${color}" stroke-width="1.5"/>
        <title>${h(modelName(p))} · ${int(p.turns)} turnos · ${pct(p.successRate)} éxito · ${p.tokPerSec.toFixed(1)} tok/s · ${fmtMs(p.avgMs)}</title>
      </g>`;
    })
    .join("");
  const labels = [...points]
    .sort((a, b) => b.turns - a.turns)
    .slice(0, 6)
    .map((p) => {
      const cx = x(p.tokPerSec);
      const cy = y(p.successRate);
      const label = `${p.modelID}${p.variant ? `/${p.variant}` : ""}`;
      return `<text x="${Math.min(W - PR - 8, cx + 8).toFixed(1)}" y="${Math.max(PT + 12, cy - 10).toFixed(1)}" class="dot-label">${h(label.length > 26 ? `${label.slice(0, 26)}…` : label)}</text>`;
    })
    .join("");
  return `<div class="chart-scroll"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mapa de rendimiento: velocidad frente a tasa de éxito por modelo" class="scatter">
    ${grid.join("")}
    ${dots}
    ${labels}
    <text x="${(PL + W - PR) / 2}" y="${H - 8}" text-anchor="middle" class="axis-title">Velocidad de salida (tokens/s) →</text>
    <text x="14" y="${(PT + H - PB) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(PT + H - PB) / 2})" class="axis-title">Tasa de éxito</text>
  </svg></div>`;
}

function timelineHtml(days: DayStats[]): string {
  if (!days.length) return `<div class="empty">Sin actividad en el periodo.</div>`;
  const max = Math.max(...days.map((d) => d.turns), 1);
  const bars = days.map((d, i) => {
    const height = Math.max(3, (d.turns / max) * 100);
    const showLabel = i === 0 || i === days.length - 1 || i % Math.ceil(days.length / 8) === 0;
    return `<div class="tday" title="${h(`${shortDate(d.date)} · ${d.turns} turnos · ${fmtTokens(d.outputTokens)} tokens · ${fmtCost(d.cost)}`)}">
      <div class="tbar"><span style="height:${height.toFixed(1)}%"></span></div>
      <small>${showLabel ? h(shortDate(d.date)) : ""}</small>
    </div>`;
  }).join("");
  return `<div class="timeline" role="img" aria-label="Actividad diaria de turnos">${bars}</div>`;
}

function donutHtml(providers: ProviderStats[]): string {
  const total = providers.reduce((sum, p) => sum + p.turns, 0);
  if (!total) return `<div class="empty">Sin datos de proveedores.</div>`;
  let acc = 0;
  const stops = providers.map((p) => {
    const from = acc;
    acc += (p.turns / total) * 100;
    return `${colorFor(p.providerID)} ${from.toFixed(2)}% ${acc.toFixed(2)}%`;
  });
  const legend = providers.map((p) => `<li>
    <i style="background:${colorFor(p.providerID)}"></i>
    <span>${h(p.providerID)}</span>
    <b>${pct((p.turns / total) * 100)}</b>
  </li>`).join("");
  return `<div class="donut-wrap">
    <div class="donut" style="background:conic-gradient(${stops.join(",")})" role="img" aria-label="Reparto de turnos por proveedor">
      <div class="donut-hole"><strong>${int(total)}</strong><span>turnos</span></div>
    </div>
    <ul class="legend">${legend}</ul>
  </div>`;
}

function modelRows(models: ModelStats[]): string {
  return models.map((m, idx) => `<tr>
    <td data-label="Modelo"><span class="rank">${idx + 1}</span><code class="model">${h(modelName(m))}</code></td>
    <td data-label="Turnos" data-value="${m.turns}">${int(m.turns)}</td>
    <td data-label="Éxito" data-value="${m.successRate.toFixed(1)}"><span class="pill ${m.successRate >= 95 ? "good" : m.successRate >= 80 ? "warn" : "bad"}">${pct(m.successRate)}</span></td>
    <td data-label="Media" data-value="${m.avgMs}">${fmtMs(m.avgMs)}</td>
    <td data-label="p95" data-value="${m.p95Ms}">${fmtMs(m.p95Ms)}</td>
    <td data-label="tok/s" data-value="${m.tokPerSec}">${m.tokPerSec ? m.tokPerSec.toFixed(1) : "—"}</td>
    <td data-label="Tokens" data-value="${m.outputTokens}">${fmtTokens(m.outputTokens)} <small>/${fmtTokens(m.inputTokens)} in</small></td>
    <td data-label="Coste" data-value="${m.cost}">${fmtCost(m.cost)} <small>${fmtCost(m.costPerTurn)}/turno</small></td>
    <td data-label="Herramientas" data-value="${m.toolCalls}">${int(m.toolCalls)}${m.toolFailures ? ` <span class="pill bad">${int(m.toolFailures)} ✗</span>` : ""}</td>
    <td data-label="Ediciones" data-value="${m.editFiles}">${int(m.editFiles)} <small>+${int(m.addedLines)}/−${int(m.removedLines)}</small></td>
  </tr>`).join("");
}

function toolCellHtml(calls: number, failures: number): string {
  return `${int(calls)}${failures ? ` <span class="pill bad">${int(failures)} ✗</span>` : ""}`;
}

/** Per-tool breakdown table: shell/edit/read/search/other calls, failures and rate. */
function toolTableRows(models: ModelStats[]): string {
  return models.map((m, idx) => `<tr>
    <td data-label="Modelo"><span class="rank">${idx + 1}</span><code class="model">${h(modelName(m))}</code></td>
    <td data-label="tok/s" data-value="${m.tokPerSec}">${m.tokPerSec ? m.tokPerSec.toFixed(1) : "—"}</td>
    <td data-label="Shell" data-value="${m.tools.shell.calls}">${toolCellHtml(m.tools.shell.calls, m.tools.shell.failures)}</td>
    <td data-label="Edit" data-value="${m.tools.edit.calls}">${toolCellHtml(m.tools.edit.calls, m.tools.edit.failures)}</td>
    <td data-label="Read" data-value="${m.tools.read.calls}">${toolCellHtml(m.tools.read.calls, m.tools.read.failures)}</td>
    <td data-label="Search" data-value="${m.tools.search.calls}">${toolCellHtml(m.tools.search.calls, m.tools.search.failures)}</td>
    <td data-label="Otras" data-value="${m.tools.other.calls}">${toolCellHtml(m.tools.other.calls, m.tools.other.failures)}</td>
    <td data-label="Fallos" data-value="${m.toolFailures}">${int(m.toolFailures)}</td>
    <td data-label="llam./min" data-value="${m.toolsPerMin}">${m.toolsPerMin.toFixed(1)}</td>
  </tr>`).join("");
}

function recentRows(rows: TurnStatRow[]): string {
  return rows.map((r) => {
    const status = r.status === "ok"
      ? `<span class="pill good">ok</span>`
      : r.status === "stopped"
        ? `<span class="pill warn">detenido</span>`
        : `<span class="pill bad">error</span>`;
    return `<tr>
      <td data-label="Cuándo" data-value="${r.finished_at}">${h(dateLabel(r.finished_at))}</td>
      <td data-label="Modelo"><code>${h(`${r.provider_id}/${r.model_id}${r.variant ? ` (${r.variant})` : ""}`)}</code></td>
      <td data-label="Estado">${status}</td>
      <td data-label="Duración" data-value="${r.duration_ms}">${fmtMs(r.duration_ms)}</td>
      <td data-label="Tokens" data-value="${r.output_tokens}">${fmtTokens(r.output_tokens)} <small>/${fmtTokens(r.input_tokens)} in</small></td>
      <td data-label="Coste" data-value="${r.cost}">${fmtCost(r.cost)}</td>
      <td data-label="Herramientas" data-value="${r.tool_calls}">${int(r.tool_calls)}${r.tool_failures ? ` <span class="pill bad">${int(r.tool_failures)} ✗</span>` : ""}</td>
    </tr>`;
  }).join("");
}

export type ReportOpts = {
  period: StatsPeriod;
  scope: StatsScope;
  title?: string;
};

/** Build the complete, dependency-free HTML report. */
export function buildHtmlReport(data: StatsData, opts: ReportOpts): string {
  const t = data.totals;
  const range = data.firstAt && data.lastAt
    ? `${dateLabel(data.firstAt)} — ${dateLabel(data.lastAt)}`
    : "Sin actividad";
  const scopeLabel = opts.scope === "all" ? "Todos los chats" : "Este chat";
  const top = data.models[0];
  const totalTests = t.testRuns;
  const testsOk = t.testOk;
  const kpis = [
    kpi("Turnos", int(t.turns), `${int(t.ok)} ok · ${int(t.errors)} error · ${int(t.stopped)} detenidos`),
    kpi("Tasa de éxito", pct(t.successRate), `${int(t.turns - t.ok)} turnos no completados`, t.successRate >= 95 ? "good" : t.successRate >= 80 ? "warn" : "bad"),
    kpi("Latencia media", fmtMs(t.avgMs), `p50 ${fmtMs(t.p50Ms)} · p95 ${fmtMs(t.p95Ms)}`),
    kpi("Velocidad", `${t.tokPerSec.toFixed(1)} tok/s`, `${fmtTokens(t.avgTokensPerTurn)} tokens/turno`),
    kpi("Tokens de salida", fmtTokens(t.outputTokens), `${fmtTokens(t.inputTokens)} entrada · ${fmtTokens(t.reasoningTokens)} razonamiento`),
    kpi("Coste", fmtCost(t.cost), `${fmtCost(t.costPerTurn)} por turno`),
    kpi("Herramientas", int(t.toolCalls), `${int(t.toolFailures)} fallos · ${t.toolsPerMin.toFixed(1)} llam./min`),
    kpi("Herram. por tipo", `${int(t.tools.shell.calls)}/${int(t.tools.edit.calls)}/${int(t.tools.read.calls)}`, `shell/edit/read · ${int(t.tools.search.calls)} search · ${int(t.tools.other.calls)} otras`),
    kpi("Cambios", `${int(t.editFiles)} archivos`, `+${int(t.addedLines)} / −${int(t.removedLines)} líneas`),
  ].join("");

  const speedRanking = data.models
    .filter((m) => m.tokPerSec > 0)
    .sort((a, b) => b.tokPerSec - a.tokPerSec)
    .slice(0, 10);
  const maxSpeed = Math.max(...speedRanking.map((m) => m.tokPerSec), 1);
  const speedBars = speedRanking.map((m) => `<div class="hbar">
    <span class="hbar-label"><code>${h(modelName(m))}</code><small>${m.tokPerSec.toFixed(1)} tok/s</small></span>
    <span class="hbar-track"><i style="width:${((m.tokPerSec / maxSpeed) * 100).toFixed(1)}%;background:${colorFor(m.providerID)}"></i></span>
  </div>`).join("");

  const providerRows = data.providers.map((p) => `<tr>
    <td data-label="Proveedor"><i class="swatch" style="background:${colorFor(p.providerID)}"></i><code>${h(p.providerID)}</code></td>
    <td data-label="Turnos" data-value="${p.turns}">${int(p.turns)}</td>
    <td data-label="Modelos" data-value="${data.models.filter((m) => m.providerID === p.providerID).length}">${data.models.filter((m) => m.providerID === p.providerID).length}</td>
    <td data-label="Éxito" data-value="${p.successRate.toFixed(1)}">${pct(p.successRate)}</td>
    <td data-label="Media" data-value="${p.avgMs}">${fmtMs(p.avgMs)}</td>
    <td data-label="tok/s" data-value="${p.tokPerSec}">${p.tokPerSec ? p.tokPerSec.toFixed(1) : "—"}</td>
    <td data-label="Coste" data-value="${p.cost}">${fmtCost(p.cost)}</td>
  </tr>`).join("");

  return `<!doctype html>
<html lang="es" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${h(opts.title ?? "OpenCodegram · Rendimiento de modelos")}</title>
<style>
:root{
  --bg:#060911;--bg2:#0b1120;--panel:rgba(255,255,255,.055);--panel-solid:#0f172a;
  --line:rgba(255,255,255,.11);--text:#e8edf8;--muted:#94a3b8;--dim:#64748b;
  --accent:#7c5cff;--accent2:#22d3ee;--good:#34d399;--warn:#fbbf24;--bad:#fb7185;
  --shadow:0 20px 60px rgba(0,0,0,.35);--radius:20px
}
html[data-theme="light"]{
  --bg:#f6f8fc;--bg2:#eef2fb;--panel:rgba(255,255,255,.86);--panel-solid:#fff;
  --line:rgba(15,23,42,.1);--text:#0f172a;--muted:#475569;--dim:#64748b;
  --shadow:0 18px 45px rgba(15,23,42,.1)
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,Arial,sans-serif;min-height:100vh;overflow-x:hidden}
body::before,body::after{content:"";position:fixed;z-index:-1;width:60vw;height:60vw;border-radius:50%;filter:blur(80px);opacity:.28;pointer-events:none}
body::before{background:radial-gradient(circle,#7c5cff,transparent 65%);top:-28vw;right:-16vw}
body::after{background:radial-gradient(circle,#22d3ee,transparent 65%);bottom:-32vw;left:-18vw;opacity:.18}
.wrap{max-width:1260px;margin:0 auto;padding:clamp(18px,4vw,46px)}
.hero{position:relative;padding:clamp(24px,5vw,54px);border:1px solid var(--line);border-radius:clamp(20px,3vw,30px);background:linear-gradient(145deg,rgba(124,92,255,.16),rgba(34,211,238,.07) 42%,var(--panel));box-shadow:var(--shadow);overflow:hidden}
.hero::after{content:"";position:absolute;inset:0;background:radial-gradient(700px 240px at 82% 0%,rgba(34,211,238,.18),transparent 60%);pointer-events:none}
.eyebrow{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent2);font-weight:700}
.hero h1{font-size:clamp(30px,6vw,62px);line-height:1.02;margin:12px 0 12px;letter-spacing:-.045em;font-weight:800}
.hero h1 span{background:linear-gradient(92deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{max-width:76ch;color:var(--muted);margin:0 0 18px;font-size:clamp(14px,2vw,17px)}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--dim);font-size:12.5px}
.meta b{color:var(--text)}
.hero-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
button{font:inherit;color:var(--text);background:rgba(255,255,255,.08);border:1px solid var(--line);padding:9px 14px;border-radius:999px;cursor:pointer;transition:.18s ease}
button:hover{transform:translateY(-1px);border-color:var(--accent);background:rgba(124,92,255,.16)}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--accent2);outline-offset:3px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:18px 0}
.kpi{position:relative;padding:18px;border:1px solid var(--line);border-radius:16px;background:var(--panel);backdrop-filter:blur(12px);overflow:hidden}
.kpi::before{content:"";position:absolute;inset:0 auto auto 0;width:100%;height:2px;background:linear-gradient(90deg,var(--accent),transparent)}
.kpi.good::before{background:linear-gradient(90deg,var(--good),transparent)}
.kpi.warn::before{background:linear-gradient(90deg,var(--warn),transparent)}
.kpi.bad::before{background:linear-gradient(90deg,var(--bad),transparent)}
.kpi-label{display:block;color:var(--muted);font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700}
.kpi-value{display:block;font-size:clamp(22px,3vw,32px);line-height:1.15;margin:8px 0 4px;letter-spacing:-.03em}
.kpi-detail{display:block;color:var(--dim);font-size:12.5px}
.panel{margin:18px 0;padding:clamp(18px,3vw,28px);border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow);backdrop-filter:blur(12px)}
.panel h2{font-size:clamp(19px,3vw,25px);margin:0 0 4px;letter-spacing:-.025em}
.hint{color:var(--muted);font-size:13.5px;margin:0 0 18px}
.grid2{display:grid;grid-template-columns:1.08fr .92fr;gap:18px}
@media(max-width:860px){.grid2{grid-template-columns:1fr}}
.chart-scroll{overflow-x:auto;margin:0 -6px;padding:0 6px}
.scatter{width:100%;min-width:540px;height:auto;display:block}
.grid{stroke:var(--line);stroke-width:1;stroke-dasharray:3 6}
.axis{fill:var(--dim);font-size:12px}
.axis-title{fill:var(--muted);font-size:12px;letter-spacing:.04em}
.dot{transition:transform .18s ease;transform-origin:center;cursor:help}
.dot:hover circle,.dot:focus circle{fill-opacity:1;stroke-width:3}
.dot-label{fill:var(--text);font-size:11px;font-weight:600;text-shadow:0 1px 4px var(--bg)}
.table-wrap{overflow-x:auto;border-radius:14px;border:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:760px}
th{position:sticky;top:0;background:var(--panel-solid);color:var(--muted);text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap;cursor:pointer;user-select:none}
th[data-sortable]:hover{color:var(--text)}
th[data-dir="asc"]::after{content:" ↑";color:var(--accent2)}
th[data-dir="desc"]::after{content:" ↓";color:var(--accent2)}
td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:rgba(124,92,255,.07)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;color:var(--text);background:rgba(255,255,255,.06);padding:2px 6px;border-radius:6px}
td small{display:block;color:var(--dim);font-size:11px}
.rank{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-right:8px;border-radius:50%;background:rgba(124,92,255,.18);color:#c4b5fd;font-size:11px;font-weight:800}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.02em}
.pill.good{background:rgba(52,211,153,.16);color:var(--good)}
.pill.warn{background:rgba(251,191,36,.16);color:var(--warn)}
.pill.bad{background:rgba(251,113,133,.16);color:var(--bad)}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px}
.toolbar input{flex:1;min-width:220px;background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:11px;color:var(--text);padding:10px 13px;font:inherit}
.toolbar input::placeholder{color:var(--dim)}
.hbar{display:grid;gap:5px;margin:0 0 12px}
.hbar-label{display:flex;justify-content:space-between;gap:12px;font-size:12.5px}
.hbar-label small{color:var(--muted)}
.hbar-track{height:9px;background:rgba(255,255,255,.07);border-radius:999px;overflow:hidden}
.hbar-track i{display:block;height:100%;border-radius:999px;transition:width .5s ease}
.donut-wrap{display:flex;align-items:center;gap:clamp(18px,4vw,38px);flex-wrap:wrap}
.donut{--size:clamp(150px,26vw,200px);width:var(--size);height:var(--size);border-radius:50%;position:relative;display:grid;place-items:center;flex:0 0 auto;box-shadow:inset 0 0 0 1px var(--line)}
.donut::after{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:0 0 40px rgba(124,92,255,.18)}
.donut-hole{width:62%;height:62%;border-radius:50%;background:var(--panel-solid);display:grid;place-items:center;align-content:center;position:relative;z-index:1}
.donut-hole strong{font-size:clamp(20px,4vw,28px);letter-spacing:-.03em}
.donut-hole span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}
.legend{list-style:none;margin:0;padding:0;display:grid;gap:8px;min-width:180px;flex:1}
.legend li{display:flex;align-items:center;gap:9px;font-size:13px}
.legend i,.swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.legend b{margin-left:auto;color:var(--muted);font-weight:700}
.timeline{display:flex;align-items:flex-end;gap:3px;height:170px;padding-top:10px}
.tday{flex:1;min-width:3px;display:flex;flex-direction:column;justify-content:flex-end;height:100%;gap:7px}
.tbar{flex:1;display:flex;align-items:flex-end;background:rgba(255,255,255,.045);border-radius:6px;overflow:hidden}
.tbar span{display:block;width:100%;border-radius:6px;background:linear-gradient(180deg,var(--accent2),var(--accent));min-height:3px;transition:height .4s ease}
.tday small{color:var(--dim);font-size:9.5px;text-align:center;white-space:nowrap;min-height:12px}
.empty{padding:26px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:14px}
footer{color:var(--dim);font-size:12px;text-align:center;padding:10px 0 34px}
footer b{color:var(--muted)}
@media(max-width:720px){
  .wrap{padding:14px}
  .hero{border-radius:20px}
  .panel{border-radius:16px}
  table{min-width:0}
  table,thead,tbody,tr,td{display:block}
  thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  tr{border-bottom:1px solid var(--line);padding:10px 4px}
  tr:last-child{border-bottom:0}
  td{display:flex;align-items:baseline;justify-content:space-between;gap:16px;border:0;padding:6px 10px;white-space:normal;text-align:right}
  td::before{content:attr(data-label);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:700;text-align:left}
  td small{display:inline}
  .timeline{height:130px}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
@media print{
  body{background:#fff;color:#000}
  body::before,body::after,.hero-actions,.toolbar{display:none}
  .panel,.kpi,.hero{box-shadow:none;background:#fff;border-color:#ddd;backdrop-filter:none}
  .hero h1 span{color:#000}
  .table-wrap{overflow:visible}
  table{min-width:0;font-size:10.5px}
  th,td{padding:5px 7px}
}
</style>
</head>
<body>
<main class="wrap">
  <header class="hero">
    <div class="eyebrow">OpenCodegram · Model Intelligence</div>
    <h1>Rendimiento de <span>modelos</span></h1>
    <p>Comparativa de latencia, velocidad, coste, fiabilidad y uso de herramientas por proveedor y modelo. Datos reales de cada turno, sin telemetría externa.</p>
    <div class="meta">
      <span><b>Periodo:</b> ${h(periodLabel(opts.period))}</span>
      <span><b>Ámbito:</b> ${h(scopeLabel)}</span>
      <span><b>Rango:</b> ${h(range)}</span>
      <span><b>Generado:</b> ${h(dateLabel(data.generatedAt))}</span>
      ${top ? `<span><b>Modelo líder:</b> ${h(modelName(top))}</span>` : ""}
    </div>
    <div class="hero-actions">
      <button type="button" id="themeToggle" aria-label="Cambiar tema">◐ Tema</button>
      <button type="button" onclick="window.print()">🖨 Imprimir / PDF</button>
    </div>
  </header>

  <section class="kpis" aria-label="Indicadores principales">${kpis}</section>

  <section class="panel">
    <h2>Mapa de rendimiento</h2>
    <p class="hint">Cada burbuja es un modelo: eje X = velocidad de salida, eje Y = tasa de éxito, tamaño = número de turnos. Pasa el cursor o enfoca una burbuja para ver el detalle.</p>
    ${scatterSvg(data.models)}
  </section>

  <section class="panel">
    <h2>Velocidad de salida</h2>
    <p class="hint">Tokens generados por segundo sobre turnos con duración medida.</p>
    ${speedBars || `<div class="empty">Aún no hay turnos con tokens y duración.</div>`}
  </section>

  <section class="panel">
    <h2>Herramientas por modelo</h2>
    <p class="hint">Llamadas por tipo (shell, edit, read, search y otras) con sus fallos. «llam./min» normaliza el uso por minuto de tiempo de turno para comparar modelos rápidos y lentos de forma justa.</p>
    <div class="table-wrap">
      <table class="sortable" id="toolTable">
        <thead><tr>
          <th data-sortable>Modelo</th>
          <th data-sortable>tok/s</th>
          <th data-sortable>Shell</th>
          <th data-sortable>Edit</th>
          <th data-sortable>Read</th>
          <th data-sortable>Search</th>
          <th data-sortable>Otras</th>
          <th data-sortable>Fallos</th>
          <th data-sortable>llam./min</th>
        </tr></thead>
        <tbody>${toolTableRows(data.models)}</tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2>Ranking de modelos</h2>
    <p class="hint">Ordena por cualquier columna y filtra por nombre. p95 muestra la latencia del 5% más lento.</p>
    <div class="toolbar"><input id="modelFilter" type="search" placeholder="Filtrar por proveedor o modelo…" aria-label="Filtrar modelos"></div>
    <div class="table-wrap">
      <table class="sortable" id="modelTable">
        <thead><tr>
          <th data-sortable>Modelo</th>
          <th data-sortable>Turnos</th>
          <th data-sortable>Éxito</th>
          <th data-sortable>Media</th>
          <th data-sortable>p95</th>
          <th data-sortable>tok/s</th>
          <th data-sortable>Tokens</th>
          <th data-sortable>Coste</th>
          <th data-sortable>Herramientas</th>
          <th data-sortable>Ediciones</th>
        </tr></thead>
        <tbody>${modelRows(data.models)}</tbody>
      </table>
    </div>
  </section>

  <div class="grid2">
    <section class="panel">
      <h2>Reparto por proveedor</h2>
      <p class="hint">Cuota de turnos de cada proveedor en el periodo.</p>
      ${donutHtml(data.providers)}
    </section>
    <section class="panel">
      <h2>Actividad diaria</h2>
      <p class="hint">Turnos por día; el alto de la barra es relativo al día más activo.</p>
      ${timelineHtml(data.days)}
    </section>
  </div>

  <section class="panel">
    <h2>Proveedores</h2>
    <p class="hint">Agregado por proveedor para comparar estabilidad y coste.</p>
    <div class="table-wrap">
      <table class="sortable" id="providerTable">
        <thead><tr>
          <th data-sortable>Proveedor</th>
          <th data-sortable>Turnos</th>
          <th data-sortable>Modelos</th>
          <th data-sortable>Éxito</th>
          <th data-sortable>Media</th>
          <th data-sortable>tok/s</th>
          <th data-sortable>Coste</th>
        </tr></thead>
        <tbody>${providerRows}</tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2>Últimos turnos</h2>
    <p class="hint">Los 40 turnos más recientes del periodo seleccionado.</p>
    <div class="table-wrap">
      <table id="recentTable">
        <thead><tr><th>Cuándo</th><th>Modelo</th><th>Estado</th><th>Duración</th><th>Tokens</th><th>Coste</th><th>Herramientas</th></tr></thead>
        <tbody>${recentRows(data.recent)}</tbody>
      </table>
    </div>
  </section>

  <footer>
    <b>OpenCodegram</b> · reporte generado automáticamente el ${h(dateLabel(data.generatedAt))}.
    ${t.turns ? `Basado en ${int(t.turns)} turnos y ${fmtTokens(t.inputTokens + t.outputTokens)} tokens.` : ""}
    Los costes provienen de OpenCode cuando están disponibles; el resto de métricas se miden localmente.
  </footer>
</main>
<script>
(() => {
  const root = document.documentElement;
  const btn = document.getElementById("themeToggle");
  try { const saved = localStorage.getItem("ocg-report-theme"); if (saved) root.dataset.theme = saved; } catch {}
  btn?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try { localStorage.setItem("ocg-report-theme", root.dataset.theme); } catch {}
  });
  const numeric = (text) => {
    const n = Number(String(text).replace(/[^0-9,.-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  };
  document.querySelectorAll("table.sortable").forEach((table) => {
    table.querySelectorAll("th[data-sortable]").forEach((th, index) => {
      th.addEventListener("click", () => {
        const body = table.tBodies[0];
        if (!body) return;
        const dir = th.dataset.dir === "asc" ? -1 : 1;
        th.dataset.dir = dir === 1 ? "asc" : "desc";
        table.querySelectorAll("th").forEach((other) => { if (other !== th) delete other.dataset.dir; });
        const rows = [...body.rows];
        rows.sort((a, b) => {
          const av = a.cells[index]?.dataset.value ?? a.cells[index]?.textContent ?? "";
          const bv = b.cells[index]?.dataset.value ?? b.cells[index]?.textContent ?? "";
          const an = numeric(av);
          const bn = numeric(bv);
          if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir;
          return String(av).localeCompare(String(bv), "es", { numeric: true }) * dir;
        });
        rows.forEach((row) => body.appendChild(row));
      });
    });
  });
  const filter = document.getElementById("modelFilter");
  filter?.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    document.querySelectorAll("#modelTable tbody tr").forEach((row) => {
      row.hidden = !!q && !row.textContent.toLowerCase().includes(q);
    });
  });
})();
</script>
</body>
</html>`;
}

/** Write the report to a temp file and return its path and download name. */
export function writeStatsReport(data: StatsData, opts: ReportOpts): { path: string; filename: string } {
  const dir = join(tmpdir(), "opencodegram-reports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(data.generatedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `opencodegram-stats-${opts.period}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.html`;
  const path = join(dir, filename);
  writeFileSync(path, buildHtmlReport(data, opts), "utf8");
  return { path, filename };
}

export type TurnStatExtra = {
  outputChars?: number;
  promptChars?: number;
  status?: TurnStatStatus;
  dataDir?: string;
};

/** Build and persist a turn stat from a finished ChatSession. Idempotent. */
export function recordTurnStatFromSession(
  s: ChatSession,
  chatId: number,
  threadId: number | undefined,
  extra: TurnStatExtra = {},
): void {
  const startedAt = s.promptStartTime ?? s.turnFinishedAt ?? Date.now();
  const finishedAt = s.turnFinishedAt ?? Date.now();
  const status: TurnStatStatus = extra.status ?? (s.stopped ? "stopped" : s.lastTurnError ? "error" : "ok");
  const edits = summarizeEdits(s, s.toolCallDetails ?? []);
  const test = detectTestRun(s.toolCallDetails ?? []);
  const toolFailures = (s.toolCallDetails ?? []).filter((d) => d.status === "failed").length;
  recordTurnStat(
    {
      sessionId: s.sessionId,
      turnSeq: s.turnSeq ?? 0,
      chatId,
      threadId,
      providerID: s.model?.providerID ?? "",
      modelID: s.model?.id ?? "",
      variant: s.model?.variant,
      status,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      firstTokenMs: s.turnFirstStreamedAt ? Math.max(0, s.turnFirstStreamedAt - startedAt) : undefined,
      inputTokens: s.turnInputTokens,
      outputTokens: s.turnOutputTokens,
      reasoningTokens: s.turnReasoningTokens,
      cacheReadTokens: s.turnCacheReadTokens,
      cacheWriteTokens: s.turnCacheWriteTokens,
      cost: s.turnCost,
      toolCalls: s.toolCallDetails?.length ?? 0,
      toolFailures,
      toolCounts: countTools(s.toolCallDetails),
      editFiles: edits.files,
      addedLines: edits.added,
      removedLines: edits.removed,
      testRuns: test ? 1 : 0,
      testOk: test?.ok ? 1 : 0,
      promptChars: extra.promptChars ?? 0,
      outputChars: extra.outputChars ?? s.lastFinalText?.length ?? 0,
    },
    extra.dataDir,
  );
}
