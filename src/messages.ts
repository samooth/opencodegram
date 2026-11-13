import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BotDeps, SendFn } from "./context.js";
import type { Config } from "./config.js";
import type { SettingsStore } from "./settings.js";
import type { TelegramClient, TelegramMessage } from "./telegram.js";
import { handleCommand, KNOWN_COMMANDS } from "./commands.js";
import { clampText, esc, normalizeCommandText, parseSlashCommand, threadOpts } from "./util.js";
import { transcribeFile, isTranscriptionEnabled } from "./transcribe.js";
import type { ChatSession } from "./types.js";
import { notePromptSent } from "./autoretry.js";

/**
 * Result of downloading a Telegram message's attachments.
 */
export type DownloadedAttachments = {
  mediaToAttach: Array<{ uri: string; name: string }>;
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

  let mediaToAttach: Array<{ uri: string; name: string }> = [];
  const voiceAttachments: Array<{ uri: string; name: string }> = [];
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
    const name = basename(rawName).replace(/\0/g, "") || `${fileId}.bin`;
    const path = join(dir, name === "." || name === ".." ? `${fileId}.bin` : name);
    await writeFile(path, buf);
    return { uri: `file://${path}`, name };
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
    await send("🎤 Transcribing voice note…");
    try {
      const transcripts: string[] = [];
      for (const attachment of voiceAttachments) {
        const filePath = attachment.uri.replace(/^file:\/\//, "");
        const transcript = await transcribeFile(filePath, config);
        if (transcript) transcripts.push(transcript);
      }
      if (transcripts.length) {
        voiceTranscript = transcripts.join("\n\n");
        await send(`📝 Transcript:\n${clampText(voiceTranscript, 3500)}`);
        const voiceNames = new Set(voiceAttachments.map((attachment) => attachment.name));
        mediaToAttach = mediaToAttach.filter((attachment) => !voiceNames.has(attachment.name));
        if (!mediaToAttach.length) {
          // Fall through to the normal text prompt path with the transcript.
          msg.text = voiceTranscript;
        }
      }
    } catch (err) {
      await send(`❌ Transcription failed: ${esc(String(err))}; sending audio as attachment.`);
    }
  }

  return { mediaToAttach, voiceAttachments, voiceTranscript };
}

/**
 * Outcome of resolving the session for a message.
 * - `session`: the session that must receive the message.
 * - `asked`: true when the user was asked to pick a session (group with
 *   several candidates), so the caller must not print "no active session".
 */
export type SessionResolution = { session?: ChatSession; asked?: boolean };

/**
 * Find, restore or create the session that should receive a message.
 * Returns undefined when the tab has no session and none can be created.
 */
async function resolveSessionForMessage(
  deps: BotDeps,
  chatId: number,
  replyThread: number | undefined,
  repliedSessionId: string | undefined,
  rawText: string,
  pending?: { text: string; files?: Array<{ uri: string; name: string }> },
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
  const ensured = await ensureActiveSession(chatId, replyThread);
  if (ensured) {
    deps.sessionTrace?.("route.active", { chatId, threadId: replyThread, sessionId: ensured.sessionId });
    return { session: ensured };
  }

  // 3) In groups, prefer the last session the user interacted with.
  if (chatId < 0) {
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
    const candidates = [...store.activeSessionByRoute.entries()]
      .filter(([k]) => k.startsWith(`${chatId}:`))
      .map(([, sid]) => sid);
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
      const keyboard = unique.slice(0, 8).map((sid) => {
        const cs = store.findSessionById(sid);
        const title = (cs?.topicTitle ?? cs?.directory?.split("/").pop() ?? sid).slice(0, 40);
        return [{ text: `💬 ${title}`, callback_data: `use:${sid}` }];
      });
      keyboard.push([{ text: "➕ New session", callback_data: "panel:new" }, { text: "📂 Sessions", callback_data: "panel:sessions" }]);
      await tg
        .sendRichMessage(chatId, "🤖 <b>¿A qué sesión respondo?</b>\n<i>Este grupo tiene varias sesiones activas. Elige una para enviar tu mensaje.</i>", {
          ...threadOpts(replyThread),
          reply_markup: { inline_keyboard: keyboard },
        })
        .catch(() => {});
      return { asked: true };
    }
  }

  const isMention = chatId < 0 && !!me.username && rawText.toLowerCase().includes("@" + me.username.toLowerCase());
  if (chatId >= 0 || isMention) {
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
    store.rememberDelivery(s.sessionId, chatId, replyThread);
    s.promptStartTime = Date.now();
    store.rememberLastChat(s.sessionId, chatId);
    store.rememberLastPrompt(s.sessionId, text);
    notePromptSent(s.sessionId, text);
    await startStatus(chatId, s);
    if (s.statusMessageId) store.rememberMessageSession(chatId, s.statusMessageId, s.sessionId);
    s.statusTimer = setInterval(() => {
      updateStatus(chatId, s).catch(() => {});
    }, 5000);
    void oc.prompt(s.sessionId, text, files).catch(async (err) => {
      if (s.statusTimer) {
        clearInterval(s.statusTimer);
        s.statusTimer = undefined;
      }
      await finishStatus(chatId, s).catch(() => {});
      await send(`❌ ${esc(String(err))}`, store.threadOptsFor(s));
    });
  } catch (err) {
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    await finishStatus(chatId, s).catch(() => {});
    await send(`❌ ${esc(String(err))}`, store.threadOptsFor(s));
  }
}

