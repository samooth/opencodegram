import { describe, expect, test } from "bun:test";
import { createStatusManager } from "../src/status.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { createTurnActivity } from "../src/activity.js";
import type { ChatSession } from "../src/types.js";

function makeHarness() {
  const blocks: any[] = [];
  const sent: any[] = [];
  const transcript = {
    publish: async () => 1,
    addBlock: (...args: any[]) => { blocks.push(args); },
    refloat: async () => 1,
  } as any;
  const tg = {
    sendRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 9 }; },
  } as any;
  const status = createStatusManager({
    tg,
    threadOptsFor: () => ({}),
    getSettings: () => DEFAULT_SETTINGS,
    pendingEdits: new Map(),
    rememberCot: () => {},
    rememberStatusMessage: () => {},
    forgetStatusMessage: () => {},
    store: undefined,
    transcript,
  } as any);
  const s = {
    sessionId: "ses_edits", buffer: "", reasoningBuffer: "", toolCalls: ["edit"],
    toolCallDetails: [{
      id: "e1", name: "edit", status: "success",
      input: JSON.stringify({ filePath: "/workspace/src/x.ts", oldString: "uno", newString: "dos" }),
    }],
    stopped: false, targetChatId: 7, directory: "/workspace",
    transcriptMessageId: 77, activity: createTurnActivity(),
  } as ChatSession;
  return { status, s, blocks, sent };
}

describe("edits inside the session card", () => {
  test("finishStatus adds edits as a transcript block instead of a new message", async () => {
    const { status, s, blocks, sent } = makeHarness();
    await status.finishStatus(7, s);
    expect(blocks.some((b) => b[1] === "tools")).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("the edits block keeps the table and per-file expandable diff", async () => {
    const { status, s, blocks } = makeHarness();
    await status.finishStatus(7, s);
    const html = String(blocks.find((b) => b[1] === "tools")?.[2] ?? "");
    expect(html).toContain("<table");
    expect(html).toContain("<blockquote expandable>");
    expect(html).toContain("src/x.ts");
  });
});
