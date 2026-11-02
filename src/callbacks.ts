import type { BotDeps } from "./context.js";
import { fileErrorMessage } from "./files/index.js";
import { renderForm, formKeyboard } from "./formui.js";
import * as mcp from "./mcp.js";
import { isSettingsKey, LABELS, renderSettings, settingsKeyboard } from "./settings.js";
import type { ChatSettings } from "./settings.js";
import type { TelegramCallbackQuery } from "./telegram.js";
import { esc, threadOpts } from "./util.js";
import { cancelAutoRetry, notePromptSent } from "./autoretry.js";

type CallbackHandler = (
  deps: BotDeps,
  cq: TelegramCallbackQuery,
  chatId: number,
  threadId: number | undefined,
  messageId: number | undefined,
  data: string,
) => Promise<void>;

const PREFIXES = [
  "fs:",
  "panel:",
  "perm:",
  "use:",
  "del:",
  "delsessions:",
  "model:",
  "agent:",
  "variant:",
  "set:",
  "cycle:",
  "goal:",
  "qswitch:",
  "runcmd:",
  "connect:",
  "sessions:",
  "filter:",
  "cmd:",
].sort((a, b) => b.length - a.length);

async function handlePerm(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^perm:(allow|always|reject|rejectreason):(.+)$/);
  if (!m) return;
  const action = m[1];
  const requestId = m[2];
  const info = deps.pendingPermissions.get(requestId);
  if (!info) {
    await deps.tg.answerCallbackQuery(cq.id, "Unknown permission");
    return;
  }
  if (info.decided) {
    await deps.tg.answerCallbackQuery(cq.id, "Already decided");
    return;
  }
  if (action === "rejectreason") {
    const reasonKey = deps.store.routeKey(info.chatId, cq.message?.message_thread_id);
    deps.awaitingReason.set(reasonKey, requestId);
    setTimeout(() => {
      if (deps.awaitingReason.get(reasonKey) === requestId) deps.awaitingReason.delete(reasonKey);
    }, 2 * 60 * 1000);
    await deps.tg.answerCallbackQuery(cq.id, "Send the reason as a message");
    if (info.messageId) {
      await deps.tg.editRichMessage(info.chatId, info.messageId, `<b>Reject with reason</b>\nSend your reason in the next message.`).catch(() => {});
    }
    return;
  }
  let decision: "once" | "always" | "reject" = "reject";
  if (action === "allow") decision = "once";
  else if (action === "always") {
    if (!deps.config.ADMIN_TELEGRAM_USER_ID || cq.from?.id !== deps.config.ADMIN_TELEGRAM_USER_ID) {
      await deps.tg.answerCallbackQuery(cq.id, "Admin only");
      return;
    }
    decision = "always";
  }
  info.decided = true;
  await deps.oc.replyPermission(info.sessionId, requestId, decision);
  await deps.tg.answerCallbackQuery(cq.id, decision === "once" ? "Allowed" : decision === "always" ? "Always allowed" : "Rejected");
  if (info.messageId) {
    await deps.tg
      .editRichMessage(info.chatId, info.messageId, `<b>Permission ${decision}</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`)
      .catch(() => {});
  }
  deps.pendingPermissions.delete(requestId);
}

async function handleConnect(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^connect:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  console.log("[connect] start", sessionId, "chat=", chatId, "thread=", threadId, "msg=", cq.message?.message_id);
  await deps.tg.answerCallbackQuery(cq.id, "Connecting…").catch(() => {});
  try {
    await deps.sessions.activateSession(chatId, sessionId, true, threadId);
    console.log("[connect] activated", sessionId);
    await deps.panels.showStatus(chatId, threadId, cq.message?.message_id);
    console.log("[connect] status shown", sessionId);
  } catch (err) {
    console.error("[connect] failed", sessionId, err);
    await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
  }
}

async function handleQswitch(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^qswitch:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  await deps.tg.answerCallbackQuery(cq.id, "Switching…").catch(() => {});
  try {
    await deps.sessions.activateSession(chatId, sessionId, false, threadId);
  } catch (err) {
    await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
  }
}

