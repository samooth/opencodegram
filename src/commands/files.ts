import { resolve } from "node:path";
import type { BotDeps, SendFn } from "../context.js";
import { createZipArchive, fileErrorMessage, formatBytes, prepareDocument, treeDirectory } from "../files/index.js";
import { esc, threadOpts } from "../util.js";
import { ctx } from "./shared.js";
import { parseListArgs, parseFindArgs, parseReadArgs } from "./sessions.js";

export async function cmd_file(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/file" || text.startsWith("/file ")) {
    const rawPath = text.slice("/file".length).trim();
    if (!rawPath) {
      await send("usage: /file <path> (relative to the session directory)");
      return true;
    }
    const s = await C.restoreActiveSession(chatId, threadId);
    const base = resolve(s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd());
    try {
      const doc = await prepareDocument(base, rawPath);
      const progress = await C.tg.sendRichMessage(chatId, `📎 Sending <b>${esc(doc.name)}</b> (${formatBytes(doc.size)})…`, threadOpts(threadId));
      try {
        await C.tg.sendDocument(
          chatId,
          doc.absolute,
          doc.name,
          `<b>${esc(doc.name)}</b>\n<code>${esc(doc.relative || doc.name)}</code>\n${formatBytes(doc.size)}`,
          { ...threadOpts(threadId), parse_mode: "HTML" },
        );
      } finally {
        await C.tg.deleteMessage(chatId, progress.message_id).catch(() => {});
      }
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_ls(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/ls" || text.startsWith("/ls ")) {
    const { path, hidden } = parseListArgs(text.slice(3).trim());
    try {
      await C.files.showListing(chatId, threadId, path, { hidden });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_find(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/find" || text.startsWith("/find ")) {
    const { query, hidden } = parseFindArgs(text.slice(5).trim());
    if (!query) {
      await send("usage: /find <text> [-a]");
      return true;
    }
    try {
      await C.files.showFind(chatId, threadId, query, { hidden });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_zip(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/zip" || text.startsWith("/zip ")) {
    const rawPath = text.slice("/zip".length).trim() || ".";
    const s = await C.restoreActiveSession(chatId, threadId);
    const base = resolve(s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd());
    let archive: Awaited<ReturnType<typeof createZipArchive>> | undefined;
    const progress = await C.tg.sendRichMessage(chatId, "🗜 Creating archive…", threadOpts(threadId));
    try {
      archive = await createZipArchive(base, rawPath);
      await C.tg.editRichMessage(chatId, progress.message_id, `📎 Sending <b>${esc(archive.name)}</b> (${formatBytes(archive.size)})…`, threadOpts(threadId)).catch(() => {});
      await C.tg.sendDocument(
        chatId,
        archive.absolute,
        archive.name,
        `<b>${esc(archive.name)}</b>\n<code>${esc(rawPath)}</code>\n${formatBytes(archive.size)}`,
        { ...threadOpts(threadId), parse_mode: "HTML" },
      );
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    } finally {
      await archive?.cleanup();
      await C.tg.deleteMessage(chatId, progress.message_id).catch(() => {});
    }
    return true;
  }
  return false;
}

export async function cmd_read(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/read" || text.startsWith("/read ")) {
    const raw = text.slice(5).trim();
    if (!raw) {
      await send("usage: /read <path> [start_line | summary]");
      return true;
    }
    if (raw.toLowerCase().endsWith(" summary")) {
      const path = raw.slice(0, -8).trim();
      try {
        await C.files.showSummary(chatId, threadId, path);
      } catch (err) {
        await send(`❌ ${esc(fileErrorMessage(err))}`);
      }
      return true;
    }
    const grepMatch = raw.match(/^(.*?)\s+grep\s+(.+)$/is);
    if (grepMatch && grepMatch[1].trim() && grepMatch[2].trim()) {
      const path = grepMatch[1].trim();
      const pattern = grepMatch[2].trim();
      try {
        await C.files.showSearch(chatId, threadId, path, pattern);
      } catch (err) {
        await send(`❌ ${esc(fileErrorMessage(err))}`);
      }
      return true;
    }
    const { path, startLine } = parseReadArgs(raw);
    try {
      await C.files.showFile(chatId, threadId, path, { startLine, maxLines: C.settings.get(chatId).previewLines });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_tree(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/tree" || text.startsWith("/tree ")) {
    const raw = text.slice(5).trim();
    const [pathPart, depthPart] = raw.split(/\s+/);
    const path = pathPart || ".";
    const depth = depthPart ? parseInt(depthPart, 10) : 3;
    const base = (await (async () => {
      const s = await C.restoreActiveSession(chatId, threadId);
      return s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    })());
    try {
      const t = await treeDirectory(base, path, Number.isFinite(depth) ? depth : 3);
      const body = t.lines.slice(0, 200).map((l) => esc(l)).join("\n");
      await send(`<b>🌳 ${esc(t.relative || ".")}</b>\n<pre>${body}</pre>`);
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

