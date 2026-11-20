import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PermissionStore, buildGlobalAllowed } from "../src/permissions.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;
beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-perm-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("PermissionStore", () => {
  test("defaults to inherit + writable", () => {
    const s = new PermissionStore(join(root, "data"));
    const p = s.get("1:2");
    expect(p.readOnly).toBe(false);
    expect(p.inherit).toBe(true);
    expect(p.allowedUsers).toEqual([]);
  });

  test("canPrompt inherits global allowlist when empty", () => {
    const s = new PermissionStore(join(root, "data"));
    const global = new Set([1, 2]);
    expect(s.canPrompt("1:2", 1, global)).toBe(true);
    expect(s.canPrompt("1:2", 99, global)).toBe(false);
  });

  test("read-only blocks everyone", () => {
    const s = new PermissionStore(join(root, "data"));
    const global = new Set([1]);
    s.setReadOnly("1:2", true);
    expect(s.canPrompt("1:2", 1, global)).toBe(false);
    expect(s.isReadOnly("1:2")).toBe(true);
  });

  test("explicit allowedUsers override inherit", () => {
    const s = new PermissionStore(join(root, "data"));
    const global = new Set([1, 2]);
    s.addUser("1:2", 3, "operator");
    s.set("1:2", { inherit: false });
    expect(s.canPrompt("1:2", 3, global)).toBe(true);
    expect(s.canPrompt("1:2", 1, global)).toBe(false);
  });

  test("isAdmin falls back to global admin", () => {
    const s = new PermissionStore(join(root, "data"));
    expect(s.isAdmin("1:2", 5, 5)).toBe(true);
    expect(s.isAdmin("1:2", 6, 5)).toBe(false);
    s.addUser("1:2", 7, "admin");
    expect(s.isAdmin("1:2", 7, 5)).toBe(true);
    expect(s.isAdmin("1:2", 5, 5)).toBe(false);
  });

  test("removeUser drops from both lists", () => {
    const s = new PermissionStore(join(root, "data"));
    s.addUser("1:2", 9, "operator");
    s.addUser("1:2", 9, "admin");
    s.removeUser("1:2", 9);
    const p = s.get("1:2");
    expect(p.allowedUsers).not.toContain(9);
    expect(p.adminUsers).not.toContain(9);
  });

  test("persists and reloads", () => {
    const s = new PermissionStore(join(root, "data"));
    s.addUser("1:2", 42, "operator");
    s.setReadOnly("1:2", true);
    const reloaded = new PermissionStore(join(root, "data"));
    expect(reloaded.get("1:2").allowedUsers).toContain(42);
    expect(reloaded.get("1:2").readOnly).toBe(true);
  });

  test("buildGlobalAllowed parses config", () => {
    const g = buildGlobalAllowed({ ADMIN_TELEGRAM_USER_ID: 5, ALLOWED_TELEGRAM_USER_IDS: "1,2,x" });
    expect(g.has(5)).toBe(true);
    expect(g.has(1)).toBe(true);
    expect(g.has(2)).toBe(true);
    expect(g.size).toBe(3);
  });
});
