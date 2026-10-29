import { loadConfig } from "./config.js";
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TelegramClient } from "./telegram.js";
import { OpenCodeBridge, resolveServerPassword } from "./opencode.js";
import type { ChatSession } from "./types.js";
import { SessionStore } from "./store.js";
import { createStatusManager } from "./status.js";
import { createPanels } from "./panels.js";
import { createSessionManager } from "./sessions.js";
import { startEventLoop } from "./events.js";
import { esc, rateLimitRetryAt, threadOpts } from "./util.js";

async function main() {
  const config = loadConfig();
  const tg = new TelegramClient(config.TELEGRAM_BOT_TOKEN);
  const oc = new OpenCodeBridge(config.OPENCODE_BASE_URL, resolveServerPassword());

  const me = await tg.getMe();
  const topicsEnabled = me.has_topics_enabled === true;
  console.log(`[opencodegram] bot: @${me.username ?? me.first_name} (id ${me.id}) topics=${topicsEnabled}`);

  const botCommands = [
    { command: "start", description: "Welcome and control panel" },
    { command: "help", description: "Show help and panel" },
    { command: "status", description: "Show active session" },
    { command: "sessions", description: "List and switch sessions" },
    { command: "use", description: "Switch to a session by ID" },
    { command: "new", description: "Create a new session" },
    { command: "models", description: "List and switch models" },
    { command: "agents", description: "List and switch agents" },
    { command: "usage", description: "Show usage and cost stats" },
    { command: "vcs", description: "Show VCS status" },
    { command: "worktrees", description: "List worktrees" },
    { command: "forms", description: "List pending forms" },
    { command: "formreply", description: "Reply to a form" },
    { command: "commands", description: "List OpenCode commands" },
    { command: "fork", description: "Fork the active session" },
    { command: "rename", description: "Rename the active session" },
    { command: "archive", description: "Archive the active session" },
    { command: "unarchive", description: "Unarchive the active session" },
    { command: "delete", description: "Delete the active session" },
    { command: "diff", description: "Show session diff" },
    { command: "context", description: "Show session context" },
    { command: "sync", description: "Sync session history to Telegram" },
    { command: "compact", description: "Compact session history" },
    { command: "stop", description: "Stop the active turn" },
  ];
  await tg.deleteMyCommands().catch(() => {});
  await tg.setMyCommands(botCommands).catch((err) => console.error("[commands]", err));
  await tg.setMyCommands(botCommands, { type: "all_private_chats" }).catch(() => {});
  await tg.setMyCommands(botCommands, { type: "all_group_chats" }).catch(() => {});
  const info = await oc.serverInfo();
  console.log(`[opencodegram] opencode: ${JSON.stringify(info)}`);

  const store = new SessionStore();
  const {
    sessionsByChat,
    sessionsByThread,
    sessionsById,
    lastChatBySession,
    lastPromptBySession,
    activeSessionByRoute,
    threadBySession,
    chatBySession,
    routeKey,
    findSessionById,
    resolveChatId,
    resolveThreadId,
    getActiveSession,
    rememberSessionChat,
    rememberActiveRoute,
    forgetSession,
    saveThreads,
    saveChats,
    saveActiveSessions,
  } = store;
  // Kept for call-site compatibility: routing is decided by the session itself.
  const threadOptsFor = (s: ChatSession | undefined, _chatId?: number): Record<string, unknown> => store.threadOptsFor(s);
  const { flushDraft, startStatus, updateStatus, finishStatus } = createStatusManager({
    tg,
    threadOptsFor: (s) => store.threadOptsFor(s),
  });
  const { createNewSession, activateSession, retireSession, restoreActiveSession, ensureActiveSession, syncTopicTitle } = createSessionManager({
    config,
    tg,
    oc,
    store,
    topicsEnabled,
    finishStatus,
  });
  const retryingSessions = new Set<string>();
  const audit = (action: string, detail: string) => {
    try {
      mkdirSync(join(process.cwd(), "data"), { recursive: true });
      const line = `${new Date().toISOString()} ${action} ${detail}\n`;
      writeFileSync(join(process.cwd(), "data", "audit.log"), line, { flag: "a" });
    } catch {
      // ignore
    }
  };
  const modelListByChat = new Map<string, Array<any>>();
  const pendingModelByChat = new Map<string, any>();
  const { showSessions, showCommands, showModels, sendPanel } = createPanels({
    tg,
    oc,
    config,
    getActiveSession,
    modelListByChat,
    routeKey,
  });
  const pendingPermissions = new Map<string, { chatId: number; sessionId: string; messageId?: number; decided: boolean; label: string; resource: string }>(); // requestId -> info
  const awaitingReason = new Map<string, string>(); // routeKey -> requestId

  startEventLoop({ tg, oc, store, retryingSessions, pendingPermissions, flushDraft, updateStatus, finishStatus, syncTopicTitle });


  // Telegram polling
  let offset = 0;
  while (true) {
    let updates: any[] = [];
    try {
      updates = await tg.getUpdates(offset, 25);
    } catch (err) {
      console.error("[poll]", err);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;

      if (u.stopped_message_generation) {
        const d = u.stopped_message_generation;
        // Find the session whose draft matches.
        for (const s of sessionsById.values()) {
          if (s.draftId !== d.draft_id) continue;
          s.stopped = true;
          if (s.timer) {
            clearTimeout(s.timer);
            s.timer = undefined;
          }
          if (s.typingTimer) {
            clearInterval(s.typingTimer);
            s.typingTimer = undefined;
          }
          const chatId = s.targetChatId ?? d.chat.id;
          await oc.interrupt(s.sessionId).catch(() => {});
          if (s.statusMessageId) {
            await tg.editRichMessage(chatId, s.statusMessageId, "⏹ <b>Stopped</b>", {
              ...threadOptsFor(s, chatId),
              reply_markup: { inline_keyboard: [] },
            }).catch(() => {});
            s.statusMessageId = undefined;
          }
          await tg.sendRichMessage(chatId, "⏹ stopped", threadOptsFor(s, chatId)).catch(() => {});
          break;
        }
        continue;
      }

      if (u.callback_query) {
        const cq = u.callback_query;
        console.log("[telegram] callback from", cq.from?.id, "data=", cq.data, "chat=", cq.message?.chat?.id);
        const userId = cq.from?.id;
        if (config.ADMIN_TELEGRAM_USER_ID && userId !== config.ADMIN_TELEGRAM_USER_ID) {
          await tg.answerCallbackQuery(cq.id, "Not authorized");
          continue;
        }
        const data = cq.data ?? "";
        const m = data.match(/^perm:(allow|always|reject|rejectreason):(.+)$/);
        if (m) {
          const action = m[1];
          const requestId = m[2];
          const info = pendingPermissions.get(requestId);
          if (!info) {
            await tg.answerCallbackQuery(cq.id, "Unknown permission");
            continue;
          }
          if (info.decided) {
            await tg.answerCallbackQuery(cq.id, "Already decided");
            continue;
          }
          if (action === "rejectreason") {
            // Set state to capture the next text as the reason, scoped to this tab.
            const reasonKey = routeKey(info.chatId, cq.message?.message_thread_id);
            awaitingReason.set(reasonKey, requestId);
            setTimeout(() => {
              if (awaitingReason.get(reasonKey) === requestId) awaitingReason.delete(reasonKey);
            }, 2 * 60 * 1000);
            await tg.answerCallbackQuery(cq.id, "Send the reason as a message");
            if (info.messageId) {
              await tg.editRichMessage(info.chatId, info.messageId, `<b>Reject with reason</b>\nSend your reason in the next message.`).catch(() => {});
            }
            continue;
          }
          let decision: "once" | "always" | "reject" = "reject";
          if (action === "allow") decision = "once";
          else if (action === "always") {
            if (config.ADMIN_TELEGRAM_USER_ID && cq.from?.id !== config.ADMIN_TELEGRAM_USER_ID) {
              await tg.answerCallbackQuery(cq.id, "Admin only");
              continue;
            }
            decision = "always";
          }
          info.decided = true;
          await oc.replyPermission(info.sessionId, requestId, decision);
          await tg.answerCallbackQuery(cq.id, decision === "once" ? "Allowed" : decision === "always" ? "Always allowed" : "Rejected");
          if (info.messageId) {
            await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission ${decision}</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`).catch(() => {});
          }
          pendingPermissions.delete(requestId);
          continue;
        }

        const chatId = cq.message?.chat?.id ?? cq.from.id;
        const cbData = cq.data ?? "";

        if (cbData === "panel:home" || cbData === "panel:status" || cbData === "panel:help") {
          await tg.answerCallbackQuery(cq.id);
          await sendPanel(chatId, cq.message?.message_thread_id);
          continue;
        }
        if (cbData === "panel:sessions") {
          await tg.answerCallbackQuery(cq.id);
          await showSessions(chatId, 0, cq.message?.message_id, cq.message?.message_thread_id);
          continue;
        }
        if (cbData === "panel:new") {
          await tg.answerCallbackQuery(cq.id, "Creating…");
          await createNewSession(chatId, false, cq.message?.message_thread_id);
          await sendPanel(chatId, cq.message?.message_thread_id);
          continue;
        }
        if (cbData === "panel:commands") {
          await tg.answerCallbackQuery(cq.id);
          await showCommands(chatId, cq.message?.message_thread_id);
          continue;
        }
        if (cbData === "panel:models") {
          await tg.answerCallbackQuery(cq.id);
          await showModels(chatId, 0, cq.message?.message_id, cq.message?.message_thread_id);
          continue;
        }
        if (cbData === "panel:stop") {
          const threadId = cq.message?.message_thread_id;
          const s = getActiveSession(chatId, threadId);
          if (s) {
            s.stopped = true;
            if (s.statusTimer) { clearInterval(s.statusTimer); s.statusTimer = undefined; }
            await oc.interrupt(s.sessionId).catch(() => {});
            await tg.answerCallbackQuery(cq.id, "Stopped");
            if (s.statusMessageId) {
              await tg.editRichMessage(chatId, s.statusMessageId, "⏹ <b>Stopped</b>", {
                ...threadOptsFor(s, chatId),
                reply_markup: { inline_keyboard: [] },
              }).catch(() => {});
              s.statusMessageId = undefined;
            }
            await tg.sendRichMessage(chatId, "⏹ stopped", threadOpts(threadId)).catch(() => {});
          } else {
            await tg.answerCallbackQuery(cq.id, "No active session");
          }
          continue;
        }
        const useMatch = cbData.match(/^use:(.+)$/);
        if (useMatch) {
          const sessionId = useMatch[1];
          const threadId = cq.message?.message_thread_id;
          await tg.answerCallbackQuery(cq.id, "Switching…");
          try {
            await activateSession(chatId, sessionId, true, threadId);
            if (cq.message?.message_id) {
              await tg.editRichMessage(chatId, cq.message.message_id, `✅ Switched to session\n<code>${esc(sessionId)}</code>`, { reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }]] } });
            }
          } catch (err) {
            await tg.answerCallbackQuery(cq.id, "Failed");
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }
        const pageMatch = cbData.match(/^sessions:page:(\d+)$/);
        if (pageMatch) {
          await tg.answerCallbackQuery(cq.id);
          await showSessions(chatId, parseInt(pageMatch[1], 10), cq.message?.message_id, cq.message?.message_thread_id);
          continue;
        }
        const modelsPageMatch = cbData.match(/^models:page:(\d+)$/);
        if (modelsPageMatch) {
          await tg.answerCallbackQuery(cq.id);
          await showModels(chatId, parseInt(modelsPageMatch[1], 10), cq.message?.message_id, cq.message?.message_thread_id);
          continue;
        }
        const modelMatch = cbData.match(/^model:(\d+)$/);
        if (modelMatch) {
          const idx = parseInt(modelMatch[1], 10);
          const threadId = cq.message?.message_thread_id;
          const scope = routeKey(chatId, threadId);
          const models = modelListByChat.get(scope) ?? [];
          const model = models[idx];
          const s = getActiveSession(chatId, threadId);
          if (!model || !s) {
            await tg.answerCallbackQuery(cq.id, "No active session/model");
            continue;
          }
          pendingModelByChat.set(scope, model);
          const variants = Array.isArray(model.variants) ? model.variants : [];
          const keyboard: any[][] = [];
          if (variants.length) {
            for (const v of variants) {
              keyboard.push([{ text: v.id === (model.variants?.[0]?.id) ? `${v.id} (default)` : v.id, callback_data: `variant:${v.id}` }]);
            }
          }
          keyboard.push([{ text: "Default", callback_data: "variant:default" }]);
          keyboard.push([{ text: "🧠 Models", callback_data: "panel:models" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
          await tg.answerCallbackQuery(cq.id);
          if (cq.message?.message_id) {
            await tg.editRichMessage(chatId, cq.message.message_id, `Select variant for <b>${esc(model.name ?? model.id)}</b>\n<code>${esc(model.providerID)}/${esc(model.id)}</code>`, { reply_markup: { inline_keyboard: keyboard } });
          }
          continue;
        }
        const variantMatch = cbData.match(/^variant:(.+)$/);
        if (variantMatch) {
          const variantId = variantMatch[1];
          const threadId = cq.message?.message_thread_id;
          const scope = routeKey(chatId, threadId);
          const model = pendingModelByChat.get(scope);
          const s = getActiveSession(chatId, threadId);
          if (!model || !s) {
            await tg.answerCallbackQuery(cq.id, "No pending model");
            continue;
          }
          const variant = variantId === "default" ? undefined : variantId;
          await tg.answerCallbackQuery(cq.id, "Switching model…");
          try {
            await oc.switchModel(s.sessionId, { id: model.id, providerID: model.providerID, variant });
            pendingModelByChat.delete(scope);
            s.model = { id: model.id, providerID: model.providerID, variant };
            if (cq.message?.message_id) {
              await tg.editRichMessage(chatId, cq.message.message_id, `✅ Model switched\n<code>${esc(model.providerID)}/${esc(model.id)}</code>${variant ? " (" + esc(variant) + ")" : ""}`, { reply_markup: { inline_keyboard: [[{ text: "🧠 Models", callback_data: "panel:models" }, { text: "🏠 Panel", callback_data: "panel:home" }]] } });
            }
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }
        const agentMatch = cbData.match(/^agent:(.+)$/);
        if (agentMatch) {
          const name = agentMatch[1];
          const s = await ensureActiveSession(chatId, cq.message?.message_thread_id);
          if (!s) { await tg.answerCallbackQuery(cq.id, "No active session"); continue; }
          await tg.answerCallbackQuery(cq.id, `Switching to ${name}…`);
          try {
            await oc.switchAgent(s.sessionId, name);
            if (cq.message?.message_id) {
              await tg.editRichMessage(chatId, cq.message.message_id, `✅ Agent switched to <b>${esc(name)}</b>`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Panel", callback_data: "panel:home" }]] } });
            } else {
              await tg.sendRichMessage(chatId, `Agent switched to ${esc(name)}`);
            }
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }

        const cmdMatch = cbData.match(/^cmd:(.+)$/);
        if (cmdMatch) {
          const name = cmdMatch[1];
          const threadId = cq.message?.message_thread_id;
          const s = getActiveSession(chatId, threadId);
          if (!s) {
            await tg.answerCallbackQuery(cq.id, "No active session");
            continue;
          }
          await tg.answerCallbackQuery(cq.id, `Running /${name}…`);
          try {
            await oc.runCommand(s.sessionId, name, "");
            await tg.sendRichMessage(chatId, `ran /${esc(name)}`, threadOpts(threadId));
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
          }
          continue;
        }

        continue;
      }

      const msg = u.message;
      if (!msg) continue;
      const userId = msg.from?.id;
      if (config.ADMIN_TELEGRAM_USER_ID && userId !== config.ADMIN_TELEGRAM_USER_ID) {
        // In groups, silently ignore non-admin messages.
        if (msg.chat.id < 0) continue;
        await tg.sendRichMessage(msg.chat.id, "Not authorized.");
        continue;
      }

      const chatId = msg.chat.id;
      const replyThread = msg.message_thread_id;
      // In groups, only respond to commands or mentions.
      if (chatId < 0) {
        const raw = (msg.text ?? msg.caption ?? "").trim();
        const isCommand = raw.startsWith("/");
        const isMention = !!me.username && raw.toLowerCase().includes("@" + me.username.toLowerCase());
        const isReplyToBot = !!msg.reply_to_message && msg.reply_to_message.from?.id === me.id;
        if (!isCommand && !isMention && !isReplyToBot) continue;
      }
      const send = (html: string, opts: Record<string, unknown> = {}) => tg.sendRichMessage(chatId, html, { ...(replyThread ? { message_thread_id: replyThread } : {}), ...opts });
      console.log("[telegram] message from", userId, chatId, JSON.stringify((msg.text ?? msg.caption ?? "").slice(0, 80)));
      tg.setMessageReaction(chatId, msg.message_id, "👀").catch(() => {});
      tg.sendChatAction(chatId, "typing", replyThread).catch(() => {});
      audit("message", `${userId} ${chatId}: ${(msg.text ?? msg.caption ?? "").slice(0, 120)}`);

      // If we are awaiting a rejection reason, handle it.
      const reasonKey = routeKey(chatId, replyThread);
      if (msg.text && awaitingReason.has(reasonKey)) {
        const requestId = awaitingReason.get(reasonKey)!;
        awaitingReason.delete(reasonKey);
        const info = pendingPermissions.get(requestId);
        if (info && !info.decided) {
          info.decided = true;
          const reason = msg.text;
          try {
            await oc.replyPermission(info.sessionId, requestId, "reject");
          } catch (err) {
            await send(`❌ ${esc(String(err))}`);
          }
          if (info.messageId) {
            await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission rejected</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>\nReason: ${esc(reason)}`).catch(() => {});
          }
          pendingPermissions.delete(requestId);
          await send(`Rejected with reason: ${esc(reason)}`);
        }
        continue;
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
          continue;
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
          s.statusTimer = setInterval(() => { updateStatus(chatId, s).catch(() => {}); }, 3000);
          await oc.prompt(s.sessionId, text, mediaToAttach);
        } catch (err) {
          if (s.statusTimer) { clearInterval(s.statusTimer); s.statusTimer = undefined; }
          await finishStatus(chatId, s).catch(() => {});
          await send(`❌ ${esc(String(err))}`, threadOptsFor(s, chatId));
        }
        continue;
      }

      if (!msg.text) continue;
      let text = (msg.text ?? msg.caption ?? "").trim();
      text = text.replace(/^\/([a-zA-Z0-9_-]+)@\w+/, "/$1");
      // Strip bot mentions anywhere in the text (group usage)
      if (me.username) text = text.replace(new RegExp("@" + me.username, "gi"), "").trim();

      if (text === "/start" || text === "/help") {
        await sendPanel(chatId, replyThread);
        continue;
      }

      if (text === "/status" || text === "/session") {
        await sendPanel(chatId, replyThread);
        continue;
      }

      if (text === "/new") {
        await createNewSession(chatId, false, replyThread);
        continue;
      }

      if (text === "/stop" || text === "/abort") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) {
          await send("no active session");
          continue;
        }
        try {
          s.stopped = true;
          if (s.statusTimer) { clearInterval(s.statusTimer); s.statusTimer = undefined; }
          await oc.interrupt(s.sessionId);
          if (s.statusMessageId) {
            await tg.editRichMessage(chatId, s.statusMessageId, "⏹ <b>Stopped</b>", {
              ...threadOptsFor(s, chatId),
              reply_markup: { inline_keyboard: [] },
            }).catch(() => {});
            s.statusMessageId = undefined;
          }
          await send("⏹ stopped", threadOptsFor(s, chatId));
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/commands") {
        await showCommands(chatId, replyThread);
        continue;
      }

      if (text === "/models" || text === "/model") {
        await showModels(chatId, 0, undefined, replyThread);
        continue;
      }

      if (text === "/agents" || text === "/agent") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        const directory = s.directory ?? config.OPENCODE_DIRECTORY;
        const agents = await oc.listAgents(directory);
        if (!agents.length) { await send("no agents available."); continue; }
        const lines = agents.map((a: any) => `• <b>${esc(a.name ?? a.id)}</b>${a.description ? " — " + esc(a.description) : ""}`);
        const keyboard = agents.map((a: any) => [{ text: a.name ?? a.id, callback_data: `agent:${a.id}` }]);
        keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
        await send(`<b>Agents</b>\n\n${lines.join("\n")}`, { reply_markup: { inline_keyboard: keyboard } });
        continue;
      }

      if (text === "/usage") {
        try {
          const stats = await oc.client.session.stats();
          const data = (stats as any)?.data ?? stats;
          const msg = [
            `<b>Usage</b>`,
            `Sessions: ${data.sessions ?? 0} · Prompts: ${data.prompts ?? 0} · Steps: ${data.steps ?? 0}`,
            `Tokens: in ${(data.tokens?.input ?? 0).toLocaleString()} · out ${(data.tokens?.output ?? 0).toLocaleString()} · reasoning ${(data.tokens?.reasoning ?? 0).toLocaleString()}`,
            `Cost: ${(data.cost ?? 0).toFixed(4)}`,
            `Tools: ${data.tools?.totals?.calls ?? 0} calls (${data.tools?.totals?.succeeded ?? 0} ok, ${data.tools?.totals?.failed ?? 0} failed)`,
          ].join("\n");
          await send(msg);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/vcs") {
        const s = await restoreActiveSession(chatId, replyThread);
        const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
        try {
          const info = await oc.vcsGet(directory);
          const status = await oc.vcsStatus(directory);
          const data = (info as any)?.data ?? info;
          const st = (status as any)?.data ?? status;
          const branch = data?.branch?.current ?? "?";
          const files = Array.isArray(st) ? st.length : (st?.files?.length ?? 0);
          await send(`<b>VCS</b>\nBranch: <code>${esc(branch)}</code>\nChanged files: ${files}`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/worktrees") {
        const s = await restoreActiveSession(chatId, replyThread);
        const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
        try {
          const res = await oc.worktreeList(directory);
          const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
          if (!list.length) { await send("no worktrees."); continue; }
          const lines = list.map((w: any) => `• <code>${esc(w.path ?? w.directory ?? "")}</code>`);
          await send(`<b>Worktrees</b>\n${lines.join("\n")}`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/forms") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          const forms = await oc.listForms(s.sessionId);
          if (!forms.length) { await send("no pending forms."); continue; }
          for (const f of forms) {
            const fields = Array.isArray(f.fields) ? f.fields : [];
            const fieldLines = fields.map((fld: any) => `• <b>${esc(fld.key)}</b> (${esc(fld.type)})${fld.required ? " *" : ""}${fld.description ? " — " + esc(fld.description) : ""}`);
            await send(`<b>Form: ${esc(f.title)}</b>\nID: <code>${esc(f.id)}</code>\n\n${fieldLines.join("\n")}\n\nReply with <code>/formreply ${esc(f.id)} {\"key\":\"value\"}</code>`);
          }
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text.startsWith("/formreply ")) {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        const rest = text.slice(11).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) { await send("usage: /formreply <form_id> <json>"); continue; }
        const formId = rest.slice(0, spaceIdx).trim();
        const jsonStr = rest.slice(spaceIdx + 1).trim();
        let answer: Record<string, unknown>;
        try {
          answer = JSON.parse(jsonStr);
        } catch {
          await send("invalid JSON."); continue;
        }
        try {
          await oc.replyForm(s.sessionId, formId, answer as Record<string, string | number | boolean | string[]>);
          await send(`Form ${esc(formId)} answered.`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/fork") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          const forked = await oc.forkSession(s.sessionId);
          const newId = (forked as any)?.id ?? (forked as any)?.sessionID ?? (forked as any)?.data?.id;
          await activateSession(chatId, newId, true, replyThread);
          await send(`Forked session.\n<code>${esc(s.sessionId)}</code> → <code>${esc(newId)}</code>`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text.startsWith("/rename ")) {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        const title = text.slice(8).trim();
        if (!title) { await send("usage: /rename <title>"); continue; }
        try {
          await oc.renameSession(s.sessionId, title);
          if (s.threadId) {
            await tg.editForumTopic(chatId, s.threadId, title.slice(0, 120)).catch(() => {});
            s.topicTitle = title.slice(0, 120);
          }
          await send(`Renamed session to <b>${esc(title)}</b>.`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/archive") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          await oc.archiveSession(s.sessionId, true);
          await send("Session archived.");
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/unarchive") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          await oc.archiveSession(s.sessionId, false);
          await send("Session unarchived.");
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/delete") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        // Simple confirmation via text; buttons would be better but keep simple.
        await send(`Delete session <code>${esc(s.sessionId)}</code>? Reply /delete confirm to proceed.`);
        continue;
      }

      if (text === "/delete confirm") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          await oc.deleteSession(s.sessionId);
          forgetSession(s.sessionId);
          await send("Session deleted.");
          await sendPanel(chatId, replyThread);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/diff") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          const diffs = await oc.diff(s.sessionId);
          if (!diffs.length) { await send("No changes."); continue; }
          const rows = diffs.map((d: any) => `<tr><td><code>${esc(d.file ?? "")}</code></td><td>+${d.additions ?? 0}/-${d.deletions ?? 0}</td><td>${esc(d.status ?? "")}</td></tr>`).join("");
          await send(`<b>Diff summary</b>\n<table><tr><th>File</th><th>Changes</th><th>Status</th></tr>${rows}</table>`);
          for (const d of diffs) {
            const patch = (d.patch ?? "").slice(0, 3500);
            await send(`<details><summary><b>${esc(d.file ?? "")}</b> (+${d.additions ?? 0}/-${d.deletions ?? 0})</summary>\n<pre><code class="language-diff">${esc(patch)}</code></pre>\n</details>`);
          }
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/sync") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          const ctx = await oc.context(s.sessionId);
          const items = Array.isArray(ctx) ? ctx : (ctx as any)?.data ?? [];
          const meaningful = items.filter((m: any) => {
            const role = m.role ?? m.type;
            return role === "user" || role === "assistant" || role === "compaction";
          }).slice(-20);
          if (!meaningful.length) { await send("No context to sync."); continue; }
          await send("<b>Syncing " + meaningful.length + " messages…</b>");
          for (const m of meaningful) {
            const role = m.role ?? m.type ?? "msg";
            let text = "";
            if (role === "user") {
              const t = m.text;
              text = typeof t === "string" ? t : (t ? JSON.stringify(t) : "");
            } else if (role === "assistant") {
              const parts = Array.isArray(m.content) ? m.content : [];
              const texts = parts.filter((p: any) => p.type === "text").map((p: any) => {
                const t = p.text;
                return typeof t === "string" ? t : (t ? JSON.stringify(t) : "");
              });
              text = texts.join(" ").trim();
              if (!text) {
                const tools = parts.filter((p: any) => p.type === "tool").map((p: any) => p.name ?? p.tool ?? "tool");
                if (tools.length) text = "🔧 " + tools.join(", ");
              }
            } else if (role === "compaction") {
              text = (m.summary ?? "").toString().split("\n")[0].slice(0, 200);
            }
            text = text.replace(/\s+/g, " ").trim().slice(0, 1000);
            const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : "📦";
            await send(icon + " <b>" + esc(role) + "</b>:\n" + esc(text || "(no text)"));
          }
          await send("✅ Sync complete.");
        } catch (err) {
          await send("❌ " + esc(String(err)));
        }
        continue;
      }

      if (text === "/context") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          const session = await oc.client.session.get({ sessionID: s.sessionId });
          const modelInfo = await (async () => {
            try {
              const res = await oc.client.model.list();
              const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
              return list.find((m: any) => m.id === session.model?.id && m.providerID === session.model?.providerID);
            } catch { return null; }
          })();
          const ctxLimit = modelInfo?.limit?.context ?? 0;
          const tokens = session.tokens ?? {};
          const inTok = tokens.input ?? 0;
          const outTok = tokens.output ?? 0;
          const reasonTok = tokens.reasoning ?? 0;
          const cacheRead = tokens.cache?.read ?? 0;
          const ctx = await oc.context(s.sessionId);
          const items = Array.isArray(ctx) ? ctx : (ctx as any)?.data ?? [];
          const meaningful = items.filter((m: any) => {
            const role = m.role ?? m.type;
            if (role === "idle") return false;
            if (role === "assistant") {
              const parts = Array.isArray(m.content) ? m.content : [];
              const hasText = parts.some((p: any) => p.type === "text" && p.text);
              const hasTool = parts.some((p: any) => p.type === "tool");
              return hasText || hasTool;
            }
            return role === "user" || role === "compaction";
          });
          const sliced = meaningful.slice(-6);
          const summaries = sliced.map((m: any) => {
            const role = m.role ?? m.type ?? "msg";
            let text = "";
            if (role === "user") {
              const t = m.text;
              text = typeof t === "string" ? t : (t ? JSON.stringify(t) : "");
            } else if (role === "assistant") {
              const parts = Array.isArray(m.content) ? m.content : [];
              const texts = parts.filter((p: any) => p.type === "text").map((p: any) => {
                const t = p.text;
                return typeof t === "string" ? t : (t ? JSON.stringify(t) : "");
              });
              const tools = parts.filter((p: any) => p.type === "tool").map((p: any) => p.name ?? p.tool ?? "tool");
              text = texts.join(" ").trim();
              if (!text && tools.length) text = "🔧 " + tools.join(", ");
            } else if (role === "compaction") {
              text = (m.summary ?? "").toString().split("\n")[0].slice(0, 120);
            } else {
              text = "";
            }
            text = text.replace(/\s+/g, " ").trim().slice(0, 160);
            const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : role === "compaction" ? "📦" : "•";
            return icon + " <b>" + esc(role) + "</b>: " + esc(text || "(no text)");
          }).filter(Boolean);
          const lastUser = [...items].reverse().find((m: any) => (m.role ?? m.type) === "user");
          const lastAssistant = [...items].reverse().find((m: any) => (m.role ?? m.type) === "assistant");
          const lastUserText = lastUser ? (typeof lastUser.text === "string" ? lastUser.text : JSON.stringify(lastUser.text ?? "")).slice(0, 200) : "";
          const lastAssistantText = lastAssistant ? (Array.isArray(lastAssistant.content) ? lastAssistant.content.filter((p: any) => p.type === "text").map((p: any) => typeof p.text === "string" ? p.text : JSON.stringify(p.text ?? "")).join(" ") : "").toString().slice(0, 200) : "";
          const tokenTable = "<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Input</td><td>" + inTok.toLocaleString() + "</td></tr><tr><td>Output</td><td>" + outTok.toLocaleString() + "</td></tr><tr><td>Reasoning</td><td>" + reasonTok.toLocaleString() + "</td></tr><tr><td>Cache read</td><td>" + cacheRead.toLocaleString() + "</td></tr><tr><td>Cost</td><td>" + (session.cost ?? 0).toFixed(4) + "</td></tr></table>";
          const msg = [
            "<b>🧠 Context</b>",
            "",
            "<table><tr><td><b>Model</b></td><td><code>" + esc(session.model?.providerID ?? "") + "/" + esc(session.model?.id ?? "") + "</code>" + (session.model?.variant ? " (" + esc(session.model.variant) + ")" : "") + "</td></tr>",
            ctxLimit ? "<tr><td><b>Window</b></td><td>" + ctxLimit.toLocaleString() + " tokens</td></tr>" : "",
            "<tr><td><b>Updated</b></td><td>" + new Date(session.time?.updated ?? Date.now()).toISOString().slice(0, 16).replace("T", " ") + "</td></tr></table>",
            "",
            tokenTable,
            "",
            lastUserText ? "<blockquote><b>Last user:</b> " + esc(lastUserText) + "</blockquote>" : "",
            lastAssistantText ? "<blockquote><b>Last assistant:</b> " + esc(lastAssistantText) + "</blockquote>" : "",
            "",
            "<b>Recent messages</b>",
            summaries.join("\n") || "(none)",
          ].filter(Boolean).join("\n");
          await send(msg);
        } catch (err) {
          await send("❌ " + esc(String(err)));
        }
        continue;

      }

      if (text === "/compact") {
        const s = await restoreActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          await oc.compactSession(s.sessionId);
          await send("Session compacted.");
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/sessions" || text.startsWith("/sessions ")) {
        const arg = text.slice("/sessions".length).trim();
        const page = /^\d+$/.test(arg) ? Math.max(0, parseInt(arg, 10) - 1) : 0;
        await showSessions(chatId, page, undefined, replyThread);
        continue;
      }

      if (text === "/use" || text.startsWith("/use ")) {
        const sessionId = text.slice(4).trim();
        if (!sessionId) {
          await showSessions(chatId, 0, undefined, replyThread);
          continue;
        }
        try {
          await activateSession(chatId, sessionId, true, replyThread);
          await send(`✅ Switched to session\n<code>${esc(sessionId)}</code>`);
        } catch (err) {
          await send(`failed to switch: ${esc(err instanceof Error ? err.message : String(err))}`);
        }
        continue;
      }

      // Create or restore the session bound to this tab.
      let s = await ensureActiveSession(chatId, replyThread);
      if (!s) {
        await createNewSession(chatId, true, replyThread);
        s = (await restoreActiveSession(chatId, replyThread))!;
      }

      const slash = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
      const known = new Set(["start", "help", "status", "session", "sessions", "new", "stop", "abort", "commands", "model", "models", "agent", "agents", "fork", "rename", "archive", "unarchive", "delete", "diff", "context", "compact", "vcs", "worktrees", "usage"]);
      if (slash && !known.has(slash[1])) {
        const name = slash[1];
        const args = (slash[2] ?? "").trim();
        try {
          await oc.runCommand(s.sessionId, name, args);
          await send(`ran /${name}`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}\n\nUse /commands to see available commands.`, { reply_markup: { inline_keyboard: [[{ text: "⚡ Commands", callback_data: "panel:commands" }, { text: "🏠 Panel", callback_data: "panel:home" }]] } });
        }
        continue;
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
        s.statusTimer = setInterval(() => { updateStatus(chatId, s).catch(() => {}); }, 3000);
        await oc.prompt(s.sessionId, text);
      } catch (err) {
        if (s.statusTimer) { clearInterval(s.statusTimer); s.statusTimer = undefined; }
        await finishStatus(chatId, s).catch(() => {});
        await send(`❌ ${esc(String(err))}`);
      }
    }
  }
}

const shutdown = (signal: string) => {
  console.log(`[opencodegram] ${signal} received, shutting down`);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
  console.error("[opencodegram] unhandled rejection", err);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});