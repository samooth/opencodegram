import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleCallback } from "../src/callbacks.js";
import { SessionStore } from "../src/store.js";
import { createStatusManager } from "../src/status.js";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { createTurnActivity, recordThought } from "../src/activity.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-toggle-e2e-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("activity toggle end to end", () => {
  test("pressing Ver detalles republishes the card with the detail text", async () => {
    const store = new SessionStore(join(root, "data"));
    const edits: Array<{ chatId: number; messageId: number; html: string }> = [];
    const tg = {
      answerCallbackQuery: async () => {},
      editRichMessage: async (chatId: number, messageId: number, html: string) => { edits.push({ chatId, messageId, html }); return {}; },
      sendRichMessage: async () => ({ message_id: 1 }),
      editMessageReplyMarkup: async () => {},
      deleteMessage: async () => {},
      sendChatAction: async () => {},
    } as any;
    const transcript = createTranscriptManager({ tg, store, threadOptsFor: () => ({}) });
    const status = createStatusManager({
      tg,
      threadOptsFor: () => ({}),
      getSettings: () => DEFAULT_SETTINGS,
      pendingEdits: new Map(),
      rememberCot: () => {},
      rememberStatusMessage: () => {},
      forgetStatusMessage: () => {},
      store,
      transcript,
    } as any);
    const deps = {
      config: { ADMIN_TELEGRAM_USER_ID: 1 },
      tg,
      store,
      status,
      transcript,
      oc: {},
      panels: {},
      sessions: {},
      pendingModelByChat: new Map(),
      files: { handleCallback: async () => false },
      settings: { get: () => DEFAULT_SETTINGS },
    } as any;

    const s = {
      sessionId: "ses_e2e", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [],
      stopped: false, targetChatId: 7, transcriptMessageId: 55, statusMessageId: 55,
      activity: createTurnActivity(),
    } as ChatSession;
    recordThought(s.activity!, "detalle_secreto_toggle", { at: 1000 });
    store.sessionsById.set(s.sessionId, s);
    store.chatBySession.set(s.sessionId, 7);
    store.rememberMessageSession(7, 55, s.sessionId);

    const cq = { id: "1", from: { id: 1 }, message: { chat: { id: 7 }, message_id: 55 }, data: "activity:ses_e2e" } as any;
    await handleCallback(deps, cq);

    expect(s.activityExpanded).toBe(true);
    expect(edits.some((e) => e.html.includes("detalle_secreto_toggle"))).toBe(true);
  });
});
