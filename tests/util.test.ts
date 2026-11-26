import { describe, expect, test } from "bun:test";
import { clampText, contextUsage, esc, isAgentMonologue, normalizeCommandText, parseSlashCommand, rateLimitRetryAt, stripAgentMonologue } from "../src/util.js";

describe("rateLimitRetryAt", () => {
  test("schedules :15 of the current hour before the mark", () => {
    const retry = rateLimitRetryAt(new Date(2026, 0, 1, 10, 5, 30));
    expect(retry.getHours()).toBe(10);
    expect(retry.getMinutes()).toBe(15);
    expect(retry.getSeconds()).toBe(0);
    expect(retry.getMilliseconds()).toBe(0);
  });

  test("schedules :15 of the next hour after the mark", () => {
    const retry = rateLimitRetryAt(new Date(2026, 0, 1, 10, 15, 0));
    expect(retry.getHours()).toBe(11);
    expect(retry.getMinutes()).toBe(15);
  });

  test("wraps around midnight", () => {
    const retry = rateLimitRetryAt(new Date(2026, 0, 1, 23, 50, 0));
    expect(retry.getDate()).toBe(2);
    expect(retry.getHours()).toBe(0);
    expect(retry.getMinutes()).toBe(15);
  });
});

describe("normalizeCommandText", () => {
  test("strips the bot target from a command", () => {
    expect(normalizeCommandText("/status@your_bot")).toBe("/status");
    expect(normalizeCommandText("/read@your_bot README.md 10")).toBe("/read README.md 10");
  });

  test("removes mentions anywhere in the text", () => {
    expect(normalizeCommandText("  @your_bot /ls src  ", "your_bot")).toBe("/ls src");
    expect(normalizeCommandText("please check @Your_Bot this", "your_bot")).toBe("please check  this");
  });

  test("leaves plain prompts untouched", () => {
    expect(normalizeCommandText("hello world", "your_bot")).toBe("hello world");
  });
});

describe("parseSlashCommand", () => {
  test("parses commands with arguments", () => {
    expect(parseSlashCommand("/ls src")).toEqual({ name: "ls", args: "src" });
    expect(parseSlashCommand("/read README.md 20")).toEqual({ name: "read", args: "README.md 20" });
    expect(parseSlashCommand("/STATUS")).toEqual({ name: "status", args: "" });
  });

  test("keeps multi-line arguments and rejects non-commands", () => {
    expect(parseSlashCommand("/find first\nsecond")).toEqual({ name: "find", args: "first\nsecond" });
    expect(parseSlashCommand("hello /ls")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("//ls")).toBeNull();
  });
});

describe("esc", () => {
  test("escapes Telegram HTML", () => {
    expect(esc('<b>&"x"</b>')).toBe("&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
  });
});

import { contextUsage } from "../src/util.js";

describe("contextUsage", () => {
  test("returns the real ratio without clamping", () => {
    expect(contextUsage(68_000, 100_000)).toEqual({ percent: 68, over: false });
    expect(contextUsage(247_758, 200_000)).toEqual({ percent: 124, over: true });
  });

  test("ignores missing or invalid values", () => {
    expect(contextUsage(undefined, 100_000)).toBeUndefined();
    expect(contextUsage(1_000, undefined)).toBeUndefined();
    expect(contextUsage(0, 100_000)).toBeUndefined();
    expect(contextUsage(1_000, 0)).toBeUndefined();
  });
});

describe("clampText", () => {
  test("leaves short text untouched", () => {
    expect(clampText("hola", 40)).toBe("hola");
  });

  test("closes the tags left open by the cut", () => {
    const html = `<b>negrita</b><blockquote>${"x".repeat(500)}</blockquote>`;
    const out = clampText(html, 120);
    expect(out.endsWith("\n…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(140);
    // The open blockquote is closed so Telegram can parse the entities.
    expect(out.match(/<blockquote>/g)?.length).toBe(1);
    expect(out.match(/<\/blockquote>/g)?.length).toBe(1);
    expect(out.match(/<b>/g)?.length).toBe(out.match(/<\/b>/g)?.length);
    // The cut is not inside a tag.
    expect(out.slice(0, -2)).not.toMatch(/<[^>]*$/);
  });

  test("does not split an entity in half", () => {
    const text = `${"x".repeat(35)}&amp;${"y".repeat(200)}`;
    const out = clampText(text, 38);
    expect(out).toBe(`${"x".repeat(35)}\n…`);
    expect(out).not.toContain("&");
  });

  test("does not cut a surrogate pair", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(100)}`;
    const out = clampText(text, 12);
    // max - 2 = 10 would land inside the pair; the cut moves back one char.
    expect(out).toBe(`${"a".repeat(9)}\n…`);
    expect(out).not.toContain("\uFFFD");
  });
});

describe("agent monologue filter", () => {
  test("strips 'The user says' and 'I should' lines but keeps useful reasoning", () => {
    const raw = 'The user says: "haz esto" — I should check the repo.\nVoy a revisar el fichero de могulo.\nEl cambio rompe el test.';
    const clean = stripAgentMonologue(raw);
    expect(clean).not.toContain("The user says");
    expect(clean).not.toContain("I should");
    expect(clean).toContain("Voy a revisar");
    expect(clean).toContain("El cambio rompe");
    expect(isAgentMonologue('  Let me do that  ')).toBe(true);
    // Word boundaries, not literal backspaces (regression: \b became \x08).
    expect(isAgentMonologue("I shouldn't")).toBe(false);
    expect(isAgentMonologue("Individual")).toBe(false);
  });
});
