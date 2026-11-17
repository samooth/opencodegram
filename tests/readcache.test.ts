import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTextFile, clearReadCache } from "../src/files/read.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;
beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-readcache-")); clearReadCache(); });
afterEach(() => { clearReadCache(); rmSync(root, { recursive: true, force: true }); });

describe("readTextFile cache", () => {
  test("returns the same content on repeated reads", async () => {
    writeFileSync(join(root, "a.txt"), "hola\nmundo\n");
    const a = await readTextFile(root, "a.txt");
    const b = await readTextFile(root, "a.txt");
    expect(a.text).toBe(b.text);
    expect(a.text).toContain("hola");
  });

  test("different line ranges produce different cache entries", async () => {
    writeFileSync(join(root, "a.txt"), "linea1\nlinea2\nlinea3\n");
    const a = await readTextFile(root, "a.txt", { startLine: 1, maxLines: 1 });
    const b = await readTextFile(root, "a.txt", { startLine: 2, maxLines: 1 });
    expect(a.text).toContain("linea1");
    expect(a.text).not.toContain("linea2");
    expect(b.text).toContain("linea2");
    expect(b.text).not.toContain("linea1");
  });
});
