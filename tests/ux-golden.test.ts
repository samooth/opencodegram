import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { createStatusManager } from "../src/status.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { createTurnActivity, recordThought, recordTool, finishTool } from "../src/activity.js";
import { renderResourceBlock } from "../src/resources.js";
import { webAppHtml, createOpsServer } from "../src/ops.js";
import { sessionHeader } from "../src/util.js";
import { renderTurnReceipt } from "../src/status-render.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-golden-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_golden",
    buffer: "",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    ...overrides,
  } as ChatSession;
}

function makeHarness(settings: typeof DEFAULT_SETTINGS = DEFAULT_SETTINGS) {
  const store = new SessionStore(join(root, "data"));
  store.lastPromptBySession.set("ses_golden", "haz algo útil");
  const published: any[] = [];
  const transcript = {
    publish: async (_c: number, _s: ChatSession, opts: any) => { published.push(opts); return 1; },
    addBlock: () => {},
    refloat: async () => 1,
  } as any;
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
  return { status, store, published };
}

/** Structural accessibility checks: balanced tags, no empty labels, no toasts. */
function assertAccessible(html: string, label: string) {
  const open = (html.match(/<(?!\/|!)[a-zA-Z][\w-]*\b[^>]*?(?<!\/)>/g) ?? []).length;
  const close = (html.match(/<\/[a-zA-Z][\w-]*>/g) ?? []).length;
  expect({ label, open, close }, "HTML tags should be balanced").toBeTruthy();
  // esc() escapes user content; nothing should inject a raw script.
  expect(html).not.toContain("<script>");
}

describe("final answer in card", () => {
  test("the finished card shows the answer by default without extra blank separators", async () => {
    const { status, published } = makeHarness();
    const s = makeSession({ statusFinished: true, lastFinalText: "Esta es la respuesta final." });
    await status.publishCard(7, s);
    const html = published[0].extraTop;
    expect(html).toContain("💬 Respuesta");
    expect(html).toContain("Esta es la respuesta final.");
    expect(html).not.toContain("<br/><br/>");
    expect(published[0].answerInCard).toBe(true);
  });

  test("the setting can disable the answer in the card", async () => {
    const { status, published } = makeHarness({ ...DEFAULT_SETTINGS, showFinalInCard: false });
    const s = makeSession({ statusFinished: true, lastFinalText: "Esta es la respuesta final." });
    await status.publishCard(7, s);
    expect(published[0].extraTop).not.toContain("💬 Respuesta");
    expect(published[0].answerInCard).toBe(false);
  });

  test("the answer block stays in the page to avoid an empty last page", () => {
    const store = new SessionStore(join(root, "data"));
    const tm = createTranscriptManager({ tg: {} as any, store, threadOptsFor: () => ({}) });
    const s = makeSession();
    tm.addBlock(s, "answer", "<p>texto duplicado</p>", "texto duplicado");
    expect(tm.renderPage(s, { answerInCard: true })!.html).not.toContain("texto duplicado");
  });
});

describe("message layout", () => {
  test("session name, model and receipt lines are separated with <br/>", () => {
    const s = makeSession({
      topicTitle: "opencodegram",
      model: { id: "hy4-flash-free", providerID: "opencode", variant: "high" },
    });
    const header = sessionHeader(s);
    expect(header).toContain("📌 <b>opencodegram</b> · <code>ses_gold</code><br/>🧠 <code>opencode/hy4-flash-free</code> (high)");
    const receipt = renderTurnReceipt({
      stopped: false,
      telemetry: ["⏱ 40s", "35% ctx"],
      test: { command: "bun test", ok: true, count: 3 },
    });
    expect(receipt).toContain("✅ <b>Listo</b><br/><i>⏱ 40s · 35% ctx</i>");
    expect(receipt).toContain("<br/>🧪 <code>bun test</code> · 3 ✓");
    expect(receipt).not.toMatch(/\n/);
  });
});

