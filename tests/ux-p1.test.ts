import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { createStatusManager } from "../src/status.js";
import { DEFAULT_SETTINGS, type ChatSettings } from "../src/settings.js";
import { createTurnActivity, renderActionRail, recordTool, finishTool, recordThought } from "../src/activity.js";
import { handleCallback } from "../src/callbacks.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-p1-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_p1",
    buffer: "",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    ...overrides,
  } as ChatSession;
}

function makeHarness() {
  const store = new SessionStore(join(root, "data"));
  const sent: any[] = [];
  const edited: any[] = [];
  const tg = {
    editMessageReplyMarkup: async () => ({}),
    sendRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 100 + sent.length }; },
    editRichMessage: async (...args: any[]) => { edited.push(args); return { message_id: args[1] }; },
  } as any;
  const transcript = createTranscriptManager({ tg, store, threadOptsFor: () => ({}) });
  return { store, transcript, sent, edited };
}

describe("P1.2 live action rail", () => {
  test("shows only the latest three real actions with duration and status", () => {
    const a = createTurnActivity();
    recordTool(a, "read", "leyendo", { at: 1000 });
    finishTool(a, a.entries[0].toolId!, true, { at: 1200 });
    recordTool(a, "edit", "editando", { at: 2000 });
    finishTool(a, a.entries[1].toolId!, true, { at: 2300 });
    recordTool(a, "bash", "bun test", { at: 3000 });
    const rail = renderActionRail(a, 5000);
    expect(rail).toContain("Últimas acciones");
    expect(rail).toContain("✅ 📖");
    expect(rail).toContain("✅ ✏️");
    expect(rail).toContain("⏳ 🖥");
    expect(rail).toContain("2.0s");
    expect(rail).not.toContain("pensamiento");
  });

  test("thoughts alone do not produce a rail", () => {
    const a = createTurnActivity();
    recordThought(a, "analizando", { at: 1000 });
    expect(renderActionRail(a)).toBe("");
  });

  test("the live card includes the rail when enabled", async () => {
    const published: any[] = [];
    const transcript = { publish: async (_c: number, _s: ChatSession, opts: any) => { published.push(opts); return 1; } } as any;
    const store = { lastPromptBySession: new Map(), getTodos: () => [], beginTurn: () => {} } as any;
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}),
      getSettings: () => ({ ...DEFAULT_SETTINGS, cardVerbosity: "medium", showActionRail: true } as ChatSettings),
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store, transcript,
    } as any);
    const s = makeSession({ activity: createTurnActivity() });
    recordTool(s.activity!, "bash", "bun test", { at: 1000 });
    await status.publishCard(7, s);
    expect(published[0].extraTop).toContain("Últimas acciones");
    expect(published[0].extraTop).toContain("bun test");
  });
});

