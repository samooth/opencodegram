import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe } from "./persist.js";
import { logger } from "./logger.js";

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

const SCHEMA = `
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
`;

export class PermissionStore {
  private readonly db: Database;
  private readonly jsonFile: string;

  constructor(dataDir = join(process.cwd(), "data")) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "permissions.db"));
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run(SCHEMA);
    this.jsonFile = join(dataDir, "permissions.json");
    this.migrateJson();
  }

  private migrateJson(): void {
    if (!existsSync(this.jsonFile)) return;
    try {
      const parsed = readJsonSafe<Record<string, Partial<ThreadPermissions>>>(this.jsonFile, "permissions");
      if (parsed) {
        const tx = this.db.transaction(() => {
          for (const [k, v] of Object.entries(parsed)) {
            if (!k) continue;
            this.db.run("INSERT OR REPLACE INTO permissions (route_key, read_only, inherit) VALUES (?, ?, ?)",
              k, v?.readOnly ? 1 : 0, v?.inherit === false ? 0 : 1);
            for (const u of v?.allowedUsers ?? []) {
              this.db.run("INSERT OR REPLACE INTO permission_users (route_key, user_id, role) VALUES (?, ?, ?)", k, u, "operator");
            }
            for (const u of v?.adminUsers ?? []) {
              this.db.run("INSERT OR REPLACE INTO permission_users (route_key, user_id, role) VALUES (?, ?, ?)", k, u, "admin");
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
    const allowed = p.inherit && p.allowedUsers.length === 0 ? globalAllowed : new Set(p.allowedUsers);
    return userId !== undefined && allowed.has(userId);
  }

  isAdmin(routeKey: string, userId: number | undefined, globalAdmin?: number): boolean {
    const p = this.get(routeKey);
    if (p.adminUsers.length) return userId !== undefined && p.adminUsers.includes(userId);
    return userId !== undefined && globalAdmin !== undefined && userId === globalAdmin;
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

  /** Render a button-driven panel for the current thread. */
  renderPanel(routeKey: string, globalAdmin?: number): { html: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
    const p = this.get(routeKey);
    const lines = [
      `🔐 <b>Permisos del thread</b>`,
      `<code>${routeKey}</code>`,
      "",
      `Modo: ${p.readOnly ? "🔒 solo lectura" : "✏️ escritura permitida"}`,
      `Heredar allowlist: ${p.inherit ? "sí" : "no"}`,
      `Operadores: ${p.allowedUsers.length ? p.allowedUsers.join(", ") : "(global)"}`,
      `Admins: ${p.adminUsers.length ? p.adminUsers.join(", ") : "(global admin)"}`,
    ];
    const users = this.listUsers(routeKey);
    if (users.length) {
      lines.push("", "<b>Usuarios:</b>");
      for (const u of users) lines.push(`• ${u.userId} — ${u.role}`);
    }
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    keyboard.push([{ text: p.readOnly ? "🔓 Permitir escritura" : "🔒 Solo lectura", callback_data: `permui:readonly:${p.readOnly ? "off" : "on"}` }]);
    keyboard.push([{ text: p.inherit ? "🔗 Heredar: sí" : "🔗 Heredar: no", callback_data: `permui:inherit:${p.inherit ? "off" : "on"}` }]);
    for (const u of users) {
      keyboard.push([{ text: `🗑 ${u.userId} (${u.role})`, callback_data: `permui:remove:${u.userId}` }]);
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
      const n = Number(part.trim());
      if (Number.isFinite(n) && n > 0) out.add(n);
    }
  }
  return out;
}