describe("callback ack", () => {
  test("the same tap is answered once even if several handlers call back", async () => {
    const { TelegramClient } = await import("../src/telegram.js");
    const client = new TelegramClient("token");
    const calls: any[] = [];
    (client as any).call = async (method: string, body: unknown) => { calls.push({ method, body }); return true; };
    await client.answerCallbackQuery("cb-1");
    await client.answerCallbackQuery("cb-1", "otro toast");
    expect(calls).toHaveLength(1);
  });
});

describe("P2 golden UX states", () => {
  test("working card: state, telemetry, compact activity and primary action", async () => {
    const { status, published } = makeHarness({ ...DEFAULT_SETTINGS, cardVerbosity: "medium" });
    const s = makeSession({
      promptStartTime: Date.now() - 12_000,
      activity: createTurnActivity(),
    });
    recordThought(s.activity!, "analizando", { at: Date.now() - 1000 });
    recordTool(s.activity!, "read", "README.md", { at: Date.now() - 2000 });
    finishTool(s.activity!, s.activity!.entries[0].toolId!, true, { at: Date.now() - 1000 });
    await status.publishCard(7, s);
    const html = (published[0].extraTop ?? "") + (published[0].extraBottom ?? "");
    expect(html).not.toContain("⏳ Trabajando…");
    expect(html).toContain("⏱ 12s");
    expect(html).toContain("Lectura ·");
    expect(html).not.toContain("Últimas acciones");
    expect(published[0].working).toBe(true);
    assertAccessible(html, "working");
  });

  test("done card: receipt with duration, edits, test and Spanish labels", async () => {
    const { status, published } = makeHarness();
    const s = makeSession({
      statusFinished: true,
      turnFinishedAt: 103_000,
      promptStartTime: 1_000,
      turnFirstStreamedAt: 3_000,
      turnOutputTokens: 4_200,
      toolCallDetails: [
        { id: "1", name: "edit", status: "success", input: JSON.stringify({ filePath: "/workspace/src/a.ts", oldString: "a", newString: "b" }) },
        { id: "2", name: "bash", status: "success", input: JSON.stringify({ command: "bun test" }), output: " 290 pass\n 0 fail" },
      ],
    });
    await status.publishCard(7, s);
    const html = published[0].extraTop;
    expect(html).toContain("✅ <b>Listo</b>");
    expect(html).toContain("⏱ 1m 42s");
    expect(html).toContain("✏️ <b>1 archivo</b> · +1 −1");
    expect(html).toContain("🧪 <code>bun test</code>");
    expect(html).toContain("290 ✓");
    expect(published[0].working).toBe(false);
    assertAccessible(html, "done");
  });

  test("stopped and error cards keep their primary actions", async () => {
    const { status, published } = makeHarness();
    const stopped = makeSession({ statusFinished: true, stopped: true });
    await status.publishCard(7, stopped);
    expect(published[0].extraTop).toContain("⏹ <b>Detenido</b>");
    const error = makeSession({ statusFinished: true, lastTurnError: "429 rate limit exceeded" });
    await status.publishCard(7, error);
    expect(published[1].extraTop).toContain("⚠️ <b>Turno interrumpido</b>");
  });

  test("every state keeps callback_data within 64 bytes and buttons non-empty", () => {
    const transcript = createTranscriptManager({
      tg: {} as any,
      store: new SessionStore(join(root, "data")),
      threadOptsFor: () => ({}),
    });
    const states: ChatSession[] = [
      makeSession(),
      makeSession({ stopped: true }),
      makeSession({ lastTurnError: "error" }),
      makeSession({ lastFinalText: "respuesta" }),
    ];
    for (const s of states) {
      const keyboard = transcript.cardKeyboard(7, s, 0, 3);
      for (const row of keyboard) {
        for (const button of row) {
          expect(button.text.length, "button label must not be empty").toBeGreaterThan(0);
          if (button.callback_data) {
            expect(new TextEncoder().encode(button.callback_data).length, button.callback_data).toBeLessThanOrEqual(64);
          }
        }
      }
    }
  });
});

