import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { writeJsonAtomic } from "../src/persist.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(TEST_ROOT, "ocg-store-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeSession(sessionId: string, threadId?: number): ChatSession {
  return {
    sessionId,
    buffer: "",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    targetChatId: 100,
    threadId,
  };
}

describe("SessionStore routing", () => {
  test("never falls back from a topic to another tab or the main chat", () => {
    const store = new SessionStore(dataDir);
    store.sessionsByThread.set(store.routeKey(100, 10), makeSession("ses_topic_10", 10));
    store.sessionsByThread.set(store.routeKey(100, 11), makeSession("ses_topic_11", 11));
    store.sessionsByChat.set(100, makeSession("ses_main"));

    expect(store.getActiveSession(100, 10)?.sessionId).toBe("ses_topic_10");
    expect(store.getActiveSession(100, 11)?.sessionId).toBe("ses_topic_11");
    expect(store.getActiveSession(100, 12)).toBeUndefined();
    expect(store.getActiveSession(100)?.sessionId).toBe("ses_main");
  });

  test("a session can only be bound to one route", () => {
    const store = new SessionStore(dataDir);
    store.rememberSessionChat("ses_a", 100);
    store.rememberActiveRoute(100, 10, "ses_a");
    expect(store.activeSessionByRoute.get("100:10")).toBe("ses_a");

    store.rememberActiveRoute(100, 11, "ses_a");
    expect(store.activeSessionByRoute.has("100:10")).toBe(false);
    expect(store.activeSessionByRoute.get("100:11")).toBe("ses_a");
  });

  test("replacing a route moves the binding without forgetting the previous session", () => {
    const store = new SessionStore(dataDir);
    store.sessionsByThread.set(store.routeKey(100, 10), makeSession("ses_a", 10));
    store.sessionsById.set("ses_a", store.sessionsByThread.get(store.routeKey(100, 10))!);
    store.rememberSessionChat("ses_a", 100);
    store.rememberActiveRoute(100, 10, "ses_a");

    store.rememberActiveRoute(100, 10, "ses_b");
    expect(store.activeSessionByRoute.get("100:10")).toBe("ses_b");
    // Previous session remains known for reply-to/background event handling;
    // explicit deletion uses forgetSession().
    expect(store.sessionsById.has("ses_a")).toBe(true);
    expect(store.chatBySession.has("ses_a")).toBe(true);
  });

  test("persists and reloads tab bindings", () => {
    const store = new SessionStore(dataDir);
    store.rememberSessionChat("ses_a", 100);
    store.rememberActiveRoute(100, 10, "ses_a");

    const reloaded = new SessionStore(dataDir);
    expect(reloaded.activeSessionByRoute.get("100:10")).toBe("ses_a");
    expect(reloaded.threadBySession.get("ses_a")).toBe(10);
    expect(reloaded.chatBySession.get("ses_a")).toBe(100);
    // The ChatSession object itself is recreated by activateSession on demand.
    expect(reloaded.getActiveSession(100, 10)).toBeUndefined();
  });

  test("forgetSession clears every routing table", () => {
    const store = new SessionStore(dataDir);
    store.sessionsByThread.set(store.routeKey(100, 10), makeSession("ses_a", 10));
    store.sessionsById.set("ses_a", store.sessionsByThread.get(store.routeKey(100, 10))!);
    store.rememberSessionChat("ses_a", 100);
    store.rememberActiveRoute(100, 10, "ses_a");

    store.forgetSession("ses_a");
    expect(store.sessionsById.has("ses_a")).toBe(false);
    expect(store.sessionsByThread.has(store.routeKey(100, 10))).toBe(false);
    expect(store.activeSessionByRoute.has("100:10")).toBe(false);
    expect(store.chatBySession.has("ses_a")).toBe(false);
    expect(store.getActiveSession(100, 10)).toBeUndefined();
  });

  test("routeKey distinguishes main chat and topics", () => {
    const store = new SessionStore(dataDir);
    expect(store.routeKey(100, 10)).toBe("100:10");
    expect(store.routeKey(100)).toBe("100:0");
    expect(store.routeKey(100, 0)).toBe("100:0");
  });
});

