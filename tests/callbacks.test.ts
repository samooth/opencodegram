import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleCallback } from "../src/callbacks.js";
import { SessionStore } from "../src/store.js";
import { rememberActivityReadPath } from "../src/transcriptmanager.js";

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

  test("activity toggle flips the session flag and refreshes the card", async () => {
    const deps = makeDeps();
    const s = { sessionId: "ses_toggle", activityExpanded: false } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    let refreshes = 0;
    deps.status.updateStatus = async () => { refreshes++; };
    const cq = { id: "4", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "activity:ses_toggle" } as any;
    await handleCallback(deps, cq);
    expect(s.activityExpanded).toBe(true);
    expect(refreshes).toBe(1);
  });

  test("resources toggle flips the flag and refreshes the card", async () => {
    const deps = makeDeps();
    const s = { sessionId: "ses_res", resourcesCollapsed: false } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    let refreshes = 0;
    deps.status.updateStatus = async () => { refreshes++; };
    const cq = { id: "9", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "resources:ses_res" } as any;
    await handleCallback(deps, cq);
    expect(s.resourcesCollapsed).toBe(true);
    expect(refreshes).toBe(1);
  });

  test("activity toggle also refreshes a finished card", async () => {
    const deps = makeDeps();
    const s = { sessionId: "ses_toggle_done", activityExpanded: false, statusFinished: true } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    let publishes = 0;
    deps.status.publishCard = async () => { publishes++; };
    const cq = { id: "5", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "activity:ses_toggle_done" } as any;
    await handleCallback(deps, cq);
    expect(s.activityExpanded).toBe(true);
    expect(publishes).toBe(1);
  });

  test("edit button opens a dedicated diff view without overwriting the card", async () => {
    const deps = makeDeps();
    deps.store.rememberPendingEdits(77, "ses_edit", [{
      id: "e1", name: "edit", status: "success",
      input: JSON.stringify({ filePath: "/workspace/src/x.ts", oldString: "a", newString: "b" }),
    }]);
    let detail = 0;
    deps.status.showEditDetail = async () => { detail++; return true; };
    const cq = { id: "7", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 77 }, data: "edit:0" } as any;
    await handleCallback(deps, cq);
    expect(detail).toBe(1);
  });

  test("readfile button opens what the tool read", async () => {
    const deps = makeDeps();
    rememberActivityReadPath("ses_read:0", "README.md");
    const opened: string[] = [];
    deps.files.showFile = async (_chat: number, _thread: unknown, path: string) => { opened.push(path); };
    const cq = { id: "8", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "readfile:ses_read:0" } as any;
    await handleCallback(deps, cq);
    expect(opened).toEqual(["README.md"]);
  });

  test("editfile button opens the edited file in the file browser", async () => {
    const deps = makeDeps();
    const s = {
      sessionId: "ses_file", directory: "/workspace",
      toolCallDetails: [{
        id: "e1", name: "edit", status: "success",
        input: JSON.stringify({ filePath: "/workspace/src/x.ts", oldString: "a", newString: "b" }),
      }],
    } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    deps.store.rememberPendingEdits(77, s.sessionId, s.toolCallDetails);
    const opened: string[] = [];
    deps.files.showFile = async (_chat: number, _thread: unknown, path: string) => { opened.push(path); };
    const cq = { id: "6", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 77 }, data: "editfile:0" } as any;
    await handleCallback(deps, cq);
    expect(opened).toEqual(["/workspace/src/x.ts"]);
  });
});