async function handleGoal(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^goal:(pause|resume|clear):(.+)$/);
  if (!m) return;
  const action = m[1];
  const sessionId = m[2];
  await deps.tg.answerCallbackQuery(cq.id, action === "clear" ? "Clearing…" : "Working…").catch(() => {});
  try {
    void deps.oc.runCommand(sessionId, "goal", action).catch((err) => {
      deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch(() => {});
    });
  } catch (err) {
    await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
  }
}

async function handleRuncmd(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^runcmd:yes:(.+)$/);
  if (!m) return;
  const key = m[1];
  const pending = deps.pendingConfirmations.get(key);
  if (!pending || pending.expires < Date.now()) {
    deps.pendingConfirmations.delete(key);
    await deps.tg.answerCallbackQuery(cq.id, "Expired").catch(() => {});
    await deps.tg.sendRichMessage(chatId, "Confirmation expired.", threadOpts(threadId));
    return;
  }
  deps.pendingConfirmations.delete(key);
  await deps.tg.answerCallbackQuery(cq.id, "Running…").catch(() => {});
  try {
    void deps.oc.runCommand(pending.sessionId, pending.name, pending.args)
      .then(() => deps.tg.sendRichMessage(chatId, `ran /${esc(pending.name)}`, threadOpts(threadId)))
      .catch((err) => deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)));
  } catch (err) {
    await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
  }
}

async function handleDelsessions(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^delsessions:page:(\d+)$/);
  if (!m) return;
  await deps.tg.answerCallbackQuery(cq.id);
  await deps.panels.showDeleteSessions(chatId, parseInt(m[1], 10), cq.message?.message_id, threadId);
}

async function handleDel(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^del:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  await deps.tg.answerCallbackQuery(cq.id);
  await deps.tg.sendRichMessage(chatId, `Delete session <code>${esc(sessionId)}</code>?`, {
    ...threadOpts(threadId),
    reply_markup: {
      inline_keyboard: [
        [{ text: "🗑 Delete", callback_data: `delconfirm:${sessionId}` }, { text: "Cancel", callback_data: "panel:home" }],
      ],
    },
  });
}

async function handleModel(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^model:(\d+)$/);
  if (!m) return;
  const idx = parseInt(m[1], 10);
  const scope = deps.store.routeKey(chatId, threadId);
  const models = deps.modelListByChat.get(scope) ?? [];
  const model = models[idx] as any;
  const s = deps.store.getActiveSession(chatId, threadId);
  if (!model) {
    await deps.tg.answerCallbackQuery(cq.id, "Model not found");
    return;
  }
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, "No active session");
    await deps.tg.sendRichMessage(chatId, "No active session in this chat/topic. Activate or create one first.", {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] },
    }).catch(() => {});
    return;
  }
  deps.pendingModelByChat.set(scope, model as { id: string; providerID: string; variant?: string });
  const variants = Array.isArray(model.variants) ? model.variants : [];
  const keyboard: any[][] = [];
  for (const v of variants) {
    keyboard.push([{ text: v.id === model.variants?.[0]?.id ? `${v.id} (default)` : v.id, callback_data: `variant:${v.id}` }]);
  }
  keyboard.push([{ text: "Default", callback_data: "variant:default" }]);
  keyboard.push([{ text: "❌ Cancel", callback_data: "modelcancel" }]);
  keyboard.push([
    { text: "🧠 Models", callback_data: "panel:models" },
    { text: "🏠 Panel", callback_data: "panel:home" },
  ]);
  await deps.tg.answerCallbackQuery(cq.id);
  if (cq.message?.message_id) {
    await deps.tg.editRichMessage(
      chatId,
      cq.message.message_id,
      `Select variant for <b>${esc(model.name ?? model.id)}</b>\n<code>${esc(model.providerID)}/${esc(model.id)}</code>`,
      { reply_markup: { inline_keyboard: keyboard } },
    );
  }
}

