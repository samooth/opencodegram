import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { handleMessage } from "../src/messages.js";
import { createFileBrowser } from "../src/filebrowser.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;
beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-msg-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeHarness(opts: { session?: ChatSession; getFileFails?: boolean } = {}) {
  const store = new SessionStore(join(root, "data"));
  const sends: string[] = [];
  const sentOpts: any[] = [];
  const prompts: Array<{ text: string; files?: unknown }> = [];
  const tg = {
    sendRichMessage: async (_chatId: number, html: string, opts?: any) => { sends.push(html); sentOpts.push(opts); return { message_id: 1 }; },
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
  return { deps, sends, sentOpts, prompts };
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

/** Telegram file downloads go through fetch; never hit the network in tests. */
async function withFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("hello", { status: 200, headers: { "content-length": "5" } })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

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

  test("ignores a command addressed to another bot", async () => {
    const s = makeSession();
    const { deps } = makeHarness({ session: s });
    let called = false;
    deps.panels.showStatus = async () => { called = true; };
    await handleMessage(deps, msg({ text: "/status@other_bot" }));
    expect(called).toBe(false);
  });

  test("ignores a document without mention or reply", async () => {
    const s = makeSession();
    const { deps, sends, prompts } = makeHarness({ session: s });
    await handleMessage(deps, msg({ document: { file_id: "d1", file_unique_id: "du1", file_name: "nota.txt" } }));
    expect(sends.length).toBe(0);
    expect(prompts.length).toBe(0);
  });

  test("processes a document replying to the bot without a mention", async () => {
    const s = { ...makeSession(), directory: root } as ChatSession;
    const { deps, prompts } = makeHarness({ session: s });
    deps.store.sessionsById.set(s.sessionId, s);
    deps.store.rememberActiveRoute(GROUP, undefined, s.sessionId);
    const document = { file_id: "d2", file_unique_id: "du2", file_name: "nota.txt" };
    await withFetch(() => handleMessage(deps, msg({ document, reply_to_message: { message_id: 5, from: { id: 999 } } })));
    expect(prompts.length).toBe(1);
    // Text files are copied into the session dir and referenced in the prompt.
    expect(String(prompts[0].text)).toContain("Archivos adjuntos");
  });

  test("processes a voice note replying to the bot without a mention", async () => {
    const s = { ...makeSession(), directory: root } as ChatSession;
    const { deps, prompts } = makeHarness({ session: s });
    deps.store.sessionsById.set(s.sessionId, s);
    deps.store.rememberActiveRoute(GROUP, undefined, s.sessionId);
    const voice = { voice: { file_id: "v1", file_unique_id: "vu1", duration: 1 } };
    await withFetch(() => handleMessage(deps, msg({ voice, reply_to_message: { message_id: 5, from: { id: 999 } } })));
    expect(prompts.length).toBe(1);
    expect((prompts[0].files as unknown[]).length).toBe(1);
  });

  test("processes a photo with a caption mention", async () => {
    const s = { ...makeSession(), directory: root } as ChatSession;
    const { deps, prompts } = makeHarness({ session: s });
    await withFetch(() => handleMessage(deps, msg({ ...photo, caption: "@bot mira esto" })));
    expect(prompts.length).toBe(1);
    expect((prompts[0].files as unknown[]).length).toBe(1);
  });

  test("processes media in a private chat without a mention", async () => {
    const s = { ...makeSession(), directory: root } as ChatSession;
    const { deps, prompts } = makeHarness({ session: s });
    await withFetch(() => handleMessage(deps, msg({ ...photo, chat: { id: 42, type: "private" } })));
    expect(prompts.length).toBe(1);
    expect((prompts[0].files as unknown[]).length).toBe(1);
  });
});

describe("file browser end-to-end", () => {
  test("/ls in a group lists the session directory through the real browser", async () => {
    const s = { ...makeSession(), directory: root } as ChatSession;
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# hello\n");
    writeFileSync(join(root, "src", "app.ts"), "export const x = 1;\n");
    const { deps, sends, sentOpts } = makeHarness({ session: s });
    deps.config.OPENCODE_DIRECTORY = root;
    deps.store.sessionsById.set(s.sessionId, s);
    deps.store.rememberActiveRoute(GROUP, undefined, s.sessionId);
    deps.files = createFileBrowser({
      tg: deps.tg,
      config: deps.config,
      getActiveSession: () => s,
    });

    await handleMessage(deps, msg({ text: "/ls" }));

    const index = sends.findIndex((html) => html.includes("README.md"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(sends[index]).toContain("<b>src</b>");
    // The listing is navigable: entries expose fs: callback buttons.
    const buttons = (sentOpts[index]?.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.some((b: { callback_data?: string }) => (b.callback_data ?? "").startsWith("fs:"))).toBe(true);
  });
});
