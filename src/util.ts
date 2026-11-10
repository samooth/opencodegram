export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Clamp a string for Telegram (max 4096 chars) without splitting mid-entity. */
export function clampText(s: string, max = 3900): string {
  if (s.length <= max) return s;
  let cut = max;
  // Avoid splitting a UTF-16 surrogate pair.
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + "\n…";
}

/** Defensive hygiene for rich message content sent as permanent/final messages. */
export function sanitizeFinalRichHtml(html: string): string {
  // <tg-thinking> is draft-only; never allow it in finals.
  return html.replace(/<tg-thinking\b[^>]*>[\s\S]*?<\/tg-thinking>/gi, "").replace(/<tg-thinking\b[^>]*\/>/gi, "");
}

/** Clamp to a safe rich-message size (Bot API rich limit is larger, but 3900 is safe for edits/sends). */
export function clampRichHtml(html: string, max = 3900): string {
  return clampText(sanitizeFinalRichHtml(html), max);
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
  const name = match[1].toLowerCase();
  // `/btw` is not a bot command: let it pass through to OpenCode as a prompt.
  if (name === "btw") return null;
  return { name, args: (match[2] ?? "").trim() };
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
  return `<blockquote${open ? "" : " expandable"}>${summary}\n<pre>${esc(body)}</pre></blockquote>`;
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

export function sessionHeader(session?: { sessionId?: string; topicTitle?: string; directory?: string } | null, fallbackId?: string): string {
  const sid = (session?.sessionId ?? fallbackId ?? "").trim();
  if (!sid) return "";
  let name = (session?.topicTitle ?? "").trim();
  if (!name && session?.directory) name = session.directory.split("/").filter(Boolean).pop() || "";
  if (!name) name = sid.slice(0, 16);
  const short = sid.slice(0, 8);
  return `📌 <b>${esc(name)}</b> · <code>${esc(short)}</code>\n`;
}

export function toolIcon(name: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("read")) return "📖";
  if (n.includes("webfetch") || n.includes("fetch") || n.includes("http")) return "🌐";
  if (n.includes("grep") || n.includes("search") || n.includes("find")) return "🔍";
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) return "✏️";
  if (n.includes("shell") || n.includes("bash") || n === "sh") return "🖥";
  if (n.includes("ls") || n.includes("list")) return "📂";
  if (n.includes("zip") || n.includes("archive")) return "📦";
  if (n.includes("diff")) return "🧾";
  if (n.includes("context")) return "🧠";
  if (n.includes("compact")) return "📦";
  if (n.includes("fork") || n.includes("session")) return "🔀";
  if (n.includes("model")) return "🤖";
  if (n.includes("form")) return "📋";
  if (n.includes("mcp")) return "🔌";
  return "🔧";
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
  let codeLang = "";
  let inTable = false;
  let tableBuf: string[] = [];
  let inList = false;
  let listType = "ul";
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (!paraBuf.length) return;
    out.push(paraBuf.join("\n"));
    paraBuf = [];
  };
  const flushList = () => {
    if (!inList) return;
    out.push(listType === "ol" ? "</ol>" : "</ul>");
    inList = false;
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.filter((l) => !/^\s*[|\-: ]+\s*$/.test(l) || /[A-Za-z0-9]/.test(l));
    // remove pure separator rows
    const dataRows = rows.filter((l) => /[A-Za-z0-9]/.test(l));
    if (!dataRows.length) { tableBuf = []; inTable = false; return; }
    const parsed = dataRows.map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
    const header = parsed[0];
    const body = parsed.slice(1);
    const ths = header.map((c) => `<th>${inline(c)}</th>`).join("");
    const trs = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
    out.push(`<table><tr>${ths}</tr>${trs}</table>`);
    tableBuf = [];
    inTable = false;
  };
  const flushCode = () => {
    if (!codeBuf.length) return;
    const lang = codeLang ? ` language="${esc(codeLang)}"` : "";
    out.push(`<pre><code${lang}>${esc(codeBuf.join("\n"))}</code></pre>`);
    codeBuf = [];
    inCodeBlock = false;
    codeLang = "";
  };

  const inline = (s: string): string => {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<b>${c}</b>`);
    s = s.replace(/__([^_]+)__/g, (_, c) => `<b>${c}</b>`);
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, (_, pre, c) => `${pre}<i>${c}</i>`);
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g, (_, pre, c) => `${pre}<i>${c}</i>`);
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
      const url = String(u).trim();
      if (!/^(https?:|mailto:|tg:)/i.test(url)) return `${t}`;
      return `<a href="${url.replace(/"/g, "&quot;")}">${t}</a>`;
    });
    return s;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushPara(); flushList(); flushTable();
      if (inCodeBlock) flushCode();
      else {
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuf.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      if (!inTable) inTable = true;
      tableBuf.push(line);
      continue;
    } else if (inTable) {
      flushTable();
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushPara(); flushList();
      out.push("");
      continue;
    }
    const h = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (h) {
      flushPara(); flushList();
      const size = h[1].length;
      out.push(`<h${size}>${inline(h[2])}</h${size}>`);
      continue;
    }
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      flushPara(); flushList();
      out.push("<hr/>");
      continue;
    }
    const bullet = trimmed.match(/^[-*+]\s+(.+)/);
    if (bullet) {
      flushPara();
      if (!inList) { out.push("<ul>"); inList = true; listType = "ul"; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const num = trimmed.match(/^\d+\.\s+(.+)/);
    if (num) {
      flushPara();
      if (!inList) { out.push("<ol>"); inList = true; listType = "ol"; }
      out.push(`<li>${inline(num[1])}</li>`);
      continue;
    }
    const bq = trimmed.match(/^>\s*(.*)/);
    if (bq) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
      continue;
    }
    flushList();
    paraBuf.push(inline(line));
  }
  flushPara();
  if (inCodeBlock) flushCode();
  if (inTable) flushTable();
  flushList();
  return out.join("\n");
}