async function handleAgent(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^agent:(.+)$/);
  if (!m) return;
  const name = m[1];
  const s = await deps.sessions.ensureActiveSession(chatId, threadId);
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, "No active session");
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, `Switching to ${name}…`);
  try {
    await deps.oc.switchAgent(s.sessionId, name);
    if (cq.message?.message_id) {
      await deps.tg.editRichMessage(chatId, cq.message.message_id, `✅ Agent switched to <b>${esc(name)}</b>`, {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Panel", callback_data: "panel:home" }]] },
      });
    } else {
      await deps.tg.sendRichMessage(chatId, `Agent switched to ${esc(name)}`);
    }
  } catch (err) {
    await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
  }
}

async function handleVariant(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^variant:(.+)$/);
  if (!m) return;
  const variantId = m[1];
  const scope = deps.store.routeKey(chatId, threadId);
  const model = deps.pendingModelByChat.get(scope);
  const s = deps.store.getActiveSession(chatId, threadId);
  if (!model) {
    await deps.tg.answerCallbackQuery(cq.id, "No pending model");
    return;
  }
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, "No active session");
    await deps.tg.sendRichMessage(chatId, "No active session in this chat/topic. Activate or create one first.", {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] },
    }).catch(() => {});
    return;
  }
  const variant = variantId === "default" ? undefined : variantId;
  await deps.tg.answerCallbackQuery(cq.id, "Switching model…");
  try {
    await deps.oc.switchModel(s.sessionId, { id: model.id, providerID: model.providerID, variant });
    deps.pendingModelByChat.delete(scope);
    s.model = { id: model.id, providerID: model.providerID, variant };
    if (cq.message?.message_id) {
      await deps.tg.editRichMessage(
        chatId,
        cq.message.message_id,
        `✅ Model switched\n<code>${esc(model.providerID)}/${esc(model.id)}</code>${variant ? " (" + esc(variant) + ")" : ""}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🧠 Models", callback_data: "panel:models" },
                { text: "🏠 Panel", callback_data: "panel:home" },
              ],
            ],
          },
        },
      );
    }
  } catch (err) {
    await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
  }
}

async function handleSet(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  if (!data.startsWith("set:")) return;
  const [, key, value] = data.split(":");
  if (!key || !isSettingsKey(key)) {
    await deps.tg.answerCallbackQuery(cq.id, "Unknown setting").catch(() => {});
    return;
  }
  let parsedValue: ChatSettings[keyof ChatSettings];
  if (key === "previewLines") parsedValue = Number(value);
  else if (key === "diffStyle") parsedValue = value === "unified" ? "unified" : "simple";
  else parsedValue = value === "true";
  const settings = deps.settings.set(chatId, key, parsedValue);
  await deps.tg.answerCallbackQuery(cq.id, `${LABELS[key]} → ${String(parsedValue)}`).catch(() => {});
  if (messageId !== undefined) {
    await deps.tg
      .editRichMessage(chatId, messageId, renderSettings(chatId, settings), {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: settingsKeyboard(settings) },
      })
      .catch(() => {});
  }
}

async function handleCycle(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  if (!data.startsWith("cycle:")) return;
  const key = data.slice(6);
  if (key === "previewLines") {
    const presets = [20, 40, 80, 160];
    const current = deps.settings.get(chatId).previewLines;
    const next = presets[(presets.indexOf(current) + 1) % presets.length] ?? presets[0];
    const settings = deps.settings.set(chatId, "previewLines", next);
    await deps.tg.answerCallbackQuery(cq.id, `${LABELS.previewLines} → ${next}`).catch(() => {});
    if (messageId !== undefined) {
      await deps.tg
        .editRichMessage(chatId, messageId, renderSettings(chatId, settings), {
          ...threadOpts(threadId),
          reply_markup: { inline_keyboard: settingsKeyboard(settings) },
        })
        .catch(() => {});
    }
    return;
  }
  if (key === "resourceHistory") {
    const presets = [6, 12, 24];
    const current = deps.settings.get(chatId).resourceHistory;
    const next = presets[(presets.indexOf(current) + 1) % presets.length] ?? presets[0];
    const settings = deps.settings.set(chatId, "resourceHistory", next);
    await deps.tg.answerCallbackQuery(cq.id, `${LABELS.resourceHistory} → ${next}`).catch(() => {});
    if (messageId !== undefined) {
      await deps.tg
        .editRichMessage(chatId, messageId, renderSettings(chatId, settings), {
          ...threadOpts(threadId),
          reply_markup: { inline_keyboard: settingsKeyboard(settings) },
        })
        .catch(() => {});
    }
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, "Unknown setting").catch(() => {});
}

async function handlePanel(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const { tg, panels, sessions, files, oc, store } = deps;
  if (data === "panel:home" || data === "panel:help") {
    await tg.answerCallbackQuery(cq.id);
    await panels.sendPanel(chatId, threadId);
    return;
  }
  if (data === "panel:status") {
    await tg.answerCallbackQuery(cq.id);
    await panels.showStatus(chatId, threadId, cq.message?.message_id);
    return;
  }
  if (data === "panel:sessions") {
    await tg.answerCallbackQuery(cq.id);
    await panels.showSessions(chatId, 0, cq.message?.message_id, threadId);
    return;
  }
  if (data === "panel:new") {
    await tg.answerCallbackQuery(cq.id, "Creating…");
    await sessions.createNewSession(chatId, false, threadId);
    await panels.sendPanel(chatId, threadId);
    return;
  }
  if (data === "panel:commands") {
    await tg.answerCallbackQuery(cq.id);
    await panels.showCommands(chatId, threadId);
    return;
  }
  if (data === "panel:files") {
    await tg.answerCallbackQuery(cq.id);
    try {
      await files.showListing(chatId, threadId, "", { messageId: cq.message?.message_id });
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(fileErrorMessage(err))}`, threadOpts(threadId));
    }
    return;
  }
  if (data === "panel:models") {
    await tg.answerCallbackQuery(cq.id);
    await panels.showModels(chatId, 0, cq.message?.message_id, threadId);
    return;
  }
  if (data === "panel:stop") {
    let s = store.getActiveSession(chatId, threadId);
    // Fall back to the session bound to this status message (survives
    // in-memory resets and thread mismatches).
    if (!s && messageId !== undefined) {
      const sid = store.messageToSession.get(`${chatId}:${messageId}`);
      if (sid) s = store.sessionsById.get(sid);
    }
    // Last resort: restore the persisted binding for this tab.
    if (!s) {
      try {
        await sessions.restoreActiveSession(chatId, threadId);
        s = store.getActiveSession(chatId, threadId);
      } catch {
        s = undefined;
      }
    }
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No active session");
      return;
    }
    s.stopped = true;
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    cancelAutoRetry(s.sessionId);
    await oc.interrupt(s.sessionId).catch(() => {});
    await tg.answerCallbackQuery(cq.id, "Stopped");
    if (s.statusMessageId) {
      await tg
        .editRichMessage(chatId, s.statusMessageId, "⏹ <b>Stopped</b>", {
          ...store.threadOptsFor(s),
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      s.statusMessageId = undefined;
    }
    await tg.sendRichMessage(chatId, "⏹ stopped", threadOpts(threadId)).catch(() => {});
    return;
  }
}

