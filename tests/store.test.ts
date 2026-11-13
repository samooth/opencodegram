import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
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
    draftId: 0,
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
    store.rememberPendingEdits(777, "ses_x", edits);
    expect(store.getPendingEditsSnapshot(777)?.sessionId).toBe("ses_x");
    expect(store.getPendingEditsSnapshot(777)?.edits?.length).toBe(1);
    expect(store.getPendingEditsSession(777)).toBe("ses_x");

    const reloaded = new SessionStore(dataDir);
    const snap = reloaded.getPendingEditsSnapshot(777);
    expect(snap?.sessionId).toBe("ses_x");
    expect(snap?.edits?.[0].name).toBe("edit");
    expect(JSON.parse(snap?.edits?.[0].input ?? "{}").filePath).toBe("src/a.ts");
  });

  test("legacy plain-sessionId snapshots still load", () => {
    const store = new SessionStore(dataDir);
    store.rememberPendingEdits(888, "ses_old");
    // Re-read with a store that accepts both formats (handled on load).
    const reloaded = new SessionStore(dataDir);
    expect(reloaded.getPendingEditsSession(888)).toBe("ses_old");
    // New format overwrites the legacy one cleanly.
    reloaded.rememberPendingEdits(888, "ses_new", [{ id: "t", name: "edit" }]);
    expect(reloaded.getPendingEditsSnapshot(888)?.sessionId).toBe("ses_new");
    expect(reloaded.getPendingEditsSnapshot(888)?.edits?.length).toBe(1);
  });
});
