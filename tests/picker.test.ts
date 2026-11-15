import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { showSessionPicker } from "../src/messages.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;
beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-picker-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeDeps(store: SessionStore) {
  const sent: any[] = [];
  const tg = {
    sendRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 1 }; },
  } as any;
  const oc = { client: { session: { get: async () => ({ title: "t" }) } } } as any;
  return { deps: { store, tg, oc } as any, sent };
}

describe("session picker", () => {
  test("orders sessions by most recent interaction (newest first)", async () => {
    const store = new SessionStore(join(root, "data"));
    const chatId = -100;
    ["ses_old", "ses_mid", "ses_new"].forEach((sid, i) => {
      store.activeSessionByRoute.set(`${chatId}:${100 + i}`, sid);
      store.sessionsById.set(sid, { sessionId: sid, targetChatId: chatId } as any);
      store.topicTitleBySession.set(sid, sid);
    });
    store.lastInteractedSessionByRoute.set(`${chatId}:1`, { sessionId: "ses_old", at: 1000 });
    store.lastInteractedSessionByRoute.set(`${chatId}:2`, { sessionId: "ses_mid", at: 2000 });
    store.lastInteractedSessionByRoute.set(`${chatId}:3`, { sessionId: "ses_new", at: 3000 });
    const { deps, sent } = makeDeps(store);
    await showSessionPicker(deps, chatId, undefined, 0);
    const kb = sent[0][2].reply_markup.inline_keyboard.flat();
    const order = kb.filter((b: any) => b.callback_data?.startsWith("use:")).map((b: any) => b.callback_data);
    expect(order).toEqual(["use:ses_new", "use:ses_mid", "use:ses_old"]);
  });

  test("shows a message when there are no sessions", async () => {
    const store = new SessionStore(join(root, "data"));
    const { deps, sent } = makeDeps(store);
    await showSessionPicker(deps, -100, undefined, 0);
    expect(String(sent[0][1])).toContain("No hay sesiones activas");
  });
});
