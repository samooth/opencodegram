import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { paginateTranscript, splitText, splitBySections, TRANSCRIPT_MAX_BLOCKS, TRANSCRIPT_MAX_THINKING_BLOCKS, TRANSCRIPT_MAX_TOOLS_BLOCKS, type TranscriptBlock } from "../src/transcript.js";
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

  test("a pageBreak block starts a fresh page for the new turn", () => {
    const blocks: TranscriptBlock[] = [
      { kind: "answer", html: "old-1", text: "old-1", at: 1 },
      { kind: "answer", html: "old-2", text: "old-2", at: 2 },
      { kind: "answer", html: "new-turn", text: "new-turn", at: 3, pageBreak: true },
    ];
    const pages = paginateTranscript(blocks, 1000);
    expect(pages.length).toBe(2);
    expect(pages[0].blocks.map((b) => b.html)).toEqual(["old-1", "old-2"]);
    expect(pages[1].blocks.map((b) => b.html)).toEqual(["new-turn"]);
  });

  test("splitBySections breaks at headings and keeps code fences intact", () => {
    const md = [
      "# Intro",
      "Texto de la introducción. " + "x".repeat(500),
      "",
      "```python",
      "print('hola')",
      "# esto no es un encabezado",
      "```",
      "",
      "# Setup",
      "Pasos de instalación. " + "y".repeat(500),
    ].join("\n");
    const parts = splitBySections(md, 800);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // The fake heading inside the fence stays with its section.
    const fencePart = parts.find((p) => p.includes("print('hola')"));
    expect(fencePart).toBeDefined();
    expect(fencePart!.includes("Setup")).toBe(false);
    // Headings start their own section.
    expect(parts.some((p) => p.startsWith("# Setup"))).toBe(true);
  });

  test("splitBySections merges small sections under the budget", () => {
    const md = ["# A", "a".repeat(200), "# B", "b".repeat(200), "# C", "c".repeat(200)].join("\n");
    const parts = splitBySections(md, 700);
    // Everything fits in one merged part: the caller then falls back to
    // size-based splitting, which would also produce a single chunk.
    expect(parts.length).toBeLessThanOrEqual(1);
  });

  test("splitBySections falls back to [] without headings", () => {
    expect(splitBySections("párrafo uno\n\npárrafo dos", 100)).toEqual([]);
    expect(splitBySections("", 100)).toEqual([]);
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
      // The rendered HTML drives the pagination, as in the real flow.
      transcript.addBlock(s, "answer", "", `${"z".repeat(600)} ${i}`, (chunk) => `<p>${chunk}</p>`);
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

  test("a block is stored once (no duplication between session and store)", () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    for (let i = 0; i < 5; i++) {
      transcript.addBlock(s, "answer", `<p>${i}</p>`, `respuesta ${i}`, (chunk) => `<p>${chunk}</p>`);
    }
    const blocks = store.getTranscript("ses_x");
    expect(blocks.length).toBe(5);
    // No duplicated content.
    expect(new Set(blocks.map((b) => b.text)).size).toBe(5);
    // The session view and the store agree.
    expect(transcript.blocksOf(s).length).toBe(5);
  });

  test("the first block of a turn is tagged and starts a fresh page", () => {
    const { transcript } = makeHarness();
    const s = makeSession();
    s.turnSeq = 1;
    transcript.addBlock(s, "thinking", "<p>think</p>", "think");
    transcript.addBlock(s, "answer", "<p>answer</p>", "answer");
    s.turnSeq = 2;
    transcript.addBlock(s, "answer", "<p>next turn</p>", "next turn");
    const blocks = transcript.blocksOf(s);
    expect(blocks.map((b) => b.turn)).toEqual([1, 1, 2]);
    expect(blocks[0].pageBreak).toBe(true);
    expect(blocks[1].pageBreak).toBeFalsy();
    expect(blocks[2].pageBreak).toBe(true);
  });

  test("while a turn streams the card shows only the live strip, not the previous page", async () => {
    const { transcript } = makeHarness();
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>previous answer</p>", "previous answer");
    await transcript.publish(123, s);
    // New turn starts: nothing recorded yet for this turn.
    s.turnSeq = 1;
    s.statusFinished = false;
    s.transcriptFollow = true;
    const rendered = transcript.renderPage(s, { extraTop: "⏳ Working…" });
    expect(rendered).toBeDefined();
    expect(rendered!.html).not.toContain("previous answer");
    expect(rendered!.html).toContain("⏳ Working…");
    // The keyboard still browses the full history.
    expect(rendered!.total).toBe(1);
    // After the turn records its blocks, the fresh page shows them.
    transcript.addBlock(s, "answer", "<p>new answer</p>", "new answer");
    const after = transcript.renderPage(s, { extraTop: "" });
    expect(after!.html).toContain("new answer");
    expect(after!.html).not.toContain("previous answer");
  });

  test("an exact repeated block replaces the previous one instead of duplicating", () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>x</p>", "mismo texto");
    transcript.addBlock(s, "answer", "<p>x</p>", "mismo texto");
    const blocks = store.getTranscript("ses_x");
    expect(blocks.length).toBe(1);
  });

  test("the transcript is bounded so the card stays navigable", () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    for (let i = 0; i < TRANSCRIPT_MAX_BLOCKS + 40; i++) {
      transcript.addBlock(s, "answer", `<p>${i}</p>`, `bloque ${i}`);
    }
    expect(store.getTranscript("ses_x").length).toBe(TRANSCRIPT_MAX_BLOCKS);
  });

  test("thinking and tools are capped but answers are kept", () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    for (let i = 0; i < 20; i++) {
      transcript.addBlock(s, "thinking", `<p>t${i}</p>`, `pensamiento ${i}`);
      transcript.addBlock(s, "tools", `<p>k${i}</p>`, `herramienta ${i}`);
      transcript.addBlock(s, "answer", `<p>a${i}</p>`, `respuesta ${i}`);
    }
    const blocks = store.getTranscript("ses_x");
    const count = (kind: string) => blocks.filter((b) => b.kind === kind).length;
    expect(count("thinking")).toBeLessThanOrEqual(TRANSCRIPT_MAX_THINKING_BLOCKS);
    expect(count("tools")).toBeLessThanOrEqual(TRANSCRIPT_MAX_TOOLS_BLOCKS);
    // The answers survive: they are the useful part of the history.
    expect(count("answer")).toBeGreaterThan(TRANSCRIPT_MAX_THINKING_BLOCKS);
  });

  test("the model/speed line is replaced instead of duplicated", () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>a</p>", "respuesta 1");
    transcript.addBlock(s, "meta", "<i>⚡ modelo · 100 tok/s</i>", "⚡ modelo · 100 tok/s");
    transcript.addBlock(s, "answer", "<p>b</p>", "respuesta 2");
    transcript.addBlock(s, "meta", "<i>⚡ modelo · 200 tok/s</i>", "⚡ modelo · 200 tok/s");
    const blocks = store.getTranscript("ses_x");
    const metas = blocks.filter((b) => b.kind === "meta");
    expect(metas.length).toBe(1);
    expect(metas[0].text).toContain("200 tok/s");
  });

  test("the limits also apply when loading the transcript from disk", () => {
    const dir = join(root, "data-load");
    mkdirSync(dir, { recursive: true });
    const many = Array.from({ length: 60 }, (_, i) => ({
      kind: "thinking" as const,
      html: `<p>t${i}</p>`,
      text: `pensamiento ${i}`,
      at: i,
    }));
    writeFileSync(join(dir, "transcripts.json"), JSON.stringify({ ses_x: many }));
    const store = new SessionStore(dir);
    const blocks = store.getTranscript("ses_x");
    expect(blocks.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_THINKING_BLOCKS);
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

  test("recovers by sending a new message when the card was deleted", async () => {
    const store = new SessionStore(join(root, "data"));
    const sent: any[] = [];
    let edits = 0;
    const tg = {
      sendRichMessage: async (...args: any[]) => {
        sent.push(args);
        return { message_id: 200 + sent.length };
      },
      editRichMessage: async (...args: any[]) => {
        edits++;
        // Simulate Telegram reporting that the message is gone.
        throw new Error("Bad Request: message to edit not found");
      },
    } as any;
    const transcript = createTranscriptManager({ tg, store, threadOptsFor: () => ({}) });
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>hi</p>", "hi");
    await transcript.publish(1, s);
    expect(sent.length).toBe(1);
    expect(s.transcriptMessageId).toBe(201);
    // Next publish tries to edit the missing card, fails, and sends a fresh one.
    transcript.addBlock(s, "answer", "<p>more</p>", "more");
    await transcript.publish(1, s);
    expect(edits).toBe(1);
    expect(sent.length).toBe(2);
    expect(s.transcriptMessageId).toBe(202);
  });

  test("refloat deletes the card and the next publish sends a fresh message", async () => {
    const store = new SessionStore(join(root, "data"));
    const sent: any[] = [];
    const deleted: any[] = [];
    const edited: any[] = [];
    const tg = {
      sendRichMessage: async (...args: any[]) => {
        sent.push(args);
        return { message_id: 300 + sent.length };
      },
      editRichMessage: async (...args: any[]) => {
        edited.push(args);
        return { message_id: args[1] };
      },
      deleteMessage: async (...args: any[]) => {
        deleted.push(args);
        return true;
      },
    } as any;
    const transcript = createTranscriptManager({ tg, store, threadOptsFor: () => ({}) });
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>a</p>", "a");
    await transcript.publish(1, s);
    expect(sent.length).toBe(1);
    expect(s.transcriptMessageId).toBe(301);

    await transcript.refloat(1, s);
    expect(deleted).toEqual([[1, 301]]);
    expect(s.transcriptMessageId).toBeUndefined();

    // The next publish sends a new message at the bottom instead of editing.
    transcript.addBlock(s, "answer", "<p>b</p>", "b");
    await transcript.publish(1, s);
    expect(sent.length).toBe(2);
    expect(edited.length).toBe(0);
    expect(s.transcriptMessageId).toBe(302);
  });

  test("refloat with keep preserves the card message and detaches it", async () => {
    const store = new SessionStore(join(root, "data"));
    const sent: any[] = [];
    const deleted: any[] = [];
    const edited: any[] = [];
    const tg = {
      sendRichMessage: async (...args: any[]) => {
        sent.push(args);
        return { message_id: 400 + sent.length };
      },
      editRichMessage: async (...args: any[]) => {
        edited.push(args);
        return { message_id: args[1] };
      },
      deleteMessage: async (...args: any[]) => {
        deleted.push(args);
        return true;
      },
    } as any;
    const transcript = createTranscriptManager({ tg, store, threadOptsFor: () => ({}) });
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>a</p>", "a");
    await transcript.publish(1, s);
    expect(sent.length).toBe(1);
    expect(s.transcriptMessageId).toBe(401);

    await transcript.refloat(1, s, { keep: true });
    expect(deleted).toEqual([]);
    expect(s.transcriptMessageId).toBeUndefined();

    // The next publish sends a new message at the bottom instead of editing.
    transcript.addBlock(s, "answer", "<p>b</p>", "b");
    await transcript.publish(1, s);
    expect(sent.length).toBe(2);
    expect(edited.length).toBe(0);
    expect(s.transcriptMessageId).toBe(402);
  });

  test("the card keyboard offers page picker and history export", async () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    for (let i = 0; i < 8; i++) {
      const big = `bloque ${i} ${"x".repeat(600)}`;
      transcript.addBlock(s, "answer", `<p>${big}</p>`, big);
    }
    await transcript.publish(1, s);
    const total = transcript.pageCount(s);
    expect(total).toBeGreaterThan(1);
    const kb = transcript.cardKeyboard(s, 0, total);
    const flat = kb.flat();
    // Middle button opens the page picker.
    expect(flat.some((b) => b.callback_data === `tpick:${s.sessionId}`)).toBe(true);
    // Export picker button is always available.
    expect(flat.some((b) => b.callback_data === `histfmt:${s.sessionId}`)).toBe(true);
    // The picker grid covers every page, navigates the card (tpagep) and closes.
    const picker = transcript.pagePickerKeyboard(s, total);
    const pickerPages = new Set(picker.flat().filter((b) => b.callback_data.startsWith(`tpagep:`)).map((b) => b.callback_data));
    for (let p = 0; p < total; p++) expect(pickerPages.has(`tpagep:${s.sessionId}:${p}`)).toBe(true);
    expect(picker.flat().some((b) => b.callback_data === `tpick:close:${s.sessionId}`)).toBe(true);
  });

  test("exportTranscriptHtml includes every block escaped", async () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    s.topicTitle = "Mi <repo>";
    transcript.addBlock(s, "thinking", "<p>idea</p>", "idea secreta");
    transcript.addBlock(s, "answer", "<p>hola</p>", "hola <mundo>");
    const html = transcript.exportTranscriptHtml(s);
    expect(html).toContain("idea secreta");
    expect(html).toContain("hola &lt;mundo&gt;");
    expect(html).toContain("Mi &lt;repo&gt;");
    expect(html).toContain("Pensamiento");
    expect(html).toContain("Respuesta");
  });

  test("exportTranscriptJsonLd includes turns, tool calls and training pairs", async () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    s.topicTitle = "demo";
    s.turnSeq = 1;
    store.lastPromptBySession.set(s.sessionId, "haz algo");
    transcript.addBlock(s, "thinking", "<p>pienso</p>", "pienso");
    transcript.addBlock(s, "tools", "<p>shell</p>", "$ ls", undefined, [
      { name: "shell", input: JSON.stringify({ command: "ls" }), output: "a.ts", status: "success" },
    ]);
    transcript.addBlock(s, "answer", "<p>hecho</p>", "hecho");
    const dataset = JSON.parse(transcript.exportTranscriptJsonLd(s));
    expect(dataset["@type"]).toBe("Dataset");
    expect(dataset.session.sessionId).toBe(s.sessionId);
    expect(dataset.stats.turns).toBe(1);
    expect(dataset.conversation[0].userPrompt).toBe("haz algo");
    expect(dataset.conversation[0].toolCalls[0].name).toBe("shell");
    expect(dataset.conversation[0].messages.some((m: any) => m.kind === "tools" && m.toolCalls?.length)).toBe(true);
    expect(dataset.trainingPairs[0].messages[0].role).toBe("user");
    expect(dataset.trainingPairs[0].toolCalls[0].output).toBe("a.ts");
  });

  test("the card shows a 📝 Diff button when the turn had edits", async () => {
    const { store, transcript } = makeHarness();
    const s = makeSession();
    transcript.addBlock(s, "answer", "<p>hola</p>", "hola");
    await transcript.publish(1, s);
    expect(s.transcriptMessageId).toBeDefined();
    // No edits yet: no Diff button.
    let kb = transcript.cardKeyboard(s, 0, 1).flat();
    expect(kb.some((b) => b.text.startsWith("📝 Diff"))).toBe(false);
    // Turn finished with edits: snapshot registered under the card id.
    store.rememberPendingEdits(s.transcriptMessageId!, s.sessionId, [
      { id: "t1", name: "edit", input: JSON.stringify({ filePath: "src/a.ts" }), status: "success" },
    ]);
    kb = transcript.cardKeyboard(s, 0, 1).flat();
    const diffBtn = kb.find((b) => b.text.startsWith("📝 Diff"));
    expect(diffBtn).toBeDefined();
    expect(diffBtn!.text).toBe("📝 Diff (1)");
    expect(diffBtn!.callback_data).toBe(`edits:full:${s.transcriptMessageId}`);
    // While working, the button hides (the turn is producing new edits).
    kb = transcript.cardKeyboard(s, 0, 1, { working: true }).flat();
    expect(kb.some((b) => b.text.startsWith("📝 Diff"))).toBe(false);
  });
});