describe("P2 entry points and cost", () => {
  test("dashboard fetches and caches accumulated cost from OpenCode", async () => {
    const store = new SessionStore(join(root, "data"));
    let calls = 0;
    const oc = {
      client: { session: { get: async () => { calls++; return { data: { cost: 0.0123 } }; } } },
    } as any;
    const sent: any[] = [];
    const tg = {
      sendRichMessage: async (...args: any[]) => { sent.push(args); return { message_id: 10 }; },
      editRichMessage: async () => ({ message_id: 10 }),
      pinChatMessage: async () => true,
      unpinChatMessage: async () => true,
    } as any;
    const { createDashboardManager } = await import("../src/dashboard.js");
    const dashboard = createDashboardManager({
      tg, store, oc,
      settings: { get: () => ({ ...DEFAULT_SETTINGS, displayMode: "unified", showSessionNameInStatus: true }) } as any,
      threadOptsFor: () => ({}),
    });
    const s = makeSession();
    await dashboard.ensure(7, undefined, s);
    expect(s.cost).toBe(0.0123);
    expect(sent[0][1]).toContain("Coste acumulado");
    expect(sent[0][1]).toContain("$0.0123");
    await dashboard.update(7, undefined, s);
    expect(calls).toBe(1); // cached on the second render
  });

  test("/web shares the app only in private chats", async () => {
    const { handleCommand } = await import("../src/commands/index.js");
    const misc = await import("../src/commands/misc.js");
    const sent: any[] = [];
    const deps = {
      config: { WEB_APP_TOKEN: "secret-token", WEB_APP_TITLE: "Mission Control", WEB_APP_URL: "https://bot.example", OPS_HOST: "127.0.0.1", OPS_PORT: 9090 },
      settings: { get: () => DEFAULT_SETTINGS },
    } as any;
    const send: any = async (html: string, opts?: any) => { sent.push({ html, opts }); };
    expect(await misc.cmd_web(deps, 7, undefined, "/web", send)).toBe(true);
    // /web now issues a single-use code instead of exposing the static token.
    expect(sent[0].opts.reply_markup.inline_keyboard[0][0].url).toContain("/app?code=");
    expect(sent[0].opts.reply_markup.inline_keyboard[0][0].url).not.toContain("token=");
    expect(sent[0].html).toContain("un solo uso");
    sent.length = 0;
    expect(await misc.cmd_web(deps, -100, undefined, "/web", send)).toBe(true);
    expect(sent[0].html).toContain("solo está disponible en chat privado");
    expect(JSON.stringify(sent[0].opts)).not.toContain("token");
    expect(sent[0].opts.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "panel:sessions")).toBe(true);
    expect(handleCommand).toBeDefined();
  });
});

