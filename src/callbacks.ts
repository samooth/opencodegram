import type { BotDeps } from "./context.js";
import { fileErrorMessage } from "./files.js";
import { renderForm, formKeyboard } from "./formui.js";
import { extractEditFile, formatEditDiff, isEditTool } from "./editutil.js";
import * as mcp from "./mcp.js";
import { isSettingsKey, LABELS, renderSettings, settingsKeyboard } from "./settings.js";
import type { ChatSettings } from "./settings.js";
import type { TelegramCallbackQuery } from "./telegram.js";
import { esc, threadOpts } from "./util.js";

/** Inline keyboard actions: panels, session/model/agent pickers and permissions. */
export async function handleCallback(deps: BotDeps, cq: TelegramCallbackQuery): Promise<void> {
  const { config, tg, oc, store, pendingPermissions, awaitingReason, panels, sessions, modelListByChat, pendingModelByChat } = deps;
  const { routeKey, getActiveSession, threadOptsFor } = store;
  const { showSessions, showDeleteSessions, showModels, showCommands, showStatus, sendPanel, providerListByChat, selectedProviderByChat } = panels;
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

  // Delete-sessions pagination.
  const deletePageMatch = cbData.match(/^delsessions:page:(\d+)$/);
  if (deletePageMatch) {
    await tg.answerCallbackQuery(cq.id);
    await showDeleteSessions(chatId, parseInt(deletePageMatch[1], 10), cq.message?.message_id, threadId);
    return;
  }

  // Delete a session: ask for confirmation.
  const deleteSessionMatch = cbData.match(/^del:(.+)$/);
  if (deleteSessionMatch) {
    const sessionId = deleteSessionMatch[1];
    await tg.answerCallbackQuery(cq.id);
    await tg.sendRichMessage(chatId, `Delete session <code>${esc(sessionId)}</code>?`, {
      ...threadOpts(threadId),
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗑 Delete", callback_data: `delconfirm:${sessionId}` }, { text: "Cancel", callback_data: "panel:home" }],
        ],
      },
    });
    return;
  }

  // Confirm deletion.
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

  // MCP callbacks are namespaced with `mcp:`.
  const mcpData = cq.data ?? "";
  if (mcpData.startsWith("mcp:")) {
    const chatId = cq.message?.chat?.id ?? cq.from.id;
    const threadId = cq.message?.message_thread_id;
    const messageId = cq.message?.message_id;
    const s = getActiveSession(chatId, threadId);
    const directory = s?.directory ?? deps.config.OPENCODE_DIRECTORY ?? process.cwd();
    const parts = mcpData.split(":");
    const action = parts[1];
    const name = parts.slice(2).join(":");
    try {
      if (action === "connect" && name) {
        await deps.oc.client.mcp.connect({ server: name, location: { directory } } as any);
        await deps.tg.answerCallbackQuery(cq.id, "Connected").catch(() => {});
      } else if (action === "disconnect" && name) {
        await deps.oc.client.mcp.disconnect({ server: name, location: { directory } } as any);
        await deps.tg.answerCallbackQuery(cq.id, "Disconnected").catch(() => {});
      } else if (action === "remove" && name) {
        await deps.oc.client.mcp.remove({ server: name, location: { directory } } as any);
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
  if (cbData.startsWith("cycle:")) {
    const key = cbData.slice(6);
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
    return;
  }

  if (cbData.startsWith("set:")) {
    const [, key, value] = cbData.split(":");
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
    return;
  }
  if (cbData === "panel:home" || cbData === "panel:help") {
    await tg.answerCallbackQuery(cq.id);
    await sendPanel(chatId, threadId);
    return;
  }
  if (cbData === "panel:status") {
    await tg.answerCallbackQuery(cq.id);
    await showStatus(chatId, threadId);
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
    const scope = routeKey(chatId, threadId);
    const provider = selectedProviderByChat?.get(scope);
    await tg.answerCallbackQuery(cq.id);
    await showModels(chatId, parseInt(modelsPageMatch[1], 10), cq.message?.message_id, threadId, provider);
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
  const modelMatch = cbData.match(/^model:(\d+)$/);
  if (modelMatch) {
    const idx = parseInt(modelMatch[1], 10);
    const scope = routeKey(chatId, threadId);
    const models = modelListByChat.get(scope) ?? [];
    const model = models[idx];
    const s = getActiveSession(chatId, threadId);
    if (!model) {
      await tg.answerCallbackQuery(cq.id, "Model not found");
      return;
    }
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No active session");
      await tg.sendRichMessage(chatId, "No active session in this chat/topic. Activate or create one first.", {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] },
      }).catch(() => {});
      return;
    }
    pendingModelByChat.set(scope, model);
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
    if (!model) {
      await tg.answerCallbackQuery(cq.id, "No pending model");
      return;
    }
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No active session");
      await tg.sendRichMessage(chatId, "No active session in this chat/topic. Activate or create one first.", {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] },
      }).catch(() => {});
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
