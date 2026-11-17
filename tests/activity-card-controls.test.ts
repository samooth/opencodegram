import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { SessionStore } from "../src/store.js";
import { createTurnActivity, recordThought } from "../src/activity.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-activity-ui-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeHarness() {
  const store = new SessionStore(join(root, "data"));
  const cleared: number[] = [];
  const tg = {
    editMessageReplyMarkup: async (_chatId: number, messageId: number) => { cleared.push(messageId); },
    editRichMessage: async () => ({}),
    sendRichMessage: async () => ({ message_id: 1 }),
    deleteMessage: async () => {},
  } as any;
  const tm = createTranscriptManager({ tg, store, threadOptsFor: () => ({}) });
  const s = {
    sessionId: "ses_ui", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [],
    stopped: false, targetChatId: 7, activity: createTurnActivity(),
  } as ChatSession;
  return { tm, s, cleared };
}

describe("activity card controls", () => {
  test("card keyboard offers a details toggle when activity exists", () => {
    const { tm, s } = makeHarness();
    recordThought(s.activity!, "algo", { at: 1000 });
    const rows = tm.cardKeyboard(s, 0, 0, {});
    const flat = rows.flat();
    expect(flat.some((b) => b.callback_data.startsWith("activity:"))).toBe(true);
  });

  test("card keyboard hides the toggle when there is no activity", () => {
    const { tm, s } = makeHarness();
    s.activity = undefined;
    const flat = tm.cardKeyboard(s, 0, 0, {}).flat();
    expect(flat.some((b) => b.callback_data.startsWith("activity:"))).toBe(false);
  });

  test("refloat clearing old cards removes their keyboard", async () => {
    const { tm, s, cleared } = makeHarness();
    s.transcriptMessageId = 42;
    s.statusMessageId = 42;
    await tm.refloat(7, s, { keep: true });
    expect(cleared).toContain(42);
    expect(s.transcriptMessageId).toBeUndefined();
  });

  test("card keyboard exposes per-file diff and open-file buttons", () => {
    const { s } = makeHarness();
    const store = new SessionStore(join(root, "data"));
    store.rememberPendingEdits(77, s.sessionId, [{
      id: "e1", name: "edit", status: "success",
      input: JSON.stringify({ filePath: "/workspace/src/x.ts", oldString: "a", newString: "b" }),
    }]);
    const controlled = createTranscriptManager({ tg: {} as any, store, threadOptsFor: () => ({}) });
    s.transcriptMessageId = 77;
    const flat = controlled.cardKeyboard(s, 0, 0, {}).flat();
    expect(flat.some((b) => b.callback_data === "edit:0")).toBe(true);
    expect(flat.some((b) => b.callback_data === "editfile:0")).toBe(true);
  });
});
