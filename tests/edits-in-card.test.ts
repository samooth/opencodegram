import { describe, expect, test } from "bun:test";
import { createStatusManager } from "../src/status.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { createTurnActivity } from "../src/activity.js";
import type { ChatSession } from "../src/types.js";

function makeHarness() {
  const blocks: any[] = [];
  const sent: any[] = [];
  const published: any[] = [];
  const order: string[] = [];
  const transcript = {
    publish: async (_chatId: number, session: ChatSession, opts?: any) => {
      order.push("publish");
      published.push(opts);
      if (!session.transcriptMessageId) session.transcriptMessageId = 123;
      return 1;
    },
    addBlock: (...args: any[]) => { order.push("block"); blocks.push(args); },
    refloat: async () => 1,
  } as any;
  const tg = {
    sendRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 9 }; },
  } as any;
  const s = {
    sessionId: "ses_edits", buffer: "", reasoningBuffer: "", toolCalls: ["edit"],
    toolCallDetails: [{
      id: "e1", name: "edit", status: "success",
      input: JSON.stringify({ filePath: "/workspace/src/x.ts", oldString: "uno", newString: "dos" }),
    }],
    stopped: false, targetChatId: 7, directory: "/workspace",
    transcriptMessageId: 77, activity: createTurnActivity(),
  } as ChatSession;
  const snapshots = new Map<string, { sessionId: string; edits: any[] }>();
  const store = {
    getPendingEditsSnapshot: (chatId: number, id: number) => snapshots.get(`${chatId}:${id}`),
    rememberPendingEdits: (chatId: number, id: number, sessionId: string, edits: any[]) => { snapshots.set(`${chatId}:${id}`, { sessionId, edits }); },
    findSessionById: (id: string) => (id === s.sessionId ? s : undefined),
    getTodos: () => [],
    lastPromptBySession: new Map(),
    rememberMessageSession: () => {},
  } as any;
  const status = createStatusManager({
    tg,
    threadOptsFor: () => ({}),
    getSettings: () => DEFAULT_SETTINGS,
    pendingEdits: new Map(),
    rememberCot: () => {},
    rememberStatusMessage: () => {},
    forgetStatusMessage: () => {},
    store,
    transcript,
  } as any);
  return { status, s, blocks, sent, store, published, order, snapshots };
}

describe("edits inside the session card", () => {
  test("finishStatus adds edits as a transcript block instead of a new message", async () => {
    const { status, s, blocks, sent } = makeHarness();
    await status.finishStatus(7, s);
    expect(blocks.some((b) => b[1] === "tools")).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("finishStatus twice in the same turn does not duplicate the edit block", async () => {
    const { status, s, blocks } = makeHarness();
    s.turnSeq = 42;
    await status.finishStatus(7, s);
    s.statusFinished = false; // simulate a second finish signal for the same turn
    await status.finishStatus(7, s);
    expect(blocks.filter((b) => b[1] === "tools")).toHaveLength(1);
  });

  test("the edits block keeps the table and per-file expandable diff", async () => {
    const { status, s, blocks } = makeHarness();
    await status.finishStatus(7, s);
    const html = String(blocks.find((b) => b[1] === "tools")?.[2] ?? "");
    expect(html).toContain("<table");
    expect(html).toContain("<blockquote expandable>");
    expect(html).toContain("src/x.ts");
  });

  test("edit detail header shows added and removed line counts", async () => {
    const { status, s, sent, store } = makeHarness();
    await status.finishStatus(7, s);
    s.toolCallDetails[0]!.input = JSON.stringify({ path: "/workspace/src/x.ts", content: "linea uno\nlinea dos" });
    store.rememberPendingEdits(7, 77, s.sessionId, s.toolCallDetails);
    const sentBefore = sent.length;
    const handled = await status.showEditDetail(7, 77, 0);
    expect(handled).toBe(true);
    const html = String(sent[sentBefore]?.[1] ?? "");
    expect(html).toContain("+2/-0");
    expect(html).not.toContain('"content"');
  });

  test("the edits block is appended before the card is published", async () => {
    const { status, s, order } = makeHarness();
    await status.finishStatus(7, s);
    expect(order.filter((step) => step === "publish").length).toBe(1);
    expect(order.indexOf("block")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("block")).toBeLessThan(order.indexOf("publish"));
  });

  test("a stopped turn closes the card as Stopped", async () => {
    const { status, s, published } = makeHarness();
    s.stopped = true;
    await status.finishStatus(7, s);
    expect(published[0]?.extraTop).toContain("⏹");
    expect(published[0]?.extraTop).not.toContain("Detenido");
    expect(published[0]?.extraTop).not.toContain("✅ <b>Listo</b>");
    expect(published[0]?.working).toBe(false);
  });

  test("the snapshot is registered under the card id created by publishing", async () => {
    const { status, s, store, snapshots } = makeHarness();
    s.transcriptMessageId = undefined;
    await status.finishStatus(7, s);
    expect(s.transcriptMessageId).toBe(123);
    expect(snapshots.get("7:123")?.sessionId).toBe(s.sessionId);
    expect(store.getPendingEditsSnapshot(7, 123)?.edits?.length).toBe(1);
  });

  test("the diff uses colorDiff markup for additions and deletions", async () => {
    const { status, s, blocks } = makeHarness();
    await status.finishStatus(7, s);
    const html = String(blocks.find((b) => b[1] === "tools")?.[2] ?? "");
    expect(html).toContain("<s>- uno</s>");
    expect(html).toContain("<b>+ dos</b>");
  });
});
