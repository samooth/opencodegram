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

describe("use: session picker", () => {
  test("does not publish a second empty card after connecting", async () => {
    const deps = makeDeps();
    let published = 0;
    let shown = 0;
    const sent: any[] = [];
    let refloated = 0;
    const cs = { sessionId: "ses_connect", buffer: "", toolCallDetails: [], stopped: false } as any;
    deps.sessions.activateSession = async () => cs;
    deps.sessions.syncTopicTitle = async () => {};
    deps.store.routeKey = () => "123";
    deps.pendingGroupPrompts = new Map();
    deps.transcript = { refloat: async () => { refloated++; } };
    deps.status.publishCard = async () => { published++; };
    deps.panels.showStatus = async () => { shown++; };
    deps.tg.sendRichMessage = async (...args: any[]) => { sent.push(args); return { message_id: 9 }; };
    const cq = { id: "1", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "use:ses_connect" } as any;
    await handleCallback(deps, cq);
    expect(refloated).toBe(1);
    expect(published).toBe(0);
    expect(sent).toHaveLength(0);
    expect(shown).toBe(1);
  });
});

describe("form cancellation", () => {
  test("cancel closes the Telegram form AND cancels it in OpenCode", async () => {
    const deps = makeDeps();
    const cancelled: Array<{ sessionId: string; formId: string }> = [];
    deps.oc.cancelForm = async (sessionId: string, formId: string) => { cancelled.push({ sessionId, formId }); };
    deps.pendingForms.set(77, {
      formId: "form_1", sessionId: "ses_x", chatId: 123, title: "Prueba",
      fields: [], answers: {}, submitted: false,
    } as any);
    deps.pendingFormsById.set("form_1", 77);
    const cq = { id: "f1", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 77 }, data: "forms:cancel" } as any;
    await handleCallback(deps, cq);
    expect(cancelled).toEqual([{ sessionId: "ses_x", formId: "form_1" }]);
    expect(deps.pendingForms.has(77)).toBe(false);
    expect(deps.pendingFormsById.has("form_1")).toBe(false);
  });
});

