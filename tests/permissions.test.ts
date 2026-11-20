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

  test("isAdmin falls back to global admin and keeps it after adding one", () => {
    const s = new PermissionStore(join(root, "data"));
    expect(s.isAdmin("1:2", 5, 5)).toBe(true);
    expect(s.isAdmin("1:2", 6, 5)).toBe(false);
    s.addUser("1:2", 7, "admin");
    expect(s.isAdmin("1:2", 7, 5)).toBe(true);
    expect(s.isAdmin("1:2", 5, 5)).toBe(true);
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

  test("resolves @usernames to numeric IDs", () => {
    const s = new PermissionStore(join(root, "data"));
    s.rememberUser(123, "@Juan_Perez");
    expect(s.resolveUser("@juan_perez")).toBe(123);
    expect(s.resolveUser("Juan_Perez")).toBe(123);
    expect(s.resolveUser("123")).toBe(123);
    expect(s.resolveUser("@desconocido")).toBeUndefined();
  });

  test("labels users with their username when known", () => {
    const s = new PermissionStore(join(root, "data"));
    s.rememberUser(123, "juan");
    s.addUser("1:2", 123, "operator");
    expect(s.label(123)).toBe("@juan");
    expect(s.label(999)).toBe("999");
    const panel = s.renderPanel("1:2");
    expect(panel.html).toContain("@juan");
  });

  test("username mapping persists across instances", () => {
    const dataDir = join(root, "data");
    new PermissionStore(dataDir).rememberUser(77, "ana");
    expect(new PermissionStore(dataDir).resolveUser("@ana")).toBe(77);
  });

  test("panel shows @username on remove buttons", () => {
    const s = new PermissionStore(join(root, "data"));
    s.rememberUser(42, "maria");
    s.addUser("1:2", 42, "operator");
    const kb = s.renderPanel("1:2").keyboard.flat();
    const remove = kb.find((b) => b.callback_data === "permui:remove:42");
    expect(remove?.text).toContain("@maria");
  });

  test("adding an operator does not lock out the global allowlist", () => {
    const s = new PermissionStore(join(root, "data"));
    const global = new Set([1, 2]);
    s.addUser("1:2", 3, "operator");
    expect(s.canPrompt("1:2", 3, global)).toBe(true);
    expect(s.canPrompt("1:2", 1, global)).toBe(true);
    expect(s.canPrompt("1:2", 99, global)).toBe(false);
    s.set("1:2", { inherit: false });
    expect(s.canPrompt("1:2", 1, global)).toBe(false);
  });

  test("global admin stays admin after a thread admin is added", () => {
    const s = new PermissionStore(join(root, "data"));
    s.addUser("1:2", 7, "admin");
    expect(s.isAdmin("1:2", 5, 5)).toBe(true);
    expect(s.isAdmin("1:2", 7, 5)).toBe(true);
    expect(s.isAdmin("1:2", 8, 5)).toBe(false);
  });

  test("buildGlobalAllowed parses config", () => {
    const g = buildGlobalAllowed({ ADMIN_TELEGRAM_USER_ID: 5, ALLOWED_TELEGRAM_USER_IDS: "1,2,x" });
    expect(g.has(5)).toBe(true);
    expect(g.has(1)).toBe(true);
    expect(g.has(2)).toBe(true);
    expect(g.size).toBe(3);
  });
});
