import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FileAccessError,
  MAX_DOCUMENT_BYTES,
  findFiles,
  formatBytes,
  listDirectory,
  prepareDocument,
  readTextFile,
  resolveSafePath,
} from "../src/files/index.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;
let base: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-files-"));
  base = join(root, "project");
  outside = join(root, "outside");
  mkdirSync(base);
  mkdirSync(outside);
  mkdirSync(join(base, "src"));
  mkdirSync(join(base, "node_modules"));
  mkdirSync(join(base, ".hidden"));
  writeFileSync(join(base, "README.md"), "# hello\nline two\nline three\n");
  writeFileSync(join(base, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(join(base, "node_modules", "lib.js"), "ignored\n");
  writeFileSync(join(base, ".env"), "SECRET=1\n");
  writeFileSync(join(base, ".hidden", "note.txt"), "hidden\n");
  writeFileSync(join(outside, "secret.txt"), "nope\n");
  symlinkSync(join(base, "README.md"), join(base, "readme-link.md"));
  symlinkSync(outside, join(base, "outside-link"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function errorCode(promise: Promise<unknown>): Promise<FileAccessError> {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(FileAccessError);
  return err as FileAccessError;
}

describe("resolveSafePath", () => {
  test("accepts the base directory and paths inside it", async () => {
    const atBase = await resolveSafePath(base);
    expect(atBase.relative).toBe("");
    expect(atBase.absolute).toBe(await resolveSafePath(base, ".").then((p) => p.absolute));

    const readme = await resolveSafePath(base, "README.md");
    expect(readme.relative).toBe("README.md");

    const absolute = await resolveSafePath(base, join(base, "src", "app.ts"));
    expect(absolute.relative).toBe("src/app.ts");
  });

  test("rejects parent traversal, absolute paths and symlinks that escape", async () => {
    expect((await errorCode(resolveSafePath(base, "../outside/secret.txt"))).code).toBe("outside");
    expect((await errorCode(resolveSafePath(base, "/etc/passwd"))).code).toBe("outside");
    expect((await errorCode(resolveSafePath(base, "outside-link/secret.txt"))).code).toBe("outside");
  });

  test("reports missing paths and invalid input", async () => {
    expect((await errorCode(resolveSafePath(base, "missing.txt"))).code).toBe("not_found");
    expect((await errorCode(resolveSafePath(base, "bad\0path"))).code).toBe("invalid");
  });
});

describe("listDirectory", () => {
  test("lists directories first with sizes and resolves internal symlinks", async () => {
    const listing = await listDirectory(base);
    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));

    expect(listing.path).toBe("");
    expect(listing.entries[0].type).toBe("directory");
    expect(listing.entries.slice(0, 2).map((entry) => entry.name)).toEqual(["node_modules", "src"]);
    expect(listing.entries.findIndex((entry) => entry.type !== "directory")).toBe(2);
    expect(byName.get("src")?.type).toBe("directory");
    expect(byName.get("README.md")?.type).toBe("file");
    expect(byName.get("README.md")?.size).toBeGreaterThan(0);
    expect(byName.get("readme-link.md")?.symlink).toBe(true);
    expect(byName.get("readme-link.md")?.external).toBe(false);
    expect(byName.get("readme-link.md")?.type).toBe("file");
    expect(byName.get("outside-link")?.external).toBe(true);
    expect(byName.has(".env")).toBe(false);
  });

  test("can include hidden entries", async () => {
    const listing = await listDirectory(base, "", { includeHidden: true });
    const names = listing.entries.map((entry) => entry.name);
    expect(names).toContain(".env");
    expect(names).toContain(".hidden");
  });

  test("lists a subdirectory and rejects files", async () => {
    const src = await listDirectory(base, "src");
    expect(src.entries.map((entry) => entry.path)).toEqual(["src/app.ts"]);
    expect((await errorCode(listDirectory(base, "README.md"))).code).toBe("not_directory");
  });
});

describe("findFiles", () => {
  test("matches recursively, skips node_modules and symlinks", async () => {
    const found = await findFiles(base, "app");
    expect(found.entries.map((entry) => entry.path)).toEqual(["src/app.ts"]);

    const lib = await findFiles(base, "lib");
    expect(lib.entries).toHaveLength(0);

    const secret = await findFiles(base, "secret");
    expect(secret.entries).toHaveLength(0);
  });

  test("filters by type and supports hidden files", async () => {
    const dirs = await findFiles(base, "src", { type: "directory" });
    expect(dirs.entries.map((entry) => entry.path)).toEqual(["src"]);

    const notes = await findFiles(base, "note", { includeHidden: true });
    expect(notes.entries.map((entry) => entry.path)).toEqual([".hidden/note.txt"]);
  });

  test("honours limit and reports truncation", async () => {
    const found = await findFiles(base, "a", { limit: 1 });
    expect(found.entries).toHaveLength(1);
    expect(found.truncated).toBe(true);
  });
});

describe("readTextFile", () => {
  test("reads a full text file", async () => {
    const read = await readTextFile(base, "README.md");
    expect(read.relative).toBe("README.md");
    expect(read.text).toContain("line two");
    expect(read.totalLines).toBe(4);
    expect(read.truncated).toBe(false);
  });

  test("slices lines and reports the range", async () => {
    const read = await readTextFile(base, "README.md", { startLine: 2, maxLines: 1 });
    expect(read.text).toBe("line two");
    expect(read.startLine).toBe(2);
    expect(read.endLine).toBe(2);
    expect(read.truncated).toBe(true);
  });

  test("reads through internal symlinks but not outside ones", async () => {
    const read = await readTextFile(base, "readme-link.md");
    expect(read.text).toContain("# hello");
    expect((await errorCode(readTextFile(base, "outside-link/secret.txt"))).code).toBe("outside");
  });

  test("rejects binary files and truncates large reads", async () => {
    writeFileSync(join(base, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    expect((await errorCode(readTextFile(base, "bin.dat"))).code).toBe("binary");

    writeFileSync(join(base, "long.txt"), "0123456789");
    const read = await readTextFile(base, "long.txt", { maxBytes: 5 });
    expect(read.text).toBe("01234");
    expect(read.totalLines).toBeUndefined();
    expect(read.truncated).toBe(true);
  });
});

describe("prepareDocument", () => {
  test("returns file metadata for /file", async () => {
    const doc = await prepareDocument(base, "README.md");
    expect(doc.name).toBe("README.md");
    expect(doc.relative).toBe("README.md");
    expect(doc.size).toBeGreaterThan(0);
  });

  test("rejects directories, outside paths and oversized files", async () => {
    expect((await errorCode(prepareDocument(base, "src"))).code).toBe("not_file");
    expect((await errorCode(prepareDocument(base, "../outside/secret.txt"))).code).toBe("outside");
    expect((await errorCode(prepareDocument(base, "outside-link/secret.txt"))).code).toBe("outside");

    writeFileSync(join(base, "huge.bin"), "");
    truncateSync(join(base, "huge.bin"), MAX_DOCUMENT_BYTES + 1);
    expect((await errorCode(prepareDocument(base, "huge.bin"))).code).toBe("too_large");
  });
});

describe("formatBytes", () => {
  test("formats common sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});
