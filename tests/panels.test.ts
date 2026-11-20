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
    editRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 1 }; },
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
  test("showSessions lists folder buttons and then sessions in the same message", async () => {
    const sessions = [
      { id: "ses_a", title: "beta", directory: "/repos/proyecto-b", model: { providerID: "p", id: "m" } },
      { id: "ses_b", title: "alpha", directory: "/repos/proyecto-a" },
      { id: "ses_c", title: "gamma", directory: "/repos/proyecto-b" },
    ];
    const { panels, sent } = makeDeps(sessions);
    const htmlOf = (a: any[]) => (typeof a[1] === "number" ? a[2] : a[1]);
    const markupOf = (a: any[]) => (typeof a[1] === "number" ? a[3] : a[2]).reply_markup;
    await panels.showSessions(123, 0);
    let keyboard = markupOf(sent[0]).inline_keyboard;
    expect(htmlOf(sent[0])).toBe("📂");
    expect(keyboard.flat().some((b: any) => b.text === "📁 proyecto-a")).toBe(true);
    expect(keyboard.flat().some((b: any) => b.text === "📁 proyecto-b")).toBe(true);
    // Tapping a folder renders its sessions as buttons in the same message.
    await panels.showSessions(123, 0, 5, undefined, undefined, undefined, { folderIndex: 1 });
    keyboard = markupOf(sent[1]).inline_keyboard;
    expect(htmlOf(sent[1])).toContain("proyecto-b");
    expect(keyboard.flat().some((b: any) => b.callback_data === "use:ses_a")).toBe(true);
    expect(keyboard.flat().some((b: any) => b.callback_data === "use:ses_c")).toBe(true);
    expect(keyboard.flat().some((b: any) => b.text === "◀ Carpetas")).toBe(true);
  });

  test("showSessions back returns to the folder list", async () => {
    const sessions = [{ id: "ses_a", title: "beta", directory: "/repos/proyecto-b" }];
    const { panels, sent } = makeDeps(sessions);
    const htmlOf = (a: any[]) => (typeof a[1] === "number" ? a[2] : a[1]);
    const markupOf = (a: any[]) => (typeof a[1] === "number" ? a[3] : a[2]).reply_markup;
    await panels.showSessions(123, 0, 5, undefined, undefined, undefined, { folderIndex: 0 });
    await panels.showSessions(123, 0, 5, undefined, undefined, undefined, { back: true });
    expect(htmlOf(sent[1])).toBe("📂");
    expect(markupOf(sent[1]).inline_keyboard.flat().some((b: any) => b.text === "📁 proyecto-b")).toBe(true);
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
