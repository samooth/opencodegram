import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPanels } from "../src/panels.js";
import { SessionStore } from "../src/store.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-panels-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeDeps() {
  const store = new SessionStore(join(root, "data"));
  const tg = {
    sendRichMessage: async () => ({ message_id: 1 }),
    editRichMessage: async () => ({ message_id: 1 }),
    answerCallbackQuery: async () => {},
  } as any;
  const oc = {
    listCommands: async () => [],
    client: {
      session: { list: async () => ({ data: [] }) },
      model: { list: async () => ({ data: [] }) },
      agent: { list: async () => ({ data: [] }) },
    },
    serverInfo: async () => ({ version: "1" }),
  } as any;
  const config = { OPENCODE_DIRECTORY: root } as any;
  const modelListByChat = new Map();
  const panels = createPanels({
    tg,
    oc,
    config,
    getActiveSession: store.getActiveSession,
    modelListByChat,
    routeKey: store.routeKey,
    metrics: { inc: () => {}, recordError: () => {} } as any,
  });
  return { panels, store };
}

describe("panels", () => {
  test("sendPanel does not throw", async () => {
    const { panels } = makeDeps();
    await panels.sendPanel(123, 456);
    expect(true).toBe(true);
  });

  test("showCommands does not throw", async () => {
    const { panels } = makeDeps();
    await panels.showCommands(123, 456);
    expect(true).toBe(true);
  });

  test("showSessions does not throw", async () => {
    const { panels } = makeDeps();
    await panels.showSessions(123, 0, undefined, 456);
    expect(true).toBe(true);
  });
});
