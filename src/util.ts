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

const PROJECT_EMOJIS = ["🔵", "🟢", "🟡", "🟠", "🔴", "🟣", "🟤", "⚪", "⬛", "🔷", "🔶", "⏹️", "⏹", "⏹", "⏹"];

export function projectEmoji(directory?: string): string {
  if (!directory) return "📁";
  let hash = 0;
  for (let i = 0; i < directory.length; i++) hash = (hash * 31 + directory.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % PROJECT_EMOJIS.length;
  return PROJECT_EMOJIS[idx];
}

export function projectLabel(directory?: string): string {
  if (!directory) return "";
  const name = directory.split("/").filter(Boolean).pop() ?? directory;
  return `${projectEmoji(directory)} ${name}`;
}

export function colorDiff(diff: string): string {
  return diff
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return `<b>${esc(line)}</b>`;
      }
      if (line.startsWith("+")) {
        return `<b>${esc(line)}</b>`;
      }
      if (line.startsWith("-")) {
        return `<s>${esc(line)}</s>`;
      }
      if (line.startsWith("@@")) {
        return `<i>${esc(line)}</i>`;
      }
      if (line.startsWith("diff ") || line.startsWith("index ")) {
        return `<b>${esc(line)}</b>`;
      }
      return esc(line);
    })
    .join("\n");
}

export function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBuf: string[] = [];
  let inTable = false;
  let tableBuf: string[] = [];

  const flushTable = () => {
    if (!tableBuf.length) return;
    // Render table as monospace pre (Telegram has no <table>).
    const rows = tableBuf.filter((l) => /[A-Za-z0-9]/.test(l));
    const text = rows.map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()).join("  │  ")).join("\n");
    out.push(`<pre>${esc(text)}</pre>`);
    tableBuf = [];
    inTable = false;
  };

  const flushCode = () => {
    if (!codeBuf.length) return;
    out.push(`<pre>${esc(codeBuf.join("\n"))}</pre>`);
    codeBuf = [];
    inCodeBlock = false;
  };

  const inline = (s: string): string => {
    s = esc(s);
    // code spans
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    // bold
    s = s.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<b>${c}</b>`);
    // italic
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, (_, pre, c) => `${pre}<i>${c}</i>`);
    // links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
    return s;
  };

  // We'll escape plain text per-line instead of global to preserve tags.
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) flushCode();
      else inCodeBlock = true;
      continue;
    }
    if (inCodeBlock) {
      codeBuf.push(line);
      continue;
    }
    // table detection
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!inTable) {
        // flush previous blank? just push
        inTable = true;
      }
      tableBuf.push(line);
      continue;
    } else if (inTable) {
      flushTable();
    }

    const trimmed = line.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }
    // headers
    const h = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (h) {
      out.push(`<b>${esc(h[2])}</b>`);
      continue;
    }
    // horizontal rule
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      out.push("────────────");
      continue;
    }
    // bullet list
    const bullet = trimmed.match(/^[-*+]\s+(.+)/);
    if (bullet) {
      out.push(`• ${inline(bullet[1])}`);
      continue;
    }
    // numbered list
    const num = trimmed.match(/^\d+\.\s+(.+)/);
    if (num) {
      out.push(`• ${inline(num[1])}`);
      continue;
    }
    // blockquote
    const bq = trimmed.match(/^>\s*(.*)/);
    if (bq) {
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
      continue;
    }
    out.push(inline(line));
  }
  if (inCodeBlock) flushCode();
  if (inTable) flushTable();
  return out.join("\n");
}
