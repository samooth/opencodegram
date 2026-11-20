import { describe, expect, test } from "bun:test";
import { BOT_COMMANDS } from "../src/botcommands.js";
import { KNOWN_COMMANDS } from "../src/commands/index.js";

describe("BOT_COMMANDS", () => {
  test("has no duplicate entries", () => {
    const names = BOT_COMMANDS.map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every advertised command is dispatchable (goal is an OpenCode fallback)", () => {
    for (const { command } of BOT_COMMANDS) {
      if (command === "goal") continue;
      expect(KNOWN_COMMANDS.has(command)).toBe(true);
    }
  });
});
