import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "./db.js";
import { readJsonSafe } from "./persist.js";
import { logger } from "./logger.js";
import { esc } from "./util.js";

export type ThreadRole = "viewer" | "operator" | "admin";

export type ThreadPermissions = {
  allowedUsers: number[];
  adminUsers: number[];
  readOnly: boolean;
  inherit: boolean;
};

export const DEFAULT_THREAD_PERMISSIONS: ThreadPermissions = {
  allowedUsers: [],
  adminUsers: [],
  readOnly: false,
  inherit: true,
};

export class PermissionStore {
  private readonly db: ReturnType<typeof getDatabase>;
  private readonly dataDir: string;
  private readonly jsonFile: string;

  constructor(dataDir = join(process.cwd(), "data")) {
    mkdirSync(dataDir, { recursive: true });
    // Permissions live in the same SQLite database as every other state key.
    this.db = getDatabase(dataDir);
    this.dataDir = dataDir;
    this.jsonFile = join(dataDir, "permissions.json");
    this.migrateJson();
    this.migrateLegacyDb();
  }

  /** Import the standalone `permissions.db` used by 0.3.x, if present. */
  private migrateLegacyDb(): void {
    const legacy = join(this.dataDir, "permissions.db");
    if (!existsSync(legacy)) return;
    try {
      const old = new Database(legacy);
      const rows = old.query("SELECT route_key, read_only, inherit FROM permissions").all() as Array<{ route_key: string; read_only: number; inherit: number }>;
      const users = old.query("SELECT route_key, user_id, role FROM permission_users").all() as Array<{ route_key: string; user_id: number; role: string }>;
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          this.db.run("INSERT OR IGNORE INTO permissions (route_key, read_only, inherit) VALUES (?, ?, ?)", r.route_key, r.read_only, r.inherit);
        }
        for (const u of users) {
          this.db.run("INSERT OR IGNORE INTO permission_users (route_key, user_id, role) VALUES (?, ?, ?)", u.route_key, u.user_id, u.role);
        }
      });
      tx();
      old.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${legacy}${suffix}`;
        if (existsSync(file)) renameSync(file, `${file}.migrated`);
      }
      logger.info("permissions", "legacy permissions.db imported into the central database");
    } catch (err) {
      logger.error("permissions", "legacy db migration failed", err);
    }
  }

  private migrateJson(): void {
    if (!existsSync(this.jsonFile)) return;
    try {
      const parsed = readJsonSafe<Record<string, Partial<ThreadPermissions>>>(this.jsonFile, "permissions");
      // The JSON file is a legacy migration source only. If SQLite already has
      // permission rows, importing again would overwrite live ACLs written by
      // the bot (for example after a failed rename of the old file).
      const existing = this.db.query(
        "SELECT (SELECT COUNT(*) FROM permissions) + (SELECT COUNT(*) FROM permission_users) AS n",
      ).get() as { n: number };
      if (parsed && (existing?.n ?? 0) === 0) {
        const tx = this.db.transaction(() => {
          for (const [k, v] of Object.entries(parsed)) {
            if (!k) continue;
            this.db.run("INSERT OR IGNORE INTO permissions (route_key, read_only, inherit) VALUES (?, ?, ?)",
              k, v?.readOnly ? 1 : 0, v?.inherit === false ? 0 : 1);
            for (const u of v?.allowedUsers ?? []) {
              this.db.run("INSERT OR IGNORE INTO permission_users (route_key, user_id, role) VALUES (?, ?, ?)", k, u, "operator");
            }
            for (const u of v?.adminUsers ?? []) {
              this.db.run("INSERT OR IGNORE INTO permission_users (route_key, user_id, role) VALUES (?, ?, ?)", k, u, "admin");
            }
          }
        });
        tx();
      }
      renameSync(this.jsonFile, `${this.jsonFile}.migrated`);
    } catch (err) {
      logger.error("permissions", "json migration failed", err);
    }
  }

  get(routeKey: string): ThreadPermissions {
    const row = this.db.query("SELECT read_only, inherit FROM permissions WHERE route_key = ?").get(routeKey) as { read_only: number; inherit: number } | null;
    const users = this.db.query("SELECT user_id, role FROM permission_users WHERE route_key = ?").all(routeKey) as { user_id: number; role: string }[];
    return {
      allowedUsers: users.filter((u) => u.role === "operator").map((u) => u.user_id),
      adminUsers: users.filter((u) => u.role === "admin").map((u) => u.user_id),
      readOnly: row?.read_only === 1,
      inherit: row ? row.inherit === 1 : true,
    };
  }

  set(routeKey: string, perms: Partial<ThreadPermissions>): ThreadPermissions {
    const cur = this.get(routeKey);
    const next = { ...cur, ...perms };
    const tx = this.db.transaction(() => {
      this.db.run("INSERT OR REPLACE INTO permissions (route_key, read_only, inherit) VALUES (?, ?, ?)",
        routeKey, next.readOnly ? 1 : 0, next.inherit ? 1 : 0);
      if (perms.allowedUsers) {
        this.db.run("DELETE FROM permission_users WHERE route_key = ? AND role = 'operator'", routeKey);
        for (const u of next.allowedUsers) this.db.run("INSERT OR REPLACE INTO permission_users (route_key, user_id, role) VALUES (?, ?, ?)", routeKey, u, "operator");
      }
      if (perms.adminUsers) {
        this.db.run("DELETE FROM permission_users WHERE route_key = ? AND role = 'admin'", routeKey);
        for (const u of next.adminUsers) this.db.run("INSERT OR REPLACE INTO permission_users (route_key, user_id, role) VALUES (?, ?, ?)", routeKey, u, "admin");
      }
    });
    tx();
    return this.get(routeKey);
  }

  canPrompt(routeKey: string, userId: number | undefined, globalAllowed: Set<number>): boolean {
    const p = this.get(routeKey);
    if (p.readOnly) return false;
    if (userId === undefined) return false;
    // Operators are ADDITIVE to the global allowlist: granting one must not
    // lock out the admin or the other allowed users. `inherit: false` is the
    // explicit way to use only the per-thread list.
    if (p.inherit && globalAllowed.has(userId)) return true;
    return p.allowedUsers.includes(userId);
  }

  isAdmin(routeKey: string, userId: number | undefined, globalAdmin?: number): boolean {
    const p = this.get(routeKey);
    // The configured global admin is always an admin of every route.
    if (userId !== undefined && globalAdmin !== undefined && userId === globalAdmin) return true;
    return userId !== undefined && p.adminUsers.includes(userId);
  }

  isReadOnly(routeKey: string): boolean {
    return this.get(routeKey).readOnly;
  }

  addUser(routeKey: string, userId: number, role: ThreadRole): ThreadPermissions {
    const p = this.get(routeKey);
    if (role === "admin") {
      if (!p.adminUsers.includes(userId)) p.adminUsers.push(userId);
    } else if (role === "operator") {
      if (!p.allowedUsers.includes(userId)) p.allowedUsers.push(userId);
    }
    return this.set(routeKey, p);
  }

  removeUser(routeKey: string, userId: number): ThreadPermissions {
    const p = this.get(routeKey);
    p.allowedUsers = p.allowedUsers.filter((u) => u !== userId);
    p.adminUsers = p.adminUsers.filter((u) => u !== userId);
    // delete rows directly to handle both roles
    this.db.run("DELETE FROM permission_users WHERE route_key = ? AND user_id = ?", routeKey, userId);
    return this.get(routeKey);
  }

  setReadOnly(routeKey: string, value: boolean): ThreadPermissions {
    return this.set(routeKey, { readOnly: value });
  }

  listUsers(routeKey: string): Array<{ userId: number; role: ThreadRole }> {
    const users = this.db.query("SELECT user_id, role FROM permission_users WHERE route_key = ?").all(routeKey) as { user_id: number; role: string }[];
    return users.map((u) => ({ userId: u.user_id, role: (u.role === "admin" ? "admin" : "operator") }));
  }

  /** Remember a Telegram username so permissions can be managed with @name. */
  rememberUser(userId: number, username?: string | null): void {
    const clean = (username ?? "").replace(/^@/, "").trim().toLowerCase();
    if (!clean || !Number.isFinite(userId) || userId <= 0) return;
    const tx = this.db.transaction(() => {
      // A username belongs to a single account: if it moved (or a stale row
      // survived), release it from the previous user before reusing it.
      this.db.run("DELETE FROM known_users WHERE username = ? AND user_id <> ?", clean, userId);
      this.db.run(
        "INSERT INTO known_users (user_id, username, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, updated_at = excluded.updated_at",
        userId, clean, Date.now(),
      );
    });
    tx();
  }

  /** Resolve a numeric ID or a previously seen @username to a user ID. */
  resolveUser(token: string | undefined): number | undefined {
    const t = (token ?? "").trim().replace(/^@/, "");
    if (!t) return undefined;
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
    // ORDER BY keeps the newest mapping even on databases migrated from the
    // old non-unique index.
    const row = this.db.query(
      "SELECT user_id FROM known_users WHERE username = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(t.toLowerCase()) as { user_id: number } | null;
    return row?.user_id;
  }

  usernameFor(userId: number): string | undefined {
    const row = this.db.query("SELECT username FROM known_users WHERE user_id = ?").get(userId) as { username: string } | null;
    return row?.username;
  }

  /** Human label for a user: @username when known, numeric ID otherwise. */
  label(userId: number): string {
    const name = this.usernameFor(userId);
    return name ? `@${name}` : String(userId);
  }

  /** Render a button-driven panel for the current thread. */
  renderPanel(routeKey: string, _globalAdmin?: number): { html: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
    const p = this.get(routeKey);
    // Defense in depth: route keys and usernames come from Telegram, but they
    // are interpolated into HTML, so escape them like every other user value.
    const lines = [
      `🔐 <b>Permisos del thread</b>`,
      `<code>${esc(routeKey)}</code>`,
      "",
      `Modo: ${p.readOnly ? "🔒 solo lectura" : "✏️ escritura permitida"}`,
      `Heredar allowlist: ${p.inherit ? "sí" : "no"}`,
      `Operadores: ${p.allowedUsers.length ? p.allowedUsers.map((u) => esc(this.label(u))).join(", ") : "(global)"}`,
      `Admins: ${p.adminUsers.length ? p.adminUsers.map((u) => esc(this.label(u))).join(", ") : "(global admin)"}`,
    ];
    const users = this.listUsers(routeKey);
    if (users.length) {
      lines.push("", "<b>Usuarios:</b>");
      for (const u of users) lines.push(`• ${esc(this.label(u.userId))} — ${u.role}`);
    }
    lines.push("", "<i>Añade con @username o con el ID numérico.</i>");
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    keyboard.push([{ text: p.readOnly ? "🔓 Permitir escritura" : "🔒 Solo lectura", callback_data: `permui:readonly:${p.readOnly ? "off" : "on"}` }]);
    keyboard.push([{ text: p.inherit ? "🔗 Heredar: sí" : "🔗 Heredar: no", callback_data: `permui:inherit:${p.inherit ? "off" : "on"}` }]);
    for (const u of users) {
      keyboard.push([{ text: `🗑 ${this.label(u.userId)} (${u.role})`.slice(0, 60), callback_data: `permui:remove:${u.userId}` }]);
    }
    keyboard.push([{ text: "➕ Añadir usuario", callback_data: "permui:add" }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    return { html: lines.join("\n"), keyboard };
  }
}

export function buildGlobalAllowed(config: { ADMIN_TELEGRAM_USER_ID?: number; ALLOWED_TELEGRAM_USER_IDS?: string }): Set<number> {
  const out = new Set<number>();
  if (config.ADMIN_TELEGRAM_USER_ID) out.add(config.ADMIN_TELEGRAM_USER_ID);
  if (config.ALLOWED_TELEGRAM_USER_IDS) {
    for (const part of config.ALLOWED_TELEGRAM_USER_IDS.split(",")) {
      const raw = part.trim();
      // Telegram IDs are positive integers; reject "1.5", "1e3" or negatives.
      if (!/^\d+$/.test(raw)) continue;
      const n = Number(raw);
      if (Number.isSafeInteger(n) && n > 0) out.add(n);
    }
  }
  return out;
}