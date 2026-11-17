import { describe, expect, test } from "bun:test";
import { createStatusManager } from "../src/status.js";
import { DEFAULT_SETTINGS, type ChatSettings } from "../src/settings.js";
import { createTurnActivity, recordThought, recordTool } from "../src/activity.js";
import type { ChatSession } from "../src/types.js";

type Published = { extraTop?: string; extraBottom?: string; working?: boolean };

function makeHarness(overrides: Partial<ChatSettings> = {}) {
  const published: Published[] = [];
  const transcript = {
    publish: async (_chatId: number, _s: ChatSession, opts: Published) => { published.push(opts); return 1; },
    addBlock: () => {},
    refloat: async () => 1,
  } as any;
  const settings = { ...DEFAULT_SETTINGS, cardVerbosity: "medium" as const, ...overrides };
  const status = createStatusManager({
    tg: {} as any,
    threadOptsFor: () => ({}),
    getSettings: () => settings,
    pendingEdits: new Map(),
    rememberCot: () => {},
    rememberStatusMessage: () => {},
    forgetStatusMessage: () => {},
    store: undefined,
    transcript,
  } as any);
  const s: ChatSession = {
    sessionId: "ses_card", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [],
    stopped: false, targetChatId: 7, activity: createTurnActivity(),
  } as ChatSession;
  return { status, s, published };
}

describe("activity summary in the session card", () => {
  test("publishCard shows counters and one expandable detail while working", async () => {
    const { status, s, published } = makeHarness();
    recordThought(s.activity!, "analizo el repo", { at: 1000 });
    recordTool(s.activity!, "read", "README.md", { at: 1100, toolId: "a" });
    s.activityExpanded = true;

    await status.publishCard(7, s);

    const top = published[0]?.extraTop ?? "";
    expect(top).toContain("+1 thought · 1 read");
    expect(top).toContain("<blockquote>");
    expect(top).toContain("analizo el repo");
  });

  test("finishStatus closes open entries and switches the prefix to minus", async () => {
    const { status, s, published } = makeHarness();
    recordThought(s.activity!, "pensando", { at: 1000 });
    recordTool(s.activity!, "bash", "bun test", { at: 1100, toolId: "a" });
    expect(s.activity!.entries.some((e) => e.open)).toBe(true);

    await status.finishStatus(7, s);

    expect(s.activity!.entries.some((e) => e.open)).toBe(false);
    const done = published[published.length - 1]?.extraTop ?? "";
    expect(done).toContain("−1 thought · 1 shell");
  });

  test("startStatus resets activity for the new turn", async () => {
    const { status, s } = makeHarness();
    recordThought(s.activity!, "turno anterior", { at: 1000 });

    await status.startStatus(7, s);

    expect(s.activity).toBeDefined();
    expect(s.activity!.thoughts).toBe(0);
    expect(s.activity!.entries).toHaveLength(0);
    expect(s.activity!.nextId).toBe(1);
  });

  test("low verbosity keeps counters but omits detail text", async () => {
    const { status, s, published } = makeHarness({ cardVerbosity: "low" });
    recordThought(s.activity!, "texto secreto", { at: 1000 });

    await status.publishCard(7, s);

    const top = published[0]?.extraTop ?? "";
    expect(top).toContain("+1 thought");
    expect(top).toContain("<blockquote>");
    expect(top).not.toContain("texto secreto");
  });

  test("finishStatus returns the card to the latest page", async () => {
    const { status, s } = makeHarness();
    s.transcriptFollow = false;
    s.transcriptPage = 0;
    await status.finishStatus(7, s);
    expect(s.transcriptFollow).toBe(true);
    expect(s.transcriptPage).toBeUndefined();
  });
});
