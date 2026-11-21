import { afterEach, describe, expect, test } from "bun:test";
import { TelegramClient } from "../src/telegram.js";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

describe("editRichMessage in topics", () => {
  test("does not send message_thread_id to editMessageText", async () => {
    let body: any;
    let urlStr = "";
    globalThis.fetch = (async (url: any, init: any) => {
      urlStr = String(url);
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as any;
    const tg = new TelegramClient("token");
    await tg.editRichMessage(-100, 77, "<p>html</p>", {
      message_thread_id: 4321,
      reply_markup: { inline_keyboard: [] },
    });
    expect(urlStr).toContain("/editMessageText");
    expect(body.chat_id).toBe(-100);
    expect(body.message_id).toBe(77);
    expect(body.message_thread_id).toBeUndefined();
    expect(body.reply_markup).toBeDefined();
  });
});