describe("SessionStore reply-to routing", () => {
  test("findSessionByAnyMessage resolves from the explicit map", () => {
    const store = new SessionStore(dataDir);
    store.sessionsById.set("ses_a", makeSession("ses_a"));
    store.rememberMessageSession(100, 555, "ses_a");
    expect(store.findSessionByAnyMessage(100, 555)).toBe("ses_a");
    expect(store.findSessionByAnyMessage(100, 999)).toBeUndefined();
    // A different chat is a different message id space.
    expect(store.findSessionByAnyMessage(200, 555)).toBeUndefined();
  });

  test("findSessionByAnyMessage trusts the persisted map after a restart (empty memory)", () => {
    const store = new SessionStore(dataDir);
    store.rememberMessageSession(100, 555, "ses_a");
    // Restart simulation: no session in memory, but the mapping is on disk.
    const reloaded = new SessionStore(dataDir);
    // Reply routing must still resolve the id so activateSession can revive
    // the session from the OpenCode server.
    expect(reloaded.findSessionByAnyMessage(100, 555)).toBe("ses_a");
  });

  test("threaded mode: each topic resolves to its own session after reload", () => {
    const store = new SessionStore(dataDir);
    store.rememberSessionChat("ses_topic_10", 100);
    store.rememberSessionChat("ses_topic_11", 100);
    store.rememberActiveRoute(100, 10, "ses_topic_10");
    store.rememberActiveRoute(100, 11, "ses_topic_11");

    const reloaded = new SessionStore(dataDir);
    // Each tab keeps its own persisted binding.
    expect(reloaded.activeSessionByRoute.get("100:10")).toBe("ses_topic_10");
    expect(reloaded.activeSessionByRoute.get("100:11")).toBe("ses_topic_11");
    // Cross-tab isolation: a message id in one topic must not resolve to the
    // other topic's session via the thread fallback.
    expect(reloaded.findSessionByAnyMessage(100, 999, 10)).toBe("ses_topic_10");
    expect(reloaded.findSessionByAnyMessage(100, 999, 11)).toBe("ses_topic_11");
    // The main chat (no thread) is a distinct route and does not collide.
    expect(reloaded.findSessionByAnyMessage(100, 999, undefined)).toBeUndefined();
  });

  test("private single-session chat: reply falls back to the tab's session", () => {
    const store = new SessionStore(dataDir);
    store.rememberSessionChat("ses_private", 100);
    store.rememberActiveRoute(100, undefined, "ses_private");
    // A bot message that was never explicitly mapped still routes to the
    // session bound to this (private, main) chat.
    expect(store.findSessionByAnyMessage(100, 4242)).toBe("ses_private");
    // A different chat does not inherit it.
    expect(store.findSessionByAnyMessage(200, 4242)).toBeUndefined();
  });

  test("findSessionByAnyMessage uses threadBySession when message is unmapped", () => {
    const store = new SessionStore(dataDir);
    store.rememberSessionChat("ses_topic", 100);
    store.threadBySession.set("ses_topic", 42);
    store.chatBySession.set("ses_topic", 100);
    // No explicit message map, but the topic has a session binding.
    expect(store.findSessionByAnyMessage(100, 9999, 42)).toBe("ses_topic");
    // Different topic does not inherit it.
    expect(store.findSessionByAnyMessage(100, 9999, 99)).toBeUndefined();
  });

  test("findSessionByAnyMessage recovers from dashboard/status/card ids", () => {
    const store = new SessionStore(dataDir);
    store.dashboardByRoute.set("r1", { sessionId: "ses_dash", chatId: 100, threadId: 5, messageId: 111 });
    store.rememberStatusMessage("ses_status", 100, 5, 222);
    const s = makeSession("ses_card");
    s.statusMessageId = 333;
    s.transcriptMessageId = 333;
    store.sessionsById.set("ses_card", s);
    store.rememberSessionChat("ses_card", 100);
    expect(store.findSessionByAnyMessage(100, 111)).toBe("ses_dash");
    expect(store.findSessionByAnyMessage(100, 222)).toBe("ses_status");
    expect(store.findSessionByAnyMessage(100, 333)).toBe("ses_card");
    expect(store.findSessionByAnyMessage(100, 444)).toBeUndefined();
  });

  test("findSessionByAnyMessage falls back to dashboard, status and card ids", () => {
    const store = new SessionStore(dataDir);
    // Dashboard (M1).
    store.setDashboard(100, 10, "ses_dash", 111);
    expect(store.findSessionByAnyMessage(100, 111)).toBe("ses_dash");
    // Status registry.
    store.rememberStatusMessage("ses_status", 100, 10, 222);
    expect(store.findSessionByAnyMessage(100, 222)).toBe("ses_status");
    // In-memory session card ids.
    const s = makeSession("ses_card");
    s.transcriptMessageId = 333;
    s.lastFinalTelegramMessageId = 444;
    store.sessionsById.set("ses_card", s);
    expect(store.findSessionByAnyMessage(100, 333)).toBe("ses_card");
    expect(store.findSessionByAnyMessage(100, 444)).toBe("ses_card");
    // Another chat never matches an in-memory card of a different chat.
    expect(store.findSessionByAnyMessage(300, 333)).toBeUndefined();
  });

  test("forgetChatBindings drops every table entry of a dead chat", () => {
    const store = new SessionStore(dataDir);
    const s = makeSession("ses_a");
    s.transcriptMessageId = 333;
    store.sessionsById.set("ses_a", s);
    store.rememberSessionChat("ses_a", 100);
    store.rememberActiveRoute(100, 10, "ses_a");
    store.rememberLastInteracted(100, 10, "ses_a");
    store.rememberMessageSession(100, 555, "ses_a");
    store.setDashboard(100, 10, "ses_a", 111);
    store.rememberStatusMessage("ses_a", 100, 10, 222);

    store.forgetChatBindings(100);
    expect(store.activeSessionByRoute.has("100:10")).toBe(false);
    expect(store.messageToSession.has("100:555")).toBe(false);
    expect(store.dashboardByRoute.has("100:10")).toBe(false);
    expect(store.chatBySession.has("ses_a")).toBe(true); // chat memory is not a binding
    // Rebinding after cleanup works normally.
    store.rememberActiveRoute(100, 10, "ses_a");
    expect(store.activeSessionByRoute.get("100:10")).toBe("ses_a");
  });

  test("forgetChatBindings keeps other chats untouched", () => {
    const store = new SessionStore(dataDir);
    store.rememberMessageSession(100, 555, "ses_a");
    store.rememberMessageSession(200, 555, "ses_b");
    store.forgetChatBindings(100);
    expect(store.messageToSession.has("100:555")).toBe(false);
    expect(store.messageToSession.has("200:555")).toBe(true);
  });
});

