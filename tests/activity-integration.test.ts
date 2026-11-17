import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleEvent } from "../src/events.js";
import { SessionStore } from "../src/store.js";
import { closeThoughts, createTurnActivity } from "../src/activity.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-activity-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeDeps() {
  const store = new SessionStore(join(root, "data"));
  const deps = {
    store,
    tg: { sendChatAction: async () => {}, sendRichMessage: async () => ({ message_id: 1 }) },
    oc: {},
    pendingPermissions: new Map(),
    pendingForms: new Map(),
    messageToSession: store.messageToSession,
    updateStatus: async () => {},
    finishStatus: async () => {},
    syncTopicTitle: async () => {},
  } as any;
  return { deps, store };
}

function makeSession(): ChatSession {
  return {
    sessionId: "ses_act", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [],
    stopped: false, targetChatId: 100, turnOutputTokens: 0,
  } as ChatSession;
}

describe("turn activity recording", () => {
  test("reasoning events record thoughts on the session", async () => {
    const { deps, store } = makeDeps();
    const s = makeSession();
    s.activity = createTurnActivity();
    store.sessionsById.set(s.sessionId, s);
    store.chatBySession.set(s.sessionId, s.targetChatId!);

    await handleEvent({ type: "session.reasoning.started", data: { sessionID: s.sessionId } }, deps);
    await handleEvent({ type: "session.reasoning.delta", data: { sessionID: s.sessionId, delta: "Voy a leer el README" } }, deps);
    await handleEvent({ type: "session.reasoning.started", data: { sessionID: s.sessionId } }, deps);
    await handleEvent({ type: "session.reasoning.delta", data: { sessionID: s.sessionId, delta: "Segundo thought" } }, deps);

    expect(s.activity.thoughts).toBe(2);
    expect(s.activity.entries.filter((e) => e.kind === "thought" && !e.open)).toHaveLength(1);
    expect(s.activity.entries.some((e) => e.detail.includes("Voy a leer el README"))).toBe(true);
  });

  test("tool events record and finish activity entries with their OpenCode id", async () => {
    const { deps, store } = makeDeps();
    const s = makeSession();
    s.activity = createTurnActivity();
    store.sessionsById.set(s.sessionId, s);
    store.chatBySession.set(s.sessionId, s.targetChatId!);

    await handleEvent({ type: "session.tool.input.started", data: { sessionID: s.sessionId, id: "call_1", name: "read" } }, deps);
    await handleEvent({ type: "session.tool.success", data: { sessionID: s.sessionId, id: "call_1", content: "ok" } }, deps);

    expect(s.activity.reads).toBe(1);
    const entry = s.activity.entries.find((e) => e.toolId === "call_1");
    expect(entry?.open).toBe(false);
    expect(entry?.ok).toBe(true);
  });

  test("tool input started without payload does not record a literal empty JSON string", async () => {
    const { deps, store } = makeDeps();
    const s = makeSession();
    s.activity = createTurnActivity();
    store.sessionsById.set(s.sessionId, s);
    store.chatBySession.set(s.sessionId, s.targetChatId!);

    await handleEvent({ type: "session.tool.input.started", data: { sessionID: s.sessionId, id: "c1", name: "bash" } }, deps);
    const entry = s.activity.entries.find((e) => e.toolId === "c1");
    expect(entry?.detail).toBe("");
    expect(s.toolCallDetails[0]?.input).toBe("");
    await handleEvent({ type: "session.tool.input.started", data: { sessionID: s.sessionId, id: "c2", name: "bash", input: "bun test" } }, deps);
    expect(s.activity.entries.find((e) => e.toolId === "c2")?.detail).toBe("bun test");
  });

  test("tool.called updates the activity detail with the real command or file", async () => {
    const { deps, store } = makeDeps();
    const s = makeSession();
    s.activity = createTurnActivity();
    store.sessionsById.set(s.sessionId, s);
    store.chatBySession.set(s.sessionId, s.targetChatId!);

    await handleEvent({ type: "session.tool.input.started", data: { sessionID: s.sessionId, id: "c1", name: "edit" } }, deps);
    await handleEvent({ type: "session.tool.called", data: { sessionID: s.sessionId, id: "c1", input: { filePath: "/workspace/src/pilot.py", oldString: "a", newString: "b" } } }, deps);
    expect(s.activity.entries.find((e) => e.toolId === "c1")?.detail).toContain("src/pilot.py");
  });

  test("closing thoughts leaves running tools open", () => {
    const a = createTurnActivity();
    a.thoughts = 1;
    a.entries.push({ id: 1, kind: "thought", label: "Thought", detail: "x", at: 1000, open: true });
    a.entries.push({ id: 2, kind: "read", label: "Read", detail: "f", at: 1000, open: true, toolId: "t" });
    a.nextId = 3;
    closeThoughts(a, 2000);
    expect(a.entries.find((e) => e.kind === "thought")?.open).toBe(false);
    expect(a.entries.find((e) => e.toolId === "t")?.open).toBe(true);
  });
});
