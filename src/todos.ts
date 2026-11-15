/** A task item as emitted by OpenCode's `todo.updated` event. */
export type TodoItem = {
  content: string;
  /** pending | in_progress | completed | cancelled */
  status: string;
  /** high | medium | low */
  priority: string;
};

const STATUS_ICON: Record<string, string> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⬜",
  cancelled: "🚫",
};

/**
 * Render a compact TODO checklist as Telegram rich HTML.
 * Cancelled items are hidden; completed/in-progress/pending are shown.
 */
export function renderTodos(todos: TodoItem[]): string {
  const visible = todos.filter((t) => t.status !== "cancelled");
  if (!visible.length) return "";
  const completed = visible.filter((t) => t.status === "completed").length;
  const lines = [`<h3>📋 Tareas (${completed}/${visible.length})</h3>`, "<ul>"];
  for (const t of visible) {
    const icon = STATUS_ICON[t.status] ?? "⬜";
    const checked = t.status === "completed" ? " checked" : "";
    lines.push(`<li><input type="checkbox"${checked}/> ${icon} ${escapeTodo(t.content)}</li>`);
  }
  lines.push("</ul>");
  return lines.join("\n");
}

function escapeTodo(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
