import type { BotDeps } from "./context.js";
import { fileErrorMessage } from "./files/index.js";
import { renderForm, formKeyboard } from "./formui.js";
import * as mcp from "./mcp.js";
import { isSettingsKey, LABELS, renderSettings, settingsKeyboard } from "./settings.js";
import type { ChatSettings } from "./settings.js";
import type { TelegramCallbackQuery } from "./telegram.js";
import { listRepoDirectories, resolveRepoDirectory } from "./sessions.js";
import { splitMarkdown } from "./transcript.js";
import { showSessionPicker } from "./messages.js";
import { buildDigestParts } from "./syncview.js";
import { clampText, esc, markdownToHtml, sessionHeader, threadOpts } from "./util.js";
import { cancelAutoRetry, notePromptSent } from "./autoretry.js";
import { describeThrottles, throttleTotals } from "./ratethrottle.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  "spick:",
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
  "tpage:",
  "tpagep:",
  "tpick:",
  "hist:",
  "ops:",
  "profile:",
  "viewfull:",
].sort((a, b) => b.length - a.length);

/**
 * Navigate the paginated session card (◀/▶ pages of the session transcript).
 */
async function handleTranscriptPage(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^tpage:(.+):(\d+)$/);
  if (!m) return;
  const sessionId = m[1];
  const page = parseInt(m[2], 10);
  await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
  const s = deps.store.findSessionById(sessionId);
  if (!s || !deps.transcript) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch(() => {});
    return;
  }
  await deps.transcript.goToPage(chatId, s, page).catch((err) => {
    console.error("[tpage] failed", err);
  });
}

/**
 * /ops actions from the ops card: reset metrics or refresh the view (admin).
 */
async function handleOps(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  if (!deps.config.ADMIN_TELEGRAM_USER_ID || cq.from?.id !== deps.config.ADMIN_TELEGRAM_USER_ID) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo para el admin").catch(() => {});
    return;
  }
  const action = data.slice("ops:".length);
  if (action === "reset") {
    deps.metrics?.reset();
    await deps.tg.answerCallbackQuery(cq.id, "♻️ Métricas reiniciadas").catch(() => {});
  } else {
    await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
  }
  if (messageId) {
    const rendered = await deps.panels.renderOps();
    await deps.tg.editRichMessage(chatId, messageId, rendered.html, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: rendered.keyboard },
    }).catch(() => {});
  }
}

/**
 * 📜 Historial: export the full transcript of the session as an HTML document.
 */
async function handleHistory(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^hist:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  await deps.tg.answerCallbackQuery(cq.id, "Generando historial…").catch(() => {});
  const s = deps.store.findSessionById(sessionId);
  if (!s || !deps.transcript) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch(() => {});
    return;
  }
  try {
    const html = deps.transcript.exportTranscriptHtml(s);
    const name = (s.topicTitle || "").trim() || s.directory?.split("/").filter(Boolean).pop() || sessionId;
    const safeName = String(name).replace(/[^\w.-]+/g, "_").slice(0, 40) || sessionId.slice(0, 12);
    const path = join("/tmp/opencode/exports", `historial-${safeName}-${sessionId.slice(0, 8)}.html`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, html, "utf8");
    const blocks = deps.transcript.blocksOf(s).length;
    await deps.tg.sendDocument(chatId, path, `historial-${safeName}.html`, `📜 Historial de <b>${esc(name)}</b> · ${blocks} bloques`, {
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
    deps.metrics?.inc("history_exports");
  } catch (err) {
    console.error("[hist] export failed", err);
    await deps.tg.sendRichMessage(chatId, `❌ No se pudo generar el historial: ${esc(String(err))}`, threadOpts(threadId)).catch(() => {});
  }
}

/**
 * ⊞ Page picker: grid with one button per page for quick jumps.
 */
async function handlePagePicker(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const closeMatch = data.match(/^tpick:close:(.+)$/);
  if (closeMatch) {
    // Close: delete the picker message.
    await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
    if (cq.message?.message_id) await deps.tg.deleteMessage(chatId, cq.message.message_id).catch(() => {});
    return;
  }
  const m = data.match(/^tpick:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
  const s = deps.store.findSessionById(sessionId);
  if (!s || !deps.transcript) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch(() => {});
    return;
  }
  const total = deps.transcript.pageCount(s);
  if (total <= 1) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo hay una página").catch(() => {});
    return;
  }
  await deps.tg
    .sendRichMessage(chatId, `⊞ <b>Ir a página</b> · <i>${total} páginas de ${esc((s.topicTitle || "").trim() || sessionId.slice(0, 12))}</i>`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: deps.transcript.pagePickerKeyboard(s, total) },
    })
    .catch(() => {});
}

