import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createStatusManager } from "../src/status.js";
import type { ChatSession } from "../src/types.js";
import type { EditDetail } from "../src/store.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-edits-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_x",
    draftId: 0,
    buffer: "",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    directory: "/tmp/opencode/repo",
    ...overrides,
  } as ChatSession;
}

const EDIT_DETAIL: EditDetail = {
  id: "tool_1",
  name: "edit",
  input: JSON.stringify({ filePath: "/tmp/opencode/repo/src/a.ts", old_string: "a", new_string: "b" }),
  status: "success",
};

function makeStore(snapshots: Record<number, { sessionId: string; edits?: EditDetail[] }> = {}) {
  return {
    getPendingEditsSnapshot: (mid: number) => snapshots[mid],
    findSessionById: (sid: string) => (sid === "ses_x" ? makeSession({ sessionId: sid }) : undefined),
  } as any;
}

describe("edit buttons from snapshots", () => {
  test("showEditDiff works with snapshot only (no live session, e.g. after restart)", async () => {
    const edited: any[] = [];
    const tg = {
      editRichMessage: async (...args: any[]) => {
        edited.push(args);
        return { message_id: args[1] };
      },
      sendRichMessage: async () => ({ message_id: 2 }),
    } as any;
    const store = makeStore({ 777: { sessionId: "ses_x", edits: [EDIT_DETAIL] } });
    const status = createStatusManager({
      tg,
      threadOptsFor: () => ({ foo: 1 }),
      getSettings: () => ({ diffStyle: "simple", showThinking: false, showTools: true, showShell: false, compactFinal: false, showCot: false, thinkingExpanded: false, toolsExpanded: false, shellExpanded: false }) as any,
      pendingEdits: new Map(),
      rememberCot: () => {},
      rememberStatusMessage: () => {},
      forgetStatusMessage: () => {},
      store,
    });
    const handled = await status.showEditDiff(7, 777, 0);
    expect(handled).toBe(true);
    expect(edited.length).toBe(1);
    const [chatId, messageId, html] = edited[0];
    expect(chatId).toBe(7);
    expect(messageId).toBe(777);
    // The edits view renders from the snapshot: header + files list.
    expect(String(html)).toContain("Edits (1)</h4>");
    expect(String(html)).toContain("a.ts");
    // Second call on the same file collapses it again.
    const handled2 = await status.showEditDiff(7, 777, 0);
    expect(handled2).toBe(true);
  });

  test("showEditDiff returns false without a snapshot", async () => {
    const status = createStatusManager({
      tg: {} as any,
      threadOptsFor: () => ({}),
      getSettings: () => ({}) as any,
      pendingEdits: new Map(),
      rememberCot: () => {},
      rememberStatusMessage: () => {},
      forgetStatusMessage: () => {},
      store: makeStore(),
    });
    expect(await status.showEditDiff(7, 999, 0)).toBe(false);
  });

  test("sendFullDiffs sends the uncapped diffs from the snapshot", async () => {
    const sent: any[] = [];
    const tg = {
      editRichMessage: async () => ({ message_id: 1 }),
      sendRichMessage: async (...args: any[]) => {
        sent.push(args);
        return { message_id: 2 + sent.length };
      },
    } as any;
    const store = makeStore({ 555: { sessionId: "ses_x", edits: [EDIT_DETAIL] } });
    const status = createStatusManager({
      tg,
      threadOptsFor: () => ({}),
      getSettings: () => ({ diffStyle: "simple" }) as any,
      pendingEdits: new Map(),
      rememberCot: () => {},
      rememberStatusMessage: () => {},
      forgetStatusMessage: () => {},
      store,
    });
    const handled = await status.sendFullDiffs(7, 555);
    expect(handled).toBe(true);
    expect(sent.length).toBe(1);
    expect(String(sent[0][1])).toContain("Full diffs</b> (1)");
    // Full diffs are not capped at 12 lines here.
    expect(String(sent[0][1])).toContain("a.ts");
  });
});
