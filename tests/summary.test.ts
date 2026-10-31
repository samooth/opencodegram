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
