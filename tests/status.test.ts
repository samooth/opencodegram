import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createStatusManager } from "../src/status.js";
import { renderPartialText } from "../src/status-render.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-status-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_x",
    buffer: "hello",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    ...overrides,
  } as ChatSession;
}

describe("status finishStatus", () => {
  test("clears statusMessageId and marks finished", async () => {
    const edits: any[] = [];
    const tg = {
      editRichMessage: async (...args: any[]) => { edits.push(args); return { message_id: 1 }; },
      sendRichMessage: async () => ({ message_id: 2 }),
    } as any;
    const status = createStatusManager({
      tg,
      threadOptsFor: () => ({}),
      getSettings: () => ({}) as any,
      pendingEdits: new Map(),
      rememberCot: () => {},
      rememberStatusMessage: () => {},
      forgetStatusMessage: () => {},
    });
    const s = makeSession({ statusMessageId: 42, targetChatId: 7 });
    await status.finishStatus(7, s);
    expect(s.statusFinished).toBe(true);
    expect(s.statusMessageId).toBeUndefined();
  });

  test("celebrateOnDone reacts with 🎉 once on a successful turn", async () => {
    const reactions: any[] = [];
    const tg = {
      editRichMessage: async () => ({ message_id: 1 }),
      sendRichMessage: async () => ({ message_id: 2 }),
      setMessageReaction: async (...args: any[]) => { reactions.push(args); return true; },
    } as any;
    const status = createStatusManager({
      tg, threadOptsFor: () => ({}),
      getSettings: () => ({ celebrateOnDone: true }) as any,
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
    } as any);
    const s = makeSession({ statusMessageId: 42, transcriptMessageId: 77, targetChatId: 7 });
    await status.finishStatus(7, s);
    expect(reactions).toEqual([[7, 77, "🎉"]]);
    await status.finishStatus(7, s); // idempotent, no second reaction
    expect(reactions).toHaveLength(1);
  });

  test("startStatus shows activity detail when a think/shell/tool toggle is on", async () => {
    const status = createStatusManager({
      tg: { editRichMessage: async () => ({ message_id: 1 }), sendRichMessage: async () => ({ message_id: 2 }) } as any,
      threadOptsFor: () => ({}),
      getSettings: () => ({ showThinking: false, showShell: false, showTools: true }) as any,
      pendingEdits: new Map(),
      rememberCot: () => {},
      rememberStatusMessage: () => {},
      forgetStatusMessage: () => {},
    });
    const s = makeSession({ activityExpanded: false });
    await status.startStatus(7, s);
    expect(s.activityExpanded).toBe(true);
  });
});

describe("partial text rendering", () => {
  test("renders shell commands as code blocks with whole lines", async () => {
        const buffer = [
      'cd /ai/repos/2026/zig-ai-clean && echo "=== python ==="',
      "find /ai/repos/2026 -name '*triple*' -o -iname '*.tsv' 2>/dev/null | head -20",
      'python3 -c "import transformers, torch; print(transformers.__version__)"',
    ].join("\n");
    const html = renderPartialText(buffer, 400);
    expect(html).toContain("<pre><code>");
    expect(html).toContain("find /ai/repos/2026");
    expect(html).toContain("-iname");
    // The command is not cut into a mid-word fragment.
    expect(html).not.toContain("…mp -iname");
  });

  test("truncates at line boundaries without a repeated-ellipsis marker", () => {
        const buffer = Array.from({ length: 20 }, (_, i) => `echo line ${i}`).join("\n");
    const html = renderPartialText(buffer, 60);
    expect(html).not.toContain("…\n");
    // No partial line like "echo line 1" cut mid-number.
    const body = html.replace(/<[^>]+>/g, "");
    for (const line of body.split("\n").filter(Boolean)) {
      if (line.startsWith("echo")) expect(line).toMatch(/^echo line \d+$/);
    }
  });

  test("plain prose stays in a blockquote", () => {
        const html = renderPartialText("Estoy revisando el código para encontrar el problema.", 400);
    expect(html).toContain("<blockquote expandable>");
    expect(html).not.toContain("<pre>");
  });
});

