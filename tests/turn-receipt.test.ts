import { describe, expect, test } from "bun:test";
import {
  detectTestRun,
  formatDuration,
  formatTokenCount,
  renderTurnReceipt,
  summarizeEdits,
  turnTelemetry,
} from "../src/status-render.js";
import type { ChatSession } from "../src/types.js";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_receipt",
    buffer: "",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    directory: "/workspace",
    ...overrides,
  } as ChatSession;
}

describe("turn receipt formatting", () => {
  test("formats durations with stable units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(102_000)).toBe("1m 42s");
    expect(formatDuration(3_600_000)).toBe("1h 00m");
    expect(formatDuration(7_500_000)).toBe("2h 05m");
  });

  test("formats token counts compactly", () => {
    expect(formatTokenCount(47)).toBe("47");
    expect(formatTokenCount(4_200)).toBe("4.2k");
    expect(formatTokenCount(42_000)).toBe("42k");
    expect(formatTokenCount(1_250_000)).toBe("1.3m");
  });

  test("telemetry includes duration, speed, tokens and context", () => {
    const s = makeSession({
      promptStartTime: 1_000,
      turnFirstStreamedAt: 2_000,
      turnOutputTokens: 500,
      statusFinished: true,
      turnFinishedAt: 13_000,
      lastContextTokens: 68_000,
      contextWindow: 100_000,
    });
    expect(turnTelemetry(s)).toEqual(["⏱ 12s", "⚡ 45.5 tok/s", "500 tok", "68% ctx"]);
  });

  test("telemetry omits misleading tok/s for tiny outputs", () => {
    const s = makeSession({
      promptStartTime: 1_000,
      turnFirstStreamedAt: 2_000,
      turnOutputTokens: 47,
      statusFinished: true,
      turnFinishedAt: 30_000,
    });
    const parts = turnTelemetry(s);
    expect(parts).toContain("47 tok");
    expect(parts.join(" ")).not.toContain("tok/s");
  });

  test("telemetry can hide speed without hiding tokens", () => {
    const s = makeSession({
      turnFirstStreamedAt: 2_000,
      turnOutputTokens: 5_000,
      statusFinished: true,
      turnFinishedAt: 10_000,
    });
    const parts = turnTelemetry(s, Date.now(), false);
    expect(parts).toContain("5.0k tok");
    expect(parts.join(" ")).not.toContain("tok/s");
  });
});

describe("turn receipt content", () => {
  test("renders a successful receipt with edits and test results", () => {
    const html = renderTurnReceipt({
      stopped: false,
      telemetry: ["⏱ 1m 42s", "⚡ 38 tok/s", "4.2k tok"],
      prompt: "arregla el card y valida",
      edits: { files: 3, added: 48, removed: 12 },
      test: { command: "bun test", ok: true, count: 290 },
    });
    expect(html).toContain("✅ <b>Listo</b>");
    expect(html).toContain("⏱ 1m 42s");
    expect(html).toContain("📝 <i>“arregla el card y valida”</i>");
    expect(html).toContain("✏️ <b>3 archivos</b> · +48 −12");
    expect(html).toContain("🧪 <code>bun test</code> · 290 ✓");
  });

  test("renders a stopped receipt without an error", () => {
    const html = renderTurnReceipt({ stopped: true, telemetry: [] });
    expect(html).toContain("⏹ <b>Detenido</b>");
    expect(html).not.toContain("Listo");
    expect(html).not.toContain("Turno interrumpido");
  });

  test("renders an actionable error receipt in one line", () => {
    const html = renderTurnReceipt({
      stopped: false,
      error: "429 rate limit exceeded\nretry later",
      telemetry: ["⏱ 8s"],
    });
    expect(html).toContain("⚠️ <b>Turno interrumpido</b>");
    expect(html).toContain("429 rate limit exceeded");
    expect(html).not.toContain("retry later");
  });

  test("escapes the prompt and test command", () => {
    const html = renderTurnReceipt({
      stopped: false,
      telemetry: [],
      prompt: "<script>alert(1)</script>",
      test: { command: "bun test <x>", ok: false },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("bun test &lt;x&gt;");
    expect(html).toContain("✗");
  });
});

describe("edit and test summaries", () => {
  test("summarizes edit additions and removals per file", () => {
    const s = makeSession();
    const details = [
      { id: "1", name: "edit", status: "success", input: JSON.stringify({ filePath: "/workspace/src/a.ts", oldString: "uno", newString: "dos" }) },
      { id: "2", name: "edit", status: "success", input: JSON.stringify({ filePath: "/workspace/src/a.ts", oldString: "tres", newString: "cuatro" }) },
      { id: "3", name: "edit", status: "success", input: JSON.stringify({ filePath: "/workspace/src/b.ts", oldString: "a", newString: "b" }) },
    ];
    const summary = summarizeEdits(s, details);
    expect(summary.files).toBe(2);
    expect(summary.added).toBe(3);
    expect(summary.removed).toBe(3);
  });

  test("detects the last test command and its pass count", () => {
    const details = [
      { id: "1", name: "bash", status: "success", input: JSON.stringify({ command: "bun test tests/a.test.ts" }), output: " 10 pass\n 0 fail" },
      { id: "2", name: "bash", status: "success", input: JSON.stringify({ command: "git status" }), output: "clean" },
    ];
    expect(detectTestRun(details)).toEqual({ command: "bun test tests/a.test.ts", ok: true, count: 10 });
  });

  test("marks a failing test run", () => {
    const details = [
      { id: "1", name: "bash", status: "failed", input: "pytest -q", output: "2 failed, 1 passed" },
    ];
    const test = detectTestRun(details);
    expect(test?.ok).toBe(false);
    expect(test?.count).toBe(1);
  });

  test("ignores non-test shell commands", () => {
    const details = [{ id: "1", name: "bash", status: "success", input: "ls -la", output: "src" }];
    expect(detectTestRun(details)).toBeUndefined();
  });
});