describe("P1.1 compact card and reading mode", () => {
  test("compact keyboard has at most three rows and keeps the primary action first", () => {
    const { transcript } = makeHarness();
    const s = makeSession({ lastFinalText: "respuesta", cardView: { compact: true, reading: false, showResources: true, unified: false } });
    const kb = transcript.compactCardKeyboard(7, s, 0, 4);
    expect(kb.length).toBeLessThanOrEqual(3);
    expect(kb[0].map((b) => b.text)).toEqual(["📄 Respuesta", "📋 Copiar"]);
    expect(kb.flat().some((b) => b.text === "📖 Leer")).toBe(true);
    expect(kb.flat().some((b) => b.callback_data === "menu:ses_p1")).toBe(true);
  });

  test("keeps Detalles and Recursos one tap away in the compact card", () => {
    const { transcript } = makeHarness();
    const a = createTurnActivity();
    a.thoughts = 1;
    const s = makeSession({
      lastFinalText: "respuesta",
      activity: a,
      cardView: { compact: true, reading: false, showResources: true, unified: false },
    });
    const kb = transcript.compactCardKeyboard(7, s, 0, 2);
    expect(kb.length).toBeLessThanOrEqual(3);
    const flat = kb.flat();
    expect(flat.some((b) => b.text === "▾ Detalles" && b.callback_data === "activity:ses_p1")).toBe(true);
    expect(flat.some((b) => b.text === "📊 Recursos ▾" && b.callback_data === "resources:ses_p1")).toBe(true);
    expect(flat.some((b) => b.text === "📖 Leer")).toBe(true);
    expect(flat.some((b) => b.text === "▾ Más")).toBe(true);
  });

  test("the overflow menu reveals the full keyboard on the same card", () => {
    const { transcript } = makeHarness();
    const s = makeSession({ lastFinalText: "respuesta", cardView: { compact: true, reading: false, showResources: true, unified: false }, cardMenuExpanded: true });
    const full = transcript.cardKeyboard(7, s, 0, 4);
    const expanded = transcript.compactCardKeyboard(7, s, 0, 4);
    expect(expanded).not.toEqual(full);
    expect(expanded.flat().some((b) => b.text === "📂 Sesiones")).toBe(true);
    expect(expanded.flat().some((b) => b.text === "▴ Menos" && b.callback_data === "menu:ses_p1")).toBe(true);
  });

  test("reading mode swaps to Volver without creating a new message", async () => {
    const { store, transcript, sent, edited } = makeHarness();
    const s = makeSession({ lastFinalText: "respuesta", cardView: { compact: true, reading: false, showResources: true, unified: false } });
    transcript.addBlock(s, "answer", "<p>texto</p>", "texto");
    await transcript.publish(7, s, { ...s.cardView, extraTop: "📊 recibo", working: false });
    expect(sent).toHaveLength(1);
    s.readingMode = true;
    s.cardView = { ...s.cardView!, reading: true };
    await transcript.publish(7, s, { ...s.cardView, extraTop: "", working: false });
    expect(sent).toHaveLength(1);
    expect(edited.length).toBeGreaterThanOrEqual(1);
    expect(edited[0][1]).toBe(s.transcriptMessageId);
    const kb = transcript.compactCardKeyboard(7, s, 0, 1);
    expect(kb[0]).toEqual([{ text: "⬅ Volver", callback_data: "back:ses_p1" }]);
  });

  test("a compact card stays within the 1.200-character budget", () => {
    const { transcript } = makeHarness();
    const s = makeSession({ cardView: { compact: true, reading: false, showResources: false, unified: false } });
    for (let i = 0; i < 6; i++) transcript.addBlock(s, "answer", `<p>${"texto ".repeat(40)}</p>`, "texto ".repeat(40));
    const rendered = transcript.renderPage(s, { extraTop: "x".repeat(4000) })!;
    expect(rendered.html.length).toBeLessThanOrEqual(1200);
  });
});

describe("P1.3 turn navigation", () => {
  test("uses Turno N/M instead of a raw page count", () => {
    const { transcript } = makeHarness();
    const s = makeSession();
    s.turnSeq = 1;
    transcript.addBlock(s, "answer", "<p>uno</p>", "uno");
    s.turnSeq = 2;
    transcript.addBlock(s, "answer", "<p>dos</p>", "dos");
    const html = transcript.renderPage(s)!.html;
    expect(html).toContain("Turno 2/2");
    expect(html).not.toContain("📄");
  });

  test("navigating to another turn adds a two-line 'antes…' recap", async () => {
    const { transcript } = makeHarness();
    const s = makeSession();
    s.turnSeq = 1;
    transcript.addBlock(s, "answer", "<p>resultado anterior</p>", "resultado anterior");
    s.turnSeq = 2;
    transcript.addBlock(s, "answer", "<p>resultado nuevo</p>", "resultado nuevo");
    s.lastViewedTurn = 1;
    const html = transcript.renderPage(s)!.html;
    expect(html).toContain("Antes…");
    expect(html).toContain("resultado anterior");
  });

  test("goToPage keeps the current view and remembers the turn", async () => {
    const { transcript } = makeHarness();
    const s = makeSession();
    s.cardView = { compact: true, reading: false, showResources: false, unified: false };
    s.turnSeq = 1;
    transcript.addBlock(s, "answer", "<p>uno</p>", "uno");
    s.turnSeq = 2;
    transcript.addBlock(s, "answer", "<p>dos</p>", "dos");
    await transcript.goToPage(7, s, 0);
    expect(s.lastViewedTurn).toBe(1);
    expect(s.transcriptFollow).toBe(false);
    const kb = transcript.compactCardKeyboard(7, s, 0, 2);
    expect(kb.flat().some((b) => b.text === "⏭ Última")).toBe(true);
  });
});

