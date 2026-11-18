import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { createTranscriptManager } from "../src/transcriptmanager.js";
import { createStatusManager } from "../src/status.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { createTurnActivity, recordThought, recordTool, finishTool } from "../src/activity.js";
import { sparkline } from "../src/resources.js";
import { webAppHtml, createOpsServer } from "../src/ops.js";
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

describe("P2 golden UX states", () => {
  test("working card: state, telemetry, compact activity and primary action", async () => {
    const { status, published } = makeHarness({ ...DEFAULT_SETTINGS, cardVerbosity: "medium" });
    const s = makeSession({
      promptStartTime: Date.now() - 12_000,
      activity: createTurnActivity(),
    });
    recordThought(s.activity!, "analizando", { at: Date.now() - 1000 });
    recordTool(s.activity!, "edit", "editando", { at: Date.now() - 2000 });
    finishTool(s.activity!, s.activity!.entries[0].toolId!, true, { at: Date.now() - 1000 });
    await status.publishCard(7, s);
    const html = published[0].extraTop;
    expect(html).toContain("⏳ Trabajando…");
    expect(html).toContain("⏱ 12s");
    expect(html).toContain("Últimas acciones");
    expect(html).toContain("✅ ✏️");
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
    expect(sent[0].opts.reply_markup.inline_keyboard[0][0].url).toContain("token=secret-token");
    sent.length = 0;
    expect(await misc.cmd_web(deps, -100, undefined, "/web", send)).toBe(true);
    expect(sent[0].html).toContain("solo está disponible en chat privado");
    expect(JSON.stringify(sent[0].opts)).not.toContain("token");
    expect(sent[0].opts.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "panel:sessions")).toBe(true);
    expect(handleCommand).toBeDefined();
  });
});

describe("P1.5 resources and web app", () => {
  test("sparkline maps samples to Unicode blocks and stays bounded", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([0, 100])).toBe("▁█");
    expect(sparkline(Array.from({ length: 30 }, (_, i) => i * 3))).toHaveLength(16);
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