describe("virtual shell and tool stats", () => {
  test("renders read/write/webfetch as $-prefixed commands", async () => {
    const { renderVirtualShell } = await import("../src/status-render.js");
    const html = renderVirtualShell([
      { id: "1", name: "read", input: JSON.stringify({ filePath: "/repo/src/main.ts" }), status: "success" },
      { id: "2", name: "write", input: JSON.stringify({ filePath: "/repo/src/new.ts" }), status: "success" },
      { id: "3", name: "webfetch", input: JSON.stringify({ url: "https://example.com" }), status: "success" },
      { id: "4", name: "edit", input: JSON.stringify({ filePath: "/repo/src/other.ts" }), status: "success" },
      { id: "5", name: "bash", input: JSON.stringify({ command: "ls -la" }), status: "success" },
    ], 200);
    expect(html).toContain("$ read /repo/src/main.ts");
    expect(html).toContain("$ write /repo/src/new.ts");
    expect(html).toContain("$ edit /repo/src/other.ts");
    expect(html).toContain("$ fetch https://example.com");
    expect(html).toContain("$ ls -la");
  });

  test("accumulates the same command regardless of a leading cd", async () => {
    const { renderVirtualShell } = await import("../src/status-render.js");
    const html = renderVirtualShell([
      { id: "1", name: "bash", input: JSON.stringify({ command: "cd /repo && bun test" }), status: "success" },
      { id: "2", name: "bash", input: JSON.stringify({ command: "cd /repo && bun test" }), status: "success" },
    ], 200);
    expect(html).toContain("$ bun test  (×2)");
    expect(html).not.toContain("cd /repo");
  });

  test("shell output unwraps truncated harness JSON and caps long output", async () => {
    const { renderVirtualShell } = await import("../src/status-render.js");
    const html = renderVirtualShell([
      { id: "1", name: "bash", input: JSON.stringify({ command: "sed -n 1,200p file.ts" }),
        status: "success", output: '[{"type":"text","text":"linea uno\nlinea dos\nlinea tres\nlinea cuatro\nlinea cinco\nlinea seis\nlinea siete\nlinea ocho"', },
    ], 400);
    expect(html).toContain("$ sed -n 1,200p file.ts");
    expect(html).toContain("linea uno");
    expect(html).not.toContain('[{"type"');
    expect(html).toContain("líneas)");
  });

  test("skill activation is its own bottom line, not a shell command", async () => {
    const { renderVirtualShell, renderSkillBlock } = await import("../src/status-render.js");
    const details = [
      { id: "s1", name: "skill", input: JSON.stringify({ id: "telegram-rich-messages" }), status: "success" },
    ] as any;
    expect(renderVirtualShell(details, 200)).not.toContain("skill telegram-rich-messages");
    const block = renderSkillBlock(details);
    expect(block).toContain("🧩 telegram-rich-messages");
    expect(block).not.toContain('{"id"');
  });

  test("execute tool shows the code, not the tool name", async () => {
    const { renderVirtualShell, isShellTool } = await import("../src/status-render.js");
    expect(isShellTool("execute")).toBe(true);
    const html = renderVirtualShell([
      { id: "1", name: "execute", input: JSON.stringify({ code: "const x = compute();\nreturn x" }), status: "success" },
    ], 200);
    expect(html).toContain("$ execute const x = compute();");
    expect(html).not.toMatch(/^\$ execute$/m);
  });

  test("bus calls render in their own section, not in the shell", async () => {
    const { renderVirtualShell, renderBusBlock, parseBusCall, formatBusCall } = await import("../src/status-render.js");
    const code = 'const r = await tools.bus.send({\n to: "F4 dev",\n type: "REPORT",\n subject: "Puerta encolada"\n});\nreturn r';
    const call = parseBusCall(code);
    expect(call?.method).toBe("send");
    expect(formatBusCall(call!)).toContain("→ F4 dev REPORT · Puerta encolada");
    const details = [{ id: "1", name: "execute", input: JSON.stringify({ code }), status: "success" }] as any;
    expect(renderVirtualShell(details, 200)).not.toContain("tools.bus");
    const block = renderBusBlock(details, "ses_x");
    expect(block).toContain('data="block:bus:ses_x:0"');
    expect(block).toContain("📨 bus:send → F4 dev REPORT · Puerta encolada");
    expect(block).toContain("Puerta encolada</b>");
    // Collapsed: button stays, content disappears.
    expect(renderBusBlock(details, "ses_x", { 0: true })).not.toContain("Puerta encolada</b>");
  });

  test("accumulates identical commands instead of overwriting", async () => {
    const { renderVirtualShell } = await import("../src/status-render.js");
    const html = renderVirtualShell([
      { id: "1", name: "bash", input: JSON.stringify({ command: "bun test" }), status: "success" },
      { id: "2", name: "read", input: JSON.stringify({ filePath: "/a.ts" }), status: "success" },
      { id: "3", name: "bash", input: JSON.stringify({ command: "bun test" }), status: "success" },
      { id: "4", name: "bash", input: JSON.stringify({ command: "bun test" }), status: "failed" },
    ], 200);
    // One accumulated line with count 3, not three separate lines.
    expect(html).toContain("$ bun test  (×3)");
    expect(html).toContain("❌");
    // Distinct commands are both present.
    expect(html).toContain("$ read /a.ts");
    // Only one "$ bun test" header line.
    const bunLines = html.split("\n").filter((l: string) => /^\$ bun test/.test(l));
    expect(bunLines.length).toBe(1);
  });

  test("tool stats line uses icons and counts failures", async () => {
    const { renderToolStats } = await import("../src/status-render.js");
    const line = renderToolStats([
      { id: "1", name: "bash", status: "success" },
      { id: "2", name: "read", status: "success" },
      { id: "3", name: "read", status: "failed" },
      { id: "4", name: "edit", status: "success" },
    ]);
    expect(line).toContain("🔧 4");
    expect(line).toContain("⚡1");
    expect(line).toContain("📖2");
    expect(line).toContain("✏️1");
    expect(line).toContain("❌1");
  });
});

