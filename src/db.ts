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
CREATE TABLE IF NOT EXISTS known_users (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  provider_id TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  variant TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_failures INTEGER NOT NULL DEFAULT 0,
  shell_calls INTEGER NOT NULL DEFAULT 0,
  shell_failures INTEGER NOT NULL DEFAULT 0,
  edit_calls INTEGER NOT NULL DEFAULT 0,
  edit_failures INTEGER NOT NULL DEFAULT 0,
  read_calls INTEGER NOT NULL DEFAULT 0,
  read_failures INTEGER NOT NULL DEFAULT 0,
  search_calls INTEGER NOT NULL DEFAULT 0,
  search_failures INTEGER NOT NULL DEFAULT 0,
  other_calls INTEGER NOT NULL DEFAULT 0,
  other_failures INTEGER NOT NULL DEFAULT 0,
  edit_files INTEGER NOT NULL DEFAULT 0,
  added_lines INTEGER NOT NULL DEFAULT 0,
  removed_lines INTEGER NOT NULL DEFAULT 0,
  test_runs INTEGER NOT NULL DEFAULT 0,
  test_ok INTEGER NOT NULL DEFAULT 0,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, turn_seq, started_at)
);
CREATE INDEX IF NOT EXISTS idx_turn_stats_finished ON turn_stats(finished_at);
CREATE INDEX IF NOT EXISTS idx_turn_stats_model ON turn_stats(provider_id, model_id);
CREATE INDEX IF NOT EXISTS idx_turn_stats_chat ON turn_stats(chat_id, finished_at);
`;

/**
 * Telegram usernames are unique at any given moment. The old schema only had a
 * non-unique index, so a recycled @name could resolve to a stale account. The
 * index is upgraded once, keeping the newest mapping for each username.
 */
function migrateKnownUsers(db: Database): void {
  const idx = db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_known_users_username'").get() as { sql: string } | null;
  if (idx && /\bUNIQUE\b/i.test(idx.sql)) return;
  const tx = db.transaction(() => {
    // Keep only the most recently seen row per username before adding the
    // uniqueness constraint.
    db.run(`
      DELETE FROM known_users WHERE rowid NOT IN (
        SELECT rowid FROM (
          SELECT rowid, ROW_NUMBER() OVER (
            PARTITION BY username ORDER BY updated_at DESC, user_id DESC
          ) AS rn FROM known_users
        ) WHERE rn = 1
      )
    `);
    db.run("DROP INDEX IF EXISTS idx_known_users_username");
    db.run("CREATE UNIQUE INDEX idx_known_users_username ON known_users(username)");
  });
  tx();
}

/**
 * Add the per-tool breakdown columns to older `turn_stats` tables. SQLite
 * cannot add several columns in one ALTER, so each is added if missing.
 */
function migrateTurnStatsColumns(db: Database): void {
  const columns = new Set(
    (db.query("PRAGMA table_info(turn_stats)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const additions: Record<string, string> = {
    shell_calls: "INTEGER NOT NULL DEFAULT 0",
    shell_failures: "INTEGER NOT NULL DEFAULT 0",
    edit_calls: "INTEGER NOT NULL DEFAULT 0",
    edit_failures: "INTEGER NOT NULL DEFAULT 0",
    read_calls: "INTEGER NOT NULL DEFAULT 0",
    read_failures: "INTEGER NOT NULL DEFAULT 0",
    search_calls: "INTEGER NOT NULL DEFAULT 0",
    search_failures: "INTEGER NOT NULL DEFAULT 0",
    other_calls: "INTEGER NOT NULL DEFAULT 0",
    other_failures: "INTEGER NOT NULL DEFAULT 0",
  };
  const tx = db.transaction(() => {
    for (const [name, def] of Object.entries(additions)) {
      if (!columns.has(name)) db.run(`ALTER TABLE turn_stats ADD COLUMN ${name} ${def}`);
    }
  });
  tx();
}

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
  migrateTurnStatsColumns(db);
  migrateKnownUsers(db);
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

type KvRow = { value: string; canonical: string; updated_at: number };

function canonicalOf(value: unknown): string {
  return JSON.stringify(value);
}

/** Read a JSON-backed state key, importing the legacy file when necessary. */
export function jsonRead<T>(file: string, tag = "db"): T | undefined {
  const key = basename(file);
  const db = dbForFile(file);
  const row = db.query("SELECT value, canonical, updated_at FROM kv_state WHERE key = ?").get(key) as KvRow | null;

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
    // The file wins on first import or on a genuine external edit. But a
    // STALE mirror (left behind when jsonWrite's file write failed, or an
    // old copy restored from backup) must NOT overwrite authoritative SQLite
    // state: compare the file mtime against the last SQLite write.
    const fileMtime = existsSync(file) ? statSync(file).mtimeMs : 0;
    if (row && fileMtime < row.updated_at - 1000) {
      // SQLite is newer: the mirror is stale, keep the authoritative value.
      return JSON.parse(row.value) as T;
    }
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
