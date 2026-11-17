import { describe, expect, test } from "bun:test";
import {
  closeOpen,
  createTurnActivity,
  recordThought,
  recordThoughtDelta,
  recordTool,
  finishTool,
  renderActivity,
  toolCategory,
  updateToolDetail,
} from "../src/activity.js";

describe("turn activity counters", () => {
  test("renders nothing when no activity was recorded", () => {
    expect(renderActivity(createTurnActivity(), "medium", false)).toBe("");
  });

  test("summarizes recorded thoughts with a plus prefix while working", () => {
    const a = createTurnActivity();
    recordThought(a, "primero", { at: 1000 });
    recordThought(a, "segundo", { at: 2000 });
    recordThought(a, "tercero", { at: 3000 });
    const out = renderActivity(a, "medium", false, 4000);
    expect(out).toContain("+3 thoughts");
  });

  test("uses a minus prefix for a finished turn", () => {
    const a = createTurnActivity();
    recordThought(a, "listo", { at: 1000 });
    const out = renderActivity(a, "medium", true, 1500);
    expect(out).toContain("−1 thought");
    expect(out).not.toContain("+1 thought");
  });

  test("categorizes reads, searches, edits and shells into counters", () => {
    expect(toolCategory("read")).toBe("read");
    expect(toolCategory("grep")).toBe("search");
    expect(toolCategory("edit")).toBe("edit");
    expect(toolCategory("bash")).toBe("shell");
    expect(toolCategory("mystery_tool")).toBe("tool");

    const a = createTurnActivity();
    recordTool(a, "read", "README.md", { at: 1000, toolId: "a" });
    recordTool(a, "grep", "foo", { at: 1100, toolId: "b" });
    recordTool(a, "edit", "src/x.ts", { at: 1200, toolId: "c" });
    recordTool(a, "bash", "bun test", { at: 1300, toolId: "d" });
    recordTool(a, "mystery_tool", "x", { at: 1400, toolId: "e" });
    const out = renderActivity(a, "high", false, 2000);
    expect(out).toContain("1 read");
    expect(out).toContain("1 search");
    expect(out).toContain("1 edit");
    expect(out).toContain("1 shell");
    expect(out).toContain("1 tool");
  });

  test("does not double count reads as generic tools", () => {
    const a = createTurnActivity();
    recordTool(a, "read", "README.md", { at: 1000, toolId: "a" });
    const out = renderActivity(a, "high", false, 1100);
    expect(out).not.toContain("1 tool");
    expect(out).toContain("1 read");
  });

  test("renders tool durations and success marks in the expandable detail", () => {
    const a = createTurnActivity();
    recordTool(a, "bash", "bun test", { at: 1000, toolId: "t1" });
    finishTool(a, "t1", true, { at: 1671 });
    const out = renderActivity(a, "high", true, 1700);
    expect(out).toContain("<blockquote>");
    expect(out).toContain("Shell");
    expect(out).toContain("671ms");
    expect(out).toContain("✅");
  });

  test("formats second-scale durations with one decimal", () => {
    const a = createTurnActivity();
    recordThought(a, "analizo", { at: 1000 });
    closeOpen(a, 4000);
    const out = renderActivity(a, "high", true, 4100);
    expect(out).toContain("3.0s");
  });

  test("groups consecutive reads and searches under Explored", () => {
    const a = createTurnActivity();
    recordTool(a, "read", ".", { at: 1000, toolId: "a" });
    recordTool(a, "glob", "README*", { at: 1100, toolId: "b" });
    const out = renderActivity(a, "high", false, 1200, true);
    expect(out).toContain("Explored: 1 read, 1 search");
    expect(out).toContain("Read");
    expect(out).toContain("Glob");
  });

  test("hides detail text at low verbosity and shows more at high verbosity", () => {
    const a = createTurnActivity();
    recordThought(a, "texto secreto del razonamiento", { at: 1000 });
    const low = renderActivity(a, "low", false, 1100);
    const high = renderActivity(a, "high", false, 1100, true);
    expect(low).not.toContain("texto secreto");
    expect(high).toContain("texto secreto");
  });

  test("escapes HTML from recorded details", () => {
    const a = createTurnActivity();
    recordThought(a, "<script>alert(1)</script>", { at: 1000 });
    const out = renderActivity(a, "high", false, 1100, true);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("caps the number of rendered entries to keep the card small", () => {
    const a = createTurnActivity();
    for (let i = 0; i < 100; i++) recordThought(a, `pensamiento ${i}`, { at: 1000 + i });
    const out = renderActivity(a, "high", false, 2000);
    expect(out).toContain("+100 thoughts");
    expect(out).not.toContain("pensamiento 0\n");
    expect((out.match(/Thought ·/g) ?? []).length).toBeLessThanOrEqual(40);
  });

  test("lazily opens a thought on the first delta without a started event", () => {
    const a = createTurnActivity();
    recordThoughtDelta(a, "delta inicial", { at: 1000 });
    expect(a.thoughts).toBe(1);
    const out = renderActivity(a, "high", false, 1100, true);
    expect(out).toContain("delta inicial");
  });

  test("expanded mode renders detail as block elements instead of an expandable quote", () => {
    const a = createTurnActivity();
    recordThought(a, "texto visible", { at: 1000 });
    const out = renderActivity(a, "high", false, 1100, true);
    expect(out).toContain("<p>");
    expect(out).toContain("texto visible");
    expect(out).not.toContain("<blockquote expandable>");
  });

  test("collapsed mode keeps one block per row", () => {
    const a = createTurnActivity();
    recordThought(a, "oculto", { at: 1000 });
    const out = renderActivity(a, "high", false, 1100, false);
    expect(out).toContain("<blockquote>");
  });

  test("keeps the detail block within a character budget so HTML is never cut mid-tag", () => {
    const a = createTurnActivity();
    for (let i = 0; i < 40; i++) recordThought(a, "x".repeat(300), { at: 1000 + i });
    const out = renderActivity(a, "high", false, 2000, true);
    expect(out.length).toBeLessThan(2500);
    expect(out.trimEnd().endsWith("</blockquote>")).toBe(true);
  });

  test("shell entries extract the command from a JSON input", () => {
    const a = createTurnActivity();
    recordTool(a, "bash", JSON.stringify({ command: "bun test" }), { at: 1000, toolId: "a" });
    expect(a.entries[0]?.detail).toBe("bun test");
    const out = renderActivity(a, "high", false, 1100, true);
    expect(out).toContain("$ bun test");
    expect(out).not.toContain("&quot;command&quot;");
  });

  test("shell detail updates also extract the command from JSON", () => {
    const a = createTurnActivity();
    recordTool(a, "bash", "", { at: 1000, toolId: "a" });
    updateToolDetail(a, "a", JSON.stringify({ cmd: "git status" }));
    expect(a.entries[0]?.detail).toBe("git status");
  });

  test("collapsed headers omit the open spinner, expanded ones keep it", () => {
    const a = createTurnActivity();
    recordThought(a, "pensando", { at: 1000 });
    const collapsed = renderActivity(a, "high", false, 1100, false);
    const expanded = renderActivity(a, "high", false, 1100, true);
    expect(collapsed).not.toContain("⏳");
    expect(expanded).toContain("⏳");
  });

  test("edit entries show the file path instead of raw JSON", () => {
    const a = createTurnActivity();
    recordTool(a, "edit", JSON.stringify({ filePath: "/workspace/src/pilot.py", oldString: "a", newString: "b" }), { at: 1000, toolId: "e" });
    expect(a.entries[0]?.detail).toBe("/workspace/src/pilot.py");
    const out = renderActivity(a, "high", false, 1100, true);
    expect(out).toContain("pilot.py");
    expect(out).not.toContain("oldString");
  });

  test("groups consecutive shell calls into one terminal-like block", () => {
    const a = createTurnActivity();
    recordTool(a, "bash", "bun test", { at: 1000, toolId: "a" });
    finishTool(a, "a", true, { at: 1100 });
    recordTool(a, "bash", "git status", { at: 1200, toolId: "b" });
    finishTool(a, "b", true, { at: 1300 });
    const out = renderActivity(a, "high", false, 1400, true);
    expect(out).toContain("Shell (2)");
    expect(out).toContain("$ bun test");
    expect(out).toContain("$ git status");
    expect(out.match(/<blockquote>/g)).toHaveLength(1);
  });

  test("collapsed mode shows headers only so the toggle has a visible effect", () => {
    const a = createTurnActivity();
    recordThought(a, "texto del pensamiento", { at: 1000 });
    const collapsed = renderActivity(a, "high", false, 1100, false);
    const expanded = renderActivity(a, "high", false, 1100, true);
    expect(collapsed).not.toContain("texto del pensamiento");
    expect(expanded).toContain("texto del pensamiento");
  });

  test("collapsed mode shows only the last few entries", () => {
    const a = createTurnActivity();
    for (let i = 0; i < 20; i++) recordThought(a, `pensamiento ${i}`, { at: 1000 + i });
    const collapsed = renderActivity(a, "high", false, 2000, false);
    const expanded = renderActivity(a, "high", false, 2000, true);
    expect((collapsed.match(/<blockquote/g) ?? []).length).toBeLessThanOrEqual(7);
    expect((expanded.match(/<blockquote/g) ?? []).length).toBeGreaterThan((collapsed.match(/<blockquote/g) ?? []).length);
  });

  test("summary line is a block element so it does not glue to the prompt", () => {
    const a = createTurnActivity();
    recordThought(a, "algo", { at: 1000 });
    expect(renderActivity(a, "medium", false, 1100, false)).toMatch(/^<p>[+−]/);
  });

  test("gives each entry its own expandable block in collapsed mode", () => {
    const a = createTurnActivity();
    recordThought(a, "primero", { at: 1000 });
    closeOpen(a, 1500);
    recordThought(a, "segundo", { at: 2000 });
    closeOpen(a, 2500);
    recordTool(a, "read", "README.md", { at: 3000, toolId: "a" });
    const out = renderActivity(a, "high", false, 3500, false);
    expect(out.match(/<blockquote>/g)).toHaveLength(3);
    expect(out).toContain("Thought</b> · 500ms");
  });
});
