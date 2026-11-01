// Lightweight debug/logger helper.
const LEVELS: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}
function debugCategories(): Set<string> {
  const raw = process.env.DEBUG ?? "";
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function categoryEnabled(cat: string): boolean {
  const cats = debugCategories();
  if (cats.has("*") || cats.has("all")) return true;
  return cats.has(cat.toLowerCase());
}
function fmt(cat: string, args: unknown[]): unknown[] { return [`[${cat}]`, ...args]; }
export const logger = {
  trace(cat: string, ...args: unknown[]): void { if (currentLevel() <= 0) console.log(...fmt(cat, args)); },
  debug(cat: string, ...args: unknown[]): void { if (currentLevel() <= 1 || categoryEnabled(cat)) console.log(...fmt(cat, args)); },
  info(cat: string, ...args: unknown[]): void { if (currentLevel() <= 2) console.log(...fmt(cat, args)); },
  warn(cat: string, ...args: unknown[]): void { if (currentLevel() <= 3) console.warn(...fmt(cat, args)); },
  error(cat: string, ...args: unknown[]): void { if (currentLevel() <= 4) console.error(...fmt(cat, args)); },
  breadcrumb(cat: string, message: string, data?: unknown): void {
    const suffix = data === undefined ? "" : ` ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 200)}`;
    console.log(`[bc][${cat}] ${message}${suffix}`);
  },
};
export default logger;
