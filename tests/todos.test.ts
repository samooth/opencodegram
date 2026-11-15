import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store.js";
import { renderTodos, type TodoItem } from "../src/todos.js";

const TEST_ROOT = "/tmp/opencode";
let root: string;
beforeEach(() => { root = mkdtempSync(join(TEST_ROOT, "ocg-todos-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("todos store", () => {
  test("remembers todos per session and persists them", () => {
    const store = new SessionStore(join(root, "data"));
    store.rememberTodos("ses_1", [
      { content: "Analizar", status: "completed", priority: "high" },
      { content: "Implementar", status: "pending", priority: "medium" },
    ]);
    expect(store.getTodos("ses_1").length).toBe(2);
    // Reload from disk.
    const store2 = new SessionStore(join(root, "data"));
    expect(store2.getTodos("ses_1")[0].content).toBe("Analizar");
    expect(store2.getTodos("ses_1")[1].status).toBe("pending");
  });

  test("replaces the previous list for the same session", () => {
    const store = new SessionStore(join(root, "data"));
    store.rememberTodos("ses_1", [{ content: "a", status: "pending", priority: "low" }]);
    store.rememberTodos("ses_1", [{ content: "b", status: "completed", priority: "high" }]);
    expect(store.getTodos("ses_1").length).toBe(1);
    expect(store.getTodos("ses_1")[0].content).toBe("b");
  });
});

describe("renderTodos", () => {
  test("renders a checklist with checked and unchecked items", () => {
    const todos: TodoItem[] = [
      { content: "Hecho", status: "completed", priority: "high" },
      { content: "En curso", status: "in_progress", priority: "medium" },
      { content: "Pendiente", status: "pending", priority: "low" },
      { content: "Cancelado", status: "cancelled", priority: "low" },
    ];
    const html = renderTodos(todos);
    expect(html).toContain("Hecho");
    expect(html).toContain("check");
    expect(html).toContain("Pendiente");
    // Cancelled items are not rendered as pending.
    expect(html).not.toContain("Cancelado");
  });

  test("returns empty string for empty list", () => {
    expect(renderTodos([])).toBe("");
  });

  test("summarizes completed/total", () => {
    const todos: TodoItem[] = [
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "pending", priority: "low" },
    ];
    expect(renderTodos(todos)).toContain("1/2");
  });
});
