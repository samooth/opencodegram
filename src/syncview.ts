import type { ChatSession } from "./types.js";
import { esc, markdownToHtml, toolIcon } from "./util.js";

/**
 * Shared renderer for the session digest shown by "Conectar" and /sync:
 * a metadata header, the most recent messages nicely formatted, and a compact
 * one-line-per-message timeline for the older ones. Content is split into
 * parts that respect the Telegram message limit instead of being silently
 * clamped (which could cut HTML mid-tag).
 */

export type DigestItem = Record<string, unknown>;
export type DigestKeyboard = Array<Array<{ text: string; callback_data: string }>>;
export type DigestPart = { html: string; keyboard?: DigestKeyboard };

const PART_BUDGET = 3800;

export function digestKeyboard(sessionId: string): DigestKeyboard {
  return [
    [
      { text: "🧠 Modelos", callback_data: `panel:ms:${sessionId}` },
      { text: "📂 Sesiones", callback_data: "panel:sessions" },
      { text: "📊 Status", callback_data: "panel:status" },
    ],
    [{ text: "🏠 Panel", callback_data: "panel:home" }],
  ];
}

export type DigestStats = { users: number; assistants: number; tools: number; compactions: number };

export function digestStats(items: DigestItem[]): DigestStats {
  const stats: DigestStats = { users: 0, assistants: 0, tools: 0, compactions: 0 };
  for (const item of items) {
    const role = item.role ?? item.type;
    if (role === "user") stats.users++;
    else if (role === "assistant") {
      stats.assistants++;
      const content = Array.isArray(item.content) ? item.content : [];
      stats.tools += content.filter((p: any) => p.type === "tool").length;
    } else if (role === "compaction") stats.compactions++;
  }
  return stats;
}

function itemRole(item: DigestItem): string {
  return String(item.role ?? item.type ?? "msg");
}

