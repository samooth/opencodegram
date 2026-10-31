import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { processUpdate } from "../src/updates.js";
import { SessionStore } from "../src/store.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-updates-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("processUpdate", () => {
  test("does not throw on an update with no message", async () => {
    const store = new SessionStore(join(root, "data"));
    const deps = {
      config: {},
      tg: { setMessageReaction: async () => {}, sendChatAction: async () => {}, sendRichMessage: async () => ({ message_id: 1 }) },
      oc: { interrupt: async () => {} },
      store,
      me: { id: 1, username: "bot" },
      sessions: { restoreActiveSession: async () => undefined, ensureActiveSession: async () => undefined, activateSession: async () => undefined, createNewSession: async () => undefined },
      status: { startStatus: async () => {}, updateStatus: async () => {}, finishStatus: async () => {} },
      metrics: { inc: () => {}, recordError: () => {} },
      audit: () => {},
      settings: { get: () => ({}) },
      panels: {},
      files: {},
      pendingPermissions: new Map(),
      pendingForms: new Map(),
      pendingFormsById: new Map(),
      awaitingReason: new Map(),
      messageToSession: store.messageToSession,
      modelListByChat: new Map(),
      pendingModelByChat: new Map(),
      pendingEdits: new Map(),
    } as any;
    await processUpdate(deps, { update_id: 1 } as any);
    expect(true).toBe(true);
  });
});
