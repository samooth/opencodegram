export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Clamp a string for Telegram (max 4096 chars) without splitting mid-entity. */
export function clampText(s: string, max = 3900): string {
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function threadOpts(threadId?: number): Record<string, unknown> {
  return threadId ? { message_thread_id: threadId } : {};
}

export type ParsedSlashCommand = {
  name: string;
  args: string;
};

/** Strip `/cmd@bot` and `@bot` mentions while preserving the rest of the text. */
export function normalizeCommandText(text: string, botUsername?: string): string {
  let normalized = text.trim();
  normalized = normalized.replace(/^\/([a-zA-Z0-9_-]+)@\w+/, "/$1");
  if (botUsername) {
    normalized = normalized.replace(new RegExp("@" + escapeRegExp(botUsername), "gi"), "").trim();
  }
  return normalized;
}

/** Parse a leading slash command. Returns null for plain prompts. */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = text.trim().match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rate limits recover at :15 of the next hour. If we are already past that
 * mark, wait for the following hour.
 */
export function rateLimitRetryAt(now: Date = new Date()): Date {
  const retry = new Date(now);
  if (now.getMinutes() < 15) {
    retry.setMinutes(15, 0, 0);
  } else {
    retry.setHours(retry.getHours() + 1, 15, 0, 0);
  }
  return retry;
}

export function detailsBlock(summary: string, body: string, open = false): string {
  return `<details${open ? " open" : ""}><summary>${summary}</summary>\n<pre>${esc(body)}</pre>\n</details>`;
}
