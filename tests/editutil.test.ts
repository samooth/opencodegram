import { describe, expect, test } from "bun:test";
import { isEditTool, extractEditFile, editStats, formatEditDiff, describeToolInput } from "../src/editutil.js";

describe("isEditTool", () => {
  test("detects edit by name", () => {
    expect(isEditTool("edit")).toBe(true);
    expect(isEditTool("Edit")).toBe(true);
    expect(isEditTool("apply_patch")).toBe(true);
    expect(isEditTool("write")).toBe(true);
    expect(isEditTool("multiedit")).toBe(true);
  });
  test("detects edit by input containing old/new string", () => {
    expect(isEditTool("foo", JSON.stringify({ oldString: "a", newString: "b" }))).toBe(true);
    expect(isEditTool("foo", JSON.stringify({ old_string: "a", new_string: "b" }))).toBe(true);
  });
  test("returns false for non-edit tools", () => {
    expect(isEditTool("read")).toBe(false);
    expect(isEditTool("bash")).toBe(false);
  });
});

describe("extractEditFile", () => {
  test("extracts filePath from JSON", () => {
    expect(extractEditFile(JSON.stringify({ filePath: "src/a.ts", oldString: "x", newString: "y" }))).toBe("src/a.ts");
  });
  test("extracts file_path", () => {
    expect(extractEditFile(JSON.stringify({ file_path: "b.ts" }))).toBe("b.ts");
  });
  test("extracts from apply_patch format", () => {
    const input = "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-old\n+new\n*** End Patch";
    expect(extractEditFile(input)).toBe("src/c.ts");
  });
  test("returns null for invalid input", () => {
    expect(extractEditFile(undefined)).toBeNull();
    expect(extractEditFile("not json")).toBeNull();
  });
});

describe("editStats", () => {
  test("counts added and removed lines", () => {
    const input = JSON.stringify({ filePath: "a.ts", oldString: "line1\nline2", newString: "line1\nline2\nline3" });
    const stats = editStats(input);
    expect(stats.file).toBe("a.ts");
    expect(stats.added).toBeGreaterThan(0);
  });
});

describe("formatEditDiff", () => {
  test("simple style produces +/- lines", () => {
    const input = JSON.stringify({ filePath: "a.ts", oldString: "old", newString: "new" });
    const diff = formatEditDiff(input, "simple");
    expect(diff).toContain("- old");
    expect(diff).toContain("+ new");
    expect(diff).toContain("--- a.ts");
  });
  test("unified style produces hunks with context", () => {
    const input = JSON.stringify({ filePath: "a.ts", oldString: "line1\nold\nline3", newString: "line1\nnew\nline3" });
    const diff = formatEditDiff(input, "unified");
    expect(diff).toContain("@@");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });
  test("handles apply_patch format", () => {
    const input = "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-old line\n+new line\n*** End Patch";
    const diff = formatEditDiff(input, "simple");
    expect(diff).toContain("--- src/x.ts");
    expect(diff).toContain("- old line");
    expect(diff).toContain("+ new line");
  });
  test("write tool input with path and content renders as an added-file diff", () => {
    const input = JSON.stringify({ path: "/repo/src/foo.ts", content: "linea uno\nlinea dos" });
    const diff = formatEditDiff(input, "simple");
    expect(diff).toContain("+++ /repo/src/foo.ts");
    expect(diff).toContain("+ linea uno");
    expect(diff).not.toContain('"content"');
    const stats = editStats(input);
    expect(stats.added).toBe(2);
    expect(stats.removed).toBe(0);
  });

  test("returns raw input for non-JSON non-patch", () => {
    expect(formatEditDiff("raw text")).toBe("raw text");
  });
  test("returns empty for undefined", () => {
    expect(formatEditDiff(undefined)).toBe("");
  });
});