describe("SessionStore pending-edit snapshots", () => {
  test("snapshot round-trips through disk and survives restarts", () => {
    const store = new SessionStore(dataDir);
    const edits = [{ id: "t1", name: "edit", input: JSON.stringify({ filePath: "src/a.ts" }), status: "success" }];
    store.rememberPendingEdits(100, 777, "ses_x", edits);
    expect(store.getPendingEditsSnapshot(100, 777)?.sessionId).toBe("ses_x");
    expect(store.getPendingEditsSnapshot(100, 777)?.edits?.length).toBe(1);
    expect(store.getPendingEditsSession(100, 777)).toBe("ses_x");

    const reloaded = new SessionStore(dataDir);
    const snap = reloaded.getPendingEditsSnapshot(100, 777);
    expect(snap?.sessionId).toBe("ses_x");
    expect(snap?.edits?.[0].name).toBe("edit");
    expect(JSON.parse(snap?.edits?.[0].input ?? "{}").filePath).toBe("src/a.ts");
  });

  test("the same message id in another chat keeps its own snapshot", () => {
    const store = new SessionStore(dataDir);
    store.rememberPendingEdits(100, 555, "ses_group", [{ id: "g", name: "edit" }]);
    store.rememberPendingEdits(200, 555, "ses_private", [{ id: "p", name: "edit" }]);
    expect(store.getPendingEditsSession(100, 555)).toBe("ses_group");
    expect(store.getPendingEditsSession(200, 555)).toBe("ses_private");
    const reloaded = new SessionStore(dataDir);
    expect(reloaded.getPendingEditsSnapshot(100, 555)?.sessionId).toBe("ses_group");
    expect(reloaded.getPendingEditsSnapshot(200, 555)?.sessionId).toBe("ses_private");
  });

  test("forgetting a snapshot only affects that chat", () => {
    const store = new SessionStore(dataDir);
    store.rememberPendingEdits(100, 555, "ses_a", [{ id: "a", name: "edit" }]);
    store.rememberPendingEdits(200, 555, "ses_b", [{ id: "b", name: "edit" }]);
    store.forgetPendingEdits(100, 555);
    expect(store.getPendingEditsSnapshot(100, 555)).toBeUndefined();
    expect(store.getPendingEditsSnapshot(200, 555)?.sessionId).toBe("ses_b");
  });

  test("legacy message-id-only snapshots are dropped on load", () => {
    const store = new SessionStore(dataDir);
    store.rememberPendingEdits(300, 888, "ses_new", [{ id: "t", name: "edit" }]);
    // Simulate the old format: a numeric key without a chat id.
    writeJsonAtomic(join(dataDir, "pendingEdits.json"), {
      "888": { sessionId: "ses_legacy" },
      "300:888": { sessionId: "ses_new" },
    });
    const reloaded = new SessionStore(dataDir);
    expect(reloaded.getPendingEditsSnapshot(300, 888)?.sessionId).toBe("ses_new");
    // The legacy entry cannot be resolved to any chat and is not loaded.
    expect([...reloaded.pendingEditsByMessage.keys()]).toEqual(["300:888"]);
  });

  test("keeps only the newest snapshots", () => {
    const store = new SessionStore(dataDir);
    for (let i = 0; i < 205; i++) store.rememberPendingEdits(100, 1000 + i, `ses_${i}`);
    expect(store.pendingEditsByMessage.size).toBe(200);
    expect(store.getPendingEditsSnapshot(100, 1000)).toBeUndefined();
    expect(store.getPendingEditsSnapshot(100, 1204)?.sessionId).toBe("ses_204");
    const reloaded = new SessionStore(dataDir);
    expect(reloaded.pendingEditsByMessage.size).toBe(200);
  });
});

describe("beginTurn", () => {
  test("increments turnSeq normally", () => {
    const store = new SessionStore(dataDir);
    const s = makeSession("ses_turn");
    expect(store.beginTurn(s)).toBe(1);
    expect(store.beginTurn(s)).toBe(2);
  });

  test("keeps turn numbers monotonic after a restart (fresh ChatSession)", () => {
    const store = new SessionStore(dataDir);
    const s1 = makeSession("ses_turn");
    store.beginTurn(s1); // 1
    store.appendTranscript("ses_turn", { kind: "answer", html: "a", text: "a", at: 1, turn: 1 });
    store.appendTranscript("ses_turn", { kind: "answer", html: "b", text: "b", at: 2, turn: 2 });
    // Simulate a restart: new ChatSession object without turnSeq.
    const s2 = makeSession("ses_turn");
    expect(store.beginTurn(s2)).toBe(3);
  });
});
