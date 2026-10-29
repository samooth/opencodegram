import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BotDeps } from "./context.js";
import type { TelegramMessage } from "./telegram.js";
import { handleCommand } from "./commands.js";
import { esc, threadOpts } from "./util.js";

/**
 * A text/media message from Telegram: gate it, download attachments, handle
 * commands, or forward it to the session bound to this tab as a prompt.
 */
export async function handleMessage(deps: BotDeps, msg: TelegramMessage): Promise<void> {
  const { config, tg, oc, store, me, sessions, status } = deps;
  const { rememberSessionChat, rememberActiveRoute, routeKey, lastChatBySession, lastPromptBySession } = store;
  const { ensureActiveSession, createNewSession, restoreActiveSession } = sessions;
  const { startStatus, updateStatus, finishStatus } = status;

  const userId = msg.from?.id;
  if (config.ADMIN_TELEGRAM_USER_ID && userId !== config.ADMIN_TELEGRAM_USER_ID) {
    // In groups, silently ignore non-admin messages.
    if (msg.chat.id < 0) return;
    await tg.sendRichMessage(msg.chat.id, "Not authorized.");
    return;
  }

  const chatId = msg.chat.id;
  const replyThread = msg.message_thread_id;
  // In groups, only respond to commands, mentions or replies to the bot.
  if (chatId < 0) {
    const raw = (msg.text ?? msg.caption ?? "").trim();
    const isCommand = raw.startsWith("/");
    const isMention = !!me.username && raw.toLowerCase().includes("@" + me.username.toLowerCase());
    const isReplyToBot = !!msg.reply_to_message && msg.reply_to_message.from?.id === me.id;
    if (!isCommand && !isMention && !isReplyToBot) return;
  }

  const send = (html: string, opts: Record<string, unknown> = {}) => tg.sendRichMessage(chatId, html, { ...(replyThread ? { message_thread_id: replyThread } : {}), ...opts });
  console.log("[telegram] message from", userId, chatId, JSON.stringify((msg.text ?? msg.caption ?? "").slice(0, 80)));
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

  // Multimedia handling
  const mediaToAttach: Array<{ uri: string; name: string }> = [];
  const downloadOne = async (fileId: string, suggestedName: string) => {
    const info = await tg.getFile(fileId);
    if (!info.file_path) throw new Error("Telegram did not return a file path");
    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${info.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dir = join("/tmp/opencode/attachments", String(chatId));
    await mkdir(dir, { recursive: true });
    const name = suggestedName || info.file_path.split("/").pop() || `${fileId}.bin`;
    const path = join(dir, name);
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
    mediaToAttach.push(await downloadOne(msg.audio.file_id, msg.audio.file_name ?? `audio_${msg.audio.file_unique_id}.mp3`));
  }
  if (msg.voice) {
    mediaToAttach.push(await downloadOne(msg.voice.file_id, `voice_${msg.voice.file_unique_id}.ogg`));
  }
  if (msg.video) {
    mediaToAttach.push(await downloadOne(msg.video.file_id, msg.video.file_name ?? `video_${msg.video.file_unique_id}.mp4`));
  }

  if (mediaToAttach.length) {
    const s = await ensureActiveSession(chatId, replyThread);
    if (!s) {
      await send("no active session");
      return;
    }
    const text = (msg.caption ?? "").trim() || (msg.photo ? "What is in this image?" : "Analyze this file");
    // Auto-switch to a vision-capable model if needed.
    if (msg.photo || msg.video) {
      try {
        const res = await oc.client.model.list();
        const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
        const current = list.find((m: any) => m.id === s.model?.id && m.providerID === s.model?.providerID);
        const supportsImage = Array.isArray(current?.capabilities?.input) && current.capabilities.input.includes("image");
        if (!supportsImage) {
          const visionModel = list.find((m: any) => Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image"));
          if (visionModel) {
            await oc.switchModel(s.sessionId, { id: visionModel.id, providerID: visionModel.providerID, variant: visionModel.variants?.[0]?.id });
            s.model = { id: visionModel.id, providerID: visionModel.providerID, variant: visionModel.variants?.[0]?.id };
            await send(`Switched to vision model: <code>${esc(visionModel.providerID)}/${esc(visionModel.id)}</code>`);
          }
        }
      } catch {
        // ignore
      }
    }
    try {
      s.targetChatId = chatId;
      s.targetThreadId = replyThread;
      rememberSessionChat(s.sessionId, chatId);
      rememberActiveRoute(chatId, replyThread, s.sessionId);
      s.promptStartTime = Date.now();
      lastChatBySession.set(s.sessionId, chatId);
      lastPromptBySession.set(s.sessionId, text);
      await startStatus(chatId, s);
      s.statusTimer = setInterval(() => {
        updateStatus(chatId, s).catch(() => {});
      }, 3000);
      await oc.prompt(s.sessionId, text, mediaToAttach);
    } catch (err) {
      if (s.statusTimer) {
        clearInterval(s.statusTimer);
        s.statusTimer = undefined;
      }
      await finishStatus(chatId, s).catch(() => {});
      await send(`❌ ${esc(String(err))}`, store.threadOptsFor(s));
    }
    return;
  }

  if (!msg.text) return;
  let text = (msg.text ?? msg.caption ?? "").trim();
  text = text.replace(/^\/([a-zA-Z0-9_-]+)@\w+/, "/$1");
  // Strip bot mentions anywhere in the text (group usage)
  if (me.username) text = text.replace(new RegExp("@" + me.username, "gi"), "").trim();

  if (await handleCommand(deps, chatId, replyThread, text, send)) return;

  // Create or restore the session bound to this tab.
  let s = await ensureActiveSession(chatId, replyThread);
  if (!s) {
    await createNewSession(chatId, true, replyThread);
    s = (await restoreActiveSession(chatId, replyThread))!;
  }
  if (!s) {
    await send("could not create a session.");
    return;
  }

  const slash = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
  const known = new Set([
    "start",
    "help",
    "status",
    "session",
    "sessions",
    "new",
    "stop",
    "abort",
    "commands",
    "file",
    "model",
    "models",
    "agent",
    "agents",
    "fork",
    "rename",
    "archive",
    "unarchive",
    "delete",
    "diff",
    "context",
    "compact",
    "vcs",
    "worktrees",
    "usage",
  ]);
  if (slash && !known.has(slash[1])) {
    const name = slash[1];
    const args = (slash[2] ?? "").trim();
    try {
      await oc.runCommand(s.sessionId, name, args);
      await send(`ran /${name}`);
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

  try {
    s.targetChatId = chatId;
    s.targetThreadId = replyThread;
    rememberSessionChat(s.sessionId, chatId);
    rememberActiveRoute(chatId, replyThread, s.sessionId);
    s.promptStartTime = Date.now();
    lastChatBySession.set(s.sessionId, chatId);
    lastPromptBySession.set(s.sessionId, text);
    await startStatus(chatId, s);
    s.statusTimer = setInterval(() => {
      updateStatus(chatId, s).catch(() => {});
    }, 3000);
    await oc.prompt(s.sessionId, text);
  } catch (err) {
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    await finishStatus(chatId, s).catch(() => {});
    await send(`❌ ${esc(String(err))}`);
  }
}
