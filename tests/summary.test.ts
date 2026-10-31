import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeFile, renderFileSummary } from "../src/files.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-summary-"));
  base = join(root, "project");
  mkdirSync(base, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("summarizeFile", () => {
  test("extracts TypeScript symbols", async () => {
    writeFileSync(join(base, "a.ts"), `import { x } from "./x";\nexport class Foo {}\nexport function bar() {}\nconst baz = 1;\n`);
    const s = await summarizeFile(base, "a.ts");
    expect(s.language).toBe("ts");
    expect(s.imports).toContain("./x");
    expect(s.symbols.some((x) => x.name === "Foo" && x.kind === "class")).toBe(true);
    expect(s.symbols.some((x) => x.name === "bar" && x.kind === "function")).toBe(true);
  });

  test("extracts Zig symbols", async () => {
    writeFileSync(join(base, "m.zig"), `const std = @import("std");\npub fn main() void {}\npub const Foo = struct { x: i32 };\n`);
    const s = await summarizeFile(base, "m.zig");
    expect(s.language).toBe("zig");
    expect(s.imports).toContain("std");
    expect(s.symbols.some((x) => x.name === "main" && x.kind === "function")).toBe(true);
    expect(s.symbols.some((x) => x.name === "Foo" && x.kind === "struct")).toBe(true);
  });

  test("extracts Python symbols", async () => {
    writeFileSync(join(base, "m.py"), `import os\nfrom x import y\nclass Foo:\n    pass\ndef bar():\n    pass\n`);
    const s = await summarizeFile(base, "m.py");
    expect(s.language).toBe("py");
    expect(s.symbols.some((x) => x.name === "Foo" && x.kind === "class")).toBe(true);
    expect(s.symbols.some((x) => x.name === "bar" && x.kind === "function")).toBe(true);
  });

  test("markdown sections", async () => {
    writeFileSync(join(base, "d.md"), `# Title\n## Sub\nbody\n`);
    const s = await summarizeFile(base, "d.md");
    expect(s.language).toBe("md");
    expect(s.sections).toContain("Title");
    expect(s.sections).toContain("Sub");
  });

  test("renderFileSummary produces HTML", () => {
    const out = renderFileSummary({ path: "/x/a.ts", relative: "a.ts", size: 10, lines: 4, language: "ts", imports: ["./x"], exports: [], symbols: [{ kind: "class", name: "Foo", line: 2 }], sections: [], head: [], tail: [], truncated: false });
    expect(out).toContain("a.ts");
    expect(out).toContain("Foo");
  });
});

import { searchTextFile } from "../src/files.js";

describe("searchTextFile", () => {
  test("finds literal matches", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const root = (await import("node:fs")).mkdtempSync("/tmp/opencode/ocg-search-");
    const base = j(root, "project");
    mkdirSync(base, { recursive: true });
    writeFileSync(j(base, "a.ts"), "foo\nbar foo\nbaz\nFOO\n");
    const r = await searchTextFile(base, "a.ts", "foo");
    expect(r.totalMatches).toBe(3); // foo, foo, FOO (case-insensitive)
    expect(r.matches.length).toBe(3);
    rmSync(root, { recursive: true, force: true });
  });

  test("regex mode", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const root = (await import("node:fs")).mkdtempSync("/tmp/opencode/ocg-search-");
    const base = j(root, "project");
    mkdirSync(base, { recursive: true });
    writeFileSync(j(base, "a.ts"), "abc123\ndef456\nghi\n");
    const r = await searchTextFile(base, "a.ts", "/\\d{3}/");
    expect(r.totalMatches).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});

import { treeDirectory } from "../src/files.js";

describe("treeDirectory", () => {
  test("renders a tree", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const root = (await import("node:fs")).mkdtempSync("/tmp/opencode/ocg-tree-");
    const base = j(root, "project");
    mkdirSync(base, { recursive: true });
    mkdirSync(j(base, "src"), { recursive: true });
    writeFileSync(j(base, "src", "a.ts"), "x");
    writeFileSync(j(base, "README.md"), "y");
    const t = await treeDirectory(base, ".", 3);
    expect(t.lines.some((l) => l.includes("src/"))).toBe(true);
    expect(t.lines.some((l) => l.includes("README.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