describe("handleCallback", () => {
  test("handles panel:home without throwing", async () => {
    const deps = makeDeps();
    const cq = { id: "1", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "panel:home" } as any;
    await handleCallback(deps, cq);
    expect(true).toBe(true);
  });

  test("repo picker and selection edit the same message", async () => {
    mkdirSync(join(root, "project"));
    const deps = makeDeps();
    const sent: any[] = [];
    const edited: any[] = [];
    deps.config.REPOS_DIRECTORY = root;
    deps.tg.sendRichMessage = async (...args: any[]) => { sent.push(args); return { message_id: 1 }; };
    deps.tg.editRichMessage = async (...args: any[]) => { edited.push(args); return { message_id: args[1] }; };
    deps.panels.renderPanel = async () => ({ html: "<b>Panel</b>", keyboard: [] }) as any;
    deps.sessions.createNewSession = async () => ({}) as any;
    const cq = (id: string, data: string) => ({ id, from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data } as any);
    await handleCallback(deps, cq("1", "panel:new"));
    expect(sent).toHaveLength(0);
    expect(edited[0][2]).toContain("Elige el repositorio");
    await handleCallback(deps, cq("2", "repo:project"));
    expect(sent).toHaveLength(0);
    expect(edited[1][2]).toContain("Panel");
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

  test("preset: applies a style bundle and refreshes /settings", async () => {
    const deps = makeDeps();
    const { SettingsStore } = await import("../src/settings.js");
    const settings = new SettingsStore(join(root, "data"));
    deps.settings = settings;
    const edits: Array<{ html: string; opts: any }> = [];
    deps.tg.editRichMessage = async (_chatId: number, _messageId: number, html: string, opts: any) => { edits.push({ html, opts }); return { message_id: 1 }; };
    const cq = { id: "15", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "preset:minimal" } as any;
    await handleCallback(deps, cq);
    expect(settings.get(123).cardPreset).toBe("minimal");
    expect(settings.get(123).showThinking).toBe(false);
    // Compact view: preset label visible, no long settings description, back button present.
    expect(edits[0].html).toContain("Minimal");
    expect(edits[0].html).not.toContain("<blockquote");
    const data = edits[0].opts.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toContain("settings:back");
  });

  test("panel:stop closes the turn instead of only republishing the card", async () => {
    const deps = makeDeps();
    const s = { sessionId: "ses_stop", stopped: false, transcriptMessageId: 77, statusMessageId: 77 } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    deps.store.rememberActiveRoute(123, undefined, s.sessionId);
    deps.store.rememberMessageSession(123, 77, s.sessionId);
    let finished = 0;
    deps.status.finishStatus = async () => { finished++; };
    const cq = { id: "10", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 77 }, data: "panel:stop" } as any;
    await handleCallback(deps, cq);
    expect(s.stopped).toBe(true);
    expect(finished).toBe(1);
  });

  test("expired edit snapshots answer with a clear alert", async () => {
    const deps = makeDeps();
    const answers: Array<{ text?: string; opts?: { show_alert?: boolean } }> = [];
    deps.tg.answerCallbackQuery = async (_id: string, text?: string, opts?: { show_alert?: boolean }) => { answers.push({ text, opts }); };
    deps.status.showEditDetail = async () => false;
    const cq = { id: "11", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "edit:0" } as any;
    await handleCallback(deps, cq);
    expect(answers[0]?.text).toContain("ya no está disponible");
    expect(answers[0]?.opts?.show_alert).toBe(true);
  });

  test("copy:answer sends the text with a native copy button in private", async () => {
    const deps = makeDeps();
    const sent: Array<{ html: string; opts: any }> = [];
    deps.tg.sendRichMessage = async (_chatId: number, html: string, opts: any) => { sent.push({ html, opts }); return { message_id: 1 }; };
    const s = { sessionId: "ses_copy", lastFinalText: "texto para copiar" } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    const cq = { id: "12", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "copy:answer:ses_copy" } as any;
    await handleCallback(deps, cq);
    expect(sent[0]?.html).toContain("texto para copiar");
    const button = sent[0]?.opts?.reply_markup?.inline_keyboard?.[0]?.[0];
    expect(button?.copy_text).toEqual({ text: "texto para copiar" });
  });

  test("copy:answer falls back to a group-friendly block without copy_text", async () => {
    const deps = makeDeps();
    const sent: Array<{ html: string; opts: any }> = [];
    deps.tg.sendRichMessage = async (_chatId: number, html: string, opts: any) => { sent.push({ html, opts }); return { message_id: 1 }; };
    const s = { sessionId: "ses_copy_group", lastFinalText: "texto para copiar" } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    const cq = { id: "13", from: { id: 1 }, message: { chat: { id: -100 }, message_id: 5 }, data: "copy:answer:ses_copy_group" } as any;
    await handleCallback(deps, cq);
    expect(sent[0]?.html).toContain("Mantén pulsado");
    expect(sent[0]?.opts?.reply_markup).toBeUndefined();
  });

  test("copy:command sends the last shell command", async () => {
    const deps = makeDeps();
    const sent: Array<{ html: string; opts: any }> = [];
    deps.tg.sendRichMessage = async (_chatId: number, html: string, opts: any) => { sent.push({ html, opts }); return { message_id: 1 }; };
    const s = {
      sessionId: "ses_copy_cmd",
      toolCallDetails: [{ id: "1", name: "bash", status: "success", input: JSON.stringify({ command: "bun test" }) }],
    } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    const cq = { id: "14", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "copy:command:ses_copy_cmd" } as any;
    await handleCallback(deps, cq);
    expect(sent[0]?.html).toContain("🖥 Comando");
    expect(sent[0]?.html).toContain("bun test");
    expect(sent[0]?.opts?.reply_markup?.inline_keyboard?.[0]?.[0]?.copy_text).toEqual({ text: "bun test" });
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
    deps.store.rememberPendingEdits(123, 77, "ses_edit", [{
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
    deps.store.rememberPendingEdits(123, 77, s.sessionId, s.toolCallDetails);
    const opened: string[] = [];
    deps.files.showFile = async (_chat: number, _thread: unknown, path: string) => { opened.push(path); };
    const cq = { id: "6", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 77 }, data: "editfile:0" } as any;
    await handleCallback(deps, cq);
    expect(opened).toEqual(["/workspace/src/x.ts"]);
  });

  test("panel:settings edits the existing message with buttons only", async () => {
    const deps = makeDeps();
    const edits: Array<{ html: string; opts: any }> = [];
    let sends = 0;
    deps.tg.editRichMessage = async (_chatId: number, _messageId: number, html: string, opts: any) => { edits.push({ html, opts }); return { message_id: 5 }; };
    deps.tg.sendRichMessage = async () => { sends++; return { message_id: 9 }; };
    const cq = { id: "st1", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "panel:settings" } as any;
    await handleCallback(deps, cq);
    expect(edits).toHaveLength(1);
    expect(sends).toBe(0);
    expect(edits[0].html).not.toContain("<blockquote");
    const data = edits[0].opts.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toContain("settings:back");
  });

  test("settings:back restores the panel in the same message", async () => {
    const deps = makeDeps();
    deps.panels.renderPanel = async () => ({ html: "<b>OpenCodegram</b>", keyboard: [[{ text: "🏠", callback_data: "panel:home" }]] });
    const edits: string[] = [];
    deps.tg.editRichMessage = async (_chatId: number, _messageId: number, html: string) => { edits.push(html); return { message_id: 5 }; };
    const cq = { id: "st2", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "settings:back" } as any;
    await handleCallback(deps, cq);
    expect(edits).toEqual(["<b>OpenCodegram</b>"]);
  });

  test("perm:always works for a thread operator", async () => {
    const deps = makeDeps();
    deps.config.ALLOWED_TELEGRAM_USER_IDS = "2";
    const { PermissionStore } = await import("../src/permissions.js");
    const perms = new PermissionStore(join(root, "data"));
    perms.rememberUser(2, "oper");
    perms.addUser("123:0", 2, "operator");
    deps.permissions = perms;
    deps.pendingPermissions.set("req1", { chatId: 123, sessionId: "ses_p", messageId: 5, decided: false, label: "tool", resource: "x" } as any);
    let decision: string | undefined;
    deps.oc.replyPermission = async (_sid: string, _rid: string, d: string) => { decision = d; };
    const answers: string[] = [];
    deps.tg.answerCallbackQuery = async (_id: string, text?: string) => { answers.push(text ?? ""); };
    const cq = { id: "p1", from: { id: 2, username: "oper" }, message: { chat: { id: 123 }, message_id: 5 }, data: "perm:always:req1" } as any;
    await handleCallback(deps, cq);
    expect(decision).toBe("always");
    expect(answers[0]).toContain("Always");
  });

  test("settings:back from a card restores the card buttons in the same message", async () => {
    const deps = makeDeps();
    const s = { sessionId: "ses_back", statusFinished: true } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    deps.store.rememberMessageSession(123, 77, s.sessionId);
    let publishes = 0;
    let sends = 0;
    deps.status.publishCard = async () => { publishes++; };
    deps.tg.sendRichMessage = async () => { sends++; return { message_id: 9 }; };
    const cq = { id: "st4", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 77 }, data: "settings:back" } as any;
    await handleCallback(deps, cq);
    expect(publishes).toBe(1);
    expect(sends).toBe(0);
  });

  test("toggling a detail setting expands the active card immediately", async () => {
    const deps = makeDeps();
    const { SettingsStore } = await import("../src/settings.js");
    const settings = new SettingsStore(join(root, "data"));
    settings.set(123, "showThinking", false);
    settings.set(123, "showShell", false);
    settings.set(123, "showTools", false);
    deps.settings = settings;
    const s = { sessionId: "ses_detail", activityExpanded: false } as any;
    deps.store.sessionsById.set(s.sessionId, s);
    deps.store.rememberActiveRoute(123, undefined, s.sessionId);
    let publishes = 0;
    deps.status.publishCard = async () => { publishes++; };
    const cq = { id: "st3", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "set:showTools:true" } as any;
    await handleCallback(deps, cq);
    expect(s.activityExpanded).toBe(true);
    expect(publishes).toBe(1);
  });

  test("db:info renders the SQLite panel in the same message", async () => {
    const deps = makeDeps();
    const edits: Array<{ html: string; markup: any }> = [];
    deps.tg.editRichMessage = async (_chatId: number, _messageId: number, html: string, opts: any) => {
      edits.push({ html, markup: opts.reply_markup });
      return { message_id: 5 };
    };
    const cq = { id: "db1", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "db:info" } as any;
    await handleCallback(deps, cq);
    expect(edits).toHaveLength(1);
    expect(edits[0].html).toContain("Base de datos");
    expect(edits[0].html).toContain("SQLite");
    const data = edits[0].markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toContain("db:refresh");
    expect(data).toContain("db:vacuum");
  });

  test("botcmd: runs bot commands from an inline button", async () => {
    const deps = makeDeps();
    let called = 0;
    deps.panels.showCommands = async () => { called++; };
    const cq = { id: "bc1", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "botcmd:commands" } as any;
    await handleCallback(deps, cq);
    expect(called).toBe(1);
  });

  test("botcmd: refuses dangerous commands", async () => {
    const deps = makeDeps();
    const answers: string[] = [];
    deps.tg.answerCallbackQuery = async (_id: string, text?: string) => { answers.push(text ?? ""); };
    const cq = { id: "bc2", from: { id: 1 }, message: { chat: { id: 123 }, message_id: 5 }, data: "botcmd:delete" } as any;
    await handleCallback(deps, cq);
    expect(answers[0]).toContain("Escribe el comando manualmente");
  });

  test("db:vacuum is denied to non-admins", async () => {
    const deps = makeDeps();
    deps.config.ALLOWED_TELEGRAM_USER_IDS = "2";
    const answers: string[] = [];
    let edits = 0;
    deps.tg.answerCallbackQuery = async (_id: string, text?: string) => { answers.push(text ?? ""); };
    deps.tg.editRichMessage = async () => { edits++; return { message_id: 5 }; };
    const cq = { id: "db2", from: { id: 2 }, message: { chat: { id: 123 }, message_id: 5 }, data: "db:vacuum" } as any;
    await handleCallback(deps, cq);
    expect(answers[0]).toContain("Solo admin");
    expect(edits).toBe(0);
  });
});
