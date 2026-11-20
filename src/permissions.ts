import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./persist.js";
import { logger } from "./logger.js";

export type ThreadRole = "viewer" | "operator" | "admin";

export type ThreadPermissions = {
  /** Users who may send prompts in this thread/topic. */
  allowedUsers: number[];
  /** Users who may manage settings, sessions and dangerous commands. */
  adminUsers: number[];
  /** When true, nobody may prompt; the thread is read-only. */
  readOnly: boolean;
  /** When allowedUsers is empty, fall back to the global allowlist. */
  inherit: boolean;
};

export const DEFAULT_THREAD_PERMISSIONS: ThreadPermissions = {
  allowedUsers: [],
  adminUsers: [],
  readOnly: false,
  inherit: true,
};

export class PermissionStore {
  private readonly file: string;
  private readonly map = new Map<string, Partial<ThreadPermissions>>();

  constructor(dataDir = join(process.cwd(), "data")) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "permissions.json");
    this.load();
  }

  get(routeKey: string): ThreadPermissions {
    const p = this.map.get(routeKey) ?? {};
    const merged = { ...DEFAULT_THREAD_PERMISSIONS, ...p };
    if (!Array.isArray(merged.allowedUsers)) merged.allowedUsers = [];
    if (!Array.isArray(merged.adminUsers)) merged.adminUsers = [];
    return merged;
  }

  set(routeKey: string, perms: Partial<ThreadPermissions>): ThreadPermissions {
    const current = this.map.get(routeKey) ?? {};
    this.map.set(routeKey, { ...current, ...perms });
    this.save();
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
    return this.set(routeKey, p);
  }

  setReadOnly(routeKey: string, value: boolean): ThreadPermissions {
    return this.set(routeKey, { readOnly: value });
  }

  private save(): void {
    try {
      const obj: Record<string, Partial<ThreadPermissions>> = {};
      for (const [k, v] of this.map) obj[k] = v;
      writeJsonAtomic(this.file, obj, false);
    } catch (err) {
      logger.error("permissions", "save failed", err);
    }
  }

  private load(): void {
    const parsed = readJsonSafe<Record<string, Partial<ThreadPermissions>>>(this.file, "permissions");
    if (!parsed) return;
    for (const [k, v] of Object.entries(parsed)) {
      if (k) this.map.set(k, v ?? {});
    }
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