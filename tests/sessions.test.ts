import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createSessionManager } from "../src/sessions.js";

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
  } as any;
  const finishStatus = async () => {};
  const sessions = createSessionManager({ config: { OPENCODE_DIRECTORY: root } as any, tg, oc, store, topicsEnabled: false, finishStatus });
  return { store, tg, oc, sessions };
}

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
});