describe("reasoning always collapsed by default", () => {
  test("finished card renders reasoning as an expandable blockquote", async () => {
    const published: any[] = [];
    const tg = { editRichMessage: async () => ({ message_id: 1 }) } as any;
    const transcript = {
      publish: async (_c: number, _s: any, opts: any) => { published.push(opts); return 1; },
      addBlock: () => {}, refloat: async () => 1,
    } as any;
    const status = createStatusManager({
      tg, threadOptsFor: () => ({}),
      getSettings: () => ({ ...DEFAULT_SETTINGS, showThinking: true, thinkingExpanded: true, showFinalInCard: false }),
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { lastPromptBySession: new Map(), getTodos: () => [] } as any,
      transcript,
    } as any);
    const s = makeSession({
      statusFinished: true,
      cotBuffer: "razonamiento secreto del turno",
      cotCount: 1,
      promptStartTime: Date.now() - 5000,
    });
    await status.publishCard(7, s);
    const html = published[0]?.extraTop ?? "";
    expect(html).toContain("🧠 Razonamiento");
    expect(html).toMatch(/data="block:done:reasoning:/);
  });
});

describe("live virtual shell", () => {
  test("shows all toolcalls as $-prefixed commands in the working card", async () => {
    const published: any[] = [];
    const transcript = {
      publish: async (_c: number, _s: any, opts: any) => { published.push(opts); return 1; },
      addBlock: () => {}, refloat: async () => 1,
    } as any;
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}),
      getSettings: () => ({ ...DEFAULT_SETTINGS, showTools: true, showPartialText: false }),
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { lastPromptBySession: new Map(), getTodos: () => [] } as any,
      transcript,
    } as any);
    const s = makeSession({
      statusFinished: false,
      toolCallDetails: [
        { id: "1", name: "read", input: JSON.stringify({ filePath: "/repo/main.ts" }), status: "success" },
        { id: "2", name: "bash", input: JSON.stringify({ command: "bun test" }), status: "success" },
      ],
    });
    await status.publishCard(7, s);
    const html = published[0]?.extraTop ?? "";
    expect(html).toContain("⚡ Shell (2)");
    expect(html).toContain("$ read /repo/main.ts");
    expect(html).toContain("$ bun test");
  });

  test("refloats a new card per turn when cardBehavior is refloat, even with showTools", async () => {
    let refloats = 0;
    const transcript = {
      publish: async () => 1, addBlock: () => {},
      refloat: async () => { refloats++; return 1; },
    } as any;
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}),
      getSettings: () => ({ ...DEFAULT_SETTINGS, showTools: true, cardBehavior: "refloat" }),
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { beginTurn: () => 1, lastPromptBySession: new Map(), getTodos: () => [] } as any,
      transcript,
    } as any);
    const s = makeSession({ statusFinished: false });
    await status.startStatus(7, s);
    expect(refloats).toBe(1);
  });
});