/**
 * A text/media message from Telegram: gate it, download attachments, handle
 * commands, or forward it to the session bound to this tab as a prompt.
 */
export async function handleMessage(deps: BotDeps, msg: TelegramMessage): Promise<void> {
  const { config, tg, oc, store, me, sessions, status } = deps;
  const { rememberSessionChat, rememberActiveRoute, routeKey } = store;
  const { ensureActiveSession, createNewSession, restoreActiveSession, activateSession } = sessions;
  const { startStatus, updateStatus, finishStatus } = status;

  const userId = msg.from?.id;
  const allowedUsers = new Set<number>();
  if (config.ADMIN_TELEGRAM_USER_ID) allowedUsers.add(config.ADMIN_TELEGRAM_USER_ID);
  if (config.ALLOWED_TELEGRAM_USER_IDS) {
    for (const part of config.ALLOWED_TELEGRAM_USER_IDS.split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n) && n > 0) allowedUsers.add(n);
    }
  }
  const isAuthorized = allowedUsers.size > 0 && userId !== undefined && allowedUsers.has(userId);
  if (!isAuthorized) {
    // In groups, silently ignore unauthorized messages.
    if (msg.chat.id < 0) return;
    await tg.sendRichMessage(msg.chat.id, "Not authorized.");
    return;
  }

  const chatId = msg.chat.id;
  const replyThread = msg.message_thread_id;
  // Replying to any bot message routes the prompt to the session that produced
  // it: explicit map first, then dashboard/status/in-memory card fallbacks.
  const replyMessageId = msg.reply_to_message?.message_id;
  const repliedSessionId = replyMessageId ? store.findSessionByAnyMessage(chatId, replyMessageId, replyThread) : undefined;
  deps.metrics?.inc("messages");
  // Ignore commands explicitly addressed to another bot.
  const rawText = (msg.text ?? msg.caption ?? "").trim();
  const commandTarget = rawText.match(/^\/[a-zA-Z0-9_-]+@([A-Za-z0-9_]+)/)?.[1];
  if (commandTarget && commandTarget.toLowerCase() !== (me.username ?? "").toLowerCase()) return;
  const isMention = chatId < 0 && !!me.username && rawText.toLowerCase().includes("@" + me.username.toLowerCase());
  const isReplyToBot = chatId < 0 && !!msg.reply_to_message && msg.reply_to_message.from?.id === me.id;
  // In groups, only respond to commands, mentions or replies to the bot.
  if (chatId < 0) {
    const isCommand = rawText.startsWith("/");
    if (!isCommand && !isMention && !isReplyToBot) return;
  }

  const send = (html: string, opts: Record<string, unknown> = {}) => tg.sendRichMessage(chatId, html, { ...(replyThread ? { message_thread_id: replyThread } : {}), ...opts });
  tg.setMessageReaction(chatId, msg.message_id, "👀").catch(() => {});
  tg.sendChatAction(chatId, "typing", replyThread).catch(() => {});
  deps.audit("message", `${userId} ${chatId}: ${(msg.text ?? msg.caption ?? "").slice(0, 120)}`);

  // If we are awaiting a rejection reason, handle it.
  const reasonKey = routeKey(chatId, replyThread);
  if (msg.text && deps.awaitingReason.has(reasonKey)) {
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

  // Download attachments.
  let downloadResult: DownloadedAttachments;
  try {
    downloadResult = await downloadAttachments(config, tg, chatId, msg, { threadId: replyThread, settings: deps.settings, send });
  } catch (err) {
    await send(`❌ Could not download attachment: ${esc(String(err))}`);
    return;
  }

  if (downloadResult.mediaToAttach.length) {
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
  let mediaToAttach: Array<{ uri: string; name: string }>;
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
  );
  const s = resolution.session;
  if (!s) {
    if (resolution.asked) return;
    await send("🤖 <b>No hay sesión activa en esta conversación.</b>\n<i>Crea una nueva o elige una existente para empezar.</i>", { reply_markup: { inline_keyboard: [[{ text: "➕ Nueva sesión aquí", callback_data: "panel:new" }, { text: "📂 Sesiones", callback_data: "panel:sessions" }]] } } );
    return;
  }
  const text = voiceTranscript
    ? ((msg.caption ?? "").trim() ? `${(msg.caption ?? "").trim()}\n\n${voiceTranscript}` : voiceTranscript)
    : ((msg.caption ?? "").trim() || (msg.photo ? "What is in this image?" : "Analyze this file"));
  // Auto-switch to a vision-capable model if needed.
  if (msg.photo || msg.video) {
    try {
      const res = await oc.client.model.list();
      const list = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[];
      const current = list.find((m: any) => m.id === s.model?.id && m.providerID === s.model?.providerID) as { id?: string; providerID?: string; capabilities?: { input?: string[] }; variants?: Array<{ id?: string }> } | undefined;
      const supportsImage = Array.isArray(current?.capabilities?.input) && current.capabilities.input.includes("image");
      if (!supportsImage) {
        const visionModel = list.find((m: any) => Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image")) as { id?: string; providerID?: string; capabilities?: { input?: string[] }; variants?: Array<{ id?: string }> } | undefined;
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

  if (await handleCommand(deps, chatId, replyThread, text, send, userId)) return;

  // Create or restore the session bound to this tab.
  const rawText = (msg.text ?? msg.caption ?? "").trim();
  const resolution = await resolveSessionForMessage(deps, chatId, replyThread, repliedSessionId, rawText, { text: rawText });
  const s = resolution.session;
  if (!s) {
    if (resolution.asked) return;
    await send("🤖 <b>No hay sesión activa en esta conversación.</b>\n<i>Crea una nueva o elige una existente para empezar.</i>", { reply_markup: { inline_keyboard: [[{ text: "➕ Nueva sesión aquí", callback_data: "panel:new" }, { text: "📂 Sesiones", callback_data: "panel:sessions" }]] } } );
    return;
  }

  const slash = parseSlashCommand(text);
  if (slash && slash.name !== "btw" && !KNOWN_COMMANDS.has(slash.name)) {
    const name = slash.name;
    const args = slash.args;

    // Dangerous commands require confirmation.
    const dangerous = new Set(["delete", "remove", "reset", "drop", "clear", "wipe", "destroy"]);
    if (dangerous.has(name.toLowerCase())) {
      const confirmKey = `runcmd:${s.sessionId}:${name}:${args}`;
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
      const names = cmds.map((c: any) => String(c?.name ?? c?.command ?? c)).filter(Boolean);
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

    try {
      void oc.runCommand(s.sessionId, name, args)
        .then(() => { if (name !== "goal") send(`ran /${esc(name)}`); })
        .catch((err) => send(`❌ ${esc(String(err))}\n\nUse /commands to see available commands.`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "⚡ Commands", callback_data: "panel:commands" },
                { text: "🏠 Panel", callback_data: "panel:home" },
              ],
            ],
          },
        }));
    } catch (err) {
      await send(`❌ ${esc(String(err))}\n\nUse /commands to see available commands.`, {
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
