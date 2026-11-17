import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearReadCache, readTextFile, resolveSafePath, FileAccessError } from "../src/files/index.js";

const TEST_ROOT = "/tmp/opencode";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(TEST_ROOT, "ocg-md-"));
  clearReadCache();
});

afterEach(() => {
  clearReadCache();
  rmSync(base, { recursive: true, force: true });
});

describe("markdown file lifecycle (create, edit, delete)", () => {
  test("creates an md file and reads it through the safe path", async () => {
    writeFileSync(join(base, "nota.md"), "# Nota\n\nContenido inicial.\n", "utf8");
    const safe = await resolveSafePath(base, "nota.md");
    expect(safe.relative).toBe("nota.md");
    const read = await readTextFile(base, "nota.md");
    expect(read.text).toContain("# Nota");
    expect(read.text).toContain("Contenido inicial.");
  });

  test("edits the md file and reads the new content after clearing the cache", async () => {
    writeFileSync(join(base, "nota.md"), "# Nota\n\nv1\n", "utf8");
    expect((await readTextFile(base, "nota.md")).text).toContain("v1");

    writeFileSync(join(base, "nota.md"), "# Nota\n\nv2 con más texto\n", "utf8");
    clearReadCache();
    const read = await readTextFile(base, "nota.md");
    expect(read.text).toContain("v2 con más texto");
    expect(read.text).not.toContain("v1");
    expect(readFileSync(join(base, "nota.md"), "utf8")).toContain("v2");
  });

  test("deletes the md file and the safe read reports not_found", async () => {
    writeFileSync(join(base, "nota.md"), "# Nota\n\na borrar\n", "utf8");
    expect((await readTextFile(base, "nota.md")).text).toContain("a borrar");

    unlinkSync(join(base, "nota.md"));
    clearReadCache();
    await expect(readTextFile(base, "nota.md")).rejects.toBeInstanceOf(FileAccessError);
    await expect(resolveSafePath(base, "nota.md")).rejects.toBeInstanceOf(FileAccessError);
  });
});
