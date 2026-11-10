import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { paginateTranscript, splitText, type TranscriptBlock } from "../src/transcript.js";
import { markdownToHtml } from "../src/util.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-transcript-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_x",
    draftId: 0,
    buffer: "",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    ...overrides,
  } as ChatSession;
}

describe("transcript pagination", () => {
  test("splits long text into chunks on line breaks", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const chunks = splitText(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    // No content is lost.
    expect(chunks.join("\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  test("groups blocks into pages that respect the budget", () => {
    const blocks: TranscriptBlock[] = Array.from({ length: 10 }, (_, i) => ({
      kind: "answer",
      html: "x".repeat(300),
      text: "x".repeat(300),
      at: i,
    }));
    const pages = paginateTranscript(blocks, 700);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[pages.length - 1].total).toBe(pages.length);
    // Every block is reachable exactly once.
    const flat = pages.flatMap((p) => p.blocks);
    expect(flat.length).toBe(blocks.length);
  });

  test("a single oversized block still gets its own page", () => {
    const blocks: TranscriptBlock[] = [{ kind: "answer", html: "y".repeat(5000), text: "y".repeat(5000), at: 0 }];
    const pages = paginateTranscript(blocks, 1000);
    expect(pages.length).toBe(1);
    expect(pages[0].blocks.length).toBe(1);
  });
});

describe("transcript manager", () => {
  function makeHarness() {
    const store = new SessionStore(join(root, "data"));
    const sent: any[] = [];
    const edited: any[] = [];
    const tg = {
      sendRichMessage: async (...args: any[]) => {
        sent.push(args);
        return { message_id: 100 + sent.length };
      },
      editRichMessage: async (...args: any[]) => {
        edited.push(args);
        return { message_id: args[1] };
      },
    } as any;
    const transcript = createTranscriptManager({
      tg,
      store,
      threadOptsFor: () => ({}),
    });
    return { store, transcript, sent, edited };
  }

  test("publish reuses the same message instead of sending one per block", async () => {
    const { transcript, sent, edited } = makeHarness();
    const s = makeSession();
    for (let i = 0; i < 5; i++) {
      transcript.addBlock(s, "answer", `<p>answer ${i}</p>`, `answer ${i}`);
      await transcript.publish(123, s);
    }
    expect(sent.length).toBe(1);
    expect(edited.length).toBe(4);
    expect(s.transcriptMessageId).toBe(101);
    // The card is edited in place: the message id never changes.
    expect(edited.every((call) => call[1] === 101)).toBe(true);
  });

  test("navigation moves between pages and keeps the user on the chosen one", async () => {
    const { transcript } = makeHarness();
    const s = makeSession();
    for (let i = 0; i < 8; i++) {
      transcript.addBlock(s, "answer", `<p>${"z".repeat(600)} ${i}</p>`, "z".repeat(600));
    }
    await transcript.publish(123, s);
    const total = transcript.pageCount(s);
    expect(total).toBeGreaterThan(1);
    await transcript.goToPage(123, s, 0);
    expect(s.transcriptPage).toBe(0);
    expect(s.transcriptFollow).toBe(false);
    // Out-of-range navigation is clamped.
    await transcript.goToPage(123, s, 999);
    expect(s.transcriptPage).toBe(total - 1);
    expect(s.transcriptFollow).toBe(true);
  });

  test("blocks persist across sessions in the store", () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>hi</p>", "hi");
    expect(store.getTranscript("ses_x").length).toBe(1);
  });

  test("markdown is rendered to rich text, not stored as raw markdown", () => {
    const { transcript } = makeHarness();
    const s = makeSession();
    transcript.addBlock(
      s,
      "answer",
      "<b>ignored</b>",
      "Hola **mundo**\n\n- uno\n- dos",
      (chunk) => markdownToHtml(chunk),
    );
    const blocks = transcript.blocksOf(s);
    expect(blocks.length).toBe(1);
    // Rich text is preserved...
    expect(blocks[0].html).toContain("<b>mundo</b>");
    expect(blocks[0].html).toContain("<li>uno</li>");
    // ...and the raw markdown is not leaked into the HTML.
    expect(blocks[0].html).not.toContain("**mundo**");
  });

  test("long markdown is split into blocks and each chunk is rendered", () => {
    const { transcript } = makeHarness();
    const s = makeSession();
    const long = Array.from({ length: 80 }, (_, i) => `linea ${i} con **negrita**`).join("\n\n");
    transcript.addBlock(s, "answer", "", long, (chunk) => markdownToHtml(chunk));
    const blocks = transcript.blocksOf(s);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.html).not.toContain("**negrita**");
      expect(block.html).toContain("<b>negrita</b>");
    }
  });

  test("resource indicators are rendered at the bottom of the card", async () => {
    const store = new SessionStore(join(root, "data"));
    const sent: any[] = [];
    const tg = {
      sendRichMessage: async (...args: any[]) => {
        sent.push(args);
        return { message_id: 5 };
      },
      editRichMessage: async (...args: any[]) => ({ message_id: args[1] }),
    } as any;
    const transcript = createTranscriptManager({
      tg,
      store,
      threadOptsFor: () => ({}),
      renderResources: () => "<pre>CPU ▓ 10%\nRAM ▓ 20%</pre>",
    });
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>x</p>", "x");
    await transcript.publish(1, s);
    const html = sent[0][1] as string;
    expect(html).toContain("CPU");
    // The indicators close the message.
    expect(html.trimEnd().endsWith("</pre>")).toBe(true);
  });

  test("publishes are serialized so concurrent edits do not cancel each other", async () => {
    const { store, transcript } = makeHarness();
    const order: string[] = [];
    const tg = {
      sendRichMessage: async () => ({ message_id: 7 }),
      editRichMessage: async (_chat: number, _id: number, _html: string) => {
        order.push("start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("end");
        return { message_id: _id };
      },
    } as any;
    const manager = createTranscriptManager({ tg, store, threadOptsFor: () => ({}) });
    const s = makeSession();
    await Promise.all([
      manager.publish(1, s),
      manager.publish(1, s),
      manager.publish(1, s),
    ]);
    // Edits never overlap.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe("start");
      expect(order[i + 1]).toBe("end");
    }
  });
});
