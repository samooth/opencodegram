import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { createStatusManager } from "../src/status.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { createTurnActivity } from "../src/activity.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-actions-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_actions",
    buffer: "",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    transcriptMessageId: 77,
    activity: createTurnActivity(),
    ...overrides,
  } as ChatSession;
}

function makeTranscript() {
  const store = new SessionStore(join(root, "data"));
  const transcript = createTranscriptManager({
    tg: { editRichMessage: async () => ({}), sendRichMessage: async () => ({ message_id: 1 }) } as any,
    store,
    threadOptsFor: () => ({}),
  });
  return { store, transcript };
}

describe("contextual card keyboards", () => {
  test("working cards lead with Stop and Details", () => {
    const { transcript } = makeTranscript();
    const s = makeSession();
    s.activity!.thoughts = 1;
    const kb = transcript.cardKeyboard(7, s, 0, 1, { working: true });
    expect(kb[0].map((b) => b.text)).toEqual(["⏹ Detener", "▾ Detalles"]);
    // Stop lives next to the page-back button, not in the primary row.
    expect(kb.flat().some((b) => b.text === "⏹ Detener" && b.callback_data === "panel:stop")).toBe(true);
  });

  test("finished cards lead with the answer and a native copy button in private", () => {
    const { transcript } = makeTranscript();
    const s = makeSession({ lastFinalText: "respuesta corta" });
    const kb = transcript.cardKeyboard(7, s, 0, 1);
    expect(kb[0].map((b) => b.text)).toEqual(["📄 Respuesta", "📋 Copiar"]);
    expect(kb[0][1].copy_text).toEqual({ text: "respuesta corta" });
  });

  test("groups get a copy callback instead of copy_text", () => {
    const { transcript } = makeTranscript();
    const s = makeSession({ lastFinalText: "respuesta corta" });
    const kb = transcript.cardKeyboard(-100, s, 0, 1);
    const flat = kb.flat();
    expect(flat.some((b) => b.copy_text !== undefined)).toBe(false);
    expect(flat.some((b) => b.callback_data === "copy:answer:ses_actions")).toBe(true);
  });

  test("long answers in private fall back to a copy callback", () => {
    const { transcript } = makeTranscript();
    const s = makeSession({ lastFinalText: "x".repeat(300) });
    const flat = transcript.cardKeyboard(7, s, 0, 1).flat();
    expect(flat.some((b) => b.copy_text !== undefined)).toBe(false);
    expect(flat.some((b) => b.callback_data === "copy:answer:ses_actions")).toBe(true);
  });

  test("stopped cards lead with Continue and history", () => {
    const { transcript } = makeTranscript();
    const s = makeSession({ stopped: true });
    const kb = transcript.cardKeyboard(7, s, 0, 1);
    expect(kb[0].map((b) => b.text)).toEqual(["▶️ Continuar", "📥 Historial"]);
    expect(kb[0][0].callback_data).toBe("retry:ses_actions");
  });

  test("error cards lead with retry and model change", () => {
    const { transcript } = makeTranscript();
    const s = makeSession({ lastTurnError: "429 rate limit" });
    const kb = transcript.cardKeyboard(7, s, 0, 1);
    expect(kb[0].map((b) => b.text)).toEqual(["🔁 Reintentar", "🧠 Cambiar modelo"]);
    expect(kb[0][1].callback_data).toBe("panel:ms:ses_actions");
  });

  test("private cards do not offer a copy-prompt button", () => {
    const { store, transcript } = makeTranscript();
    store.lastPromptBySession.set("ses_actions", "arregla el card");
    const s = makeSession();
    const flat = transcript.cardKeyboard(7, s, 0, 1).flat();
    expect(flat.some((b) => b.text === "📋 Copiar prompt")).toBe(false);
  });

  test("private cards offer a copy-command button for the last shell command", () => {
    const { transcript } = makeTranscript();
    const s = makeSession({
      toolCallDetails: [
        { id: "1", name: "bash", status: "success", input: JSON.stringify({ command: "bun test" }) },
      ],
    });
    const flat = transcript.cardKeyboard(7, s, 0, 1).flat();
    const button = flat.find((b) => b.text === "📋 Copiar comando");
    expect(button?.copy_text).toEqual({ text: "bun test" });
  });

  test("groups fall back to a copy-command callback", () => {
    const { transcript } = makeTranscript();
    const s = makeSession({
      toolCallDetails: [
        { id: "1", name: "bash", status: "success", input: JSON.stringify({ command: "bun test" }) },
      ],
    });
    const flat = transcript.cardKeyboard(-100, s, 0, 1).flat();
    const button = flat.find((b) => b.text === "📋 Copiar comando");
    expect(button?.callback_data).toBe("copy:command:ses_actions");
  });
});

function makeStatusHarness() {
  const published: Array<{ extraTop?: string; working?: boolean }> = [];
  const transcript = {
    publish: async (_chatId: number, session: ChatSession, opts: any) => {
      published.push(opts);
      if (!session.transcriptMessageId) session.transcriptMessageId = 99;
      return 1;
    },
    addBlock: () => {},
    refloat: async () => 1,
  } as any;
  const store = {
    lastPromptBySession: new Map<string, string>(),
    getTodos: () => [],
    beginTurn: () => {},
  } as any;
  const status = createStatusManager({
    tg: {} as any,
    threadOptsFor: () => ({}),
    getSettings: () => DEFAULT_SETTINGS,
    pendingEdits: new Map(),
    rememberCot: () => {},
    rememberStatusMessage: () => {},
    forgetStatusMessage: () => {},
    store,
    transcript,
  } as any);
  return { status, store, published };
}

describe("card receipts", () => {
  test("the finished strip includes duration, edits and the detected test", async () => {
    const { status, store, published } = makeStatusHarness();
    const s = makeSession({
      promptStartTime: 1_000,
      turnFinishedAt: 103_000,
      turnOutputTokens: 4_200,
      turnFirstStreamedAt: 3_000,
      statusFinished: true,
      toolCallDetails: [
        { id: "1", name: "edit", status: "success", input: JSON.stringify({ filePath: "/workspace/src/a.ts", oldString: "uno", newString: "dos" }) },
        { id: "2", name: "bash", status: "success", input: JSON.stringify({ command: "bun test" }), output: " 290 pass\n 0 fail" },
      ],
    });
    store.lastPromptBySession.set(s.sessionId, "arregla el card");
    await status.publishCard(7, s);
    const top = published[0]?.extraTop ?? "";
    expect(top).toContain("✅ <b>Listo</b>");
    expect(top).toContain("⏱ 1m 42s");
    expect(top).toContain("✏️ <b>1 archivo</b> · +1 −1");
    expect(top).toContain("bun test");
    expect(top).toContain("290 ✓");
    expect(published[0]?.working).toBe(false);
  });

  test("an error strip is readable in one line", async () => {
    const { status, published } = makeStatusHarness();
    const s = makeSession({
      statusFinished: true,
      turnFinishedAt: 5_000,
      lastTurnError: "429 rate limit exceeded\nretry later",
    });
    await status.publishCard(7, s);
    const top = published[0]?.extraTop ?? "";
    expect(top).toContain("⚠️ <b>Turno interrumpido</b>");
    expect(top).toContain("429 rate limit exceeded");
    expect(top).not.toContain("retry later");
  });
});
