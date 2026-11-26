/**
 * Debug tracer: writes a numbered breadcrumb stream to data/debug.log.
 *
 * Enabled with DEBUG_TRACE_ENABLED=true (default off). Independent of
 * SESSION_TRACE_ENABLED so it can be turned on just for a debug session
 * without touching the production breadcrumbs.
 *
 * Every line has the form:
 *   <iso> D<seq> <category> <event> <json | text>
 *
 * The monotonically increasing D<seq> makes it trivial to order events even
 * when several async flows interleave, and to correlate a Telegram message id
 * with the card that was sent/edited.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const enabled = (process.env.DEBUG_TRACE_ENABLED ?? "false").toLowerCase() === "true" || process.env.DEBUG_TRACE_ENABLED === "1";
const logFile = process.env.DEBUG_TRACE_FILE ?? join(process.cwd(), "data", "debug.log");
let seq = 0;

/** Append one numbered breadcrumb. Never throws — debug logging must not break the bot. */
export function dtrace(category: string, event: string, fields?: Record<string, unknown> | string): number {
  const id = ++seq;
  if (!enabled) return id;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    try {
      if (statSync(logFile).size > 1_000_000) renameSync(logFile, `${logFile}.1`);
    } catch {
      // no file yet
    }
    const payload = typeof fields === "string" ? fields : fields === undefined ? "" : JSON.stringify(fields);
    appendFileSync(logFile, `${new Date().toISOString()} D${id} ${category} ${event}${payload ? ` ${payload}` : ""}\n`, "utf8");
  } catch {
    // ignore
  }
  return id;
}

export const debugTraceEnabled = enabled;
