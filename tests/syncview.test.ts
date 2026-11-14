import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildDigestParts, digestStats } from "../src/syncview.js";
import type { ChatSession } from "../src/types.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-sync-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "ses_x",
    draftId: 0,
    buffer: "",
    reasoningBuffer: "",
    toolCalls: [],
    toolCallDetails: [],
    stopped: false,
    directory: "/ai/repos/2026/myrepo",
    model: { id: "gpt-x", providerID: "prov" },
    ...overrides,
  } as ChatSession;
}

function userItem(text: string): Record<string, unknown> {
  return { role: "user", text };
}

function assistantItem(text: string, tools?: string[]): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: "text", text });
  for (const t of tools ?? []) content.push({ type: "tool", name: t });
  return { role: "assistant", content };
}

describe("session digest (Conectar //sync)", () => {
  test("empty context yields a single friendly part with keyboard", () => {
    const parts = buildDigestParts(makeSession(), [], { title: "📜 Contenido", sessionId: "ses_x" });
    expect(parts.length).toBe(1);
    expect(parts[0].html).toContain("No hay contexto todavía");
    expect(parts[0].html).toContain("0👤 · 0🤖");
    expect(parts[0].keyboard).toBeDefined();
    expect(parts[0].keyboard!.flat().some((b) => b.callback_data === "panel:ms:ses_x")).toBe(true);
  });

  test("header shows model, directory and stats", () => {
    const items = [userItem("hola"), assistantItem("qué tal")];
    const parts = buildDigestParts(makeSession(), items, { title: "📜 Contenido", sessionId: "ses_x" });
    const html = parts.map((p) => p.html).join("\n");
    expect(html).toContain("prov/gpt-x");
    expect(html).toContain("📁 myrepo");
    expect(html).toContain("1👤 · 1🤖");
  });

  test("user and assistant messages are rendered with truncation hints", () => {
    const long = "x".repeat(2000);
    const items = [userItem(long), assistantItem("y".repeat(3000))];
    const parts = buildDigestParts(makeSession(), items, { title: "📜 Contenido", sessionId: "ses_x" });
    const html = parts.map((p) => p.html).join("\n");
    expect(html).toContain("(+600 caracteres)");
    expect(html).toContain("(+800 caracteres)");
  });

  test("tool-only assistant turns list tool names with icons", () => {
    const items = [assistantItem("", ["bash", "read", "edit"])];
    const parts = buildDigestParts(makeSession(), items, { title: "📜 Contenido", sessionId: "ses_x" });
    const html = parts.map((p) => p.html).join("\n");
    // Names are prefixed with their tool icon and joined with separators.
    expect(html).toContain("🖥 bash · 📖 read · ✏️ edit");
    expect(html).toContain("expandable");
  });

  test("older messages become a compact timeline (one line each)", () => {
    const items: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 12; i++) {
      items.push(userItem(`pregunta ${i}`));
      items.push(assistantItem(`respuesta ${i}`));
    }
    const parts = buildDigestParts(makeSession(), items, { title: "📜 Contenido", sessionId: "ses_x" });
    const html = parts.map((p) => p.html).join("\n");
    // Timeline exists and shows previews of the older messages.
    expect(html).toContain("Mensajes anteriores (18)</summary>");
    expect(html).toContain("👤 pregunta 0");
    // The 6 most recent messages are shown in full.
    expect(html).toContain("respuesta 11");
  });

  test("long digests split into parts within the Telegram limit", () => {
    const items: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) {
      items.push(userItem("u".repeat(3000)));
      items.push(assistantItem("a".repeat(3000)));
    }
    const parts = buildDigestParts(makeSession(), items, { title: "📜 Contenido", sessionId: "ses_x" });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.html.length).toBeLessThanOrEqual(3850);
      expect(part.keyboard).toBeDefined();
    }
    // Continuation parts carry the marker.
    expect(parts[1].html).toContain("(continúa)");
  });

  test("digestStats counts roles and tools", () => {
    const stats = digestStats([
      userItem("a"),
      userItem("b"),
      assistantItem("c", ["bash", "read"]),
      assistantItem("", ["edit"]),
      { role: "compaction", summary: "s" },
    ]);
    expect(stats).toEqual({ users: 2, assistants: 2, tools: 3, compactions: 1 });
  });
});
