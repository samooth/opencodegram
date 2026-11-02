import { basename, join } from "node:path";
import type { Config } from "./config.js";
import {
  FileAccessError,
  fileErrorMessage,
  findFiles,
  formatBytes,
  listDirectory,
  prepareDocument,
  readTextFile,
  searchTextFile,
  summarizeFile,
  renderFileSummary,
  type FileEntry,
  type ReadResult,
  type SearchResult,
  type FileSummary,
} from "./files.js";
import type { TelegramCallbackQuery, TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { ChatSettings } from "./settings.js";
import { esc, threadOpts } from "./util.js";

export type FileBrowserDeps = {
  tg: TelegramClient;
  config: Config;
  getActiveSession: (chatId: number, threadId?: number) => ChatSession | undefined;
  getSettings?: (chatId: number, threadId?: number) => ChatSettings;
};

type ListingView = {
  kind: "listing";
  chatId: number;
  threadId?: number;
  base: string;
  dir: string;
  hidden: boolean;
  entries: FileEntry[];
  page: number;
  total: number;
  truncated: boolean;
};

type FindView = {
  kind: "find";
  chatId: number;
  threadId?: number;
  base: string;
  query: string;
  hidden: boolean;
  entries: FileEntry[];
  page: number;
  scanned: number;
  truncated: boolean;
};

type FileView = {
  kind: "file";
  chatId: number;
  threadId?: number;
  base: string;
  path: string;
  read: ReadResult;
  back?: BrowseView;
};

type SummaryView = {
  kind: "summary";
  chatId: number;
  threadId?: number;
  base: string;
  path: string;
  summary: FileSummary;
  back?: BrowseView;
};

type SearchView = {
  kind: "search";
  chatId: number;
  threadId?: number;
  base: string;
  path: string;
  result: SearchResult;
  back?: BrowseView;
};

type BrowseView = ListingView | FindView;
type View = BrowseView | FileView | SummaryView | SearchView;

const PAGE_SIZE = 12;
const MAX_CACHED_VIEWS = 120;

export type FileBrowser = ReturnType<typeof createFileBrowser>;

export function createFileBrowser({ tg, config, getActiveSession, getSettings }: FileBrowserDeps) {
  // Buttons reference indexes into the listing attached to their own message.
  // Keying by message_id keeps old messages functional when a new /ls arrives.
  const views = new Map<string, View>();

  function baseFor(chatId: number, threadId?: number): string {
    const session = getActiveSession(chatId, threadId);
    return session?.directory ?? config.OPENCODE_DIRECTORY ?? process.cwd();
  }

  function remember(chatId: number, messageId: number, view: View): void {
    views.set(`${chatId}:${messageId}`, view);
    while (views.size > MAX_CACHED_VIEWS) {
      const oldest = views.keys().next().value;
      if (oldest === undefined) break;
      views.delete(oldest);
    }
  }

  async function sendOrEdit(
    chatId: number,
    threadId: number | undefined,
    messageId: number | undefined,
    html: string,
    keyboard: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number | undefined> {
    const opts = { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } };
    if (messageId) {
      try {
        await tg.editRichMessage(chatId, messageId, html, opts);
        return messageId;
      } catch (err) {
        console.error("[files] edit failed", err);
      }
    }
    try {
      const sent = await tg.sendRichMessage(chatId, html, opts);
      return sent?.message_id;
    } catch (err) {
      console.error("[files] send failed", err);
      return undefined;
    }
  }

  async function render(view: View, messageId?: number): Promise<number | undefined> {
    const html = view.kind === "file" ? renderFile(view) : view.kind === "find" ? renderFind(view) : view.kind === "summary" ? renderSummary(view) : view.kind === "search" ? renderSearch(view) : renderListing(view);
    const keyboard = view.kind === "file" ? fileKeyboard(view) : view.kind === "find" ? findKeyboard(view) : view.kind === "summary" ? summaryKeyboard(view) : view.kind === "search" ? searchKeyboard(view) : listingKeyboard(view);
    const id = await sendOrEdit(view.chatId, view.threadId, messageId, html, keyboard);
    if (id !== undefined) remember(view.chatId, id, view);
    return id;
  }

  /** Send a file from the browser as a Telegram document. */
  async function sendAsDocument(chatId: number, threadId: number | undefined, base: string, path: string, note?: string): Promise<void> {
    const doc = await prepareDocument(base, path);
    const caption = [
      `<b>${esc(doc.name)}</b>`,
      `<code>${esc(doc.relative || doc.name)}</code>`,
      formatBytes(doc.size),
      note ? `<i>${esc(note)}</i>` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const progress = await tg.sendRichMessage(chatId, `📎 Sending <b>${esc(doc.name)}</b> (${formatBytes(doc.size)})…`, threadOpts(threadId));
    try {
      await tg.sendDocument(chatId, doc.absolute, doc.name, caption, { ...threadOpts(threadId), parse_mode: "HTML" });
    } finally {
      await tg.deleteMessage(chatId, progress.message_id).catch(() => {});
    }
  }

  async function showListing(
    chatId: number,
    threadId: number | undefined,
    path = "",
    options: { hidden?: boolean; page?: number; messageId?: number; base?: string } = {},
  ): Promise<void> {
    const base = options.base ?? baseFor(chatId, threadId);
    const hidden = options.hidden ?? false;
    const listing = await listDirectory(base, path, { includeHidden: hidden });
    const page = clampPage(options.page ?? 0, listing.total);
    const view: ListingView = {
      kind: "listing",
      chatId,
      threadId,
      base: listing.base,
      dir: listing.path,
      hidden,
      entries: listing.entries,
      page,
      total: listing.total,
      truncated: listing.truncated,
    };
    await render(view, options.messageId);
  }

  async function showFind(
    chatId: number,
    threadId: number | undefined,
    query: string,
    options: { hidden?: boolean; page?: number; messageId?: number; base?: string } = {},
  ): Promise<void> {
    const base = options.base ?? baseFor(chatId, threadId);
    const hidden = options.hidden ?? false;
    const found = await findFiles(base, query, { includeHidden: hidden, limit: 100 });
    const page = clampPage(options.page ?? 0, found.entries.length);
    const view: FindView = {
      kind: "find",
      chatId,
      threadId,
      base: found.base,
      query: query.trim(),
      hidden,
      entries: found.entries,
      page,
      scanned: found.scanned,
      truncated: found.truncated,
    };
    await render(view, options.messageId);
  }

  async function showFile(
    chatId: number,
    threadId: number | undefined,
    path: string,
    options: { startLine?: number; maxLines?: number; messageId?: number; back?: BrowseView; base?: string; forcePreview?: boolean } = {},
  ): Promise<void> {
    const base = options.base ?? baseFor(chatId, threadId);
    const settings = getSettings?.(chatId, threadId);
    const maxLines = Math.max(10, Math.min(500, options.maxLines ?? settings?.previewLines ?? 160));
    let read: ReadResult;
    try {
      read = await readTextFile(base, path, { startLine: options.startLine ?? 1, maxLines });
    } catch (err) {
      // A binary file cannot be previewed; deliver it as a document instead.
      if (err instanceof FileAccessError && err.code === "binary") {
        await sendAsDocument(chatId, threadId, base, path, "Binary file sent as a document.");
        return;
      }
      throw err;
    }
    // For large/truncated files, show an automatic structural summary instead
    // of a (truncated) preview, with a button to view the raw preview.
    if (read.truncated && !options.forcePreview) {
      await showSummary(chatId, threadId, path, { messageId: options.messageId, back: options.back, base });
      return;
    }
    const view: FileView = {
      kind: "file",
      chatId,
      threadId,
      base: read.base,
      path: read.relative,
      read,
      back: options.back,
    };
    await render(view, options.messageId);
  }

  async function showSummary(
    chatId: number,
    threadId: number | undefined,
    path: string,
    options: { messageId?: number; back?: BrowseView; base?: string } = {},
  ): Promise<void> {
    const base = options.base ?? baseFor(chatId, threadId);
    let summary: FileSummary;
    try {
      summary = await summarizeFile(base, path);
    } catch (err) {
      if (err instanceof FileAccessError && err.code === "binary") {
        await sendAsDocument(chatId, threadId, base, path, "Binary file sent as a document.");
        return;
      }
      throw err;
    }
    const view: SummaryView = {
      kind: "summary",
      chatId,
      threadId,
      base: summary.path.startsWith(base) ? base : base,
      path: summary.relative,
      summary,
      back: options.back,
    };
    const text = renderFileSummary(summary);
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    // Per-symbol peek buttons (first 8) to jump to that line.
    const syms = summary.symbols.slice(0, 8);
    for (let i = 0; i < syms.length; i += 2) {
      const row: Array<{ text: string; callback_data: string }> = [];
      for (let j = i; j < Math.min(i + 2, syms.length); j++) {
        const sym = syms[j];
        row.push({ text: `${sym.name.slice(0, 16)} (L${sym.line})`, callback_data: `fs:peek:${sym.line}` });
      }
      keyboard.push(row);
    }
    keyboard.push([{ text: "📄 Ver preview", callback_data: "fs:preview" }]);
    keyboard.push([{ text: "📎 Enviar documento", callback_data: "fs:send" }]);
    if (view.back) keyboard.push([{ text: "⬆ Back", callback_data: "fs:u" }]);
    keyboard.push([{ text: "📂 Browse root", callback_data: "fs:r" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    const sentId = await sendOrEdit(chatId, threadId, options.messageId, text, keyboard);
    if (sentId !== undefined) views.set(`${chatId}:${sentId}`, view);
  }

  function renderSummary(view: SummaryView): string {
    return renderFileSummary(view.summary);
  }

  function renderSearch(view: SearchView): string {
    const r = view.result;
    const lines: string[] = [];
    lines.push(`<b>🔎 ${esc(r.relative)}</b>`);
    lines.push(`<i>${r.totalMatches} match(es) for <code>${esc(r.pattern)}</code>${r.truncated ? " (truncated)" : ""}</i>`);
    lines.push("");
    if (!r.matches.length) lines.push("<i>no matches</i>");
    else for (const m of r.matches) lines.push(`<code>${String(m.line).padStart(4, " ")}</code> │ ${esc(m.text)}`);
    return lines.join("\n");
  }

  function summaryKeyboard(view: SummaryView): Array<Array<{ text: string; callback_data: string }>> {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
      [{ text: "📄 Ver preview", callback_data: "fs:preview" }],
      [{ text: "📎 Enviar documento", callback_data: "fs:send" }],
    ];
    if (view.back) keyboard.push([{ text: "⬆ Back", callback_data: "fs:u" }]);
    keyboard.push([{ text: "📂 Browse root", callback_data: "fs:r" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    return keyboard;
  }

  async function showSearch(
    chatId: number,
    threadId: number | undefined,
    path: string,
    pattern: string,
    options: { messageId?: number; back?: BrowseView; base?: string } = {},
  ): Promise<void> {
    const base = options.base ?? baseFor(chatId, threadId);
    const result = await searchTextFile(base, path, pattern);
    const view: SearchView = { kind: "search", chatId, threadId, base, path: result.relative, result, back: options.back };
    const lines: string[] = [];
    lines.push(`<b>🔎 ${esc(result.relative)}</b>`);
    lines.push(`<i>${result.totalMatches} match(es) for <code>${esc(result.pattern)}</code>${result.truncated ? " (truncated)" : ""}</i>`);
    lines.push("");
    if (!result.matches.length) {
      lines.push("<i>no matches</i>");
    } else {
      for (const m of result.matches) {
        lines.push(`<code>${String(m.line).padStart(4, " ")}</code> │ ${esc(m.text)}`);
      }
      if (result.totalMatches > result.matches.length) {
        lines.push(`… y ${result.totalMatches - result.matches.length} más`);
      }
    }
    const text = lines.join("\n");
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    if (view.back) keyboard.push([{ text: "⬆ Back", callback_data: "fs:u" }]);
    keyboard.push([{ text: "📂 Browse root", callback_data: "fs:r" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    const sentId = await sendOrEdit(chatId, threadId, options.messageId, text, keyboard);
    if (sentId !== undefined) views.set(`${chatId}:${sentId}`, view);
  }

  function searchKeyboard(view: SearchView): Array<Array<{ text: string; callback_data: string }>> {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    if (view.back) keyboard.push([{ text: "⬆ Back", callback_data: "fs:u" }]);
    keyboard.push([{ text: "📂 Browse root", callback_data: "fs:r" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    return keyboard;
  }

  function renderListing(view: ListingView): string {
    const start = view.page * PAGE_SIZE;
    const slice = view.entries.slice(start, start + PAGE_SIZE);
    const absolute = view.dir ? join(view.base, view.dir) : view.base;
    const rows = slice
      .map((entry) => {
        const size = entry.type === "directory" ? "—" : entry.type === "symlink" ? "external" : formatBytes(entry.size);
        return `<tr><td>${entryIcon(entry)}</td><td><b>${esc(truncateText(entry.name, 80))}</b></td><td>${size}</td><td>${formatDate(entry.mtime)}</td></tr>`;
      })
      .join("");
    const table = slice.length
      ? `<table><tr><th>Type</th><th>Name</th><th>Size</th><th>Modified</th></tr>${rows}</table>`
      : "<i>(empty directory)</i>";
    const meta = [
      `${view.total} entries`,
      view.hidden ? "hidden visible" : "",
      view.truncated ? "listing truncated" : "",
      view.total > PAGE_SIZE ? `page ${view.page + 1}/${Math.ceil(view.total / PAGE_SIZE)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `<b>📂 ${esc(view.dir || ".")}</b>\n<code>${esc(absolute)}</code>\n<i>${esc(meta)}</i>\n\n${table}`;
  }

  function listingKeyboard(view: ListingView): Array<Array<{ text: string; callback_data: string }>> {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    const start = view.page * PAGE_SIZE;
    const slice = view.entries.slice(start, start + PAGE_SIZE);
    slice.forEach((entry, index) => {
      const callbackIndex = start + index;
      const label = `${entryIcon(entry)} ${entry.name}`.slice(0, 60);
      const row = [{ text: label, callback_data: `fs:e:${callbackIndex}` }];
      if (entry.type === "file" && !entry.external) {
        row.push({ text: "📎 Send", callback_data: `fs:d:${callbackIndex}` });
      }
      keyboard.push(row);
    });

    const nav: Array<{ text: string; callback_data: string }> = [];
    if (view.page > 0) nav.push({ text: "◀ Prev", callback_data: `fs:p:${view.page - 1}` });
    if (start + PAGE_SIZE < view.total) nav.push({ text: "Next ▶", callback_data: `fs:p:${view.page + 1}` });
    if (nav.length) keyboard.push(nav);

    if (view.dir) {
      const crumbs: Array<{ text: string; callback_data: string }> = [{ text: "🏠", callback_data: "fs:cd:" }];
      let cumulative = "";
      for (const segment of view.dir.split("/").filter(Boolean)) {
        cumulative = cumulative ? `${cumulative}/${segment}` : segment;
        const callbackData = `fs:cd:${cumulative}`;
        if (callbackData.length <= 64) crumbs.push({ text: `📂 ${segment}`.slice(0, 18), callback_data: callbackData });
      }
      if (crumbs.length > 1) keyboard.push(crumbs);
    }

    const actions: Array<{ text: string; callback_data: string }> = [];
    if (view.dir) actions.push({ text: "⬆ Up", callback_data: "fs:u" });
    if (view.dir) actions.push({ text: "📂 Root", callback_data: "fs:r" });
    actions.push({ text: "🏠 Panel", callback_data: "panel:home" });
    keyboard.push(actions);
    return keyboard;
  }

  function renderFind(view: FindView): string {
    const start = view.page * PAGE_SIZE;
    const slice = view.entries.slice(start, start + PAGE_SIZE);
    const rows = slice
      .map((entry) => {
        const size = entry.type === "directory" ? "—" : formatBytes(entry.size);
        return `<tr><td>${entryIcon(entry)}</td><td><code>${esc(truncateText(entry.path, 100))}</code></td><td>${size}</td></tr>`;
      })
      .join("");
    const table = slice.length
      ? `<table><tr><th>Type</th><th>Path</th><th>Size</th></tr>${rows}</table>`
      : "<i>no matches</i>";
    const meta = [
      `${view.entries.length} matches`,
      `scanned ${view.scanned}`,
      view.hidden ? "hidden visible" : "",
      view.truncated ? "limited" : "",
      view.entries.length > PAGE_SIZE ? `page ${view.page + 1}/${Math.ceil(view.entries.length / PAGE_SIZE)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `<b>🔎 ${esc(view.query)}</b>\n<code>${esc(view.base)}</code>\n<i>${esc(meta)}</i>\n\n${table}`;
  }

  function findKeyboard(view: FindView): Array<Array<{ text: string; callback_data: string }>> {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    const start = view.page * PAGE_SIZE;
    const slice = view.entries.slice(start, start + PAGE_SIZE);
    slice.forEach((entry, index) => {
      const callbackIndex = start + index;
      const label = `${entryIcon(entry)} ${entry.path}`.slice(0, 60);
      const row = [{ text: label, callback_data: `fs:e:${callbackIndex}` }];
      if (entry.type === "file" && !entry.external) {
        row.push({ text: "📎 Send", callback_data: `fs:d:${callbackIndex}` });
      }
      keyboard.push(row);
    });
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (view.page > 0) nav.push({ text: "◀ Prev", callback_data: `fs:p:${view.page - 1}` });
    if (start + PAGE_SIZE < view.entries.length) nav.push({ text: "Next ▶", callback_data: `fs:p:${view.page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([
      { text: "📂 Browse root", callback_data: "fs:r" },
      { text: "🏠 Panel", callback_data: "panel:home" },
    ]);
    return keyboard;
  }

  function renderFile(view: FileView): string {
    const read = view.read;
    const width = String(read.endLine).length;
    const lines = read.text.split("\n");
    const numbered = lines.map((line, index) => `${String(read.startLine + index).padStart(width, " ")} │ ${line}`).join("\n");
    const preview = fitPreview(numbered, 3500);
    const escapedPreview = escapeAndFit(preview, 3700);
    const previewCut = preview !== numbered || escapedPreview !== esc(preview);
    const meta = [
      formatBytes(read.size),
      `lines ${read.startLine}-${read.endLine}${read.totalLines !== undefined ? ` of ${read.totalLines}` : ""}`,
      read.truncated || previewCut ? "preview truncated" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return [
      `<b>📄 ${esc(basename(view.path) || view.path)}</b>`,
      `<code>${esc(view.path || ".")}</code>`,
      `<i>${esc(meta)}</i>`,
      "",
      `<pre><code>${escapedPreview || "(empty file)"}</code></pre>`,
    ].join("\n");
  }

  function fileKeyboard(view: FileView): Array<Array<{ text: string; callback_data: string }>> {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
      [{ text: "📎 Send as document", callback_data: "fs:send" }],
    ];
    if (view.back) {
      keyboard.push([{ text: "⬆ Back", callback_data: "fs:u" }]);
    } else {
      keyboard.push([{ text: "📂 Browse root", callback_data: "fs:r" }]);
    }
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    return keyboard;
  }

  async function openEntry(view: BrowseView, index: number, messageId: number, callbackId: string): Promise<void> {
    const entry = view.entries[index];
    if (!entry) {
      await tg.answerCallbackQuery(callbackId, "Listing expired; run /ls again").catch(() => {});
      return;
    }
    if (entry.external) {
      await tg.answerCallbackQuery(callbackId, "This symlink points outside the session directory").catch(() => {});
      return;
    }
    await tg.answerCallbackQuery(callbackId).catch(() => {});
    if (entry.type === "directory") {
      await showListing(view.chatId, view.threadId, entry.path, {
        hidden: view.kind === "listing" ? view.hidden : false,
        messageId,
        base: view.base,
      });
      return;
    }
    await showFile(view.chatId, view.threadId, entry.path, { messageId, back: view, base: view.base });
  }

  async function handleCallback(cq: TelegramCallbackQuery): Promise<boolean> {
    const data = cq.data ?? "";
    if (!data.startsWith("fs:")) return false;

    const chatId = cq.message?.chat?.id;
    if (!chatId) {
      await tg.answerCallbackQuery(cq.id, "Missing chat").catch(() => {});
      return true;
    }
    const threadId = cq.message?.message_thread_id;
    const messageId = cq.message?.message_id;
    const view = messageId !== undefined ? views.get(`${chatId}:${messageId}`) : undefined;

    const resolveKey = (value: string): string | undefined => {
      const prefixes = ["fs:cd:", "fs:d:", "fs:p:", "fs:e:", "fs:peek:"];
      for (const prefix of prefixes) {
        if (value.startsWith(prefix)) return prefix;
      }
      if (value === "fs:r" || value === "fs:send" || value === "fs:u" || value === "fs:preview" || value === "fs:summary") return value;
      return undefined;
    };

    type FsHandler = (
      view: View | undefined,
      chatId: number,
      threadId: number | undefined,
      messageId: number | undefined,
      cq: TelegramCallbackQuery,
      data: string,
    ) => Promise<boolean>;

    const handlers: Record<string, FsHandler> = {
      "fs:cd:": async (view, chatId, threadId, messageId, cq, data) => {
        const target = data.slice(6);
        await tg.answerCallbackQuery(cq.id).catch(() => {});
        await showListing(chatId, threadId, target, { messageId, base: view?.base });
        return true;
      },
      "fs:r": async (view, chatId, threadId, messageId, cq) => {
        await tg.answerCallbackQuery(cq.id).catch(() => {});
        await showListing(chatId, threadId, "", { messageId, base: view?.base });
        return true;
      },
      "fs:send": async (view, chatId, threadId, _messageId, cq) => {
        if (!view || (view.kind !== "file" && view.kind !== "summary")) {
          await tg.answerCallbackQuery(cq.id, "Expired; run /ls again").catch(() => {});
          return true;
        }
        await tg.answerCallbackQuery(cq.id, "Sending…").catch(() => {});
        await sendAsDocument(chatId, threadId, view.base, view.path);
        return true;
      },
      "fs:preview": async (view, chatId, threadId, messageId, cq) => {
        if (!view || view.kind !== "summary") {
          await tg.answerCallbackQuery(cq.id, "Expired; run /ls again").catch(() => {});
          return true;
        }
        await tg.answerCallbackQuery(cq.id).catch(() => {});
        await showFile(chatId, threadId, view.path, { messageId, back: view.back, base: view.base, maxLines: 160, forcePreview: true });
        return true;
      },
      "fs:peek:": async (view, chatId, threadId, messageId, cq, data) => {
        const peekMatch = data.match(/^fs:peek:(\d+)$/);
        if (!peekMatch) {
          await tg.answerCallbackQuery(cq.id, "Unknown file action").catch(() => {});
          return true;
        }
        if (!view || view.kind !== "summary") {
          await tg.answerCallbackQuery(cq.id, "Expired; run /ls again").catch(() => {});
          return true;
        }
        const line = parseInt(peekMatch[1], 10);
        await tg.answerCallbackQuery(cq.id).catch(() => {});
        await showFile(chatId, threadId, view.path, { messageId, back: view.back, base: view.base, startLine: line, maxLines: 40, forcePreview: true });
        return true;
      },
      "fs:u": async (view, chatId, threadId, messageId, cq) => {
        if (!view) {
          await tg.answerCallbackQuery(cq.id, "Expired; run /ls again").catch(() => {});
          return true;
        }
        if (view.kind === "file" || view.kind === "summary") {
          if (!view.back) {
            await tg.answerCallbackQuery(cq.id, "No previous listing").catch(() => {});
            return true;
          }
          await tg.answerCallbackQuery(cq.id).catch(() => {});
          await render(view.back, messageId);
          return true;
        }
        if (view.kind === "search") {
          if (!view.back) {
            await tg.answerCallbackQuery(cq.id, "No previous listing").catch(() => {});
            return true;
          }
          await tg.answerCallbackQuery(cq.id).catch(() => {});
          await render(view.back, messageId);
          return true;
        }
        if (view.kind === "find") {
          await tg.answerCallbackQuery(cq.id).catch(() => {});
          await showListing(chatId, threadId, "", { messageId, hidden: view.hidden, base: view.base });
          return true;
        }
        if (!view.dir) {
          await tg.answerCallbackQuery(cq.id, "Already at the root").catch(() => {});
          return true;
        }
        const parent = parentPath(view.dir);
        await tg.answerCallbackQuery(cq.id).catch(() => {});
        await showListing(chatId, threadId, parent, { messageId, hidden: view.hidden, base: view.base });
        return true;
      },
      "fs:d:": async (view, chatId, threadId, _messageId, cq, data) => {
        const downloadMatch = data.match(/^fs:d:(\d+)$/);
        if (!downloadMatch) {
          await tg.answerCallbackQuery(cq.id, "Unknown file action").catch(() => {});
          return true;
        }
        if (!view || view.kind === "file" || view.kind === "summary" || view.kind === "search") {
          await tg.answerCallbackQuery(cq.id, "Expired; run /ls again").catch(() => {});
          return true;
        }
        const entry = view.entries[parseInt(downloadMatch[1], 10)];
        if (!entry) {
          await tg.answerCallbackQuery(cq.id, "Listing expired; run /ls again").catch(() => {});
          return true;
        }
        if (entry.external) {
          await tg.answerCallbackQuery(cq.id, "This symlink points outside the session directory").catch(() => {});
          return true;
        }
        if (entry.type !== "file") {
          await tg.answerCallbackQuery(cq.id, "That entry is not a file").catch(() => {});
          return true;
        }
        await tg.answerCallbackQuery(cq.id, "Sending…").catch(() => {});
        await sendAsDocument(chatId, threadId, view.base, entry.path);
        return true;
      },
      "fs:p:": async (view, chatId, threadId, messageId, cq, data) => {
        const pageMatch = data.match(/^fs:p:(\d+)$/);
        if (!pageMatch) {
          await tg.answerCallbackQuery(cq.id, "Unknown file action").catch(() => {});
          return true;
        }
        if (!view || view.kind === "file" || view.kind === "summary" || view.kind === "search") {
          await tg.answerCallbackQuery(cq.id, "Expired; run /ls again").catch(() => {});
          return true;
        }
        const page = clampPage(parseInt(pageMatch[1], 10), view.kind === "find" ? view.entries.length : view.total);
        await tg.answerCallbackQuery(cq.id).catch(() => {});
        await render({ ...view, page }, messageId);
        return true;
      },
      "fs:e:": async (view, chatId, threadId, messageId, cq, data) => {
        const entryMatch = data.match(/^fs:e:(\d+)$/);
        if (!entryMatch) {
          await tg.answerCallbackQuery(cq.id, "Unknown file action").catch(() => {});
          return true;
        }
        if (!view || view.kind === "file" || view.kind === "summary" || view.kind === "search") {
          await tg.answerCallbackQuery(cq.id, "Expired; run /ls again").catch(() => {});
          return true;
        }
        if (messageId === undefined) {
          await tg.answerCallbackQuery(cq.id, "Expired; run /ls again").catch(() => {});
          return true;
        }
        await openEntry(view, parseInt(entryMatch[1], 10), messageId, cq.id);
        return true;
      },
      "fs:summary": async (_view, _chatId, _threadId, _messageId, cq) => {
        await tg.answerCallbackQuery(cq.id, "Unknown file action").catch(() => {});
        return true;
      },
    };

    try {
      const key = resolveKey(data);
      const handler = key ? handlers[key] : undefined;
      if (handler) {
        return await handler(view, chatId, threadId, messageId, cq, data);
      }
      await tg.answerCallbackQuery(cq.id, "Unknown file action").catch(() => {});
      return true;
    } catch (err) {
      console.error("[files] callback failed", err);
      await tg.answerCallbackQuery(cq.id, truncateText(fileErrorMessage(err), 180)).catch(() => {});
      await tg.sendRichMessage(chatId, `❌ ${esc(fileErrorMessage(err))}`, threadOpts(threadId)).catch(() => {});
      return true;
    }
  }

    return { showListing, showFind, showFile, showSummary, showSearch, handleCallback };
}

function entryIcon(entry: FileEntry): string {
  if (entry.external) return "🔗";
  if (entry.type === "directory") return "📁";
  if (entry.type === "symlink") return "🔗";
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const icons: Record<string, string> = {
    c: "🔧", cc: "🔧", cpp: "🔧", h: "🔧", hpp: "🔧", rs: "🦀", go: "🐹",
    js: "📜", ts: "📜", jsx: "📜", tsx: "📜", json: "🧩", yaml: "🧩", yml: "🧩", toml: "🧩",
    md: "📝", txt: "📝", log: "📝",
    png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", svg: "🖼", webp: "🖼",
    mp3: "🎵", wav: "🎵", ogg: "🎵", flac: "🎵",
    mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬", webm: "🎬",
    zip: "📦", tar: "📦", gz: "📦", tgz: "📦", "7z": "📦",
    pdf: "📕", html: "🌐", css: "🎨",
    sh: "⚙️", py: "🐍",
  };
  return icons[ext] ?? "📄";
}

function formatDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function clampPage(page: number, total: number): number {
  const last = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  if (!Number.isFinite(page)) return 0;
  return Math.max(0, Math.min(Math.floor(page), last));
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function fitPreview(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n…";
}

/** Escape a preview and truncate without cutting an HTML entity in half. */
function escapeAndFit(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    const piece = esc(char);
    if (out.length + piece.length > max) return out + "\n…";
    out += piece;
  }
  return out;
}
