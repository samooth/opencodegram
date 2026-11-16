import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { handleMessage } from "../src/messages.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;
beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-msg-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeHarness(opts: { session?: ChatSession; getFileFails?: boolean } = {}) {
  const store = new SessionStore(join(root, "data"));
  const sends: string[] = [];
  const prompts: Array<{ text: string; files?: unknown }> = [];
  const tg = {
    sendRichMessage: async (_chatId: number, html: string) => { sends.push(html); return { message_id: 1 }; },
    setMessageReaction: async () => {},
    sendChatAction: async () => {},
    getFile: async () => { if (opts.getFileFails) throw new Error("no file"); return { file_path: "x/y.ogg", file_size: 10 }; },
  } as any;
  const oc = { prompt: async (_sid: string, text: string, files?: unknown) => { prompts.push({ text, files }); } } as any;
  const session = opts.session;
  const deps = {
    config: { ADMIN_TELEGRAM_USER_ID: 42 },
    tg,
    oc,
    store,
    me: { id: 999, username: "bot" },
    sessions: {
      restoreActiveSession: async () => session,
      resolveSessionForRetry: async () => session,
      ensureActiveSession: async () => session,
      activateSession: async () => session,
      createNewSession: async () => session,
    },
    status: { startStatus: async () => {}, updateStatus: async () => {}, finishStatus: async () => {} },
    panels: { showStatus: async () => {}, showSessions: async () => {} },
    files: {},
    settings: { get: () => ({ voiceTranscription: false, autoArtifacts: false }) },
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
  return { deps, sends, prompts };
}

function makeSession(): ChatSession {
  return {
    sessionId: "ses_test", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [], stopped: false, targetChatId: -100,
  } as ChatSession;
}

const GROUP = -100123;

function msg(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 10,
    from: { id: 42, username: "admin" },
    chat: { id: GROUP, type: "supergroup" },
    date: Math.floor(Date.now() / 1000),
    ...overrides,
  } as any;
}

const photo = { photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10 }] };

describe("group media gating", () => {
  test("ignores a photo without an explicit mention", async () => {
    const { deps, sends, prompts } = makeHarness({ session: makeSession() });
    await handleMessage(deps, msg(photo));
    expect(sends.length).toBe(0);
    expect(prompts.length).toBe(0);
  });

  test("ignores a photo replying to the bot without a mention", async () => {
    const { deps, sends, prompts } = makeHarness({ session: makeSession() });
    await handleMessage(deps, msg({ ...photo, reply_to_message: { message_id: 5, from: { id: 999 } } }));
    expect(sends.length).toBe(0);
    expect(prompts.length).toBe(0);
  });

  test("ignores plain text without mention or reply", async () => {
    const { deps, sends, prompts } = makeHarness({ session: makeSession() });
    await handleMessage(deps, msg({ text: "hola grupo" }));
    expect(sends.length).toBe(0);
    expect(prompts.length).toBe(0);
  });

  test("processes a mention and sends the prompt", async () => {
    const s = makeSession();
    const { deps, prompts } = makeHarness({ session: s });
    await handleMessage(deps, msg({ text: "@bot hola" }));
    expect(prompts.length).toBe(1);
    expect(prompts[0].text).toContain("hola");
  });

  test("processes a command in a group", async () => {
    const s = makeSession();
    const { deps } = makeHarness({ session: s });
    let called = false;
    deps.panels.showStatus = async () => { called = true; };
    await handleMessage(deps, msg({ text: "/status" }));
    expect(called).toBe(true);
  });
});
