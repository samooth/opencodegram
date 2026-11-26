import { logger } from "./logger.js";
import { isDangerousCommand } from "./dangerous.js";
import { buildGlobalAllowed } from "./permissions.js";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BotDeps, SendFn } from "./context.js";
import type { Config } from "./config.js";
import type { SettingsStore } from "./settings.js";
import type { TelegramClient, TelegramMessage } from "./telegram.js";
import { handleCommand, KNOWN_COMMANDS } from "./commands.js";
import { clampText, esc, normalizeCommandText, parseSlashCommand, sessionHeader, threadOpts } from "./util.js";
import { transcribeFileStreaming, isTranscriptionEnabled } from "./transcribe.js";
import type { ChatSession } from "./types.js";
import { cancelAutoRetry, notePromptSent } from "./autoretry.js";
import { clearRetryNotice, noteTelegramPrompt } from "./events.js";
import { STATUS_EDIT_INTERVAL_MS } from "./constants.js";
import { dtrace } from "./debuglog.js";

/**
 * Result of downloading a Telegram message's attachments.
 */
export type DownloadedAttachments = {
  mediaToAttach: Array<{ uri: string; name: string; source?: { type: string; uri: string } }>;
  voiceAttachments: Array<{ uri: string; name: string }>;
  voiceTranscript: string | null;
};

/**
 * Download all attachments of a Telegram message into /tmp/opencode/attachments.
 * Performs voice transcription when enabled. Throws on download failure.
 */
export async function downloadAttachments(
  config: Config,
  tg: TelegramClient,
  chatId: number,
  msg: TelegramMessage,
  opts?: { threadId?: number; settings?: SettingsStore; send?: SendFn },
): Promise<DownloadedAttachments> {
  const threadId = opts?.threadId;
  const settings = opts?.settings;
  const send: SendFn =
    opts?.send ??
    ((html: string, o: Record<string, unknown> = {}) =>
      tg.sendRichMessage(chatId, html, { ...(threadId ? { message_thread_id: threadId } : {}), ...o }));

  let mediaToAttach: Array<{ uri: string; name: string; source?: { type: string; uri: string } }> = [];
  const voiceAttachments: Array<{ uri: string; name: string }> = [];
  // Downloaded attachments are handed to OpenCode as file:// URIs. Keep only
  // known-safe extensions; anything else (executables, scripts, unknown) is
  // stored as .bin so it can never be mistaken for something runnable.
  const SAFE_ATTACHMENT_EXT = new Set([
    "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "toml", "xml", "html", "htm", "css",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "rtf", "epub",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "heic",
    "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "webm", "mp4", "mov", "avi", "mkv",
    "zip", "gz", "tar", "bz2", "xz", "7z", "tgz",
    "log", "patch", "diff", "sql", "proto", "graphql", "ipynb",
  ]);
  const safeAttachmentName = (raw: string, fileId: string): string => {
    let name = basename(raw).replace(/[\0-\x1f\x7f]/g, "").slice(0, 120);
    if (!name || name === "." || name === "..") return `${fileId}.bin`;
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (!SAFE_ATTACHMENT_EXT.has(ext)) {
      name = `${name.slice(0, dot > 0 ? dot : name.length)}.bin`;
    }
    return name;
  };
  const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
  const downloadOne = async (fileId: string, suggestedName: string) => {
    const info = await tg.getFile(fileId);
    if (!info.file_path) throw new Error("Telegram did not return a file path");
    if (typeof info.file_size === "number" && info.file_size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`File too large (${info.file_size} bytes; limit ${MAX_DOWNLOAD_BYTES})`);
    }
    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${info.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > MAX_DOWNLOAD_BYTES) throw new Error("File too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error("File too large");
    const dir = join("/tmp/opencode/attachments", String(chatId));
    await mkdir(dir, { recursive: true });
    const rawName = suggestedName || info.file_path.split("/").pop() || `${fileId}.bin`;
    const name = safeAttachmentName(rawName, fileId);
    const path = join(dir, name);
    await writeFile(path, buf);
    return { uri: `file://${path}`, name, source: { type: "uri", uri: `file://${path}` } };
  };

  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    mediaToAttach.push(await downloadOne(largest.file_id, `photo_${largest.file_unique_id}.jpg`));
  }
  if (msg.document) {
    mediaToAttach.push(await downloadOne(msg.document.file_id, msg.document.file_name ?? `document_${msg.document.file_unique_id}`));
  }
  if (msg.audio) {
    const audioAttachment = await downloadOne(msg.audio.file_id, msg.audio.file_name ?? `audio_${msg.audio.file_unique_id}.mp3`);
    mediaToAttach.push(audioAttachment);
    voiceAttachments.push(audioAttachment);
  }
  if (msg.voice) {
    const voiceAttachment = await downloadOne(msg.voice.file_id, `voice_${msg.voice.file_unique_id}.ogg`);
    mediaToAttach.push(voiceAttachment);
    voiceAttachments.push(voiceAttachment);
  }
  if (msg.video) {
    mediaToAttach.push(await downloadOne(msg.video.file_id, msg.video.file_name ?? `video_${msg.video.file_unique_id}.mp4`));
  }

  let voiceTranscript: string | null = null;
  const voiceTranscriptionEnabled = settings ? settings.get(chatId).voiceTranscription : true;
  if (voiceAttachments.length && isTranscriptionEnabled(config) && voiceTranscriptionEnabled) {
    const progressMsg = await send("🎤 Transcribing voice note…") as { message_id?: number } | undefined;
    try {
      const transcripts: string[] = [];
      for (const attachment of voiceAttachments) {
        const filePath = attachment.uri.replace(/^file:\/\//, "");
        const transcript = await transcribeFileStreaming(filePath, config, async (partial) => {
          if (progressMsg?.message_id) {
            const text = `🎤 Transcribiendo…\n<blockquote>${esc(clampText(partial, 3500))}</blockquote>`;
            await tg.editRichMessage(chatId, progressMsg.message_id, text, { parse_mode: "HTML" }).catch(logger.ignore("messages", "voice progress edit"));
          }
        });
        if (transcript) transcripts.push(transcript);
      }
      if (transcripts.length) {
        voiceTranscript = transcripts.join("\n\n");
        if (progressMsg?.message_id) {
          await tg.editRichMessage(chatId, progressMsg.message_id, `📝 Transcript:\n${clampText(voiceTranscript, 3500)}`, { parse_mode: "HTML" }).catch(logger.ignore("messages", "voice transcript edit"));
        } else {
          await send(`📝 Transcript:\n${clampText(voiceTranscript, 3500)}`);
        }
        const voiceNames = new Set(voiceAttachments.map((attachment) => attachment.name));
        mediaToAttach = mediaToAttach.filter((attachment) => !voiceNames.has(attachment.name));
        if (!mediaToAttach.length) {
          // Fall through to the normal text prompt path with the transcript.
          msg.text = voiceTranscript;
        }
      }
    } catch (err) {
      console.warn("[transcribe] failed", String(err));
      await send(`❌ Transcription failed: ${esc(String(err))}; sending audio as attachment.`);
    }
  }

  return { mediaToAttach, voiceAttachments, voiceTranscript };
}