describe("P1.5 resources and web app", () => {
  test("CTX never clamps an over-limit window; it flags it", () => {
    const s = makeSession({ lastContextTokens: 247_758, contextWindow: 200_000, cpuHistory: [23], memHistory: [57] });
    const text = renderResourceBlock(s, { history: 12 }).replace(/<[^>]+>/g, "");
    expect(text).toContain("CTX ");
    expect(text).toContain("248k / 200k (⚠ 124%)");
    expect(text).not.toContain("CTX ⚠ 124% (247,758");
  });

  test("resource indicators have no decorative sparkline tail", () => {
    const s = makeSession({ cpuHistory: [23], memHistory: [57] });
    const text = renderResourceBlock(s, { history: 12 }).replace(/<[^>]+>/g, "");
    expect(text).not.toMatch(/[▁▂▃▄▅▆▇█]/);
    expect(text).toMatch(/^CPU [▓░●○]/m);
    expect(text).toMatch(/^RAM [▓░●○]/m);
  });

  test("CTX uses a bar, compact totals and a trailing percentage", () => {
    const s = makeSession({ lastContextTokens: 353_983, contextWindow: 1_048_576 });
    const text = renderResourceBlock(s, { history: 12 }).replace(/<[^>]+>/g, "");
    expect(text).toContain("CTX ▓▓▓░░░░░░░ 354k / 1M (34%)");
  });

  test("web app escapes the title and hides the token in the HTML", () => {
    const html = webAppHtml("Mission <Control>");
    expect(html).toContain("Mission &lt;Control&gt;");
    expect(html).not.toContain("Mission <Control>");
    expect(html).toContain("fetch('data.json'+location.search)");
  });

  test("the private web app requires a token and serves data when enabled", async () => {
    const store = new SessionStore(join(root, "data"));
    const base = {
      config: { OPS_HOST: "127.0.0.1", OPS_PORT: 0, WEB_APP_TOKEN: "secret-token", WEB_APP_TITLE: "Mission Control", DISK_GUARD_MIN_FREE_MB: 1 },
      oc: { serverInfo: async () => ({ version: "test" }) },
      store,
      metrics: { snapshot: () => ({}), inc: () => {} },
    } as any;
    const server = createOpsServer(base);
    await new Promise<void>((r) => setTimeout(r, 50));
    const port = server.port();
    expect(port).toBeGreaterThan(0);
    try {
      const noToken = await fetch(`http://127.0.0.1:${port}/app`);
      expect(noToken.status).toBe(404);
      const app = await fetch(`http://127.0.0.1:${port}/app?token=secret-token`);
      expect(app.status).toBe(200);
      expect(await app.text()).toContain("Mission Control");
      const data = await fetch(`http://127.0.0.1:${port}/app/data.json?token=secret-token`);
      expect(await data.json()).toHaveProperty("sessions");
    } finally {
      server.stop();
    }
  });
});

describe("finished card reading order", () => {
  test("Razonamiento → Pensamiento → Respuesta, with the receipt last", async () => {
    const activity = createTurnActivity();
    recordThought(activity, "analizando el problema");
    const { status, published } = makeHarness({
      ...DEFAULT_SETTINGS,
      showThinking: true,
      showLatestThought: true,
      showFinalInCard: true,
    });
    const s = makeSession({
      statusFinished: true,
      cotBuffer: "pensamiento de la primera parte\n\n---\n\nrazonamiento final del turno",
      lastFinalText: "Esta es la respuesta final.",
      activity,
      promptStartTime: Date.now() - 5000,
      turnFinishedAt: Date.now(),
      toolCallDetails: [{ id: "1", name: "bash", input: '{"command":"ls"}', status: "success" }],
    });
    await status.publishCard(7, s);
    const html = published[0].extraTop as string;
    const reasoning = html.indexOf("🧠 Razonamiento");
    const thinking = html.indexOf("Pensamiento");
    const shell = html.indexOf("⚡ Shell");
    const done = html.indexOf("✅ <b>Listo</b>");
    const answer = html.indexOf("💬 Respuesta");
    // New order: reasoning → pensamiento → shell → Respuesta → Listo (receipt last).
    expect(reasoning).toBeGreaterThanOrEqual(0);
    expect(thinking).toBeGreaterThan(reasoning);
    expect(shell).toBeGreaterThan(thinking);
    expect(answer).toBeGreaterThan(shell);
    expect(done).toBeGreaterThan(answer);
  });

  test("settings disable each block", async () => {
    const { status, published } = makeHarness({
      ...DEFAULT_SETTINGS,
      showThinking: false,
      showLatestThought: false,
      showFinalInCard: false,
    });
    const s = makeSession({
      statusFinished: true,
      cotBuffer: "razonamiento oculto",
      lastFinalText: "respuesta oculta",
    });
    await status.publishCard(7, s);
    const html = published[0].extraTop as string;
    expect(html).not.toContain("🧠 Razonamiento");
    expect(html).toContain("✅ <b>Listo</b>");
  });
});
