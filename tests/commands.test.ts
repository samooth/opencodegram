import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_COMMANDS, handleCommand } from "../src/commands.js";
import type { BotDeps, SendFn } from "../src/context.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-commands-"));
  base = join(root, "project");
  mkdirSync(base);
  writeFileSync(join(base, "README.md"), "# hello\n");
  writeFileSync(join(root, "outside.txt"), "outside\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness(activeSession: { directory: string } | undefined = undefined) {
  const calls: string[] = [];
  const sends: string[] = [];
  const documents: string[] = [];

  const deps = {
    config: { OPENCODE_DIRECTORY: base },
    tg: {
      sendDocument: async (_chatId: number, _path: string, name: string) => {
        documents.push(name);
      },
      sendRichMessage: async () => ({ message_id: 1 }),
      deleteMessage: async () => true,
    },
    oc: {},
    store: {
      threadOptsFor: () => ({}),
      getTodos: () => [{ content: "Tarea demo", status: "pending", priority: "medium" }],
      lastPromptBySession: new Map(),
    },
    sessions: {
      restoreActiveSession: async () => activeSession,
      resolveSessionForRetry: async () => activeSession,
      activateSession: async () => undefined,
      createNewSession: async () => undefined,
    },
    panels: {
      sendPanel: async () => {
        calls.push("panel");
      },
      showCommands: async () => {
        calls.push("commands");
      },
      showModels: async () => {
        calls.push("models");
      },
      showSessions: async () => {
        calls.push("sessions");
      },
    },
    files: {
      showListing: async (_chatId: number, _threadId: number | undefined, path: string, options?: { hidden?: boolean }) => {
        calls.push(`ls:${path}:${options?.hidden ? "a" : "-"}`);
      },
      showFind: async (_chatId: number, _threadId: number | undefined, query: string, options?: { hidden?: boolean }) => {
        calls.push(`find:${query}:${options?.hidden ? "a" : "-"}`);
      },
      showFile: async (_chatId: number, _threadId: number | undefined, path: string, options?: { startLine?: number }) => {
        calls.push(`read:${path}:${options?.startLine ?? 1}`);
      },
    },
    settings: {
      get: () => ({
        showThinking: true,
        showTools: true,
        thinkingExpanded: false,
        toolsExpanded: true,
        showPartialText: true,
        autoArtifacts: true,
        voiceTranscription: true,
        compactFinal: false,
      }),
      set: () => ({
        showThinking: true,
        showTools: true,
        thinkingExpanded: false,
        toolsExpanded: true,
        showPartialText: true,
        autoArtifacts: true,
        voiceTranscription: true,
        compactFinal: false,
      }),
    },
  } as unknown as BotDeps;

  const send: SendFn = async (html: string) => {
    sends.push(html);
  };
  return { deps, calls, sends, documents, send };
}

describe("handleCommand routing", () => {
  test("routes /todos to the checklist", async () => {
    const { deps, sends, send } = harness({ directory: base });
    const handled = await handleCommand(deps, 1, undefined, "/todos", send, 1);
    expect(handled).toBe(true);
    expect(sends.some((m) => m.includes("Tarea demo"))).toBe(true);
  });

  test("dispatches file browser commands", async () => {
    const h = harness();
    expect(await handleCommand(h.deps, 100, 10, "/ls", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/ls src", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/ls -a", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/find status", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/find status -a", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/read README.md 7", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/read README.md", h.send)).toBe(true);
    expect(h.calls).toEqual(["ls::-", "ls:src:-", "ls::a", "find:status:-", "find:status:a", "read:README.md:7", "read:README.md:1"]);
  });

  test("shows usage when required arguments are missing", async () => {
    const h = harness();
    expect(await handleCommand(h.deps, 100, 10, "/find", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/read", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/file", h.send)).toBe(true);
    expect(h.sends).toEqual([
      "Uso: /find <text> [-a]",
      "Uso: /read <path> [start_line | summary]",
      "Uso: /file <path> (relative to the session directory)",
    ]);
  });

  test("/stop closes the turn with finishStatus, not a working republish", async () => {
    const { cmd_stop } = await import("../src/commands/sessions.js");
    const calls: string[] = [];
    const s = { sessionId: "ses_stop", stopped: false, statusMessageId: 12, statusTimer: setInterval(() => {}, 100000) } as any;
    clearInterval(s.statusTimer);
    s.statusTimer = undefined;
    const deps = {
      config: {},
      store: { getActiveSession: () => s },
      sessions: { restoreActiveSession: async () => s },
      oc: { interrupt: async () => {} },
      status: {
        finishStatus: async () => { calls.push("finish"); },
        updateStatus: async () => { calls.push("update"); },
      },
      panels: {},
      autoretry: {},
    } as any;
    const send: SendFn = async () => {};
    expect(await cmd_stop(deps, 100, undefined, "/stop", send)).toBe(true);
    expect(s.stopped).toBe(true);
    expect(calls).toEqual(["finish"]);
  });

  test("routes existing commands and falls through for prompts", async () => {
    const h = harness();
    expect(await handleCommand(h.deps, 100, 10, "/start", h.send)).toBe(true);
    expect(h.sends.join("\n")).toContain("Bienvenido a opencodegram");
    expect(await handleCommand(h.deps, 100, 10, "/commands", h.send)).toBe(true);
    expect(await handleCommand(h.deps, 100, 10, "/stop", h.send)).toBe(true);
    expect(h.calls).toEqual(["commands"]);
    expect(h.sends.join("\n")).toContain("No hay sesión activa");
    expect(await handleCommand(h.deps, 100, 10, "please review this", h.send)).toBe(false);
  });

  test("sends files through the safe document path", async () => {
    const h = harness({ directory: base });
    expect(await handleCommand(h.deps, 100, 10, "/file README.md", h.send)).toBe(true);
    expect(h.documents).toEqual(["README.md"]);
    expect(h.sends).toHaveLength(0);
  });

  test("rejects /file paths outside the session directory", async () => {
    const h = harness({ directory: base });
    expect(await handleCommand(h.deps, 100, 10, "/file ../outside.txt", h.send)).toBe(true);
    expect(h.documents).toHaveLength(0);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toContain("outside the session directory");
  });

  test("knows every bot command that handleCommand intercepts", () => {
    for (const name of ["ls", "find", "read", "file", "stop", "sessions", "use", "sync"]) {
      expect(KNOWN_COMMANDS.has(name)).toBe(true);
    }
  });

  test("/permissions add accepts @username", async () => {
    const { PermissionStore } = await import("../src/permissions.js");
    const perms = new PermissionStore(join(root, "data"));
    perms.rememberUser(321, "carlos");
    const sends: string[] = [];
    const deps = {
      config: { ADMIN_TELEGRAM_USER_ID: 1 },
      store: { routeKey: (c: number, t?: number) => `${c}:${t ?? 0}` },
      permissions: perms,
      sessions: {},
      panels: {},
      files: {},
    } as any;
    const send: SendFn = async (html: string) => { sends.push(html); return {}; };
    await handleCommand(deps, 123, undefined, "/permissions add @carlos operator", send, 1);
    expect(perms.get("123:0").allowedUsers).toContain(321);
    expect(sends[0]).toContain("@carlos");
  });
});
