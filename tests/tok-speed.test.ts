import { describe, expect, test } from "bun:test";
import type { ChatSession } from "../src/types.js";

function makeSession(): ChatSession {
  return { sessionId: "ses_t", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [], stopped: false } as ChatSession;
}

describe("token-speed fields", () => {
  test("accumulated tokens start undefined and can be reset", () => {
    const s = makeSession();
    expect(s.turnOutputTokens).toBeUndefined();
    s.turnOutputTokens = 100;
    s.turnOutputTokens = 0; // reset at startStatus
    expect(s.turnOutputTokens).toBe(0);
  });

  test("first-streamed timestamp is captured once", () => {
    const s = makeSession();
    expect(s.turnFirstStreamedAt).toBeUndefined();
    const t = Date.now();
    if (!s.turnFirstStreamedAt) s.turnFirstStreamedAt = t;
    expect(s.turnFirstStreamedAt).toBe(t);
    // A second delta must not overwrite it.
    if (!s.turnFirstStreamedAt) s.turnFirstStreamedAt = t + 1000;
    expect(s.turnFirstStreamedAt).toBe(t);
  });

  test("speed uses accumulated tokens and streamed window", () => {
    const s = makeSession();
    const now = Date.now();
    s.turnFirstStreamedAt = now - 4000; // 4s ago
    s.turnOutputTokens = 800;
    const elapsed = Math.max(0.5, (now - s.turnFirstStreamedAt) / 1000);
    const speed = (s.turnOutputTokens / elapsed).toFixed(1);
    expect(speed).toBe("200.0");
  });
});
