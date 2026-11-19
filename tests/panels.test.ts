import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPanels } from "../src/panels.js";
import { SessionStore } from "../src/store.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-panels-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeDeps(sessions: any[] = []) {
  const store = new SessionStore(join(root, "data"));
  const sent: any[] = [];
  const tg = {
    sendRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 1 }; },
    editRichMessage: async () => ({ message_id: 1 }),
    answerCallbackQuery: async () => {},
  } as any;
  const oc = {
    listCommands: async () => [],
    listSessionsCached: async () => sessions,
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
  return { panels, store, sent };
}

describe("panels", () => {
  test("showSessions groups sessions by folder", async () => {
    const sessions = [
      { id: "ses_a", title: "beta", directory: "/repos/proyecto-b", model: { providerID: "p", id: "m" } },
      { id: "ses_b", title: "alpha", directory: "/repos/proyecto-a" },
      { id: "ses_c", title: "gamma", directory: "/repos/proyecto-b" },
    ];
    const { panels, sent } = makeDeps(sessions);
    await panels.showSessions(123, undefined, 0);
    const html = sent[0][1];
    expect(html).toContain("📁 <b>proyecto-a</b>");
    expect(html).toContain("📁 <b>proyecto-b</b>");
    expect(html.indexOf("proyecto-a")).toBeLessThan(html.indexOf("proyecto-b"));
    expect(html.indexOf("alpha")).toBeLessThan(html.indexOf("beta"));
  });

  test("sendPanel exposes the settings button", async () => {
    const { panels, sent } = makeDeps();
    await panels.sendPanel(123, 456);
    const keyboard = sent[0][2].reply_markup.inline_keyboard.flat();
    expect(keyboard.some((b: any) => b.text === "⚙️ Ajustes" && b.callback_data === "panel:settings")).toBe(true);
  });

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
