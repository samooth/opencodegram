import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createStatusManager } from "../src/status.js";
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
});
