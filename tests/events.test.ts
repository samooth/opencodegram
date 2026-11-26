import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleEvent, noteTelegramPrompt } from "../src/events.js";
import { SessionStore } from "../src/store.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-events-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeDeps() {
  const store = new SessionStore(join(root, "data"));
  const sent: string[] = [];
  const tg = {
    sent,
    sendRichMessage: async (_chatId: number, text: string) => { sent.push(text); return { message_id: 1 }; },
    sendRichMessageMarkdown: async () => ({ message_id: 2 }),
    editRichMessage: async () => ({ message_id: 3 }),
    setMessageReaction: async () => {},
  } as any;
  const oc = {
    prompt: async () => {},
    client: { session: { message: { get: async () => ({}) }, get: async () => ({}) } },
    interrupt: async () => {},
  } as any;
  const settings = { get: () => ({ autoArtifacts: false, voiceTranscription: false }) } as any;
  const deps = {
    tg,
    oc,
    store,
    pendingPermissions: new Map(),
    pendingForms: new Map(),
    pendingFormsById: new Map(),
    settings,
    messageToSession: store.messageToSession,
    flushDraft: async () => {},
    updateStatus: async () => {},
    finishStatus: async () => {},
    syncTopicTitle: async () => {},
  } as any;
  return { deps, store };
}

describe("handleEvent", () => {
  test("coalesces text deltas into a single updateStatus call", async () => {
    const { deps, store } = makeDeps();
    let updates = 0;
    deps.updateStatus = async () => { updates++; };
    const session = {
      sessionId: "ses_delta", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [],
      stopped: false, targetChatId: 100,
    } as any;
    store.sessionsById.set("ses_delta", session);
    store.chatBySession.set("ses_delta", 100);
    for (let i = 0; i < 5; i++) {
      await handleEvent({ type: "session.text.delta", data: { sessionID: "ses_delta", delta: "x" } }, deps);
    }
    await new Promise((r) => setTimeout(r, 650));
    expect(session.buffer).toBe("xxxxx");
    expect(updates).toBe(1);
  });

  test("does not throw on session.text.started without in-memory session", async () => {
    const { deps } = makeDeps();
    await handleEvent({ type: "session.text.started", data: { sessionID: "ses_unknown" } }, deps);
    expect(true).toBe(true);
  });

  test("does not throw on permission.asked with missing fields", async () => {
    const { deps } = makeDeps();
    await handleEvent({ type: "permission.asked", data: {} }, deps);
    expect(true).toBe(true);
  });

  test("does not throw on session.idle", async () => {
    const { deps } = makeDeps();
    await handleEvent({ type: "session.idle", data: { sessionID: "ses_unknown" } }, deps);
    expect(true).toBe(true);
  });

  test("does not throw on unknown event type", async () => {
    const { deps } = makeDeps();
    await handleEvent({ type: "foo.bar", data: {} }, deps);
    expect(true).toBe(true);
  });

  test("stores a provider failure on the session before closing the card", async () => {
    const { deps, store } = makeDeps();
    const session = {
      sessionId: "ses_fail", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [],
      stopped: false, targetChatId: 100, statusFinished: false,
    } as any;
    store.sessionsById.set("ses_fail", session);
    store.chatBySession.set("ses_fail", 100);
    let finished = 0;
    deps.finishStatus = async (_chatId: number, s: any) => { finished++; expect(s.lastTurnError).toContain("provider exploded"); };
    await handleEvent({ type: "session.execution.failed", data: { sessionID: "ses_fail", error: { message: "provider exploded" } } }, deps);
    expect(session.lastTurnError).toContain("provider exploded");
    expect(finished).toBe(1);
  });

  test("does not auto-retry a prompt restored from disk", async () => {
    const { deps, store } = makeDeps();
    store.rememberLastChat("ses_old", 123);
    store.rememberLastPrompt("ses_old", "prompt viejo");
    let prompts = 0;
    deps.oc.prompt = async () => { prompts++; };
    await handleEvent(
      { type: "session.execution.failed", data: { sessionID: "ses_old", error: { message: "rate limit exceeded" } } },
      deps,
    );
    expect(prompts).toBe(0);
    expect(deps.tg.sent.some((text: string) => text.includes("rate limit exceeded"))).toBe(true);
  });
});

describe("text.ended final delivery", () => {
  test("delivers one final answer per turn even with multiple text.ended parts", async () => {
    const { deps, store } = makeDeps();
    const session = {
      sessionId: "ses_parts",
      buffer: "respuesta completa",
      reasoningBuffer: "",
      toolCalls: [],
      toolCallDetails: [],
      stopped: false,
      targetChatId: 100,
      promptStartTime: 1000,
      statusFinished: false,
    } as any;
    store.sessionsById.set("ses_parts", session);
    store.chatBySession.set("ses_parts", 100);
    store.lastPromptBySession.set("ses_parts", "haz algo");
    noteTelegramPrompt("ses_parts", "haz algo");

    const sent = (deps.tg as any).sent as string[];
    await handleEvent({ type: "session.text.ended", data: { sessionID: "ses_parts", assistantMessageID: "msg_a", text: "parte 1" } }, deps);
    const afterFirst = sent.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(session.lastFinalDeliveredPromptStart).toBe(1000);

    // A second text.ended part of the SAME assistant message (same msg id,
    // different partial text) must be ignored — one final answer per message.
    await handleEvent({ type: "session.text.ended", data: { sessionID: "ses_parts", assistantMessageID: "msg_a", text: "parte 2" } }, deps);
    expect(sent.length).toBe(afterFirst);

    // A new user prompt + new assistant message is allowed to deliver again.
    noteTelegramPrompt("ses_parts", "otra pregunta");
    session.promptStartTime = 2000;
    await handleEvent({ type: "session.text.ended", data: { sessionID: "ses_parts", assistantMessageID: "msg_c", text: "nueva respuesta" } }, deps);
    expect(sent.length).toBeGreaterThan(afterFirst);
  });
});

describe("model capture in stats", () => {
  test("captures model from the assistant message when session has no model", async () => {
    const { deps, store } = makeDeps();
    // Make message.get return a model (restored session has no s.model).
    (deps.oc as any).client.session.message.get = async () => ({
      modelID: "glyph-cluster", providerID: "kilo", time: { completed: Date.now() },
    });
    const session = {
      sessionId: "ses_model", buffer: "answer", reasoningBuffer: "", toolCalls: [], toolCallDetails: [],
      stopped: false, targetChatId: 100, promptStartTime: Date.now() - 5000, statusFinished: false,
    } as any;
    store.sessionsById.set("ses_model", session);
    store.chatBySession.set("ses_model", 100);
    noteTelegramPrompt("ses_model", "test prompt");

    await handleEvent({ type: "session.text.ended", data: {
      sessionID: "ses_model", assistantMessageID: "m1", text: "answer",
    } }, deps);

    // The session now knows its model, so subsequent stats use it (not unknown).
    expect(session.model).toBeDefined();
    expect(session.model.providerID).toBe("kilo");
    expect(session.model.id).toBe("glyph-cluster");
  });
});
