import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "./logger.js";
import { writeFileAtomic } from "./persist.js";
import { esc } from "./util.js";

/**
 * Single SQLite database for all daemon state.
 *
 * `data/opencodegram.db` owns every persisted key (sessions, settings, offsets,
 * permissions, …). The legacy `data/*.json` files are kept as a human-readable
 * mirror: they are imported on first read and re-written on every save, so an
 * existing installation upgrades in place without a maintenance window. If a
 * JSON file is edited externally, the file wins on the next read and is
 * re-imported into SQLite.
 *
 * One Database connection per data directory keeps isolated test fixtures (and
 * multiple bot instances in one process) from sharing state.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  canonical TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS permissions (
  route_key TEXT PRIMARY KEY,
  read_only INTEGER NOT NULL DEFAULT 0,
  inherit INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS permission_users (
  route_key TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (route_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_permission_users_route ON permission_users(route_key);
`;

const databases = new Map<string, Database>();

/** Return the SQLite connection for the data directory that owns `file`. */
function dbForFile(file: string): Database {
  const dir = dirname(file);
  const existing = databases.get(dir);
  if (existing) return existing;
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "opencodegram.db"));
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run(SCHEMA);
  databases.set(dir, db);
  return db;
}

/** Return the SQLite connection for a data directory. */
export function getDatabase(dataDir = join(process.cwd(), "data")): Database {
  return dbForFile(join(dataDir, ".db"));
}

/** Close the connection for a data directory (useful for tests/shutdown). */
export function closeDatabase(dataDir: string): void {
  const dir = dirname(join(dataDir, ".db"));
  const db = databases.get(dir);
  if (db) {
    db.close();
    databases.delete(dir);
  }
}

type KvRow = { value: string; canonical: string };

function canonicalOf(value: unknown): string {
  return JSON.stringify(value);
}

/** Read a JSON-backed state key, importing the legacy file when necessary. */
export function jsonRead<T>(file: string, tag = "db"): T | undefined {
  const key = basename(file);
  const db = dbForFile(file);
  const row = db.query("SELECT value, canonical FROM kv_state WHERE key = ?").get(key) as KvRow | null;

  let fromFile: T | undefined;
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8")) as T;
    } catch (err) {
      // A corrupt JSON file must not overwrite healthy SQLite state.
      logger.error(tag, `corrupt JSON mirror ignored: ${file}`, err);
    }
  }

  if (fromFile !== undefined && (!row || canonicalOf(fromFile) !== row.canonical)) {
    // First import, or the file was edited outside the bot: the file wins.
    jsonWrite(file, fromFile);
    return fromFile;
  }
  if (row) {
    try {
      return JSON.parse(row.value) as T;
    } catch (err) {
      logger.error(tag, `corrupt SQLite value for ${key}`, err);
    }
  }
  return fromFile;
}

/** Persist a JSON-backed state key in SQLite and mirror it to its JSON file. */
export function jsonWrite(file: string, value: unknown, pretty = true): void {
  const key = basename(file);
  const db = dbForFile(file);
  const text = JSON.stringify(value, null, pretty ? 2 : 0);
  db.run(
    "INSERT INTO kv_state (key, value, canonical, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, canonical = excluded.canonical, updated_at = excluded.updated_at",
    key,
    text,
    canonicalOf(value),
    Date.now(),
  );
  // The mirror is a convenience/backup. A read-only filesystem must never
  // prevent SQLite from persisting the authoritative state.
  try {
    writeFileAtomic(file, text);
  } catch (err) {
    logger.error("db", `JSON mirror failed for ${key}`, err);
  }
}

/**
 * Import every legacy top-level JSON file up front so a fresh install has all
 * of its state in SQLite from the first tick (per-session `transcripts/` files
 * stay on disk — they are large blobs managed by the transcript manager).
 */
export function importAllJson(dataDir = join(process.cwd(), "data")): number {
  if (!existsSync(dataDir)) return 0;
  let imported = 0;
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (jsonRead(join(dataDir, entry.name), "db") !== undefined) imported++;
  }
  return imported;
}

export type DbStats = {
  file: string;
  sizeBytes: number;
  sqliteVersion: string;
  kvEntries: number;
  permissionRows: number;
  permissionUserRows: number;
  keys: Array<{ key: string; bytes: number }>;
};

/** Runtime overview used by the button-driven "🗄 Datos" panel. */
export function dbStats(dataDir = join(process.cwd(), "data")): DbStats {
  const db = getDatabase(dataDir);
  const file = join(dataDir, "opencodegram.db");
  const version = db.query("SELECT sqlite_version() AS v").get() as { v: string };
  const kv = db.query("SELECT COUNT(*) AS n FROM kv_state").get() as { n: number };
  const pr = db.query("SELECT COUNT(*) AS n FROM permissions").get() as { n: number };
  const pu = db.query("SELECT COUNT(*) AS n FROM permission_users").get() as { n: number };
  const rows = db.query("SELECT key, length(value) AS bytes FROM kv_state ORDER BY key").all() as Array<{ key: string; bytes: number }>;
  return {
    file,
    sizeBytes: existsSync(file) ? statSync(file).size : 0,
    sqliteVersion: version.v,
    kvEntries: kv.n,
    permissionRows: pr.n,
    permissionUserRows: pu.n,
    keys: rows.map((r) => ({ key: r.key, bytes: r.bytes })),
  };
}

/** Reclaim space from the single database file. */
export function vacuum(dataDir = join(process.cwd(), "data")): void {
  getDatabase(dataDir).run("VACUUM");
}

export type DbKeyboard = Array<Array<{ text: string; callback_data: string }>>;

/** Pure renderer for the button-driven database panel. */
export function renderDbPanel(stats: DbStats, isAdmin: boolean): { html: string; keyboard: DbKeyboard } {
  const size = stats.sizeBytes < 1024
    ? `${stats.sizeBytes} B`
    : `${(stats.sizeBytes / 1024).toFixed(1)} KB`;
  const lines = [
    "🗄 <b>Base de datos</b>",
    `<code>${esc(stats.file)}</code>`,
    "",
    `SQLite ${esc(stats.sqliteVersion)} · ${size}`,
    `Claves: ${stats.kvEntries} · Permisos: ${stats.permissionRows} · Usuarios: ${stats.permissionUserRows}`,
  ];
  if (stats.keys.length) {
    lines.push("", "<b>Claves guardadas</b>", "<pre>");
    for (const k of stats.keys.slice(0, 24)) {
      lines.push(`${esc(k.key.padEnd(24, " "))} ${String(k.bytes).padStart(7, " ")} B`);
    }
    lines.push("</pre>");
    if (stats.keys.length > 24) lines.push(`<i>… y ${stats.keys.length - 24} más</i>`);
  }
  lines.push("", "<i>Todo el estado vive en SQLite; los .json son un espejo legible.</i>");
  const keyboard: DbKeyboard = [[{ text: "🔄 Actualizar", callback_data: "db:refresh" }]];
  if (isAdmin) keyboard.push([{ text: "🧹 Compactar (VACUUM)", callback_data: "db:vacuum" }]);
  keyboard.push([{ text: "🏠 Panel", callback_data: "db:back" }]);
  return { html: lines.join("\n"), keyboard };
}
