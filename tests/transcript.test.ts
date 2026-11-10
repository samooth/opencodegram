import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { paginateTranscript, splitText, type TranscriptBlock } from "../src/transcript.js";
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
});
