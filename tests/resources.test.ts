import { describe, expect, test } from "bun:test";
import { renderResourceBlock } from "../src/resources.js";
import type { ChatSession } from "../src/types.js";

function makeSession(): ChatSession {
  return { sessionId: "ses_r", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [], stopped: false } as ChatSession;
}

describe("renderResourceBlock", () => {
  test("renders CPU and RAM indicators", () => {
    const s = makeSession();
    const html = renderResourceBlock(s);
    expect(html).toContain("CPU");
    expect(html).toContain("RAM");
    expect(html.startsWith("<pre>")).toBe(true);
  });

  test("caches repeated renders for the same values (history does not grow)", () => {
    const s = makeSession();
    renderResourceBlock(s);
    const firstLen = s.cpuHistory?.length ?? 0;
    renderResourceBlock(s);
    renderResourceBlock(s);
    expect(s.cpuHistory?.length).toBe(firstLen);
  });

  test("caps history at 12 samples", () => {
    const s = makeSession();
    for (let i = 0; i < 20; i++) {
      s.lastContextTokens = i * 1000; // force a different cache key
      renderResourceBlock(s);
    }
    expect((s.cpuHistory?.length ?? 0) <= 12).toBe(true);
    expect((s.memHistory?.length ?? 0) <= 12).toBe(true);
  });
});
