import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, dbStats, getDatabase, importAllJson, jsonRead, jsonWrite, vacuum } from "../src/db.js";
import { PermissionStore } from "../src/permissions.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-db-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  closeDatabase(dataDir);
  rmSync(root, { recursive: true, force: true });
});

describe("SQLite central store", () => {
  test("imports a legacy JSON file into SQLite on first read", () => {
    const file = join(dataDir, "active.json");
    writeFileSync(file, JSON.stringify({ "1:0": "ses_1" }));
    expect(jsonRead<Record<string, string>>(file)).toEqual({ "1:0": "ses_1" });
    const db = getDatabase(dataDir);
    const row = db.query("SELECT value FROM kv_state WHERE key = ?").get("active.json") as { value: string } | null;
    expect(row).not.toBeNull();
    expect(row!.value).toContain("ses_1");
    // The JSON mirror is preserved as a human-readable backup.
    expect(existsSync(file)).toBe(true);
  });

  test("writes to SQLite and keeps the JSON mirror in sync", () => {
    const file = join(dataDir, "settings.json");
    jsonWrite(file, { showThinking: false });
    expect(jsonRead<{ showThinking: boolean }>(file)).toEqual({ showThinking: false });
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed).toEqual({ showThinking: false });
  });

  test("survives a new store instance", () => {
    const file = join(dataDir, "todos.json");
    jsonWrite(file, { "1:0": ["a", "b"] });
    closeDatabase(dataDir);
    const again = jsonRead<Record<string, string[]>>(file);
    expect(again).toEqual({ "1:0": ["a", "b"] });
  });

  test("an external edit of the JSON mirror wins and is re-imported", () => {
    const file = join(dataDir, "delivery.json");
    jsonWrite(file, { v: 1 });
    writeFileSync(file, JSON.stringify({ v: 2 }));
    expect(jsonRead<{ v: number }>(file)).toEqual({ v: 2 });
    const db = getDatabase(dataDir);
    const row = db.query("SELECT canonical FROM kv_state WHERE key = ?").get("delivery.json") as { canonical: string };
    expect(row.canonical).toBe('{"v":2}');
  });

  test("imports all top-level JSON files eagerly", () => {
    writeFileSync(join(dataDir, "todos.json"), JSON.stringify({ "1:0": ["x"] }));
    writeFileSync(join(dataDir, "delivery.json"), JSON.stringify({ a: 1 }));
    expect(importAllJson(dataDir)).toBe(2);
    const stats = dbStats(dataDir);
    expect(stats.keys.map((k) => k.key)).toEqual(["delivery.json", "todos.json"]);
  });

  test("statistics expose database size and key counts", () => {
    jsonWrite(join(dataDir, "active.json"), { a: 1 });
    jsonWrite(join(dataDir, "buttons.json"), { b: 2 });
    const stats = dbStats(dataDir);
    expect(existsSync(stats.file)).toBe(true);
    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.sqliteVersion).toMatch(/^\d+\./);
    expect(stats.kvEntries).toBe(2);
    expect(stats.keys.map((k) => k.key)).toEqual(["active.json", "buttons.json"]);
    expect(() => vacuum(dataDir)).not.toThrow();
  });

  test("permissions live in the same SQLite file", () => {
    const perms = new PermissionStore(dataDir);
    perms.addUser("1:2", 42, "operator");
    const db = getDatabase(dataDir);
    const count = db.query("SELECT COUNT(*) AS n FROM permission_users").get() as { n: number };
    expect(count.n).toBe(1);
    expect(existsSync(join(dataDir, "permissions.db"))).toBe(false);
    const stats = dbStats(dataDir);
    expect(stats.permissionUserRows).toBe(1);
  });

  test("migrates a standalone legacy permissions.db", () => {
    const legacy = join(dataDir, "permissions.db");
    const old = new Database(legacy);
    old.run("CREATE TABLE permissions (route_key TEXT PRIMARY KEY, read_only INTEGER, inherit INTEGER)");
    old.run("CREATE TABLE permission_users (route_key TEXT, user_id INTEGER, role TEXT, PRIMARY KEY (route_key, user_id))");
    old.run("INSERT INTO permissions VALUES (?, ?, ?)", "1:2", 1, 0);
    old.run("INSERT INTO permission_users VALUES (?, ?, ?)", "1:2", 42, "operator");
    old.close();
    const perms = new PermissionStore(dataDir);
    expect(perms.get("1:2")).toEqual({ allowedUsers: [42], adminUsers: [], readOnly: true, inherit: false });
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
  });

  test("migrates a legacy permissions.json into the central database", () => {
    writeFileSync(join(dataDir, "permissions.json"), JSON.stringify({
      "1:2": { allowedUsers: [7], adminUsers: [9], readOnly: true, inherit: false },
    }));
    const perms = new PermissionStore(dataDir);
    expect(perms.get("1:2")).toEqual({ allowedUsers: [7], adminUsers: [9], readOnly: true, inherit: false });
    expect(existsSync(join(dataDir, "permissions.json.migrated"))).toBe(true);
  });
});