/**
 * Picker navigation: jump to the chosen page on the session card and close
 * the picker message so the chat does not fill with pickers.
 */
async function handlePickerJump(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^tpagep:(.+):(\d+)$/);
  if (!m) return;
  const sessionId = m[1];
  const page = parseInt(m[2], 10);
  await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
  if (cq.message?.message_id) await deps.tg.deleteMessage(chatId, cq.message.message_id).catch(() => {});
  const s = deps.store.findSessionById(sessionId);
  if (!s || !deps.transcript) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch(() => {});
    return;
  }
  await deps.transcript.goToPage(chatId, s, page).catch((err) => {
    console.error("[tpagep] failed", err);
  });
}

async function handlePerm(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {  const m = data.match(/^perm:(allow|always|reject|rejectreason):(.+)$/);
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
  await deps.tg.answerCallbackQuery(cq.id, "Connecting…").catch(() => {});
  try {
    const cs = await deps.sessions.activateSession(chatId, sessionId, true, threadId);
    // Show session content like a normal message (digest), linked to session.
    const resolvedCs = cs ?? deps.store.findSessionById(sessionId);
    let items: Array<Record<string, unknown>> = [];
    let contextError: string | undefined;
    try {
      const ctxData = await deps.oc.context(sessionId);
      items = (Array.isArray(ctxData) ? ctxData : ((ctxData as { data?: unknown })?.data ?? [])) as Array<Record<string, unknown>>;
    } catch (err) {
      contextError = String(err);
    }
    const parts = buildDigestParts(resolvedCs ?? null, items, {
      title: "📜 Contenido de la sesión",
      note: contextError ? `No se pudo cargar el contexto: ${contextError}` : "✅ Sesión conectada: los mensajes se envían a esta sesión",
      sessionId,
    });
    // First part replaces the clicked message; extra parts are new messages.
    const first = parts[0];
    const firstKeyboard = { inline_keyboard: first.keyboard };
    if (messageId) {
      await deps.tg.editRichMessage(chatId, messageId, first.html, { ...threadOpts(threadId), reply_markup: firstKeyboard }).catch(() => {});
      deps.store.rememberMessageSession(chatId, messageId, sessionId);
    } else {
      const sent = await deps.tg.sendRichMessage(chatId, first.html, { ...threadOpts(threadId), reply_markup: firstKeyboard }).catch(() => undefined);
      if (sent?.message_id) deps.store.rememberMessageSession(chatId, sent.message_id, sessionId);
    }
    for (const part of parts.slice(1)) {
      const sent = await deps.tg.sendRichMessage(chatId, part.html, { ...threadOpts(threadId), reply_markup: { inline_keyboard: part.keyboard } }).catch(() => undefined);
      if (sent?.message_id) deps.store.rememberMessageSession(chatId, sent.message_id, sessionId);
    }
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
      .then(() => { if (pending.name !== "goal") deps.tg.sendRichMessage(chatId, `ran /${esc(pending.name)}`, threadOpts(threadId)); })
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
  const userId = cq.from?.id;
  // Prefer the snapshot rendered in this very message: a shared index could
  // point to another model after a refresh or a concurrent user action.
  const panel = messageId !== undefined ? deps.panels.modelPanels.get(messageId) : undefined;
  const scope = panel?.scope ?? deps.panels.userScope(chatId, threadId, userId);
  const models = panel?.list ?? deps.modelListByChat.get(scope) ?? [];
  const model = models[idx];
  const targetId = panel?.targetSessionId ?? deps.panels.modelTargetSessionByScope.get(scope);
  const s = targetId ? deps.store.findSessionById(targetId) : deps.store.getActiveSession(chatId, threadId);
  if (!model) {
    await deps.tg.answerCallbackQuery(cq.id, "Model not found");
    return;
  }
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, targetId ? "Target session not found" : "No active session");
    await deps.tg.sendRichMessage(chatId, targetId ? `Target session not found: <code>${esc(targetId)}</code>` : "No active session in this chat/topic. Activate or create one first.", {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] },
    }).catch(() => {});
    return;
  }
  const pending = { id: model.id, providerID: model.providerID, variant: model.variant };
  if (messageId !== undefined) {
    const entry = deps.panels.modelPanels.get(messageId);
    if (entry) entry.pendingModel = pending;
  }
  if (!messageId) deps.pendingModelByChat.set(scope, pending);
  const variants = Array.isArray(model.variants) ? model.variants : [];
  const keyboard: any[][] = [];
  for (const v of variants) {
    keyboard.push([{ text: v.id === model.variants?.[0]?.id ? `${v.id} (default)` : v.id, callback_data: `variant:${v.id}` }]);
  }
  keyboard.push([{ text: "Default", callback_data: "variant:default" }]);
  keyboard.push([{ text: "❌ Cancel", callback_data: "modelcancel" }]);
  keyboard.push([
    { text: "🧠 Models", callback_data: `panel:ms:${s.sessionId}` },
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
  const userId = cq.from?.id;
  const panel = messageId !== undefined ? deps.panels.modelPanels.get(messageId) : undefined;
  const scope = panel?.scope ?? deps.panels.userScope(chatId, threadId, userId);
  const model = panel?.pendingModel ?? deps.pendingModelByChat.get(scope);
  const targetId = panel?.targetSessionId ?? deps.panels.modelTargetSessionByScope.get(scope);
  const s = targetId ? deps.store.findSessionById(targetId) : deps.store.getActiveSession(chatId, threadId);
  if (!model) {
    await deps.tg.answerCallbackQuery(cq.id, "No pending model");
    return;
  }
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, targetId ? "Target session not found" : "No active session");
    await deps.tg.sendRichMessage(chatId, targetId ? `Target session not found: <code>${esc(targetId)}</code>` : "No active session in this chat/topic. Activate or create one first.", {
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
    if (panel) panel.pendingModel = undefined;
    s.model = { id: model.id, providerID: model.providerID, variant };
    if (cq.message?.message_id) {
      await deps.tg.editRichMessage(
        chatId,
        cq.message.message_id,
        `${sessionHeader(s)}✅ Model switched\n<code>${esc(model.providerID)}/${esc(model.id)}</code>${variant ? " (" + esc(variant) + ")" : ""}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🧠 Models", callback_data: `panel:ms:${s.sessionId}` },
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
  if (key === "previewLines" || key === "longAnswerThreshold") parsedValue = Number(value);
  else if (key === "diffStyle") parsedValue = value === "unified" ? "unified" : "simple";
  else if (key === "cardBehavior")
    parsedValue = value === "refloat_keep" ? "refloat_keep" : value === "refloat" ? "refloat" : "fixed";
  else if (key === "displayMode") parsedValue = value === "unified" ? "unified" : "flexible";
  else if (key === "longAnswerDelivery")
    parsedValue = value === "message" ? "message" : value === "auto" ? "auto" : "card";
  else parsedValue = value === "true";
  const settings = deps.settings.set(chatId, key, parsedValue);

  if (key === "displayMode") {
    if (parsedValue === "unified") {
      const s = deps.store.getActiveSession(chatId, threadId) ?? (await deps.sessions.restoreActiveSession(chatId, threadId).catch(() => undefined));
      if (s) await deps.dashboard.ensure(chatId, threadId, s, { working: !!s.statusMessageId && !s.statusFinished }).catch(() => {});
    } else {
      const dash = deps.store.getDashboard(chatId, threadId);
      if (dash) await deps.tg.unpinChatMessage(chatId, { message_id: dash.messageId }).catch(() => {});
    }
  }

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
  if (key === "longAnswerThreshold") {
    const presets = [800, 1200, 1800, 2600, 3600];
    const current = deps.settings.get(chatId).longAnswerThreshold;
    const next = presets[(presets.indexOf(current) + 1) % presets.length] ?? presets[0];
    const settings = deps.settings.set(chatId, "longAnswerThreshold", next);
    await deps.tg.answerCallbackQuery(cq.id, `${LABELS.longAnswerThreshold} → ${next}`).catch(() => {});
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
  const { tg, panels, sessions, files, oc, store, settings } = deps;
  // The pinned dashboard (M1) must not be replaced by panel views.
  const dash = store.getDashboard(chatId, threadId);
  const editId = dash && dash.messageId === messageId ? undefined : messageId;
  if (data === "panel:home" || data === "panel:help") {
    await tg.answerCallbackQuery(cq.id);
    await panels.sendPanel(chatId, threadId);
    return;
  }
  if (data === "panel:settings") {
    await tg.answerCallbackQuery(cq.id);
    const s = settings.get(chatId);
    await tg.sendRichMessage(chatId, renderSettings(chatId, s), {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: settingsKeyboard(s) },
    });
    return;
  }
  if (data === "panel:status") {
    await tg.answerCallbackQuery(cq.id);
    await panels.showStatus(chatId, threadId, editId);
    return;
  }
  if (data === "panel:sessions") {
    await tg.answerCallbackQuery(cq.id);
    // Always send a fresh message (do not replace the clicked one) so the
    // sessions list stays visible and does not overwrite the current view.
    await panels.showSessions(chatId, 0, undefined, threadId);
    return;
  }
  if (data === "panel:new") {
    const repos = listRepoDirectories(deps.config);
    if (repos.length) {
      await tg.answerCallbackQuery(cq.id);
      const keyboard: any[][] = repos.map((name) => [{ text: name, callback_data: `repo:${name}` }]);
      keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
      await tg.sendRichMessage(chatId, "Elige el repositorio para la nueva sesión:", { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } });
      return;
    }
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
      await files.showListing(chatId, threadId, "", { messageId: editId });
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(fileErrorMessage(err))}`, threadOpts(threadId));
    }
    return;
  }
  if (data === "panel:models") {
    await tg.answerCallbackQuery(cq.id);
    await panels.showModels(chatId, 0, editId, threadId, undefined, null, { userId: cq.from?.id });
    return;
  }
  if (data.startsWith("panel:ms:")) {
    const targetSessionId = data.slice("panel:ms:".length).trim();
    await tg.answerCallbackQuery(cq.id);
    await panels.showModels(chatId, 0, editId, threadId, undefined, targetSessionId || null, { userId: cq.from?.id });
    return;
  }
  if (data === "panel:stop") {
    let s = store.getActiveSession(chatId, threadId);
    // The Stop button lives in the status card of a specific session. Prefer
    // that session: a detached session can keep working in another tab while
    // this route already shows a different one.
    if (messageId !== undefined) {
      const sid = store.findSessionByStatusMessage(chatId, messageId) ?? store.messageToSession.get(`${chatId}:${messageId}`);
      if (sid) s = store.sessionsById.get(sid) ?? store.findSessionById(sid);
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
    if (s.transcriptMessageId) {
      // The session card keeps its paginated transcript; only the live part ends.
      await deps.status.publishCard(chatId, s).catch(() => {});
      s.statusMessageId = undefined;
    } else if (s.statusMessageId) {
      await tg
        .editRichMessage(chatId, s.statusMessageId, "⏹ <b>Stopped</b>", {
          ...store.threadOptsFor(s),
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      s.statusMessageId = undefined;
    }
    const stoppedMsg = await tg.sendRichMessage(chatId, "⏹ stopped", threadOpts(threadId)).catch(() => undefined);
    if (stoppedMsg?.message_id) store.rememberMessageSession(chatId, stoppedMsg.message_id, s.sessionId);
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
  const pageMatch = data.match(/^sessions:page:(\d+)(?::(all|running|group))?$/);
  if (pageMatch) {
    const page = parseInt(pageMatch[1], 10);
    const mode = pageMatch[2] ?? "all";
    await deps.tg.answerCallbackQuery(cq.id);
    if (mode === "running") await deps.panels.showSessions(chatId, page, cq.message?.message_id, threadId, undefined, true);
    else if (mode === "group") await deps.panels.showSessions(chatId, page, cq.message?.message_id, threadId, chatId);
    else await deps.panels.showSessions(chatId, page, cq.message?.message_id, threadId);
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
      .then(() => { if (name !== "goal") deps.tg.sendRichMessage(chatId, `ran /${esc(name)}`, threadOpts(threadId)); })
      .catch((err) => deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)));
  } catch (err) {
    await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
  }
}

async function handleProfile(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const name = data.slice("profile:".length);
  let settings = deps.settings.get(chatId);
  if (name === "unified") {
    settings = deps.settings.set(chatId, "displayMode", "unified");
    settings = deps.settings.set(chatId, "longAnswerDelivery", "auto");
    settings = deps.settings.set(chatId, "cardBehavior", "refloat");
  } else if (name === "unified_split") {
    settings = deps.settings.set(chatId, "displayMode", "unified");
    settings = deps.settings.set(chatId, "longAnswerDelivery", "message");
    settings = deps.settings.set(chatId, "cardBehavior", "refloat_keep");
  } else if (name === "flexible") {
    settings = deps.settings.set(chatId, "displayMode", "flexible");
    settings = deps.settings.set(chatId, "longAnswerDelivery", "auto");
  } else {
    await deps.tg.answerCallbackQuery(cq.id, "Perfil desconocido").catch(() => {});
    return;
  }
  if (settings.displayMode === "unified") {
    const s = deps.store.getActiveSession(chatId, threadId) ?? (await deps.sessions.restoreActiveSession(chatId, threadId).catch(() => undefined));
    if (s) await deps.dashboard.ensure(chatId, threadId, s, { working: !!s.statusMessageId && !s.statusFinished }).catch(() => {});
  } else {
    const dash = deps.store.getDashboard(chatId, threadId);
    if (dash) await deps.tg.unpinChatMessage(chatId, { message_id: dash.messageId }).catch(() => {});
  }
  await deps.tg.answerCallbackQuery(cq.id, `Perfil: ${name}`).catch(() => {});
  if (messageId !== undefined) {
    await deps.tg
      .editRichMessage(chatId, messageId, renderSettings(chatId, settings), {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: settingsKeyboard(settings) },
      })
      .catch(() => {});
  }
}

async function handleViewFull(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const sessionId = data.slice("viewfull:".length);
  await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
  const s = deps.store.findSessionById(sessionId);
  const text = s?.lastFinalText;
  if (!s || !text) {
    await deps.tg.sendRichMessage(chatId, "No hay respuesta completa disponible.", threadOpts(threadId)).catch(() => {});
    return;
  }
  const parts = splitMarkdown(text, 3200);
  if (parts.length <= 1) {
    await deps.tg.sendRichMessage(chatId, clampText(`${sessionHeader(s)}${markdownToHtml(text)}`, 3900), threadOpts(threadId)).catch(() => {});
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    const prefix = `<i>(${i + 1}/${parts.length})</i>\n`;
    const piece = `${sessionHeader(s)}${prefix}${markdownToHtml(chunk)}`;
    await deps.tg.sendRichMessage(chatId, clampText(piece, 3900), threadOpts(threadId)).catch(() => {});
  }
}

export const CALLBACK_DISPATCH: Record<string, CallbackHandler> = {
  "fs:": handleFs,
  "tpage:": handleTranscriptPage,
  "tpagep:": handlePickerJump,
  "tpick:": handlePagePicker,
  "hist:": handleHistory,
  "ops:": handleOps,
  "panel:": handlePanel,
  "perm:": handlePerm,
  "spick:": async (deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) => {
    const m = data.match(/^spick:(\d+)$/);
    if (!m) return;
    await deps.tg.answerCallbackQuery(cq.id).catch(() => {});
    const page = parseInt(m[1], 10);
    if (messageId !== undefined) await deps.tg.deleteMessage(chatId, messageId).catch(() => {});
    await showSessionPicker(deps, chatId, threadId, page);
  },
  "use:": async (deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) => {
    const m = data.match(/^use:(.+)$/);
    if (!m) return;
    const sessionId = m[1];
    await deps.tg.answerCallbackQuery(cq.id, "Connecting…");
    try {
      const cs = await deps.sessions.activateSession(chatId, sessionId, true, threadId);
      // Rename the tab to the connected session (best-effort; works in
      // private threaded chats, silently fails in groups without permission).
      if (cs) {
        cs.topicTitle = undefined;
        await deps.sessions.syncTopicTitle(chatId, cs).catch(() => {});
      }
      // A message may have been waiting for the user to pick a session.
      const route = deps.store.routeKey(chatId, threadId);
      const pending = deps.pendingGroupPrompts.get(route);
      if (pending && Date.now() - pending.at < 10 * 60 * 1000) {
        deps.pendingGroupPrompts.delete(route);
        const s = deps.store.findSessionById(sessionId);
        if (s) {
          s.targetChatId = chatId;
          s.targetThreadId = threadId;
          await deps.status.startStatus(chatId, s);
          void deps.oc.prompt(s.sessionId, pending.text, pending.files).catch((err) => {
            deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch(() => {});
          });
          return;
        }
      }
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
  "profile:": handleProfile,
  "viewfull:": handleViewFull,
};

export const callbackDispatch = CALLBACK_DISPATCH;
export const dispatch = CALLBACK_DISPATCH;
export const handlers = CALLBACK_DISPATCH;

export async function handleCallback(deps: BotDeps, cq: TelegramCallbackQuery): Promise<void> {
  const { config, tg, oc, store, pendingPermissions, awaitingReason, panels, sessions, modelListByChat, pendingModelByChat } = deps;
  const { routeKey, getActiveSession, threadOptsFor } = store;
  const { showSessions, showDeleteSessions, showModels, showCommands, showStatus, sendPanel, providerListByChat, selectedProviderByChat } = panels;
  const { activateSession, ensureActiveSession, createNewSession } = sessions;

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
  // Custom reply buttons.
  const btnMatch = cbData.match(/^btn:(\d+)$/);
  if (btnMatch) {
    const idx = Number(btnMatch[1]);
    const buttons = deps.store.getCustomButtons(chatId);
    const btn = buttons[idx];
    if (!btn) {
      await tg.answerCallbackQuery(cq.id, "Button expired");
      return;
    }
    await tg.answerCallbackQuery(cq.id, btn.label).catch(() => {});
    const s = deps.store.getActiveSession(chatId, threadId);
    if (!s) {
      await tg.sendRichMessage(chatId, "no active session.", threadOpts(threadId));
      return;
    }
    // Send the configured text as a prompt.
    const send = (html: string, opts: Record<string, unknown> = {}) => tg.sendRichMessage(chatId, html, { ...(threadId ? { message_thread_id: threadId } : {}), ...opts });
    await deps.status.startStatus(chatId, s).catch(() => {});
    void deps.oc.prompt(s.sessionId, btn.text).catch(async (err) => {
      await send(`❌ ${esc(String(err))}`);
    });
    return;
  }

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

  const repoMatch = cbData.match(/^(?:repo|newrepo|repos|new:repo|repo:new):(.+)$/);
  if (repoMatch) {
    const repoName = repoMatch[1].trim();
    await tg.answerCallbackQuery(cq.id, "Creating…");
    const directory = resolveRepoDirectory(deps.config, repoName) ?? repoName;
    try {
      await sessions.createNewSession(chatId, false, threadId, directory);
      await panels.sendPanel(chatId, threadId).catch(() => {});
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
    }
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
    const userId = cq.from?.id;
    const scope = deps.panels.userScope(chatId, threadId, userId);
    const providers = providerListByChat.get(scope) ?? [];
    const raw = provMatch[1];
    if (raw === "back") {
      await tg.answerCallbackQuery(cq.id);
      await showModels(chatId, 0, cq.message?.message_id, threadId, undefined, undefined, { userId });
      return;
    }
    const index = parseInt(raw, 10);
    const provider = providers[index];
    if (!provider) {
      await tg.answerCallbackQuery(cq.id, "Provider not found");
      return;
    }
    await tg.answerCallbackQuery(cq.id);
    await showModels(chatId, 0, cq.message?.message_id, threadId, provider, undefined, { userId });
    return;
  }

  if (cbData === "modelcancel") {
    const userId = cq.from?.id;
    const scope = deps.panels.userScope(chatId, threadId, userId);
    pendingModelByChat.delete(scope);
    deps.panels.modelTargetSessionByScope.delete(scope);
    if (messageId !== undefined) deps.panels.modelPanels.delete(messageId);
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
    const userId = cq.from?.id;
    const scope = deps.panels.userScope(chatId, threadId, userId);
    const provider = selectedProviderByChat?.get(scope);
    await tg.answerCallbackQuery(cq.id);
    await showModels(chatId, parseInt(modelsPageMatch[1], 10), cq.message?.message_id, threadId, provider, undefined, { userId });
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
    // Route the form's follow-up responses to the tab where the form lives.
    deps.store.rememberDelivery(state.sessionId, state.chatId, state.threadId);
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

  const match = data.match(/^fq:(\d+):(-?\d+)$/);
  if (!match) {
    await deps.tg.answerCallbackQuery(cq.id, "Unknown form action").catch(() => {});
    return true;
  }
  const fieldIndex = Number(match[1]);
  const optionIndex = Number(match[2]);
  const field = state.fields[fieldIndex];
  if (!field) {
    await deps.tg.answerCallbackQuery(cq.id, "Expired").catch(() => {});
    return true;
  }
  const multi = (() => {
    const t = (field.type || "").toLowerCase();
    if (t.includes("multi") || t.includes("array") || t.includes("list")) return true;
    return (field as { multiple?: boolean }).multiple === true;
  })();

  if (optionIndex === -1) {
    await deps.tg.answerCallbackQuery(cq.id, "Done").catch(() => {});
    await deps.tg
      .editRichMessage(chatId, messageId, renderForm(state), {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: formKeyboard(state) },
      })
      .catch(() => {});
    return true;
  }

  const option = field.options?.[optionIndex];
  if (!option) {
    await deps.tg.answerCallbackQuery(cq.id, "Expired").catch(() => {});
    return true;
  }

  if (multi) {
    const current = Array.isArray(state.answers[field.key]) ? [...(state.answers[field.key] as unknown as string[])] : [];
    const idx = current.indexOf(option.value);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(option.value);
    state.answers[field.key] = current;
    await deps.tg.answerCallbackQuery(cq.id, current.includes(option.value) ? `Added ${option.label}` : `Removed ${option.label}`).catch(() => {});
  } else {
    state.answers[field.key] = option.value;
    await deps.tg.answerCallbackQuery(cq.id, `Selected ${option.label}`).catch(() => {});
  }
  await deps.tg
    .editRichMessage(chatId, messageId, renderForm(state), {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: formKeyboard(state) },
    })
    .catch(() => {});
  return true;
}
