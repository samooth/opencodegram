import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createSessionManager, confineSessionDirectory } from "../src/sessions.js";
import { createTurnActivity, recordThought } from "../src/activity.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-sessions-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeHarness() {
  const store = new SessionStore(join(root, "data"));
  const tg = {
    createForumTopic: async () => ({ message_thread_id: 1 }),
    editForumTopic: async () => {},
    sendRichMessage: async () => ({ message_id: 1 }),
  } as any;
  const oc = {
    client: {
      session: {
        get: async () => ({ id: "ses_x", directory: "/tmp", model: { id: "m", providerID: "p" }, title: "t" }),
        list: async () => ({ data: [] }),
      },
    },
    interrupt: async () => {},
    contextWindow: async () => undefined,
  } as any;
  const finishStatus = async () => {};
  const cleaned: number[] = [];
  const cleanupCard = async (_chatId: number, messageId: number) => { cleaned.push(messageId); };
  const sessions = createSessionManager({ config: { OPENCODE_DIRECTORY: root } as any, tg, oc, store, topicsEnabled: false, finishStatus, cleanupCard });
  return { store, tg, oc, sessions, cleaned };
}

describe("confineSessionDirectory", () => {
  test("accepts a repo name under REPOS_DIRECTORY and rejects absolute escapes", () => {
    mkdirSync(join(root, "repos", "proyecto"), { recursive: true });
    const config = { REPOS_DIRECTORY: join(root, "repos"), OPENCODE_DIRECTORY: root } as any;
    expect(confineSessionDirectory(config, "proyecto")).toBe(join(root, "repos", "proyecto"));
    expect(confineSessionDirectory(config, "/etc")).toBe(join(root, "repos"));
    expect(confineSessionDirectory(config, "~/.ssh")).toBe(join(root, "repos"));
    expect(confineSessionDirectory(config, "../../etc")).toBe(join(root, "repos"));
    expect(confineSessionDirectory(config)).toBe(join(root, "repos"));
  });

  test("falls back to the configured directory when no repo root exists", () => {
    const config = { OPENCODE_DIRECTORY: root } as any;
    expect(confineSessionDirectory(config, "/etc")).toBe(root);
  });
});

describe("sessions restoreActiveSession", () => {
  test("returns undefined when no binding exists for the route", async () => {
    const { sessions } = makeHarness();
    const res = await sessions.restoreActiveSession(123, 456);
    expect(res).toBeUndefined();
  });

  test("ensureActiveSession does not create a session in groups", async () => {
    const { sessions } = makeHarness();
    const res = await sessions.ensureActiveSession(-100, 456);
    expect(res).toBeUndefined();
  });

  test("retiring a session cleans its old card", async () => {
    const { sessions, cleaned } = makeHarness();
    const previous = {
      sessionId: "ses_retire", statusMessageId: 77, transcriptMessageId: 77, statusFinished: true,
    } as any;
    await sessions.retireSession(123, previous);
    expect(cleaned).toContain(77);
  });

  test("reactivating a finished session resets per-turn activity", async () => {
    const { sessions, store } = makeHarness();
    const activity = createTurnActivity();
    recordThought(activity, "turno anterior");
    const s = {
      sessionId: "ses_react", buffer: "x", reasoningBuffer: "y", toolCalls: [], toolCallDetails: [],
      stopped: false, targetChatId: 123, statusFinished: true, activity,
    } as any;
    store.sessionsById.set(s.sessionId, s);
    await sessions.activateSession(123, s.sessionId);
    expect(s.activity.thoughts).toBe(0);
    expect(s.activity.entries).toHaveLength(0);
  });
});

describe("syncTopicTitle", () => {
  test("does not rename group topics", async () => {
    const { sessions, tg, store } = makeHarness();
    const calls: any[] = [];
    tg.editForumTopic = async (...args: any[]) => { calls.push(args); return true; };
    const s = { sessionId: "ses_x", threadId: 123, targetThreadId: 123, targetChatId: -100, directory: "/tmp" } as any;
    store.threadBySession.set("ses_x", 123);
    await sessions.syncTopicTitle(-100, s);
    expect(calls.length).toBe(0);
  });

  test("renames private topics", async () => {
    const { sessions, tg, store } = makeHarness();
    const calls: any[] = [];
    tg.editForumTopic = async (...args: any[]) => { calls.push(args); return true; };
    const s = { sessionId: "ses_x", threadId: 123, targetThreadId: 123, targetChatId: 150831158, directory: "/tmp" } as any;
    store.threadBySession.set("ses_x", 123);
    await sessions.syncTopicTitle(150831158, s);
    expect(calls.length).toBe(1);
  });
});
