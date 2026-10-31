import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleEvent } from "../src/events.js";
import { SessionStore } from "../src/store.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-events-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeDeps() {
  const store = new SessionStore(join(root, "data"));
  const tg = {
    sendRichMessage: async () => ({ message_id: 1 }),
    sendRichMessageMarkdown: async () => ({ message_id: 2 }),
    editRichMessage: async () => ({ message_id: 3 }),
    setMessageReaction: async () => {},
  } as any;
  const oc = {
    client: { session: { message: { get: async () => ({}) }, get: async () => ({}) } },
    interrupt: async () => {},
  } as any;
  const settings = { get: () => ({ autoArtifacts: false, voiceTranscription: false }) } as any;
  const deps = {
    tg,
    oc,
    store,
    retryingSessions: new Set(),
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
});