async function handleFs(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  await deps.files.handleCallback(cq);
}

async function handleSessions(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const filterMatch = data.match(/^sessions:filter:(all|running|group)$/);
  if (filterMatch) {
    const mode = filterMatch[1];
    await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
    if (mode === "running") await deps.panels.showSessions(chatId, 0, cq.message?.message_id, threadId, undefined, true);
    else if (mode === "group") await deps.panels.showSessions(chatId, 0, cq.message?.message_id, threadId, chatId);
    else await deps.panels.showSessions(chatId, 0, cq.message?.message_id, threadId);
    return;
  }
  const pageMatch = data.match(/^sessions:page:(\d+)$/);
  if (pageMatch) {
    await deps.tg.answerCallbackQuery(cq.id);
    await deps.panels.showSessions(chatId, parseInt(pageMatch[1], 10), cq.message?.message_id, threadId);
    return;
  }
}

async function handleFilter(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  return;
}

async function handleCmd(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^cmd:(.+)$/);
  if (!m) return;
  const name = m[1];
  const dangerous = new Set(["delete", "remove", "reset", "drop", "clear", "wipe", "destroy"]);
  if (dangerous.has(name.toLowerCase())) {
    await deps.tg.answerCallbackQuery(cq.id, "Type the command manually");
    await deps.tg.sendRichMessage(chatId, "⚠️ For safety, run this command by typing it.", threadOpts(threadId));
    return;
  }
  const s = deps.store.getActiveSession(chatId, threadId);
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, "No active session");
    return;
  }
  const cmds = await deps.oc.listCommandsCached(s.directory);
  if (!cmds.some((c: any) => c?.name === name)) {
    await deps.tg.answerCallbackQuery(cq.id, "Unknown command");
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, `Running /${name}…`);
  try {
    void deps.oc.runCommand(s.sessionId, name, "")
      .then(() => deps.tg.sendRichMessage(chatId, `ran /${esc(name)}`, threadOpts(threadId)))
      .catch((err) => deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)));
  } catch (err) {
    await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
  }
}

