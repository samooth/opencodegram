import type { BotDeps } from "./context.js";
import { fileErrorMessage } from "./files.js";
import { renderForm, formKeyboard } from "./formui.js";
import { extractEditFile, formatEditDiff, isEditTool } from "./editutil.js";
import { isSettingsKey, LABELS, renderSettings, settingsKeyboard } from "./settings.js";
import type { TelegramCallbackQuery } from "./telegram.js";
import { esc, threadOpts } from "./util.js";

/** Inline keyboard actions: panels, session/model/agent pickers and permissions. */
export async function handleCallback(deps: BotDeps, cq: TelegramCallbackQuery): Promise<void> {
  const { config, tg, oc, store, pendingPermissions, awaitingReason, panels, sessions, modelListByChat, pendingModelByChat } = deps;
  const { routeKey, getActiveSession, threadOptsFor } = store;
  const { showSessions, showModels, showCommands, sendPanel } = panels;
  const { activateSession, ensureActiveSession, createNewSession } = sessions;

  console.log("[telegram] callback from", cq.from?.id, "data=", cq.data, "chat=", cq.message?.chat?.id);
  const userId = cq.from?.id;
  if (config.ADMIN_TELEGRAM_USER_ID && userId !== config.ADMIN_TELEGRAM_USER_ID) {
    await tg.answerCallbackQuery(cq.id, "Not authorized");
    return;
  }

  const data = cq.data ?? "";
  const m = data.match(/^perm:(allow|always|reject|rejectreason):(.+)$/);
  if (m) {
    const action = m[1];
    const requestId = m[2];
    const info = pendingPermissions.get(requestId);
    if (!info) {
      await tg.answerCallbackQuery(cq.id, "Unknown permission");
      return;
    }
    if (info.decided) {
      await tg.answerCallbackQuery(cq.id, "Already decided");
      return;
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
      return;
    }
    let decision: "once" | "always" | "reject" = "reject";
    if (action === "allow") decision = "once";
    else if (action === "always") {
      if (config.ADMIN_TELEGRAM_USER_ID && cq.from?.id !== config.ADMIN_TELEGRAM_USER_ID) {
        await tg.answerCallbackQuery(cq.id, "Admin only");
        return;
      }
      decision = "always";
    }
    info.decided = true;
    await oc.replyPermission(info.sessionId, requestId, decision);
    await tg.answerCallbackQuery(cq.id, decision === "once" ? "Allowed" : decision === "always" ? "Always allowed" : "Rejected");
    if (info.messageId) {
      await tg
        .editRichMessage(info.chatId, info.messageId, `<b>Permission ${decision}</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`)
        .catch(() => {});
    }
    pendingPermissions.delete(requestId);
    return;
  }

  const chatId = cq.message?.chat?.id ?? cq.from.id;
  const cbData = cq.data ?? "";
  const threadId = cq.message?.message_thread_id;
  const messageId = cq.message?.message_id;

  // File browser callbacks are namespaced with `fs:`.
  if (await deps.files.handleCallback(cq)) return;

  // Interactive forms (model questions with options).
  const formCallbackHandled = await handleFormCallback(deps, cq);
  if (formCallbackHandled) return;

  // Show an edit from a finished status card as a diff.
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

  // Settings toggles.
  if (cbData.startsWith("set:")) {
    const [, key, value] = cbData.split(":");
    if (!key || !isSettingsKey(key)) {
      await deps.tg.answerCallbackQuery(cq.id, "Unknown setting").catch(() => {});
      return;
    }
    const boolValue = value === "true";
    const settings = deps.settings.set(chatId, key, boolValue);
    await deps.tg.answerCallbackQuery(cq.id, `${LABELS[key]} → ${boolValue ? "on" : "off"}`).catch(() => {});
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
  if (cbData === "panel:home" || cbData === "panel:status" || cbData === "panel:help") {
    await tg.answerCallbackQuery(cq.id);
    await sendPanel(chatId, threadId);
    return;
  }
  if (cbData === "panel:sessions") {
    await tg.answerCallbackQuery(cq.id);
    await showSessions(chatId, 0, cq.message?.message_id, threadId);
    return;
  }
  if (cbData === "panel:new") {
    await tg.answerCallbackQuery(cq.id, "Creating…");
    await createNewSession(chatId, false, threadId);
    await sendPanel(chatId, threadId);
    return;
  }
  if (cbData === "panel:commands") {
    await tg.answerCallbackQuery(cq.id);
    await showCommands(chatId, threadId);
    return;
  }
  if (cbData === "panel:files") {
    await tg.answerCallbackQuery(cq.id);
    try {
      await deps.files.showListing(chatId, threadId, "", { messageId: cq.message?.message_id });
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(fileErrorMessage(err))}`, threadOpts(threadId));
    }
    return;
  }
  if (cbData === "panel:models") {
    await tg.answerCallbackQuery(cq.id);
    await showModels(chatId, 0, cq.message?.message_id, threadId);
    return;
  }
  if (cbData === "panel:stop") {
    const s = getActiveSession(chatId, threadId);
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No active session");
      return;
    }
    s.stopped = true;
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    await oc.interrupt(s.sessionId).catch(() => {});
    await tg.answerCallbackQuery(cq.id, "Stopped");
    if (s.statusMessageId) {
      await tg
        .editRichMessage(chatId, s.statusMessageId, "⏹ <b>Stopped</b>", {
          ...threadOptsFor(s),
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      s.statusMessageId = undefined;
    }
    await tg.sendRichMessage(chatId, "⏹ stopped", threadOpts(threadId)).catch(() => {});
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

  const useMatch = cbData.match(/^use:(.+)$/);
  if (useMatch) {
    const sessionId = useMatch[1];
    const current = getActiveSession(chatId, threadId);
    if (current && current.statusMessageId) {
      await tg.answerCallbackQuery(cq.id, "Stop the current turn first").catch(() => {});
      return;
    }
    await tg.answerCallbackQuery(cq.id, "Switching…");
    try {
      await activateSession(chatId, sessionId, true, threadId);
      if (cq.message?.message_id) {
        await tg.editRichMessage(chatId, cq.message.message_id, `✅ Switched to session\n<code>${esc(sessionId)}</code>`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📂 Sessions", callback_data: "panel:sessions" },
                { text: "🏠 Panel", callback_data: "panel:home" },
              ],
            ],
          },
        });
      }
    } catch (err) {
      await tg.answerCallbackQuery(cq.id, "Failed");
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
    }
    return;
  }

  const pageMatch = cbData.match(/^sessions:page:(\d+)$/);
  if (pageMatch) {
    await tg.answerCallbackQuery(cq.id);
    await showSessions(chatId, parseInt(pageMatch[1], 10), cq.message?.message_id, threadId);
    return;
  }
  const modelsPageMatch = cbData.match(/^models:page:(\d+)$/);
  if (modelsPageMatch) {
    await tg.answerCallbackQuery(cq.id);
    await showModels(chatId, parseInt(modelsPageMatch[1], 10), cq.message?.message_id, threadId);
    return;
  }

  const modelMatch = cbData.match(/^model:(\d+)$/);
  if (modelMatch) {
    const idx = parseInt(modelMatch[1], 10);
    const scope = routeKey(chatId, threadId);
    const models = modelListByChat.get(scope) ?? [];
    const model = models[idx];
    const s = getActiveSession(chatId, threadId);
    if (!model || !s) {
      await tg.answerCallbackQuery(cq.id, "No active session/model");
      return;
    }
    pendingModelByChat.set(scope, model);
    const variants = Array.isArray(model.variants) ? model.variants : [];
    const keyboard: any[][] = [];
    for (const v of variants) {
      keyboard.push([{ text: v.id === model.variants?.[0]?.id ? `${v.id} (default)` : v.id, callback_data: `variant:${v.id}` }]);
    }
    keyboard.push([{ text: "Default", callback_data: "variant:default" }]);
    keyboard.push([
      { text: "🧠 Models", callback_data: "panel:models" },
      { text: "🏠 Panel", callback_data: "panel:home" },
    ]);
    await tg.answerCallbackQuery(cq.id);
    if (cq.message?.message_id) {
      await tg.editRichMessage(
        chatId,
        cq.message.message_id,
        `Select variant for <b>${esc(model.name ?? model.id)}</b>\n<code>${esc(model.providerID)}/${esc(model.id)}</code>`,
        { reply_markup: { inline_keyboard: keyboard } },
      );
    }
    return;
  }

  const variantMatch = cbData.match(/^variant:(.+)$/);
  if (variantMatch) {
    const variantId = variantMatch[1];
    const scope = routeKey(chatId, threadId);
    const model = pendingModelByChat.get(scope);
    const s = getActiveSession(chatId, threadId);
    if (!model || !s) {
      await tg.answerCallbackQuery(cq.id, "No pending model");
      return;
    }
    const variant = variantId === "default" ? undefined : variantId;
    await tg.answerCallbackQuery(cq.id, "Switching model…");
    try {
      await oc.switchModel(s.sessionId, { id: model.id, providerID: model.providerID, variant });
      pendingModelByChat.delete(scope);
      s.model = { id: model.id, providerID: model.providerID, variant };
      if (cq.message?.message_id) {
        await tg.editRichMessage(
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
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
    }
    return;
  }

  const agentMatch = cbData.match(/^agent:(.+)$/);
  if (agentMatch) {
    const name = agentMatch[1];
    const s = await ensureActiveSession(chatId, threadId);
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No active session");
      return;
    }
    await tg.answerCallbackQuery(cq.id, `Switching to ${name}…`);
    try {
      await oc.switchAgent(s.sessionId, name);
      if (cq.message?.message_id) {
        await tg.editRichMessage(chatId, cq.message.message_id, `✅ Agent switched to <b>${esc(name)}</b>`, {
          reply_markup: { inline_keyboard: [[{ text: "🏠 Panel", callback_data: "panel:home" }]] },
        });
      } else {
        await tg.sendRichMessage(chatId, `Agent switched to ${esc(name)}`);
      }
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
    }
    return;
  }

  const cmdMatch = cbData.match(/^cmd:(.+)$/);
  if (cmdMatch) {
    const name = cmdMatch[1];
    const s = getActiveSession(chatId, threadId);
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No active session");
      return;
    }
    await tg.answerCallbackQuery(cq.id, `Running /${name}…`);
    try {
      await oc.runCommand(s.sessionId, name, "");
      await tg.sendRichMessage(chatId, `ran /${esc(name)}`, threadOpts(threadId));
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
