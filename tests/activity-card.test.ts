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
  const store = { lastPromptBySession: new Map<string, string>(), getTodos: () => [] } as any;
  const status = createStatusManager({
    tg: {} as any,
    threadOptsFor: () => ({}),
    getSettings: () => settings,
    pendingEdits: new Map(),
    rememberCot: () => {},
    rememberStatusMessage: () => {},
    forgetStatusMessage: () => {},
    store,
    transcript,
  } as any);
  const s: ChatSession = {
    sessionId: "ses_card", buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [],
    stopped: false, targetChatId: 7, activity: createTurnActivity(),
  } as ChatSession;
  return { status, s, published, store };
}

describe("activity summary in the session card", () => {
  test("publishCard shows counters and one expandable detail while working", async () => {
    const { status, s, published } = makeHarness();
    recordThought(s.activity!, "analizo el repo", { at: 1000 });
    recordTool(s.activity!, "read", "README.md", { at: 1100, toolId: "a" });
    s.activityExpanded = true;

    await status.publishCard(7, s);

    const top = published[0]?.extraTop ?? "";
    expect(top).toContain("1 pensamiento · 1 lectura");
    expect(top).toContain("<blockquote");
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
    expect(done).toContain("1 pensamiento · 1 comando");
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
    expect(top).toContain("1 pensamiento");
    expect(top).toContain("<blockquote");
    expect(top).not.toContain("texto secreto");
  });

  test("live card truncates the prompt to a short hint", async () => {
    const { status, s, published, store } = makeHarness();
    const long = "Explicame de que va este repo y ademas quiero que detalles todos los modos de la tarjeta y sus botones por favor";
    store.lastPromptBySession.set(s.sessionId, long);
    store.getTurnPrompt = () => long;
    await status.publishCard(7, s);
    const top = (published[0]?.extraTop ?? "") + (published[0]?.extraBottom ?? "");
    expect(top).toContain(long.slice(0, 50));
    expect(top).toContain(long.slice(-49));
    expect(top).not.toContain(long);
    expect(top).toContain("…");
  });

  test("done strip also truncates the prompt", async () => {
    const { status, s, published, store } = makeHarness();
    const long = "Explicame de que va este repo y ademas quiero que detalles todos los modos de la tarjeta y sus botones por favor";
    store.lastPromptBySession.set(s.sessionId, long);
    await status.finishStatus(7, s);
    const top = published[published.length - 1]?.extraTop ?? "";
    expect(top).toContain(long.slice(0, 50));
    expect(top).toContain(long.slice(-49));
    expect(top).not.toContain(long);
  });

  test("auto-finished card has real duration and tok/s in the footer", async () => {
    const { status, s, published } = makeHarness();
    // publishCard's auto-finish path sets statusFinished but not turnFinishedAt.
    s.statusFinished = true;
    s.promptStartTime = Date.now() - 10_000;
    s.turnFirstStreamedAt = Date.now() - 9_000;
    s.turnOutputTokens = 500;
    s.lastFinalText = "respuesta final";
    await status.publishCard(7, s);
    const html = published[published.length - 1]?.extraTop ?? "";
    expect(s.turnFinishedAt).toBeGreaterThan(0);
    expect(html).toContain("tok/s");
    expect(html).not.toContain("· — · —");
  });

  test("toggling the thoughts block keeps the thought text on both cards", async () => {
    const { status, s, published } = makeHarness();
    recordThought(s.activity!, "analizando el problema de memoria", { at: Date.now() - 1000 });
    await status.publishCard(7, s);
    s.thoughtsCollapsed = true;
    await status.publishCard(7, s);
    s.thoughtsCollapsed = false;
    s._lastPublishAt = 0;
    await status.publishCard(7, s);
    const live = published[published.length - 1]?.extraTop ?? "";
    expect(live).toContain("analizando el problema de memoria");

    // Finished card: low verbosity must not strip the detail (detailCap = 0).
    s.lastFinalText = "Respuesta final";
    s.statusFinished = true;
    s.thoughtsDoneCollapsed = true;
    s._lastPublishAt = 0;
    await status.publishCard(7, s);
    const collapsedDone = published[published.length - 1]?.extraTop ?? "";
    expect(collapsedDone).toContain("analizando el problema de memoria");
    s.thoughtsDoneCollapsed = false;
    s._lastPublishAt = 0;
    await status.publishCard(7, s);
    const openDone = published[published.length - 1]?.extraTop ?? "";
    expect(openDone).toContain("analizando el problema de memoria");
  });

  test("low token counts show a count but no misleading tok/s", async () => {
    const { status, s, published } = makeHarness();
    s.turnOutputTokens = 47;
    s.turnFirstStreamedAt = Date.now() - 27000;
    await status.publishCard(7, s);
    const top = (published[0]?.extraTop ?? "") + (published[0]?.extraBottom ?? "");
    expect(top).toContain("47 tok");
    expect(top).not.toContain("tok/s");
  });

  test("enough tokens show the measured speed", async () => {
    const { status, s, published } = makeHarness();
    s.turnOutputTokens = 500;
    s.turnFirstStreamedAt = Date.now() - 4000;
    await status.publishCard(7, s);
    const top = (published[0]?.extraTop ?? "") + (published[0]?.extraBottom ?? "");
    expect(top).toContain("tok/s");
  });

  test("progress and prompts render as block elements, not glued inline text", async () => {
    const { status, s, published } = makeHarness();
    s.turnOutputTokens = 500;
    s.turnFirstStreamedAt = Date.now() - 4000;
    await status.publishCard(7, s);
    const top = (published[0]?.extraTop ?? "") + (published[0]?.extraBottom ?? "");
    expect(top).toContain("<p><i>⚡");
  });

  test("startStatus hides resources by default on the first turn", async () => {
    const { status, s } = makeHarness();
    s.resourcesCollapsed = undefined;
    await status.startStatus(7, s);
    expect(s.resourcesCollapsed).toBe(true);
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