export const CALLBACK_DISPATCH: Record<string, CallbackHandler> = {
  "fs:": handleFs,
  "panel:": handlePanel,
  "perm:": handlePerm,
  "use:": async (deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) => {
    const m = data.match(/^use:(.+)$/);
    if (!m) return;
    const sessionId = m[1];
    await deps.tg.answerCallbackQuery(cq.id, "Connecting…");
    try {
      await deps.sessions.activateSession(chatId, sessionId, true, threadId);
      await deps.panels.showStatus(chatId, threadId, cq.message?.message_id);
    } catch (err) {
      await deps.tg.answerCallbackQuery(cq.id, "Failed");
      await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
    }
  },
  "del:": handleDel,
  "delsessions:": handleDelsessions,
  "model:": handleModel,
  "agent:": handleAgent,
  "variant:": handleVariant,
  "set:": handleSet,
  "cycle:": handleCycle,
  "goal:": handleGoal,
  "qswitch:": handleQswitch,
  "runcmd:": handleRuncmd,
  "connect:": handleConnect,
  "sessions:": handleSessions,
  "filter:": handleFilter,
  "cmd:": handleCmd,
};

export const callbackDispatch = CALLBACK_DISPATCH;
export const dispatch = CALLBACK_DISPATCH;
export const handlers = CALLBACK_DISPATCH;