describe("finished card collapses reasoning regardless of profile", () => {
  test("verbose profile (thinkingExpanded) still collapses the done card", async () => {
    const { createTurnActivity, recordThought } = await import("../src/activity.js");
    const { PRESET_SETTINGS } = await import("../src/settings.js");
    const published: any[] = [];
    const transcript = { publish: async (_c: number, _s: any, o: any) => { published.push(o); return 1; }, addBlock: () => {}, refloat: async () => 1 } as any;
    const settings = { ...DEFAULT_SETTINGS, ...PRESET_SETTINGS.verbose, cardBehavior: "refloat" as const } as any;
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}), getSettings: () => settings,
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { lastPromptBySession: new Map(), getTodos: () => [] } as any, transcript,
    } as any);
    const activity = createTurnActivity();
    recordThought(activity, "pensamiento detallado del modelo");
    const s = makeSession({
      statusFinished: true, activity, activityExpanded: true,
      cotBuffer: "razonamiento del turno", cotCount: 1, promptStartTime: Date.now() - 5000,
    });
    await status.publishCard(7, s);
    const html = published[0]?.extraTop ?? "";
    // No expanded detail marker (▴) in the finished card.
    expect(html).not.toContain("▴");
    expect(html).toMatch(/data="block:done:reasoning:/);
    expect(html).toMatch(/<blockquote expandable>💭 Pensamientos/);
  });
});

describe("todo checklist in the card", () => {
  test("renders the remembered todos as a checklist in the card", async () => {
    const published: any[] = [];
    const transcript = { publish: async (_c: number, _s: any, o: any) => { published.push(o); return 1; }, addBlock: () => {}, refloat: async () => 1 } as any;
    const todos = [
      { content: "Preparar", status: "completed", priority: "medium" },
      { content: "Revisar", status: "in_progress", priority: "medium" },
      { content: "Terminar", status: "pending", priority: "medium" },
    ];
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}), getSettings: () => ({ ...DEFAULT_SETTINGS }) as any,
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { lastPromptBySession: new Map(), getTodos: () => todos } as any, transcript,
    } as any);
    await status.publishCard(7, makeSession({ statusFinished: true }));
    const html = published[0]?.extraTop ?? "";
    expect(html).toContain("📋 Tareas (1/3)");
    expect(html).toContain("✅ Preparar");
    expect(html).toContain("🔄 Revisar");
    expect(html).toContain("⬜ Terminar");
  });
});

describe("subagents in the card", () => {
  test("lists how many and which child sessions are working", async () => {
    const published: any[] = [];
    const transcript = { publish: async (_c: number, _s: any, o: any) => { published.push(o); return 1; }, addBlock: () => {}, refloat: async () => 1 } as any;
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}),
      getSettings: () => ({ ...DEFAULT_SETTINGS }) as any,
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: {
        lastPromptBySession: new Map(), getTodos: () => [], getTranscript: () => [],
        getActiveSubagents: () => ({
          total: 2, busy: 1,
          children: [
            { sessionId: "ses_child_111111", title: "Auditoría web", busy: true, status: "busy" },
            { sessionId: "ses_child_222222", title: "Revisión", busy: false, status: "idle" },
          ],
        }),
      } as any,
      transcript,
    } as any);
    await status.publishCard(7, makeSession({ statusFinished: false, statusMessageId: 5 }));
    const html = published[0]?.extraTop ?? "";
    expect(html).toContain("🤖 <b>Subagentes (2)</b> · 1 activo");
    expect(html).toContain("ses_child_11");
    expect(html).toContain("Auditoría web");
    expect(html).toContain("ses_child_22");
    expect(html).toContain("Revisión");
  });
});

describe("live answer section", () => {
  test("accumulates completed and streaming answers below the shell with a toggle", async () => {
    const published: any[] = [];
    const transcript = { publish: async (_c: number, _s: any, o: any) => { published.push(o); return 1; }, addBlock: () => {}, refloat: async () => 1 } as any;
    const blocks = [
      { kind: "answer", html: "<p>primera respuesta</p>", text: "primera respuesta", at: 1, turn: 1 },
      { kind: "answer", html: "<p>segunda respuesta</p>", text: "segunda respuesta", at: 2, turn: 1 },
    ];
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}),
      getSettings: () => ({ ...DEFAULT_SETTINGS, showPartialText: true, showTools: true }) as any,
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { lastPromptBySession: new Map(), getTodos: () => [], getTranscript: () => blocks } as any,
      transcript,
    } as any);
    const s = makeSession({ statusFinished: false, statusMessageId: 5, turnSeq: 1, buffer: "respuesta en curso" });
    await status.publishCard(7, s);
    const html = published[0]?.extraTop ?? "";
    expect(html).toContain('data="block:answer:ses_x"');
    expect(html).toContain("primera respuesta");
    expect(html).toContain("segunda respuesta");
    expect(html).toContain("respuesta en curso");
    expect(html.indexOf("💬 Respuesta")).toBeLessThan(html.indexOf("respuesta en curso"));
  });
});