describe("P1.4 PR-style diff review", () => {
  test("the diff review includes the file table, patch download and copy button", async () => {
    const sent: any[] = [];
    const files: any[] = [];
    const store = {
      getPendingEditsSnapshot: () => ({ sessionId: "ses_x", edits: [{
        id: "1", name: "edit", status: "success",
        input: JSON.stringify({ filePath: "/workspace/src/a.ts", oldString: "uno", newString: "dos" }),
      }] }),
      findSessionById: () => ({ sessionId: "ses_x", directory: "/workspace" }),
      rememberPendingEdits: () => {},
      rememberMessageSession: () => {},
    } as any;
    const status = createStatusManager({
      tg: { sendRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 1 }; } } as any,
      threadOptsFor: () => ({}),
      getSettings: () => DEFAULT_SETTINGS,
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store,
    } as any);
    expect(await status.sendFullDiffs(7, 555)).toBe(true);
    expect(String(sent[0][1])).toContain("Revisión de cambios</b> (1)");
    expect(String(sent[0][1])).toContain("<table><tr><th>Archivo</th>");
    const buttons = sent[0][2].reply_markup.inline_keyboard.flat();
    expect(buttons.some((b: any) => b.callback_data === "patch:555")).toBe(true);
    expect(buttons.some((b: any) => b.text === "📋 Copiar diff")).toBe(true);
    expect(status.plainDiffFor(7, 555)).toContain("--- src/a.ts");
  });

  test("sendPatch writes a .patch document", async () => {
    const sent: any[] = [];
    const store = {
      getPendingEditsSnapshot: () => ({ sessionId: "ses_x", edits: [{
        id: "1", name: "edit", status: "success",
        input: JSON.stringify({ filePath: "/workspace/src/a.ts", oldString: "uno", newString: "dos" }),
      }] }),
      findSessionById: () => ({ sessionId: "ses_x", directory: "/workspace" }),
    } as any;
    const status = createStatusManager({
      tg: { sendDocument: async (...args: any[]) => { sent.push(args); return { message_id: 1 }; } } as any,
      threadOptsFor: () => ({}),
      getSettings: () => DEFAULT_SETTINGS,
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store,
    } as any);
    expect(await status.sendPatch(7, 555)).toBe(true);
    expect(sent[0][2]).toMatch(/\.patch$/);
    expect(sent[0][3]).toContain("git apply");
  });
});

describe("P1.1 card view callbacks", () => {
  function makeDeps() {
    const store = new SessionStore(join(root, "data"));
    let publishes = 0;
    const sent: any[] = [];
    const deps = {
      config: { ADMIN_TELEGRAM_USER_ID: 1 },
      tg: {
        answerCallbackQuery: async () => {},
        sendRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 1 }; },
        editRichMessage: async () => ({ message_id: 1 }),
      },
      store,
      oc: { interrupt: async () => {} },
      panels: { sendPanel: async () => {} },
      files: { handleCallback: async () => false },
      sessions: { restoreActiveSession: async () => undefined },
      pendingModelByChat: new Map(),
      status: { publishCard: async () => { publishes++; } },
      me: { id: 999, username: "bot" },
      settings: { get: () => DEFAULT_SETTINGS },
    } as any;
    return { deps, store, sent, publishes: () => publishes };
  }

  test("read: enters reading mode and republishes the same card", async () => {
    const { deps, store, sent, publishes } = makeDeps();
    const s = makeSession();
    store.sessionsById.set(s.sessionId, s);
    const cq = { id: "1", from: { id: 1 }, message: { chat: { id: 7 }, message_id: 9 }, data: `read:${s.sessionId}` } as any;
    await handleCallback(deps, cq);
    expect(s.readingMode).toBe(true);
    expect(publishes()).toBe(1);
    expect(sent).toHaveLength(0);
  });

  test("back: exits reading mode, menu: toggles the full keyboard", async () => {
    const { deps, store } = makeDeps();
    const s = makeSession({ readingMode: true });
    store.sessionsById.set(s.sessionId, s);
    await handleCallback(deps, { id: "1", from: { id: 1 }, message: { chat: { id: 7 }, message_id: 9 }, data: `back:${s.sessionId}` } as any);
    expect(s.readingMode).toBe(false);
    await handleCallback(deps, { id: "2", from: { id: 1 }, message: { chat: { id: 7 }, message_id: 9 }, data: `menu:${s.sessionId}` } as any);
    expect(s.cardMenuExpanded).toBe(true);
  });
});
