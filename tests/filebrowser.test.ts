import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { createFileBrowser } from "../src/filebrowser.js";
import type { TelegramCallbackQuery, TelegramClient } from "../src/telegram.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-browser-"));
  base = join(root, "project");
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "README.md"), "# hello\n");
  writeFileSync(join(base, "src", "app.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Sent = { chatId: number; html: string; opts: any };

function makeBrowser() {
  const sent: Sent[] = [];
  const edits: Array<Sent & { messageId: number }> = [];
  const answers: Array<string | undefined> = [];
  const documents: Array<{ path: string; name: string; caption?: string }> = [];
  let nextMessageId = 50;

  const tg = {
    sendRichMessage: async (chatId: number, html: string, opts: any) => {
      sent.push({ chatId, html, opts });
      return { message_id: nextMessageId++ };
    },
    editRichMessage: async (chatId: number, messageId: number, html: string, opts: any) => {
      edits.push({ chatId, messageId, html, opts });
    },
    sendDocument: async (_chatId: number, path: string, name: string, caption?: string) => {
      documents.push({ path, name, caption });
      return { message_id: nextMessageId++ };
    },
    answerCallbackQuery: async (_id: string, text?: string) => {
      answers.push(text);
      return true;
    },
  } as unknown as TelegramClient;

  const browser = createFileBrowser({
    tg,
    config: { OPENCODE_DIRECTORY: base } as unknown as Config,
    getActiveSession: () => undefined,
  });

  return { browser, sent, edits, answers, documents };
}

function buttons(opts: any): Array<{ text: string; callback_data: string }> {
  return (opts?.reply_markup?.inline_keyboard ?? []).flat();
}

function callback(messageId: number, data: string, id = "cb"): TelegramCallbackQuery {
  return {
    id,
    from: { id: 1 },
    message: {
      message_id: messageId,
      chat: { id: 100, type: "supergroup" },
      message_thread_id: 10,
      date: 0,
    },
    data,
  } as TelegramCallbackQuery;
}

describe("file browser", () => {
  test("lists, navigates into a directory, previews a file and goes back", async () => {
    const { browser, sent, edits, answers, documents } = makeBrowser();
    await browser.showListing(100, 10, "");

    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("README.md");
    expect(sent[0].html).toContain("src");
    const firstId = 50;

    const readmeSend = buttons(sent[0].opts).find((button) => button.text === "📎 Send");
    expect(readmeSend?.callback_data.startsWith("fs:d:")).toBe(true);
    await browser.handleCallback(callback(firstId, readmeSend!.callback_data, "cb-send-list"));
    expect(documents.at(-1)?.name).toBe("README.md");
    expect(answers.at(-1)).toBe("Sending…");

    const srcButton = buttons(sent[0].opts).find((button) => button.text.includes("src"));
    expect(srcButton?.callback_data.startsWith("fs:e:")).toBe(true);
    await browser.handleCallback(callback(firstId, srcButton!.callback_data, "cb-dir"));

    expect(edits).toHaveLength(1);
    expect(edits[0].messageId).toBe(firstId);
    expect(edits[0].html).toContain("app.ts");
    expect(answers.at(-1)).toBeUndefined();

    const appButton = buttons(edits[0].opts).find((button) => button.text.includes("app.ts") && button.callback_data.startsWith("fs:e:"));
    expect(appButton?.callback_data.startsWith("fs:e:")).toBe(true);
    await browser.handleCallback(callback(firstId, appButton!.callback_data, "cb-file"));

    expect(edits).toHaveLength(2);
    expect(edits[1].html).toContain("export const x = 1;");
    expect(edits[1].html).toContain("src/app.ts");

    const sendFile = buttons(edits[1].opts).find((button) => button.text.includes("Send as document"));
    expect(sendFile?.callback_data).toBe("fs:send");
    await browser.handleCallback(callback(firstId, "fs:send", "cb-send-file"));
    expect(documents.at(-1)?.name).toBe("app.ts");
    expect(documents.at(-1)?.caption).toContain("src/app.ts");

    const backButton = buttons(edits[1].opts).find((button) => button.text.includes("Back"));
    expect(backButton?.callback_data).toBe("fs:u");
    await browser.handleCallback(callback(firstId, "fs:u", "cb-back"));

    expect(edits).toHaveLength(3);
    expect(edits[2].html).toContain("app.ts");
    expect(edits[2].html).not.toContain("export const x = 1;");
  });

  test("sends binary files as documents instead of previewing them", async () => {
    writeFileSync(join(base, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const { browser, sent, edits, documents } = makeBrowser();
    await browser.showListing(100, 10, "");

    const binary = buttons(sent[0].opts).find((button) => button.text.includes("bin.dat") && button.callback_data.startsWith("fs:e:"));
    await browser.handleCallback(callback(50, binary!.callback_data, "cb-binary"));

    expect(edits).toHaveLength(0);
    expect(documents.at(-1)?.name).toBe("bin.dat");
    expect(documents.at(-1)?.caption).toContain("Binary file");
  });

  test("searches files and opens a result", async () => {
    const { browser, sent, edits } = makeBrowser();
    await browser.showFind(100, 10, "app");
    expect(sent[0].html).toContain("app.ts");
    expect(sent[0].html).toContain("matches");

    const result = buttons(sent[0].opts).find((button) => button.text.includes("app.ts"));
    await browser.handleCallback(callback(50, result!.callback_data, "cb-find"));
    expect(edits[0].html).toContain("export const x = 1;");
  });

  test("answers expired callbacks instead of throwing", async () => {
    const { browser, answers } = makeBrowser();
    await browser.handleCallback(callback(999, "fs:u", "cb-expired"));
    expect(answers.at(-1)).toContain("Expired");
  });
});
