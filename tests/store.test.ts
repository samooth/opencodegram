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
    store.sessionsByThread.set(10, makeSession("ses_topic_10", 10));
    store.sessionsByThread.set(11, makeSession("ses_topic_11", 11));
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

  test("replacing a route retires the previous session", () => {
    const store = new SessionStore(dataDir);
    store.sessionsByThread.set(10, makeSession("ses_a", 10));
    store.sessionsById.set("ses_a", store.sessionsByThread.get(10)!);
    store.rememberSessionChat("ses_a", 100);
    store.rememberActiveRoute(100, 10, "ses_a");

    store.rememberActiveRoute(100, 10, "ses_b");
    expect(store.activeSessionByRoute.get("100:10")).toBe("ses_b");
    expect(store.sessionsById.has("ses_a")).toBe(false);
    expect(store.sessionsByThread.has(10)).toBe(false);
    expect(store.chatBySession.has("ses_a")).toBe(false);
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
    store.sessionsByThread.set(10, makeSession("ses_a", 10));
    store.sessionsById.set("ses_a", store.sessionsByThread.get(10)!);
    store.rememberSessionChat("ses_a", 100);
    store.rememberActiveRoute(100, 10, "ses_a");

    store.forgetSession("ses_a");
    expect(store.sessionsById.has("ses_a")).toBe(false);
    expect(store.sessionsByThread.has(10)).toBe(false);
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
