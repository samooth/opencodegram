import { describe, expect, test } from "bun:test";
import { esc, normalizeCommandText, parseSlashCommand, rateLimitRetryAt } from "../src/util.js";

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