describe("answer visible in the finished card", () => {
  test("answer appears after shell virtual with state by the prompt", async () => {
    const { createTurnActivity, recordThought } = await import("../src/activity.js");
    const { PRESET_SETTINGS } = await import("../src/settings.js");
    const published: any[] = [];
    const transcript = { publish: async (_c: number, _s: any, o: any) => { published.push(o); return 1; }, addBlock: () => {}, refloat: async () => 1 } as any;
    const settings = { ...DEFAULT_SETTINGS, ...PRESET_SETTINGS.verbose, cardBehavior: "refloat" as const, showFinalInCard: true } as any;
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}), getSettings: () => settings,
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { lastPromptBySession: new Map(), getTodos: () => [] } as any, transcript,
    } as any);
    const activity = createTurnActivity();
    recordThought(activity, "pensamiento secundario");
    const answer = "Mi respuesta completa y legible sin pulsar nada.";
    const s = makeSession({
      statusFinished: true, activity, activityExpanded: true,
      lastFinalText: answer, cotBuffer: "razonamiento del turno", cotCount: 1,
      promptStartTime: Date.now() - 5000,
      toolCallDetails: [{ id: "1", name: "bash", input: '{"command":"ls"}', status: "success" }],
    });
    await status.publishCard(7, s);
    const html = published[0]?.extraTop ?? "";
    const reasoningIdx = html.indexOf("🧠 Razonamiento");
    const shellIdx = html.indexOf("⚡ Shell");
    const answerIdx = html.indexOf("💬 Respuesta");
    // State sits next to the prompt at the top; answer follows the shell.
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(shellIdx).toBeGreaterThan(reasoningIdx);
    expect(answerIdx).toBeGreaterThan(shellIdx);
    expect(html).toContain(answer);
  });

});

describe("live streaming sections", () => {
  test("shows reasoning as its own collapsible block while working", async () => {
    const published: any[] = [];
    const transcript = { publish: async (_c: number, _s: any, o: any) => { published.push(o); return 1; }, addBlock: () => {}, refloat: async () => 1 } as any;
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}),
      getSettings: () => ({ ...DEFAULT_SETTINGS, showThinking: true, showTools: true, showPartialText: false }),
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { lastPromptBySession: new Map(), getTodos: () => [] } as any, transcript,
    } as any);
    const s = makeSession({
      statusFinished: false,
      reasoningBuffer: "El modelo está razonando sobre la seguridad...",
      toolCallDetails: [{ id: "1", name: "read", input: '{"filePath":"a.ts"}', status: "success" }],
    });
    await status.publishCard(7, s);
    const html = published[0]?.extraTop ?? "";
    expect(html).toMatch(/data="block:reasoning:[^"]+">🧠 Razonamiento/);
    expect(html).toContain("El modelo está razonando");
    expect(html).toMatch(/data="block:shell:/);
    expect(html).toContain("$ read a.ts");
  });

  test("shows an empty virtual shell block when no toolcalls yet", async () => {
    const published: any[] = [];
    const transcript = { publish: async (_c: number, _s: any, o: any) => { published.push(o); return 1; }, addBlock: () => {}, refloat: async () => 1 } as any;
    const status = createStatusManager({
      tg: {} as any, threadOptsFor: () => ({}),
      getSettings: () => ({ ...DEFAULT_SETTINGS, showTools: true, showPartialText: false }),
      pendingEdits: new Map(), rememberCot: () => {}, rememberStatusMessage: () => {}, forgetStatusMessage: () => {},
      store: { lastPromptBySession: new Map(), getTodos: () => [] } as any, transcript,
    } as any);
    const s = makeSession({ statusFinished: false, toolCallDetails: [] });
    await status.publishCard(7, s);
    const html = published[0]?.extraTop ?? "";
    expect(html).toMatch(/<blockquote expandable>⚡ Shell \(0\)/);
    expect(html).toContain("⚡ Shell (0)");
  });
});
