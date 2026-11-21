import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createStatusManager } from "../src/status.js";
import { renderPartialText } from "../src/status-render.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-status-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_x",
    buffer: "hello",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    ...overrides,
  } as ChatSession;
}

describe("status finishStatus", () => {
  test("clears statusMessageId and marks finished", async () => {
    const edits: any[] = [];
    const tg = {
      editRichMessage: async (...args: any[]) => { edits.push(args); return { message_id: 1 }; },
      sendRichMessage: async () => ({ message_id: 2 }),
    } as any;
    const status = createStatusManager({
      tg,
      threadOptsFor: () => ({}),
      getSettings: () => ({}) as any,
      pendingEdits: new Map(),
      rememberCot: () => {},
      rememberStatusMessage: () => {},
      forgetStatusMessage: () => {},
    });
    const s = makeSession({ statusMessageId: 42, targetChatId: 7 });
    await status.finishStatus(7, s);
    expect(s.statusFinished).toBe(true);
    expect(s.statusMessageId).toBeUndefined();
  });

  test("startStatus shows activity detail when a think/shell/tool toggle is on", async () => {
    const status = createStatusManager({
      tg: { editRichMessage: async () => ({ message_id: 1 }), sendRichMessage: async () => ({ message_id: 2 }) } as any,
      threadOptsFor: () => ({}),
      getSettings: () => ({ showThinking: false, showShell: false, showTools: true }) as any,
      pendingEdits: new Map(),
      rememberCot: () => {},
      rememberStatusMessage: () => {},
      forgetStatusMessage: () => {},
    });
    const s = makeSession({ activityExpanded: false });
    await status.startStatus(7, s);
    expect(s.activityExpanded).toBe(true);
  });
});

describe("partial text rendering", () => {
  test("renders shell commands as code blocks with whole lines", async () => {
        const buffer = [
      'cd /ai/repos/2026/zig-ai-clean && echo "=== python ==="',
      "find /ai/repos/2026 -name '*triple*' -o -iname '*.tsv' 2>/dev/null | head -20",
      'python3 -c "import transformers, torch; print(transformers.__version__)"',
    ].join("\n");
    const html = renderPartialText(buffer, 400);
    expect(html).toContain("<pre><code>");
    expect(html).toContain("find /ai/repos/2026");
    expect(html).toContain("-iname");
    // The command is not cut into a mid-word fragment.
    expect(html).not.toContain("…mp -iname");
  });

  test("truncates at line boundaries with an explicit marker", () => {
        const buffer = Array.from({ length: 20 }, (_, i) => `echo line ${i}`).join("\n");
    const html = renderPartialText(buffer, 60);
    expect(html).toContain("…\n");
    // No partial line like "echo line 1" cut mid-number.
    const body = html.replace(/<[^>]+>/g, "");
    for (const line of body.split("\n").filter(Boolean)) {
      if (line.startsWith("echo")) expect(line).toMatch(/^echo line \d+$/);
    }
  });

  test("plain prose stays in a blockquote", () => {
        const html = renderPartialText("Estoy revisando el código para encontrar el problema.", 400);
    expect(html).toContain("<blockquote expandable>");
    expect(html).not.toContain("<pre>");
  });
});
