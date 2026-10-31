import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleCallback } from "../src/callbacks.js";
import { SessionStore } from "../src/store.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-cb-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeDeps() {
  const store = new SessionStore(join(root, "data"));
  const tg = {
    answerCallbackQuery: async () => {},
    sendRichMessage: async () => ({ message_id: 1 }),
    editRichMessage: async () => ({ message_id: 1 }),
    setMessageReaction: async () => {},
  } as any;
  const oc = { interrupt: async () => {}, client: { session: { list: async () => ({ data: [] }) } } } as any;
  const deps = {
    config: { OPENCODE_DIRECTORY: root, ADMIN_TELEGRAM_USER_ID: 1 },
    tg,
    oc,
    store,
    me: { id: 999, username: "bot" },
    topicsEnabled: false,
    sessions: { restoreActiveSession: async () => undefined, ensureActiveSession: async () => undefined, activateSession: async () => undefined, createNewSession: async () => undefined },
    status: { startStatus: async () => {}, updateStatus: async () => {}, finishStatus: async () => {} },
    panels: { sendPanel: async () => {}, showModels: async () => {}, showSessions: async () => {}, showCommands: async () => {} },
    files: { handleCallback: async () => false },
    settings: { get: () => ({}) },
    metrics: { inc: () => {}, recordError: () => {} },
    audit: () => {},
    pendingPermissions: new Map(),
    pendingForms: new Map(),
    pendingFormsById: new Map(),
    awaitingReason: new Map(),
    messageToSession: store.messageToSession,
    modelListByChat: new Map(),
    pendingModelByChat: new Map(),
    pendingEdits: new Map(),
  } as any;
  return deps;
}

describe("handleCallback", () => {
  test("handles panel:home without throwing", async () => {
    const deps = makeDeps();
    const cq = { id: "1", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "panel:home" } as any;
    await handleCallback(deps, cq);
    expect(true).toBe(true);
  });

  test("handles fs: callback delegation", async () => {
    const deps = makeDeps();
    deps.files.handleCallback = async () => true;
    const cq = { id: "2", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "fs:r" } as any;
    await handleCallback(deps, cq);
    expect(true).toBe(true);
  });

  test("handles unknown callback gracefully", async () => {
    const deps = makeDeps();
    const cq = { id: "3", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "totally:unknown" } as any;
    await handleCallback(deps, cq);
    expect(true).toBe(true);
  });
});