/** Truncated text with an explicit "+N" hint instead of a silent cut. */
function withHint(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n<i>… (+${text.length - max} caracteres)</i>`;
}

function assistantText(item: DigestItem): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .filter((p: any) => p.type === "text")
    .map((p: any) => (typeof p.text === "string" ? p.text : p?.text ? JSON.stringify(p.text) : ""))
    .join("\n\n")
    .trim();
}

function assistantTools(item: DigestItem): string[] {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .filter((p: any) => p.type === "tool")
    .map((p: any) => String(p.name ?? p.tool ?? "tool"));
}

/** One rendered message of the digest (already HTML). */
function renderItem(item: DigestItem): string {
  const role = itemRole(item);
  if (role === "user") {
    const raw = item.text;
    const text = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
    if (!text.trim()) return "";
    const repeat = (item as any)._repeat;
    const repeatHint = repeat && repeat > 1 ? ` <i>(×${repeat})</i>` : "";
    return `<h4>👤 Tú</h4>${repeatHint}\n<blockquote>${esc(withHint(text.trim(), 1400))}</blockquote>`;
  }
  if (role === "assistant") {
    const text = assistantText(item);
    if (text) return `<h4>🤖 OpenCode</h4>\n${markdownToHtml(withHint(text, 2200))}`;
    const tools = assistantTools(item);
    if (tools.length) {
      const line = tools.slice(0, 8).map((name) => `${toolIcon(name)} ${esc(name)}`).join(" · ");
      const more = tools.length > 8 ? ` … (+${tools.length - 8})` : "";
      return `<h4>🤖 OpenCode</h4>\n<blockquote expandable>🔧 ${line}${more}</blockquote>`;
    }
    return "";
  }
  if (role === "compaction") {
    const sum = String(item.summary ?? "").trim();
    return sum ? `<blockquote expandable>📦 <b>Compaction</b>\n${esc(withHint(sum, 500))}</blockquote>` : "";
  }
  return "";
}

/** One-line preview for the older-messages timeline. */
function previewOf(item: DigestItem): string {
  const role = itemRole(item);
  if (role === "user") {
    const raw = item.text;
    const text = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
    return `👤 ${text.trim().replace(/\s+/g, " ").slice(0, 100)}`;
  }
  if (role === "assistant") {
    const text = assistantText(item);
    if (text) return `🤖 ${text.replace(/\s+/g, " ").slice(0, 100)}`;
    const tools = assistantTools(item);
    return `🤖 🔧 ${tools.slice(0, 4).join(", ")}`;
  }
  if (role === "compaction") return `📦 ${(String(item.summary ?? "")).replace(/\s+/g, " ").slice(0, 100)}`;
  return "";
}

/**
 * Build the digest parts. Returns one or more messages: a header with session
 * metadata, the last 6 messages in full, and the older ones as a compact
 * timeline; each part fits the Telegram limit.
 */
export function buildDigestParts(
  s: ChatSession | null,
  items: DigestItem[],
  opts: { title: string; note?: string; sessionId: string },
): DigestPart[] {
  const keyboard = digestKeyboard(opts.sessionId);
  // Collapse consecutive identical user prompts (e.g. manual retries) into a
  // single entry with a count, so the digest stays readable.
  const raw = items.filter((item) => ["user", "assistant", "compaction"].includes(itemRole(item)));
  const meaningful: DigestItem[] = [];
  for (const item of raw) {
    const prev = meaningful[meaningful.length - 1];
    if (itemRole(item) === "user" && prev && itemRole(prev) === "user" && item.text === prev.text) {
      (prev as any)._repeat = ((prev as any)._repeat ?? 1) + 1;
      continue;
    }
    meaningful.push(item);
  }
  const sliced = meaningful.slice(-40);
  const stats = digestStats(items); // counts raw items
  const metaParts: string[] = [];
  if (s?.model) metaParts.push(`🧠 ${esc(s.model.providerID)}/${esc(s.model.id)}${s.model.variant ? ` (${esc(s.model.variant)})` : ""}`);
  if (s?.directory) metaParts.push(`📁 ${esc(s.directory.split("/").filter(Boolean).pop() ?? s.directory)}`);
  metaParts.push(`💬 ${stats.users}👤 · ${stats.assistants}🤖 · 🔧 ${stats.tools}`);
  if (stats.compactions) metaParts.push(`📦 ${stats.compactions}`);

  const header = [
    `<h3>${esc(opts.title)}</h3>`,
    `<p><i>${metaParts.join(" · ")}</i></p>`,
    opts.note ? `<p><i>${esc(opts.note)}</i></p>` : "",
  ].filter(Boolean).join("\n");

  if (!meaningful.length) {
    return [{ html: `${header}\n\n<p><i>No hay contexto todavía: envía el primer mensaje.</i></p>`, keyboard }];
  }

  const rendered = sliced.map(renderItem).filter(Boolean);
  const recentCount = Math.min(6, rendered.length);
  const recent = rendered.slice(-recentCount);
  const older = rendered.slice(0, Math.max(0, rendered.length - recentCount));
  const olderPreviews = sliced.slice(0, Math.max(0, sliced.length - recentCount))
    .map(previewOf)
    .filter((line) => line.trim());

  const parts: DigestPart[] = [];
  // First part: header + as many recent messages as fit.
  let current = header;
  for (const block of recent) {
    if (current.length + block.length + 2 > PART_BUDGET && current !== header) {
      parts.push({ html: current, keyboard });
      current = `<b>${esc(opts.title)}</b> <i>(continúa)</i>`;
    }
    current += `\n\n<hr/>\n\n${block}`;
  }
  if (olderPreviews.length) {
    const timeline = `<hr/>\n<blockquote expandable>📚 <b>Mensajes anteriores</b> (${olderPreviews.length})\n${esc(
      olderPreviews.slice(-120).join("\n"),
    )}</blockquote>`;
    if (current.length + timeline.length + 2 <= PART_BUDGET) {
      current += `\n\n${timeline}`;
    } else {
      parts.push({ html: current, keyboard });
      current = `<b>${esc(opts.title)}</b> <i>(continúa)</i>\n\n${timeline}`;
    }
  }
  parts.push({ html: current, keyboard });
  return parts;
}