/**
 * Outcome of resolving the session for a message.
 * - `session`: the session that must receive the message.
 * - `asked`: true when the user was asked to pick a session (group with
 *   several candidates), so the caller must not print "No hay sesión activa".
 */
export type SessionResolution = { session?: ChatSession; asked?: boolean };

/**
 * Find, restore or create the session that should receive a message.
 * Returns undefined when the tab has no session and none can be created.
 */


const PICKER_PAGE_SIZE = 8;

export async function showSessionPicker(
  deps: BotDeps,
  chatId: number,
  threadId: number | undefined,
  page: number,
): Promise<void> {
  const { store, tg, oc } = deps;
  const candidates = [...store.activeSessionByRoute.entries()]
    .filter(([k]) => k.startsWith(`${chatId}:`))
    .map(([, sid]) => sid);
  const unique = [...new Set(candidates)].filter((sid) => store.findSessionById(sid));
  // Order by most recent interaction (newest first). Fall back to the session's
  // prompt start time when the route has no recorded interaction.
  const recency = (sid: string): number => {
    let at = store.findSessionById(sid)?.promptStartTime ?? 0;
    for (const [key, value] of store.lastInteractedSessionByRoute) {
      if (key.startsWith(`${chatId}:`) && value.sessionId === sid && value.at > at) at = value.at;
    }
    return at;
  };
  unique.sort((a, b) => recency(b) - recency(a));
  if (!unique.length) {
    await tg.sendRichMessage(chatId, "🤖 <b>No hay sesiones activas en este grupo.</b>", threadOpts(threadId)).catch(() => {});
    return;
  }
  const total = unique.length;
  const totalPages = Math.max(1, Math.ceil(total / PICKER_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = unique.slice(p * PICKER_PAGE_SIZE, (p + 1) * PICKER_PAGE_SIZE);

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const sid of slice) {
    const cs = store.findSessionById(sid);
    let title = cs?.topicTitle ?? cs?.directory?.split("/").pop();
    if (!title) {
      try {
        const sess = await oc.client.session.get({ sessionID: sid }) as { title?: string; location?: { directory?: string }; directory?: string };
        if (sess?.title) title = sess.title;
        if (!title) {
          const d = sess?.location?.directory ?? sess?.directory;
          if (d) title = d.split("/").filter(Boolean).pop();
        }
      } catch { /* ignore */ }
    }
    title = (title ?? sid.slice(0, 12)).slice(0, 40);
    rows.push([{ text: title, callback_data: `use:${sid}` }]);
  }

  if (totalPages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (p > 0) nav.push({ text: "◀", callback_data: `spick:${p - 1}` });
    nav.push({ text: `${p + 1}/${totalPages}`, callback_data: `spick:${p}` });
    if (p < totalPages - 1) nav.push({ text: "▶", callback_data: `spick:${p + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: "➕ Nueva sesión", callback_data: "panel:new" }, { text: "📂 Sesiones", callback_data: "panel:sessions" }]);

  await tg.sendRichMessage(
    chatId,
    `🤖 <h3>¿A qué sesión respondo?</h3>\n<p><i>${total} sesiones activas. Elige una.</i></p>`,
    { ...threadOpts(threadId), reply_markup: { inline_keyboard: rows } },
  ).catch(() => {});
}


async function resolveSessionForMessage(
  deps: BotDeps,
  chatId: number,
  replyThread: number | undefined,
  repliedSessionId: string | undefined,
  rawText: string,
  pending?: { text: string; files?: Array<{ uri: string; name: string }> },
  isReplyToBot?: boolean,
): Promise<SessionResolution> {
  const { store, sessions, me, tg } = deps;
  const { ensureActiveSession, createNewSession, restoreActiveSession, activateSession } = sessions;

  // 1) Reply to a bot message that belongs to a session -> route to that session.
  if (repliedSessionId) {
    const active = store.getActiveSession(chatId, replyThread);
    if (active?.sessionId === repliedSessionId) return { session: active };
    try {
      await activateSession(chatId, repliedSessionId, true, replyThread);
      const resolved = await restoreActiveSession(chatId, replyThread);
      if (resolved) {
        deps.sessionTrace?.("route.reply", { chatId, threadId: replyThread, sessionId: repliedSessionId });
        return { session: resolved };
      }
    } catch (err) {
      console.error("[reply] activate related session failed", repliedSessionId, err);
    }
    // Fallback to in-memory session if activation couldn't switch route cleanly.
    const inMem = store.findSessionById(repliedSessionId);
    if (inMem) return { session: inMem };
    // The replied session is gone (deleted/archived): say so instead of
    // pretending this is an ambiguous group message (which would show the
    // "¿a qué sesión respondo?" picker and lose the reply context).
    await tg
      .sendRichMessage(
        chatId,
        `⚠️ <b>La sesión del mensaje contestado ya no está disponible</b> (<code>${esc(repliedSessionId.slice(0, 12))}</code>).\n<i>Puede estar archivada o borrada. Usa /sessions para ver las activas.</i>`,
        { ...threadOpts(replyThread), reply_markup: { inline_keyboard: [[{ text: "📂 Sesiones", callback_data: "panel:sessions" }]] } },
      )
      .catch(() => {});
    deps.sessionTrace?.("route.reply.missing", { chatId, threadId: replyThread, sessionId: repliedSessionId });
    return { asked: true };
  }

  // 2) Active session for this exact route.
  // When replying to a bot message, do not auto-create a session if none is
  // bound: the reply should route to the replied session (or show the picker),
  // not silently spawn a new one.
  if (!isReplyToBot) {
    const ensured = await ensureActiveSession(chatId, replyThread);
    if (ensured) {
      deps.sessionTrace?.("route.active", { chatId, threadId: replyThread, sessionId: ensured.sessionId });
      return { session: ensured };
    }
  }

  // 3) In groups, prefer the last session the user interacted with IN THIS
  // THREAD. Never guess across the whole chat when replying to an unmapped bot
  // message: doing so steals the route from whichever session was live in the
  // thread and detaches it, leaving two cards "active" at the same time.
  if (chatId < 0) {
    if (!isReplyToBot) {
      const last = store.getLastInteractedSession(chatId, replyThread);
      if (last) {
        try {
          await activateSession(chatId, last, true, replyThread);
          const s = await restoreActiveSession(chatId, replyThread);
          if (s) return { session: s };
        } catch (err) {
          console.error("[reply] activate last-interacted failed", last, err);
        }
      }
    }
    const candidates = [...store.activeSessionByRoute.entries()]
      .filter(([k]) => k.startsWith(`${chatId}:`))
      .map(([, sid]) => sid);
    // The current thread's binding is the strongest candidate for a reply.
    if (isReplyToBot && replyThread !== undefined) {
      const bound = store.activeSessionByRoute.get(store.routeKey(chatId, replyThread));
      if (bound && store.findSessionById(bound) && !candidates.includes(bound)) candidates.unshift(bound);
    }
    const unique = [...new Set(candidates)].filter((sid) => store.findSessionById(sid));
    if (unique.length === 1) {
      try {
        await activateSession(chatId, unique[0], true, replyThread);
        const s = await restoreActiveSession(chatId, replyThread);
        if (s) return { session: s };
      } catch (err) {
        console.error("[reply] single-candidate activate failed", unique[0], err);
      }
    }
    if (unique.length > 1) {
      // Several sessions live in this group: let the user pick instead of
      // guessing, and remember the pending message to send afterwards.
      const route = store.routeKey(chatId, replyThread);
      if (pending) deps.pendingGroupPrompts.set(route, { ...pending, at: Date.now() });
      deps.sessionTrace?.("route.picker", { chatId, threadId: replyThread, candidates: unique.length });
      await showSessionPicker(deps, chatId, replyThread, 0);
      return { asked: true };
    }
  }

  const isMention = chatId < 0 && !!me.username && rawText.toLowerCase().includes("@" + me.username.toLowerCase());
  // A reply to a bot message must never silently spawn a new session,
  // even if the user also mentioned the bot in their reply text.
  if (!isReplyToBot && (chatId >= 0 || isMention)) {
    await createNewSession(chatId, true, replyThread);
    const s = await restoreActiveSession(chatId, replyThread);
    return { session: s };
  }
  return {};
}

/**
 * Mark the session busy, start the status card and dispatch the prompt.
 * Errors are reported in the same tab without rejecting the caller.
 */
/** Report a prompt/turn error with a model-switch button when it looks like a limit. */
async function reportPromptError(
  deps: BotDeps,
  chatId: number,
  s: ChatSession,
  text: string,
  send: SendFn,
): Promise<void> {
  const errMsg = String(text);
  const isLimit = /limit|usage|quota|provider|subscribe|free/i.test(errMsg);
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [[
    { text: "🧠 Cambiar modelo", callback_data: `panel:ms:${s.sessionId}` },
    { text: "📂 Sesiones", callback_data: "panel:sessions" },
  ]];
  const opts = isLimit
    ? { ...deps.store.threadOptsFor(s), reply_markup: { inline_keyboard: keyboard } }
    : deps.store.threadOptsFor(s);
  const sent = await send(`${sessionHeader(s)}❌ ${esc(errMsg)}`, opts) as { message_id?: number } | undefined;
  if (sent?.message_id) deps.store.rememberMessageSession(chatId, sent.message_id, s.sessionId);
}

async function startPrompt(
  deps: BotDeps,
  chatId: number,
  replyThread: number | undefined,
  s: ChatSession,
  text: string,
  send: SendFn,
  files?: Array<{ uri: string; name: string }>,
): Promise<void> {
  const { oc, store, status } = deps;
  const { startStatus, updateStatus, finishStatus } = status;
  try {
    // Do NOT cancel an in-progress turn here: OpenCode serialises prompts per
    // session and emits one text.ended per prompt. Cancelling made each new
    // prompt discard the previous turn's answer (the user saw "no response").
    s.targetChatId = chatId;
    s.targetThreadId = replyThread;
    s.lastFinalMessageId = undefined;
    s.lastFinalSentAt = undefined;
    s.lastFinalDeliveredPromptStart = undefined;
    s.lastFinalSeparatedPromptStart = undefined;
    s.textEndedHandled = undefined;
    s.sentArtifacts = new Set();
    store.rememberSessionChat(s.sessionId, chatId);
    store.rememberActiveRoute(chatId, replyThread, s.sessionId);
    store.rememberLastInteracted(chatId, replyThread, s.sessionId);
    // Events for this turn must be delivered here, even if the session is
    // also reachable from another chat/topic.
    deps.store.rememberDelivery(s.sessionId, chatId, replyThread);
    s.promptStartTime = Date.now();
    store.rememberLastChat(s.sessionId, chatId);
    store.rememberLastPrompt(s.sessionId, text);
    deps.sessionTrace?.("prompt.dispatch", { sessionId: s.sessionId, chatId, replyThread, len: text.length });
    notePromptSent(s.sessionId, text);
    // A manual prompt supersedes any pending auto-retry: cancel it and drop its
    // notice message so the new turn does not race with a stale retry (which
    // used to duplicate the previous turn and interleave the rate-limit warning).
    cancelAutoRetry(s.sessionId);
    clearRetryNotice(s.sessionId);
    // Mark this prompt as ours so its inbox.enqueued echo is not shown as TUI.
    noteTelegramPrompt(s.sessionId, text);
    await startStatus(chatId, s);
    if (s.statusMessageId) store.rememberMessageSession(chatId, s.statusMessageId, s.sessionId);
    s.statusTimer = setInterval(() => {
      updateStatus(chatId, s).catch((err) => logger.warn("messages", "status update failed", String(err)));
    }, STATUS_EDIT_INTERVAL_MS);
    void oc.prompt(s.sessionId, text, files).catch(async (err) => {
      if (s.statusTimer) {
        clearInterval(s.statusTimer);
        s.statusTimer = undefined;
      }
      await finishStatus(chatId, s).catch((err) => logger.warn("messages", "finishStatus failed", String(err)));
      await reportPromptError(deps, chatId, s, String(err), send);
    });
  } catch (err) {
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    await finishStatus(chatId, s).catch((err) => logger.warn("messages", "finishStatus failed", String(err)));
    await reportPromptError(deps, chatId, s, String(err), send);
  }
}

/**
 * A text/media message from Telegram: gate it, download attachments, handle
 * commands, or forward it to the session bound to this tab as a prompt.
 */
// Simple per-user rate limiter: max N messages per minute.
const userMessageTimes = new Map<number, number[]>();
let lastCleanup = 0;
/** How long a "add user" capture stays armed. */
const PERMISSION_ADD_TTL_MS = 5 * 60_000;

function isRateLimited(userId: number, limit: number): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const times = userMessageTimes.get(userId) ?? [];
  const recent = times.filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    userMessageTimes.set(userId, recent);
    return true;
  }
  recent.push(now);
  userMessageTimes.set(userId, recent);
  return false;
}

export async function handleMessage(deps: BotDeps, msg: TelegramMessage): Promise<void> {
  const { config, tg, oc, store, me } = deps;
  dtrace("msg", "enter", { telegramMsgId: msg.message_id, chatId: msg.chat.id, threadId: msg.message_thread_id, userId: msg.from?.id, textLen: (msg.text ?? msg.caption ?? "").length });
  const { routeKey } = store;

  const userId = msg.from?.id;
  // Ignore the bot's own messages and service-only updates (topic created,
  // pinned, etc.) which have no text/caption/media and would otherwise be
  // processed as prompts or rejected as "Not authorized".
  if (userId !== undefined && me?.id !== undefined && userId === me.id) return;
  // Periodic cleanup of in-memory pending stores (B5/B6/B7).
  const now = Date.now();
  if (now - lastCleanup > 60_000) {
    lastCleanup = now;
    for (const [k, v] of deps.pendingConfirmations ?? []) if (v.expires < now) deps.pendingConfirmations.delete(k);
    for (const [k, v] of deps.pendingGroupPrompts ?? []) if (now - v.at > 10 * 60_000) deps.pendingGroupPrompts.delete(k);
    for (const [k, v] of deps.awaitingPermissionAdd ?? []) if (now - v.at > PERMISSION_ADD_TTL_MS) deps.awaitingPermissionAdd?.delete(k);
    if (userMessageTimes.size > 1000) {
      const cutoff = now - 60_000;
      for (const [uid, times] of userMessageTimes) {
        const recent = times.filter((t) => t > cutoff);
        if (!recent.length) userMessageTimes.delete(uid);
        else userMessageTimes.set(uid, recent);
      }
    }
  }
  // Per-user rate limit (opt-in via USER_RATE_LIMIT_ENABLED). The global admin
  // is exempt: it must always be able to drive the bot, even under load.
  const isAdmin = userId !== undefined && config.ADMIN_TELEGRAM_USER_ID !== undefined && userId === config.ADMIN_TELEGRAM_USER_ID;
  if (config.USER_RATE_LIMIT_ENABLED && !isAdmin && userId !== undefined && isRateLimited(userId, config.USER_RATE_LIMIT_PER_MINUTE)) {
    if (msg.chat.id < 0) return;
    await tg.sendRichMessage(msg.chat.id, "⏳ Too many messages. Please slow down.");
    return;
  }
  const hasContent = !!(msg.text ?? msg.caption ?? msg.photo ?? msg.document ?? msg.audio ?? msg.voice ?? msg.video);
  const serviceMsg = msg as typeof msg & { forum_topic_created?: unknown; forum_topic_edited?: unknown; forum_topic_closed?: unknown; pinned_message?: unknown };
  const isService = !!(serviceMsg.forum_topic_created || serviceMsg.forum_topic_edited || serviceMsg.forum_topic_closed || serviceMsg.pinned_message);
  if (isService && !hasContent) return;
  const chatId = msg.chat.id;
  const replyThread = msg.message_thread_id;
  const globalAllowed = buildGlobalAllowed(deps.config);
  const isAuthorized = deps.permissions
    ? deps.permissions.canPrompt(deps.store.routeKey(chatId, replyThread), userId, globalAllowed)
    : (globalAllowed.size > 0 && userId !== undefined && globalAllowed.has(userId));
  dtrace("msg", "auth", { telegramMsgId: msg.message_id, chatId, threadId: replyThread, isAuthorized });
  if (!isAuthorized) {
    // In groups, silently ignore unauthorized messages.
    if (msg.chat.id < 0) return;
    await tg.sendRichMessage(msg.chat.id, "Not authorized.");
    return;
  }
  // Learn usernames only AFTER authorization: nobody outside the allowlist may
  // seed or overwrite the @name -> ID map used by the permission UI.
  if (userId !== undefined && msg.from?.username) deps.permissions?.rememberUser(userId, msg.from.username);
  const replyFrom = msg.reply_to_message?.from as { id: number; username?: string } | undefined;
  if (replyFrom?.id !== undefined && replyFrom.username) {
    deps.permissions?.rememberUser(replyFrom.id, replyFrom.username);
  }

  // Pending auto-retries are cancelled in startPrompt() for the DESTINATION
  // session only. Cancelling every session here made an unrelated message (or
  // a command, or a message in another chat) silently kill a retry that was
  // still waiting on a 429 backoff, leaving that user without an answer.
  // Replying to any bot message routes the prompt to the session that produced
  // it: explicit map first, then dashboard/status/in-memory card fallbacks.
  const replyMessageId = msg.reply_to_message?.message_id;
  let repliedSessionId = replyMessageId ? store.findSessionByAnyMessage(chatId, replyMessageId, replyThread) : undefined;
  // Fallback: if the replied bot message was never mapped, try to recover
  // the session from a session id embedded in its text (cards/digests include
  // "ses_..." in their header). This keeps replies routing to the right
  // session instead of showing the "which session?" picker.
  if (!repliedSessionId && replyMessageId) {
    const replied = msg.reply_to_message as { text?: unknown; caption?: unknown } | undefined;
    const repliedText = ((replied?.text ?? replied?.caption ?? "") as string).toString();
    // Recover the session from a ses_ id embedded in the replied bot message
    // (cards, digests, final answers and errors all include it in their
    // header). This keeps replies routing to the right session even when the
    // explicit message->session map missed this message.
    const matches = repliedText.match(/ses_[A-Za-z0-9]+/g);
    // Only recover when there is a single session id in the message (avoid
    // mis-routing replies to session lists).
    if (matches && matches.length === 1) {
      const partial = matches[0];
      if (store.findSessionById(partial)) {
        repliedSessionId = partial;
      } else {
        // Cards render only the first 8 chars of the id; resolve it by prefix
        // when exactly one known session matches.
        const known = new Set<string>([...store.sessionsById.keys(), ...store.activeSessionByRoute.values()]);
        const prefixed = [...known].filter((sid) => sid.startsWith(partial));
        if (prefixed.length === 1) repliedSessionId = prefixed[0];
      }
    }
  }
  deps.metrics?.inc("messages");
  // Ignore commands explicitly addressed to another bot.
  const rawText = (msg.text ?? msg.caption ?? "").trim();
  const commandTarget = rawText.match(/^\/[a-zA-Z0-9_-]+@([A-Za-z0-9_]+)/)?.[1];
  if (commandTarget && commandTarget.toLowerCase() !== (me.username ?? "").toLowerCase()) return;
  const isMention = chatId < 0 && !!me.username && rawText.toLowerCase().includes("@" + me.username.toLowerCase());
  const isReplyToBot = chatId < 0 && !!msg.reply_to_message && msg.reply_to_message.from?.id === me.id;
  // Media (photos/documents/audio/...) is more likely to be sent by accident in
  // a group. Only treat it as a prompt when the bot is explicitly mentioned,
  // even if the message happens to reply to a bot message.
  const hasMedia = !!(msg.photo ?? msg.document ?? msg.audio ?? msg.voice ?? msg.video);
  const isPhoto = !!msg.photo;
  // In groups, only respond to commands, mentions or replies to the bot.
  // Photos require an explicit mention (they are often sent by accident);
  // documents/audio/voice/video also work as a reply to the bot.
  if (chatId < 0) {
    const isCommand = rawText.startsWith("/");
    if (hasMedia && isPhoto) {
      if (!isMention) return;
    } else if (hasMedia) {
      if (!isMention && !isReplyToBot) return;
    } else if (!isCommand && !isMention && !isReplyToBot) {
      return;
    }
  }

  const send = (html: string, opts: Record<string, unknown> = {}) => tg.sendRichMessage(chatId, html, { ...(replyThread ? { message_thread_id: replyThread } : {}), ...opts });
  // Reactions are useful as an ack in groups; in private chats they are noise.
  if (chatId < 0) tg.setMessageReaction(chatId, msg.message_id, "👀").catch(() => {});
  tg.sendChatAction(chatId, "typing", replyThread).catch(() => {});
  deps.audit("message", `${userId} ${chatId}: ${(msg.text ?? msg.caption ?? "").slice(0, 120)}`);
  deps.sessionTrace?.("message.audit", { chatId, threadId: replyThread, userId, telegramMsgId: msg.message_id });
  dtrace("msg", "accepted", { telegramMsgId: msg.message_id, chatId, threadId: replyThread });

  // If we are awaiting a rejection reason, handle it.
  const reasonKey = routeKey(chatId, replyThread);
  if (msg.text && deps.awaitingReason.has(reasonKey)) {
    deps.sessionTrace?.("message.consumed", { reason: "awaitingReason", chatId, threadId: replyThread });
    const requestId = deps.awaitingReason.get(reasonKey)!;
    deps.awaitingReason.delete(reasonKey);
    const info = deps.pendingPermissions.get(requestId);
    if (info && !info.decided) {
      info.decided = true;
      const reason = msg.text;
      try {
        await oc.replyPermission(info.sessionId, requestId, "reject");
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      if (info.messageId) {
        await tg
          .editRichMessage(info.chatId, info.messageId, `<b>Permission rejected</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>\nReason: ${esc(reason)}`)
          .catch(() => {});
      }
      deps.pendingPermissions.delete(requestId);
      await send(`Rejected with reason: ${esc(reason)}`);
    }
    return;
  }

  // If we are awaiting a user id for permission add, capture it. The capture
  // belongs to the admin who opened it and expires, so it can never swallow a
  // later message from another person. Slash commands are never captured.
  const permAddKey = routeKey(chatId, replyThread);
  const pendingPermAdd = deps.awaitingPermissionAdd?.get(permAddKey);
  if (msg.text && pendingPermAdd && !msg.text.trim().startsWith("/")) {
    const fresh = Date.now() - pendingPermAdd.at <= PERMISSION_ADD_TTL_MS;
    if (!fresh) {
      deps.awaitingPermissionAdd?.delete(permAddKey);
    } else if (pendingPermAdd.requestedBy !== userId) {
      // Someone else is chatting in the thread: leave the capture for its owner.
    } else {
      deps.sessionTrace?.("message.consumed", { reason: "awaitingPermissionAdd", chatId, threadId: replyThread });
      deps.awaitingPermissionAdd?.delete(permAddKey);
      const parts = msg.text.trim().split(/\s+/);
      const role = parts[1] === "admin" ? "admin" : "operator";
      if (!deps.permissions) { await send("Permisos no disponibles."); return; }
      const globalAdmin = deps.config.ADMIN_TELEGRAM_USER_ID;
      const isAdm = deps.permissions.isAdmin(permAddKey, userId, globalAdmin);
      if (!isAdm) { await send("Solo admin."); return; }
      const id = deps.permissions.resolveUser(parts[0]);
      if (id === undefined) {
        await send(`No conozco a <code>${esc(parts[0])}</code>. Pídele que escriba al bot (o responde a su mensaje) y vuelve a intentarlo, o usa su ID numérico.`);
        return;
      }
      deps.permissions.addUser(permAddKey, id, role);
      await send(`✅ Añadido ${esc(deps.permissions.label(id))} como ${role}.`);
      // Re-show the panel.
      const panel = deps.permissions.renderPanel(permAddKey, globalAdmin);
      await send(panel.html, { reply_markup: { inline_keyboard: panel.keyboard } });
      return;
    }
  }

  // Download attachments.
  let downloadResult: DownloadedAttachments;
  try {
    downloadResult = await downloadAttachments(config, tg, chatId, msg, { threadId: replyThread, settings: deps.settings, send });
  } catch (err) {
    await send(`❌ Could not download attachment: ${esc(String(err))}`);
    return;
  }

  if (downloadResult.mediaToAttach.length) {
    deps.sessionTrace?.("message.consumed", { reason: "media", chatId, threadId: replyThread });
    await handleMediaMessage(deps, msg, chatId, replyThread, repliedSessionId, send, downloadResult);
    return;
  }

  await handleTextMessage(deps, msg, chatId, replyThread, repliedSessionId, send);
}

export async function handleMediaMessage(
  deps: BotDeps,
  msg: TelegramMessage,
  chatId: number,
  replyThread: number | undefined,
  repliedSessionId: string | undefined,
  send: SendFn,
  attachments?: { mediaToAttach: Array<{ uri: string; name: string }>; voiceTranscript: string | null },
): Promise<void> {
  const { config, tg, oc } = deps;

  // Resolve attachments (download if not provided).
  let mediaToAttach: Array<{ uri: string; name: string; source?: { type: string; uri: string } }>;
  let voiceTranscript: string | null;
  if (attachments) {
    mediaToAttach = attachments.mediaToAttach;
    voiceTranscript = attachments.voiceTranscript;
  } else {
    try {
      const res = await downloadAttachments(config, tg, chatId, msg, { threadId: replyThread, settings: deps.settings, send });
      mediaToAttach = res.mediaToAttach;
      voiceTranscript = res.voiceTranscript;
    } catch (err) {
      await send(`❌ Could not download attachment: ${esc(String(err))}`);
      return;
    }
  }
  if (!mediaToAttach.length) return;

  const resolution = await resolveSessionForMessage(
    deps,
    chatId,
    replyThread,
    repliedSessionId,
    (msg.text ?? msg.caption ?? "").trim(),
    { text: (msg.text ?? msg.caption ?? "").trim() || "Analiza este archivo", files: mediaToAttach },
    chatId < 0 && !!msg.reply_to_message && msg.reply_to_message.from?.id === deps.me?.id,
  );
  deps.sessionTrace?.("message.resolved", { chatId, threadId: replyThread, hasSession: !!resolution.session, asked: !!resolution.asked, sessionId: resolution.session?.sessionId });
  const s = resolution.session;
  if (!s) {
    if (resolution.asked) return;
    await send("🤖 <h3>No hay sesión activa</h3>\n<p><i>Crea una nueva o elige una existente para empezar.</i></p>", { reply_markup: { inline_keyboard: [[{ text: "➕ Nueva sesión aquí", callback_data: "panel:new" }, { text: "📂 Sesiones", callback_data: "panel:sessions" }]] } } );
    return;
  }
  // Copy downloaded attachments into the session directory so OpenCode can read
  // them (it only reads files under the session's working directory).
  if (!s.directory) {
    try {
      const res = await oc.client.session.get({ sessionID: s.sessionId }) as { location?: { directory?: string }; directory?: string };
      s.directory = res?.location?.directory ?? res?.directory;
    } catch (err) {
      console.warn("[media] could not resolve session dir", err);
    }
  }
  if (s.directory) {
    const { copyFile, mkdir: mkdirAsync } = await import("node:fs/promises");
    const { basename: bn, join: jn } = await import("node:path");
    await mkdirAsync(s.directory, { recursive: true }).catch((e) => console.warn("[media] mkdir failed", e));
    for (const att of mediaToAttach) {
      const srcPath = att.uri.replace(/^file:\/\//, "");
      const destPath = jn(s.directory, bn(srcPath));
      if (srcPath === destPath) continue; // already in session dir
      try {
        await copyFile(srcPath, destPath);
        att.uri = `file://${destPath}`;
        const withSource = att as typeof att & { source?: { type: string; uri: string } };
        if (withSource.source) withSource.source.uri = `file://${destPath}`;
      } catch (err) {
        console.warn("[media] could not copy to session dir", srcPath, err);
      }
    }
  } else {
    console.warn("[media] no session directory; sending original URIs");
  }
  let text = voiceTranscript
    ? ((msg.caption ?? "").trim() ? `${(msg.caption ?? "").trim()}\n\n${voiceTranscript}` : voiceTranscript)
    : ((msg.caption ?? "").trim() || (msg.photo ? "What is in this image?" : "Analyze this file"));
  // Auto-switch to a vision-capable model if needed.
  if (msg.photo || msg.video) {
    try {
      const res = await oc.client.model.list();
      const list = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[];
      type VisionModel = { id?: string; providerID?: string; capabilities?: { input?: string[] }; variants?: Array<{ id?: string }> };
      const current = (list as VisionModel[]).find((m) => m.id === s.model?.id && m.providerID === s.model?.providerID);
      const supportsImage = Array.isArray(current?.capabilities?.input) && current.capabilities.input.includes("image");
      if (!supportsImage) {
        const visionModel = (list as VisionModel[]).find((m) => Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image"));
        if (visionModel) {
          await oc.switchModel(s.sessionId, { id: visionModel.id!, providerID: visionModel.providerID!, variant: visionModel.variants?.[0]?.id });
          s.model = { id: visionModel.id!, providerID: visionModel.providerID!, variant: visionModel.variants?.[0]?.id };
          await send(`Switched to vision model: <code>${esc(visionModel.providerID!)}/${esc(visionModel.id!)}</code>`);
        }
      }
    } catch {
      // ignore
    }
  }
  // Text attachments: copy into the session directory and reference by
  // relative path in the prompt, so OpenCode reads them with its own tools
  // (more reliable than inlining, and avoids bloating the prompt).
  const TEXT_EXTS = new Set([".md", ".txt", ".json", ".ts", ".js", ".py", ".yaml", ".yml", ".toml", ".csv", ".xml", ".html", ".css", ".sh", ".log"]);
  const { extname: extOf, basename: bnOf } = await import("node:path");
  const refPaths: string[] = [];
  const remaining: typeof mediaToAttach = [];
  for (const att of mediaToAttach) {
    const ext = extOf(att.uri.replace(/^file:\/\//, "")).toLowerCase();
    if (TEXT_EXTS.has(ext) && s.directory) {
      const srcPath = att.uri.replace(/^file:\/\//, "");
      const destPath = (await import("node:path")).join(s.directory, bnOf(srcPath));
      if (srcPath === destPath) {
        // Already in the session directory; just reference it.
        refPaths.push(bnOf(srcPath));
        continue;
      }
      try {
        const { copyFile, mkdir: mkdirAsync } = await import("node:fs/promises");
        await mkdirAsync(s.directory, { recursive: true }).catch(() => {});
        await copyFile(srcPath, destPath);
        refPaths.push(bnOf(srcPath));
        continue;
      } catch (err) {
        console.warn("[media] could not copy text file to session dir", att.name, err);
      }
    }
    remaining.push(att);
  }
  if (refPaths.length) {
    const refs = refPaths.map((r) => `- ${r}`).join("\n");
    text = text + `\n\nArchivos adjuntos (léelos con la herramienta read):\n${refs}`;
  }
  mediaToAttach = remaining;

  await startPrompt(deps, chatId, replyThread, s, text, send, mediaToAttach);
}

export async function handleTextMessage(
  deps: BotDeps,
  msg: TelegramMessage,
  chatId: number,
  replyThread: number | undefined,
  repliedSessionId: string | undefined,
  send: SendFn,
): Promise<void> {
  const { oc, me } = deps;
  const userId = msg.from?.id;

  if (!msg.text) return;
  let text = (msg.text ?? msg.caption ?? "").trim();
  text = normalizeCommandText(text, me.username);

  // Replying to someone with "/permissions add [role]" grants that person the
  // role without having to know their ID or username.
  const permAddReply = text.match(/^\/permissions\s+add\s*(operator|admin)?\s*$/i);
  if (permAddReply && msg.reply_to_message?.from?.id !== undefined) {
    const role = permAddReply[1]?.toLowerCase() === "admin" ? "admin" : "operator";
    text = `/permissions add ${msg.reply_to_message.from.id} ${role}`;
  }

  if (await handleCommand(deps, chatId, replyThread, text, send, userId)) {
    deps.sessionTrace?.("message.consumed", { reason: "command", chatId, threadId: replyThread, text: text.slice(0,30) });
    return;
  }

  // Create or restore the session bound to this tab.
  const rawText = (msg.text ?? msg.caption ?? "").trim();
  const resolution = await resolveSessionForMessage(deps, chatId, replyThread, repliedSessionId, rawText, { text: rawText }, chatId < 0 && !!msg.reply_to_message && msg.reply_to_message.from?.id === me.id);
  deps.sessionTrace?.("message.resolved", { chatId, threadId: replyThread, hasSession: !!resolution.session, asked: !!resolution.asked, sessionId: resolution.session?.sessionId });
  const s = resolution.session;
  if (!s) {
    if (resolution.asked) return;
    await send("🤖 <h3>No hay sesión activa</h3>\n<p><i>Crea una nueva o elige una existente para empezar.</i></p>", { reply_markup: { inline_keyboard: [[{ text: "➕ Nueva sesión aquí", callback_data: "panel:new" }, { text: "📂 Sesiones", callback_data: "panel:sessions" }]] } } );
    return;
  }

  const slash = parseSlashCommand(text);
  if (slash && slash.name !== "btw" && !KNOWN_COMMANDS.has(slash.name)) {
    const name = slash.name;
    const args = slash.args;

    // Dangerous commands require confirmation.
    if (isDangerousCommand(name)) {
      // callback_data is limited to 64 bytes (Bot API §6). Use a short opaque
      // key as the map key; the full session/name/args live in the map value.
      const confirmKey = `rc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      deps.pendingConfirmations = deps.pendingConfirmations ?? new Map();
      deps.pendingConfirmations.set(confirmKey, { sessionId: s.sessionId, name, args, expires: Date.now() + 30_000 });
      await send(`⚠️ <b>Confirm</b>: run <code>/${esc(name)}</code>${args ? " " + esc(args) : ""}?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Run", callback_data: `runcmd:yes:${confirmKey}` }, { text: "❌ Cancel", callback_data: "panel:home" }],
          ],
        },
      });
      return;
    }

    // Pre-filter using cached OpenCode command list.
    try {
      const cmds = await oc.listCommandsCached(s.directory);
      const names = (cmds as Array<{ name?: string; command?: string } | string>).map((c) => String((c as { name?: string })?.name ?? (c as { command?: string })?.command ?? c)).filter(Boolean);
      if (names.length && !names.includes(name)) {
        // fuzzy suggestions
        const lower = name.toLowerCase();
        const suggestions = names.filter((n) => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase().slice(0, 3))).slice(0, 5);
        let msgOut = `❌ <code>/${esc(name)}</code> no es un comando de OpenCode.`;
        if (suggestions.length) msgOut += `\n¿Quisiste decir: ${suggestions.map((x) => `<code>/${esc(x)}</code>`).join(", ")}?`;
        msgOut += `\n\nComandos disponibles: ${names.map((x) => `<code>/${esc(x)}</code>`).join(", ")}.`;
        msgOut += "\n\nSi querías enviarlo como texto, quita el / inicial.";
        await send(msgOut, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "⚡ Commands", callback_data: "panel:commands" },
                { text: "🏠 Panel", callback_data: "panel:home" },
              ],
            ],
          },
        });
        return;
      }
    } catch {
      // If listing fails, fall through to runCommand.
    }

    // Route the command's follow-up responses to the tab where it was sent.
    deps.store.rememberDelivery(s.sessionId, chatId, replyThread);
    try {
      void oc.runCommand(s.sessionId, name, args)
        .then(() => { if (name !== "goal") send(`ran /${esc(name)}`); })
        .catch((err) => {
          const e = String(err);
          const isLimit = /limit|usage|quota|provider|subscribe|free/i.test(e);
          const kb = isLimit
            ? [[{ text: "🧠 Cambiar modelo", callback_data: `panel:ms:${s.sessionId}` }, { text: "📂 Sesiones", callback_data: "panel:sessions" }]]
            : [[{ text: "⚡ Commands", callback_data: "panel:commands" }, { text: "🏠 Panel", callback_data: "panel:home" }]];
          return send(`${sessionHeader(s)}❌ ${esc(e)}\n\nUse /commands to see available commands.`, { reply_markup: { inline_keyboard: kb } });
        });
    } catch (err) {
      await send(`${sessionHeader(s)}❌ ${esc(String(err))}\n\nUse /commands to see available commands.`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "⚡ Commands", callback_data: "panel:commands" },
              { text: "🏠 Panel", callback_data: "panel:home" },
            ],
          ],
        },
      });
    }
    return;
  }

  await startPrompt(deps, chatId, replyThread, s, text, send);
}