export async function handleCallback(deps: BotDeps, cq: TelegramCallbackQuery): Promise<void> {
  const { config, tg, oc, store, pendingPermissions, awaitingReason, panels, sessions, modelListByChat, pendingModelByChat } = deps;
  const { routeKey, getActiveSession, threadOptsFor } = store;
  const { showSessions, showDeleteSessions, showModels, showCommands, showStatus, sendPanel, providerListByChat, selectedProviderByChat } = panels;
  const { activateSession, ensureActiveSession, createNewSession } = sessions;

  console.log("[telegram] callback from", cq.from?.id, "data=", cq.data, "chat=", cq.message?.chat?.id);
  const userId = cq.from?.id;
  const allowedUsers = new Set<number>();
  if (config.ADMIN_TELEGRAM_USER_ID) allowedUsers.add(config.ADMIN_TELEGRAM_USER_ID);
  if (config.ALLOWED_TELEGRAM_USER_IDS) {
    for (const part of config.ALLOWED_TELEGRAM_USER_IDS.split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n) && n > 0) allowedUsers.add(n);
    }
  }
  if (allowedUsers.size === 0 || userId === undefined || !allowedUsers.has(userId)) {
    await tg.answerCallbackQuery(cq.id, "Not authorized");
    return;
  }

  const data = cq.data ?? "";
  const chatId = cq.message?.chat?.id ?? cq.from.id;
  const cbData = cq.data ?? "";
  const threadId = cq.message?.message_thread_id;
  const messageId = cq.message?.message_id;

  if (await deps.files.handleCallback(cq)) return;

  const prefix = PREFIXES.find((p) => cbData.startsWith(p));
  if (prefix && CALLBACK_DISPATCH[prefix]) {
    await CALLBACK_DISPATCH[prefix](deps, cq, chatId, threadId, messageId, cbData);
    return;
  }

  // Fallback for unlisted prefixes.
  const retryMatch = cbData.match(/^retry:(.+)$/);
  if (retryMatch) {
    const sessionId = retryMatch[1];
    await tg.answerCallbackQuery(cq.id, "Retrying…").catch(() => {});
    const prompt = deps.store.lastPromptBySession.get(sessionId);
    if (!prompt) {
      await tg.sendRichMessage(chatId, "no previous prompt to retry.", threadOpts(threadId));
      return;
    }
    try {
      await deps.sessions.activateSession(chatId, sessionId, true, threadId);
      const s = await deps.sessions.restoreActiveSession(chatId, threadId);
      if (!s) throw new Error("session not found");
      s.targetChatId = chatId;
      s.targetThreadId = threadId;
      deps.store.rememberSessionChat(s.sessionId, chatId);
      deps.store.rememberActiveRoute(chatId, threadId, s.sessionId);
      s.promptStartTime = Date.now();
      deps.store.rememberLastChat(s.sessionId, chatId);
      deps.store.rememberLastPrompt(s.sessionId, prompt);
      notePromptSent(s.sessionId, prompt);
      await deps.status.startStatus(chatId, s);
      if (s.statusMessageId) deps.store.rememberMessageSession(chatId, s.statusMessageId, s.sessionId);
      s.statusTimer = setInterval(() => {
        deps.status.updateStatus(chatId, s).catch(() => {});
      }, 5000);
      await deps.oc.prompt(s.sessionId, prompt).catch(async (err) => {
        if (s.statusTimer) {
          clearInterval(s.statusTimer);
          s.statusTimer = undefined;
        }
        await deps.status.finishStatus(chatId, s).catch(() => {});
        await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
      });
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
    }
    return;
  }

  const deleteConfirmMatch = cbData.match(/^delconfirm:(.+)$/);
  if (deleteConfirmMatch) {
    const sessionId = deleteConfirmMatch[1];
    await tg.answerCallbackQuery(cq.id, "Deleting…");
    try {
      await oc.interrupt(sessionId).catch(() => {});
      await oc.deleteSession(sessionId);
      store.forgetSession(sessionId);
      if (cq.message?.message_id !== undefined) {
        await tg.editRichMessage(chatId, cq.message.message_id, `✅ Deleted <code>${esc(sessionId)}</code>`, {
          reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }]] },
        }).catch(() => {});
      }
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
    }
    return;
  }

  const mcpData = cq.data ?? "";
  if (mcpData.startsWith("mcp:")) {
    const s = getActiveSession(chatId, threadId);
    const directory = s?.directory ?? deps.config.OPENCODE_DIRECTORY ?? process.cwd();
    const parts = mcpData.split(":");
    const action = parts[1];
    const name = parts.slice(2).join(":");
    try {
      if (action === "connect" && name) {
        await deps.oc.client.mcp.connect({ server: name, location: { directory } } as unknown as Parameters<typeof deps.oc.client.mcp.connect>[0]);
        await deps.tg.answerCallbackQuery(cq.id, "Connected").catch(() => {});
      } else if (action === "disconnect" && name) {
        await deps.oc.client.mcp.disconnect({ server: name, location: { directory } } as unknown as Parameters<typeof deps.oc.client.mcp.disconnect>[0]);
        await deps.tg.answerCallbackQuery(cq.id, "Disconnected").catch(() => {});
      } else if (action === "remove" && name) {
        await deps.oc.client.mcp.remove({ server: name, location: { directory } } as unknown as Parameters<typeof deps.oc.client.mcp.remove>[0]);
        await deps.tg.answerCallbackQuery(cq.id, "Removed").catch(() => {});
      } else if (action === "resources") {
        await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
        const { resources, templates } = await mcp.listMcpResources(deps.oc, directory);
        const all = [...resources, ...templates];
        if (!all.length) {
          await deps.tg.sendRichMessage(chatId, "No MCP resources available.", threadOpts(threadId));
          return;
        }
        const lines = all.map((resource) => `• <b>${esc(resource.name)}</b> (${esc(resource.server)})\n  <code>${esc(resource.uri)}</code>`);
        await deps.tg.sendRichMessage(chatId, `<b>MCP resources</b>\n${lines.join("\n\n")}\n\nUse /mcp read <uri>`, threadOpts(threadId));
        return;
      } else {
        await deps.tg.answerCallbackQuery(cq.id, "Unknown MCP action").catch(() => {});
        return;
      }
      const { text, keyboard } = await mcp.renderMcpList(deps.oc, directory);
      if (messageId !== undefined) {
        await deps.tg.editRichMessage(chatId, messageId, text, { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
      } else {
        await deps.tg.sendRichMessage(chatId, text, { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } });
      }
    } catch (err) {
      await deps.tg.answerCallbackQuery(cq.id, "Failed").catch(() => {});
      await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch(() => {});
    }
    return;
  }

  const formCallbackHandled = await handleFormCallback(deps, cq);
  if (formCallbackHandled) return;

  const fullEditsMatch = (cq.data ?? "").match(/^edits:full:(\d+)$/);
  if (fullEditsMatch && cq.message?.message_id !== undefined) {
    const handled = await deps.status.sendFullDiffs(chatId, Number(fullEditsMatch[1]), threadId);
    await deps.tg.answerCallbackQuery(cq.id, handled ? "Sending diffs…" : "Edit expired").catch(() => {});
    return;
  }

  const editMatch = (cq.data ?? "").match(/^edit:(\d+)$/);
  if (editMatch && cq.message?.message_id !== undefined) {
    const handled = await deps.status.showEditDiff(chatId, cq.message.message_id, Number(editMatch[1]));
    if (handled) {
      await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
      return;
    }
    await deps.tg.answerCallbackQuery(cq.id, "Edit expired").catch(() => {});
    return;
  }

  if (cbData === "new:confirm") {
    await tg.answerCallbackQuery(cq.id, "Creating…");
    try {
      await createNewSession(chatId, false, threadId);
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
    }
    return;
  }
  if (cbData === "new:cancel") {
    await tg.answerCallbackQuery(cq.id, "Canceled");
    return;
  }

  const deleteMatch = cbData.match(/^delete:(confirm|cancel)(?::(.+))?$/);
  if (deleteMatch) {
    const action = deleteMatch[1];
    const sessionId = deleteMatch[2];
    if (action === "cancel") {
      await tg.answerCallbackQuery(cq.id, "Cancelled").catch(() => {});
      if (messageId !== undefined) {
        await tg.editRichMessage(chatId, messageId, "Deletion cancelled.", { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
      return;
    }
    if (!sessionId) {
      await tg.answerCallbackQuery(cq.id, "Missing session").catch(() => {});
      return;
    }
    await tg.answerCallbackQuery(cq.id, "Deleting…").catch(() => {});
    try {
      await oc.deleteSession(sessionId);
      store.forgetSession(sessionId);
      if (messageId !== undefined) {
        await tg.editRichMessage(chatId, messageId, `✅ Session deleted\n<code>${esc(sessionId)}</code>`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
      await sendPanel(chatId, threadId);
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch(() => {});
    }
    return;
  }

  const provMatch = cbData.match(/^prov:(.+)$/);
  if (provMatch) {
    const scope = routeKey(chatId, threadId);
    const providers = providerListByChat.get(scope) ?? [];
    const raw = provMatch[1];
    if (raw === "back") {
      await tg.answerCallbackQuery(cq.id);
      await showModels(chatId, 0, cq.message?.message_id, threadId);
      return;
    }
    const index = parseInt(raw, 10);
    const provider = providers[index];
    if (!provider) {
      await tg.answerCallbackQuery(cq.id, "Provider not found");
      return;
    }
    await tg.answerCallbackQuery(cq.id);
    await showModels(chatId, 0, cq.message?.message_id, threadId, provider);
    return;
  }

  if (cbData === "modelcancel") {
    const scope = routeKey(chatId, threadId);
    pendingModelByChat.delete(scope);
    await tg.answerCallbackQuery(cq.id, "Cancelled").catch(() => {});
    if (cq.message?.message_id) {
      await tg.editRichMessage(chatId, cq.message.message_id, "Model selection cancelled.", {
        reply_markup: { inline_keyboard: [[{ text: "🧠 Models", callback_data: "panel:models" }, { text: "🏠 Panel", callback_data: "panel:home" }]] },
      }).catch(() => {});
    }
    return;
  }

  const modelsPageMatch = cbData.match(/^models:page:(\d+)$/);
  if (modelsPageMatch) {
    const scope = routeKey(chatId, threadId);
    const provider = selectedProviderByChat?.get(scope);
    await tg.answerCallbackQuery(cq.id);
    await showModels(chatId, parseInt(modelsPageMatch[1], 10), cq.message?.message_id, threadId, provider);
    return;
  }

  const skillMatch = cbData.match(/^skill:(.+)$/);
  if (skillMatch) {
    const id = skillMatch[1];
    const s = getActiveSession(chatId, threadId);
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No active session");
      return;
    }
    await tg.answerCallbackQuery(cq.id, `Loading ${id}…`);
    try {
      await oc.loadSkill(s.sessionId, id);
      await tg.sendRichMessage(chatId, `Loaded skill <b>${esc(id)}</b>`, threadOpts(threadId));
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
    }
    return;
  }
}
async function handleFormCallback(deps: BotDeps, cq: TelegramCallbackQuery): Promise<boolean> {
  const data = cq.data ?? "";
  if (data !== "forms:submit" && data !== "forms:cancel" && !data.startsWith("fq:")) return false;

  const chatId = cq.message?.chat?.id ?? cq.from.id;
  const threadId = cq.message?.message_thread_id;
  const messageId = cq.message?.message_id;
  if (messageId === undefined) {
    await deps.tg.answerCallbackQuery(cq.id, "Expired").catch(() => {});
    return true;
  }
  const state = deps.pendingForms.get(messageId);
  if (!state) {
    await deps.tg.answerCallbackQuery(cq.id, "Form expired").catch(() => {});
    return true;
  }

  if (data === "forms:cancel") {
    await deps.tg.answerCallbackQuery(cq.id, "Cancelled").catch(() => {});
    await deps.tg
      .editRichMessage(chatId, messageId, `<b>Form cancelled</b>\n<code>${esc(state.formId)}</code>`, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
    deps.pendingForms.delete(messageId);
    deps.pendingFormsById.delete(state.formId);
    return true;
  }

  if (data === "forms:submit") {
    if (state.submitted) {
      await deps.tg.answerCallbackQuery(cq.id, "Already submitted").catch(() => {});
      return true;
    }
    const allRequired = state.fields.filter((field) => field.required).every((field) => state.answers[field.key] !== undefined);
    if (!allRequired) {
      await deps.tg.answerCallbackQuery(cq.id, "Required fields missing").catch(() => {});
      return true;
    }
    state.submitted = true;
    await deps.tg.answerCallbackQuery(cq.id, "Submitting…").catch(() => {});
    try {
      await deps.oc.replyForm(state.sessionId, state.formId, state.answers as Record<string, string | number | boolean | string[]>);
      await deps.tg
        .editRichMessage(chatId, messageId, `<b>Form submitted</b>\n<code>${esc(state.formId)}</code>`, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
    } catch (err) {
      state.submitted = false;
      await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch(() => {});
    }
    deps.pendingForms.delete(messageId);
    deps.pendingFormsById.delete(state.formId);
    return true;
  }

  const match = data.match(/^fq:(\d+):(\d+)$/);
  if (!match) {
    await deps.tg.answerCallbackQuery(cq.id, "Unknown form action").catch(() => {});
    return true;
  }
  const fieldIndex = Number(match[1]);
  const optionIndex = Number(match[2]);
  const field = state.fields[fieldIndex];
  const option = field?.options?.[optionIndex];
  if (!field || !option) {
    await deps.tg.answerCallbackQuery(cq.id, "Expired").catch(() => {});
    return true;
  }
  state.answers[field.key] = option.value;
  await deps.tg.answerCallbackQuery(cq.id, `Selected ${option.label}`).catch(() => {});
  await deps.tg
    .editRichMessage(chatId, messageId, renderForm(state), {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: formKeyboard(state) },
    })
    .catch(() => {});
  return true;
}
