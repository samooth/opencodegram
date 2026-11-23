import { isDangerousCommand, isChatAdminCommand } from "./dangerous.js";
import { handleCommand } from "./commands.js";
import { isRouteAdmin } from "./commands/shared.js";
import type { InlineKeyboard } from "./apitypes.js";
import type { BotDeps } from "./context.js";
import { fileErrorMessage } from "./files/index.js";
import { renderForm, formKeyboard } from "./formui.js";
import * as mcp from "./mcp.js";
import { CARD_PRESETS, isSettingsKey, LABELS, PRESET_LABELS, renderSettingsPanel, settingsKeyboard } from "./settings.js";
import type { CardPreset, ChatSettings } from "./settings.js";
import type { TelegramCallbackQuery } from "./telegram.js";
import { listRepoDirectories, resolveRepoDirectory } from "./sessions.js";
import { splitMarkdown } from "./transcript.js";
import { extractEditFile } from "./editutil.js";
import { getActivityReadPath } from "./transcriptmanager.js";
import { buildGlobalAllowed } from "./permissions.js";
import { dbStats, renderDbPanel, vacuum } from "./db.js";
import { collectStats, renderStatsPanel, writeStatsReport, type StatsPeriod, type StatsScope } from "./stats.js";
import { isShellTool, parseShellCommand } from "./status-render.js";
import { showSessionPicker } from "./messages.js";
import { clampText, copyTextButton, esc, markdownToHtml, sessionHeader, threadOpts, truncate } from "./util.js";
import { cancelAutoRetry, notePromptSent } from "./autoretry.js";
import { join } from "node:path";
import { handleTranscriptPage, handleCardView, handleHistory, handleHistoryFormatPicker, handlePagePicker, handlePickerJump } from "./callbacks/history.js";

type CallbackHandler = (
  deps: BotDeps,
  cq: TelegramCallbackQuery,
  chatId: number,
  threadId: number | undefined,
  messageId: number | undefined,
  data: string,
) => Promise<void>;

const PREFIXES = [
  "panel:",
  "perm:",
  "permthread:",
  "permui:",
  "db:",
  "stats:",
  "settings:",
  "use:",
  "spick:",
  "del:",
  "delsessions:",
  "model:",
  "agent:",
  "variant:",
  "set:",
  "cycle:",
  "preset:",
  "goal:",
  "qswitch:",
  "runcmd:",
  "connect:",
  "sessions:",
  "cmd:",
  "botcmd:",
  "tpage:",
  "tpagep:",
  "tpick:",
  "read:",
  "back:",
  "menu:",
  "hist:",
  "histfmt:",
  "ops:",
  "profile:",
  "viewfull:",
  "activity:",
  "editfile:",
  "readfile:",
  "resources:",
  "patch:",
  "copy:",
].sort((a, b) => b.length - a.length);

/**
 * Navigate the paginated session card (◀/▶ pages of the session transcript).
 */
/**
 * /ops actions from the ops card: reset metrics or refresh the view (admin).
 */
async function handleOps(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  if (!isRouteAdmin(deps, chatId, threadId, cq.from?.id)) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo para el admin").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const action = data.slice("ops:".length);
  if (action === "reset") {
    deps.metrics?.reset();
    await deps.tg.answerCallbackQuery(cq.id, "♻️ Métricas reiniciadas").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  } else {
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
  if (messageId) {
    const rendered = await deps.panels.renderOps();
    await deps.tg.editRichMessage(chatId, messageId, rendered.html, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: rendered.keyboard },
    }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

/**
 * 📜 Historial: export the full transcript of the session as an HTML document.
 */
async function handlePerm(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^perm:(allow|always|reject|rejectreason):(.+)$/);
  if (!m) return;
  const action = m[1];
  const requestId = m[2];
  const info = deps.pendingPermissions.get(requestId);
  if (!info) {
    await deps.tg.answerCallbackQuery(cq.id, "Permiso desconocido").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  if (info.decided) {
    await deps.tg.answerCallbackQuery(cq.id, "Ya decidido").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  if (action === "rejectreason") {
    // A reason is pending: clear the auto-reject timer so it does not fire
    // while the user types. handleMessage will finish the decision by calling
    // replyPermission("reject") with the reason text.
    if (info.timeoutHandle) clearTimeout(info.timeoutHandle);
    const reasonKey = deps.store.routeKey(info.chatId, cq.message?.message_thread_id);
    deps.awaitingReason.set(reasonKey, requestId);
    setTimeout(() => {
      if (deps.awaitingReason.get(reasonKey) === requestId) deps.awaitingReason.delete(reasonKey);
    }, 2 * 60 * 1000);
    await deps.tg.answerCallbackQuery(cq.id, "Envía el motivo como mensaje").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (info.messageId) {
      await deps.tg.editRichMessage(info.chatId, info.messageId, `<b>Reject with reason</b>\nSend your reason in the next message.`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
    return;
  }
  let decision: "once" | "always" | "reject" = "reject";
  if (action === "allow") decision = "once";
  else if (action === "always") {
    // Any operator who may prompt in this route can whitelist a tool. The
    // button used to be admin-only and rejected operators with "Solo admin".
    const routeKey = (deps.store.routeKey ?? ((c: number, t?: number) => `${c}:${t ?? 0}`))(chatId, threadId);
    const allowed = deps.permissions
      ? deps.permissions.canPrompt(routeKey, cq.from?.id, buildGlobalAllowed(deps.config))
      : !!deps.config.ADMIN_TELEGRAM_USER_ID && cq.from?.id === deps.config.ADMIN_TELEGRAM_USER_ID;
    if (!allowed) {
      await deps.tg.answerCallbackQuery(cq.id, "Sin permiso").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
    decision = "always";
  }
  info.decided = true;
  if (info.timeoutHandle) clearTimeout(info.timeoutHandle);
  // A pending "reject with reason" must not consume the next user message.
  deps.awaitingReason.delete(deps.store.routeKey(info.chatId, cq.message?.message_thread_id));
  await deps.oc.replyPermission(info.sessionId, requestId, decision);
  await deps.tg.answerCallbackQuery(cq.id, decision === "once" ? "Allowed" : decision === "always" ? "Always allowed" : "Rejected").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  if (info.messageId) {
    await deps.tg
      .editRichMessage(info.chatId, info.messageId, `<b>Permission ${decision}</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`)
      .catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
  deps.pendingPermissions.delete(requestId);
}

async function handleConnect(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^connect:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  await deps.tg.answerCallbackQuery(cq.id, "Conectando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  try {
    const cs = await deps.sessions.activateSession(chatId, sessionId, true, threadId);
    const resolvedCs = cs ?? deps.store.findSessionById(sessionId);
    // Show the session like a normal turn: the card in groups, a normal
    // message in private chats. No digest.
    if (chatId < 0 && deps.transcript) {
      // Group: publish the session card (current page = last answer if idle).
      await deps.status.publishCard(chatId, resolvedCs!);
      if (resolvedCs?.transcriptMessageId) {
        deps.store.rememberMessageSession(chatId, resolvedCs.transcriptMessageId, sessionId);
      }
      if (messageId) deps.store.rememberMessageSession(chatId, messageId, sessionId);
    } else {
      // Private: send a normal message with session info + last answer.
      const s = resolvedCs;
      const lines: string[] = [];
      if (s) lines.push(sessionHeader(s).trimEnd());
      lines.push("✅ <b>Sesión conectada</b>");
      if (s?.model) lines.push(`🧠 ${esc(s.model.providerID)}/${esc(s.model.id)}${s.model.variant ? ` (${esc(s.model.variant)})` : ""}`);
      if (s?.directory) lines.push(`📁 <code>${esc(s.directory)}</code>`);
      if (s?.lastFinalText) lines.push("", s.lastFinalText.slice(0, 3000));
      // P2: a short recap so reconnecting feels like picking up a conversation,
      // not starting cold. Last prompt + activity counts come from local state.
      const lastPrompt = deps.store.lastPromptBySession.get(sessionId);
      const a = s?.activity;
      const counts = a
        ? [`${a.thoughts} pensamientos`, `${a.reads} lecturas`, `${a.edits} ediciones`, `${a.shells} comandos`]
          .filter((part) => !part.startsWith("0 ")).join(" · ")
        : "";
      if (lastPrompt || counts) {
        lines.push("", "⏮ <b>Recap</b>");
        if (lastPrompt) lines.push(`👤 <i>${esc(truncate(lastPrompt, 160))}</i>`);
        if (counts) lines.push(`🔧 <i>${esc(counts)}</i>`);
        if (s?.model) lines.push(`🧠 <code>${esc(s.model.providerID)}/${esc(s.model.id)}</code>`);
      }
      const html = lines.join("\n");
      const keyboard = [[
        { text: "🧠 Models", callback_data: `panel:ms:${sessionId}` },
        { text: "📂 Sessions", callback_data: "panel:sessions" },
        { text: "📊 Status", callback_data: "panel:status" },
      ]];
      if (messageId) {
        await deps.tg.editRichMessage(chatId, messageId, clampText(html, 3900), { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
        deps.store.rememberMessageSession(chatId, messageId, sessionId);
      } else {
        const sent = await deps.tg.sendRichMessage(chatId, clampText(html, 3900), { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } }).catch(() => undefined);
        if (sent?.message_id) deps.store.rememberMessageSession(chatId, sent.message_id, sessionId);
      }
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
  await deps.tg.answerCallbackQuery(cq.id, "Cambiando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
  await deps.tg.answerCallbackQuery(cq.id, action === "clear" ? "Limpiando…" : "Trabajando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  try {
    void deps.oc.runCommand(sessionId, "goal", action).catch((err) => {
      deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
    await deps.tg.answerCallbackQuery(cq.id, "Expirado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.tg.sendRichMessage(chatId, "Confirmación expirada.", threadOpts(threadId));
    return;
  }
  deps.pendingConfirmations.delete(key);
  if (!isRouteAdmin(deps, chatId, threadId, cq.from?.id)) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo admin").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, "Ejecutando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  await deps.panels.showDeleteSessions(chatId, parseInt(m[1], 10), cq.message?.message_id, threadId);
}

async function handleDel(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^del:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  await deps.tg.sendRichMessage(chatId, `Delete session <code>${esc(sessionId)}</code>?`, {
    ...threadOpts(threadId),
    reply_markup: {
      inline_keyboard: [
        [{ text: "🗑 Borrar", callback_data: `delconfirm:${sessionId}` }, { text: "Cancelar", callback_data: "panel:home" }],
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
  type UiModel = { id: string; providerID: string; variant?: string; name?: string; variants?: Array<{ id?: string } | string> };
  const models = (panel?.list ?? deps.modelListByChat.get(scope) ?? []) as UiModel[];
  const model = models[idx];
  const targetId = panel?.targetSessionId ?? deps.panels.modelTargetSessionByScope.get(scope);
  const s = targetId ? deps.store.findSessionById(targetId) : deps.store.getActiveSession(chatId, threadId);
  if (!model) {
    await deps.tg.answerCallbackQuery(cq.id, "Modelo no encontrado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, targetId ? "Target session not found" : "No hay sesión activa").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.tg.sendRichMessage(chatId, targetId ? `Target session not found: <code>${esc(targetId)}</code>` : "No active session in this chat/topic. Activate or create one first.", {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] },
    }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const pending = { id: model.id ?? "", providerID: model.providerID ?? "", variant: model.variant };
  if (messageId !== undefined) {
    const entry = deps.panels.modelPanels.get(messageId);
    if (entry) entry.pendingModel = pending;
  }
  if (!messageId) deps.pendingModelByChat.set(scope, pending);
  const variants = Array.isArray(model.variants) ? model.variants : [];
  const keyboard: InlineKeyboard = [];
  const variantIds = variants.map((v) => (typeof v === "string" ? v : v.id ?? ""));
  const defaultVariant = variantIds[0] ?? "";
  for (const v of variantIds) {
    keyboard.push([{ text: v === defaultVariant ? `${v} (default)` : v, callback_data: `variant:${v}` }]);
  }
  keyboard.push([{ text: "Predeterminado", callback_data: "variant:default" }]);
  keyboard.push([{ text: "❌ Cancel", callback_data: "modelcancel" }]);
  keyboard.push([
    { text: "🧠 Models", callback_data: `panel:ms:${s.sessionId}` },
    { text: "🏠 Panel", callback_data: "panel:home" },
  ]);
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
    await deps.tg.answerCallbackQuery(cq.id, "No hay sesión activa").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, `Switching to ${name}…`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
    await deps.tg.answerCallbackQuery(cq.id, "No hay modelo pendiente").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, targetId ? "Target session not found" : "No hay sesión activa").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.tg.sendRichMessage(chatId, targetId ? `Target session not found: <code>${esc(targetId)}</code>` : "No active session in this chat/topic. Activate or create one first.", {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] },
    }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const variant = variantId === "default" ? undefined : variantId;
  await deps.tg.answerCallbackQuery(cq.id, "Cambiando modelo…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  try {
    await deps.oc.switchModel(s.sessionId, { id: model.id, providerID: model.providerID, variant });
    deps.pendingModelByChat.delete(scope);
    if (panel) panel.pendingModel = undefined;
    s.model = { id: model.id, providerID: model.providerID, variant };
    // Refresh the context window: keeping the old model's value would make
    // the CTX line show a bogus percentage (or >100%) after a model switch.
    void deps.oc.contextWindow(model.providerID, model.id).then((cw) => {
      if (cw && s.model?.id === model.id) s.contextWindow = cw;
    }).catch((err) => console.warn("[callbacks] contextWindow refresh failed", err?.message ?? err));
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
    await deps.tg.answerCallbackQuery(cq.id, "Opción desconocida").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  let parsedValue: ChatSettings[keyof ChatSettings];
  if (key === "previewLines" || key === "longAnswerThreshold") parsedValue = Number(value);
  else if (key === "onboardingStep") parsedValue = Number(value);
  else if (key === "diffStyle") parsedValue = value === "unified" ? "unified" : "simple";
  else if (key === "cardBehavior")
    parsedValue = value === "refloat_keep" ? "refloat_keep" : value === "refloat" ? "refloat" : "fixed";
  else if (key === "displayMode") parsedValue = value === "unified" ? "unified" : "flexible";
  else if (key === "cardTheme")
    parsedValue = value === "light" ? "light" : value === "dark" ? "dark" : "auto";
  else if (key === "cardVerbosity")
    parsedValue = value === "low" ? "low" : value === "high" ? "high" : "medium";
  else if (key === "cardPreset")
    parsedValue = CARD_PRESETS.includes(value as CardPreset) ? (value as CardPreset) : "balanced";
  else if (key === "longAnswerDelivery")
    parsedValue = value === "message" ? "message" : value === "auto" ? "auto" : "card";
  else parsedValue = value === "true";
  const settings = deps.settings.set(chatId, key, parsedValue);

  // Toggles that change the card's visible blocks must refresh it immediately
  // instead of waiting for the next turn.
  if (
    key === "showThinking" || key === "showShell" || key === "showTools" ||
    key === "showResourceUsage" || key === "showPartialText" || key === "showCot" ||
    key === "showFinalInCard" || key === "compactCard"
  ) {
    const active = deps.store.getActiveSession(chatId, threadId);
    if (active) {
      active.activityExpanded = settings.showThinking || settings.showShell || settings.showTools;
      void deps.status.publishCard(chatId, active).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
  }

  if (key === "displayMode") {
    if (parsedValue === "unified") {
      const s = deps.store.getActiveSession(chatId, threadId) ?? (await deps.sessions.restoreActiveSession(chatId, threadId).catch(() => undefined));
      if (s) await deps.dashboard.ensure(chatId, threadId, s, { working: !!s.statusMessageId && !s.statusFinished }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    } else {
      const dash = deps.store.getDashboard(chatId, threadId);
      if (dash) await deps.tg.unpinChatMessage(chatId, { message_id: dash.messageId }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
  }

  await deps.tg.answerCallbackQuery(cq.id, `${LABELS[key]} → ${String(parsedValue)}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  if (messageId !== undefined) {
    await deps.tg
      .editRichMessage(chatId, messageId, renderSettingsPanel(chatId, settings), {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: settingsKeyboard(settings) },
      })
      .catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
    await deps.tg.answerCallbackQuery(cq.id, `${LABELS.previewLines} → ${next}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (messageId !== undefined) {
      await deps.tg
        .editRichMessage(chatId, messageId, renderSettingsPanel(chatId, settings), {
          ...threadOpts(threadId),
          reply_markup: { inline_keyboard: settingsKeyboard(settings) },
        })
        .catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
    return;
  }
  if (key === "resourceHistory") {
    const presets = [6, 12, 24];
    const current = deps.settings.get(chatId).resourceHistory;
    const next = presets[(presets.indexOf(current) + 1) % presets.length] ?? presets[0];
    const settings = deps.settings.set(chatId, "resourceHistory", next);
    await deps.tg.answerCallbackQuery(cq.id, `${LABELS.resourceHistory} → ${next}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (messageId !== undefined) {
      await deps.tg
        .editRichMessage(chatId, messageId, renderSettingsPanel(chatId, settings), {
          ...threadOpts(threadId),
          reply_markup: { inline_keyboard: settingsKeyboard(settings) },
        })
        .catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
    return;
  }
  if (key === "longAnswerThreshold") {
    const presets = [800, 1200, 1800, 2600, 3600];
    const current = deps.settings.get(chatId).longAnswerThreshold;
    const next = presets[(presets.indexOf(current) + 1) % presets.length] ?? presets[0];
    const settings = deps.settings.set(chatId, "longAnswerThreshold", next);
    await deps.tg.answerCallbackQuery(cq.id, `${LABELS.longAnswerThreshold} → ${next}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (messageId !== undefined) {
      await deps.tg
        .editRichMessage(chatId, messageId, renderSettingsPanel(chatId, settings), {
          ...threadOpts(threadId),
          reply_markup: { inline_keyboard: settingsKeyboard(settings) },
        })
        .catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, "Opción desconocida").catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

/** P1.6: apply a named style bundle from /settings and persist it per chat. */
async function handlePreset(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  if (!data.startsWith("preset:")) return;
  const preset = data.slice("preset:".length) as CardPreset;
  if (!CARD_PRESETS.includes(preset)) {
    await deps.tg.answerCallbackQuery(cq.id, "Estilo desconocido").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const settings = deps.settings.applyPreset(chatId, preset);
  // Refresh the active card so the new profile is visible immediately.
  const active = deps.store.getActiveSession(chatId, threadId);
  if (active) {
    active.activityExpanded = settings.showThinking || settings.showShell || settings.showTools;
    void deps.status.publishCard(chatId, active).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
  await deps.tg.answerCallbackQuery(cq.id, `🎛 Estilo: ${PRESET_LABELS[preset]}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  if (messageId !== undefined) {
    await deps.tg
      .editRichMessage(chatId, messageId, renderSettingsPanel(chatId, settings), {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: settingsKeyboard(settings) },
      })
      .catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

/** Granular per-thread permissions: toggle read-only. */
async function handlePermThread(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^permthread:readonly:(on|off)$/);
  if (!m) return;
  if (!deps.permissions) {
    await deps.tg.answerCallbackQuery(cq.id, "Permisos no disponibles.").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const routeKey = deps.store.routeKey(chatId, threadId);
  const globalAdmin = deps.config.ADMIN_TELEGRAM_USER_ID;
  const userId = cq.from?.id;
  const isAdmin = deps.permissions.isAdmin(routeKey, userId, globalAdmin);
  if (!isAdmin) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo admin").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const value = m[1] === "on";
  deps.permissions.setReadOnly(routeKey, value);
  await deps.tg.answerCallbackQuery(cq.id, value ? "🔒 Solo lectura" : "🔓 Escritura permitida").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  if (messageId !== undefined) {
    await deps.tg.editRichMessage(chatId, messageId, `🔐 Permisos · ${routeKey}\nSolo lectura: ${value ? "sí" : "no"}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: [[{ text: value ? "🔓 Permitir escritura" : "🔒 Solo lectura", callback_data: `permthread:readonly:${value ? "off" : "on"}` }]] },
    }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

/** Button-driven granular permissions for the current thread. */
async function handlePermUI(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  if (!data.startsWith("permui:")) return;
  if (!deps.permissions) {
    await deps.tg.answerCallbackQuery(cq.id, "Permisos no disponibles.").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const routeKey = deps.store.routeKey(chatId, threadId);
  const globalAdmin = deps.config.ADMIN_TELEGRAM_USER_ID;
  const userId = cq.from?.id;
  const isAdmin = deps.permissions.isAdmin(routeKey, userId, globalAdmin);
  if (!isAdmin) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo admin").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const action = data.slice("permui:".length);
  if (action === "readonly:on" || action === "readonly:off") {
    const value = action.endsWith("on");
    deps.permissions.setReadOnly(routeKey, value);
    await deps.tg.answerCallbackQuery(cq.id, value ? "🔒 Solo lectura" : "🔓 Escritura permitida").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  } else if (action === "inherit:on" || action === "inherit:off") {
    const value = action.endsWith("on");
    deps.permissions.set(routeKey, { inherit: value });
    await deps.tg.answerCallbackQuery(cq.id, value ? "🔗 Heredar: sí" : "🔗 Heredar: no").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  } else if (action.startsWith("remove:")) {
    const id = Number(action.slice("remove:".length));
    if (Number.isFinite(id) && id > 0) {
      deps.permissions.removeUser(routeKey, id);
      await deps.tg.answerCallbackQuery(cq.id, `🗑 ${deps.permissions.label(id)}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
  } else if (action === "add") {
    // Bind the capture to this admin and expire it: a stale "add user" prompt
    // must never swallow a later message from someone else.
    deps.awaitingPermissionAdd?.set(routeKey, { chatId, threadId, at: Date.now(), requestedBy: cq.from?.id ?? 0 });
    await deps.tg.answerCallbackQuery(cq.id, "Responde con: @usuario [operator|admin]").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.tg.sendRichMessage(chatId, "Responde con <code>@usuario</code> (o el ID) y el rol, p. ej. <code>@juan operator</code> o <code>123456 admin</code>. El usuario debe haber escrito al bot o pulsado un botón antes para que conozca su @username.", threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  } else if (action === "refresh") {
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  } else {
    await deps.tg.answerCallbackQuery(cq.id, "Acción desconocida").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  // Re-render the panel in the same message.
  if (messageId !== undefined) {
    const panel = deps.permissions.renderPanel(routeKey, deps.config.ADMIN_TELEGRAM_USER_ID);
    await deps.tg.editRichMessage(chatId, messageId, panel.html, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: panel.keyboard },
    }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

/** ◀ Volver: restore the previous button view in the SAME message. */
async function handleSettingsBack(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  if (data !== "settings:back") return;
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  // Settings opened from a session card (⚙️): go back to that card, with its
  // original buttons, by editing the very message we are sitting in.
  if (messageId !== undefined) {
    const sessionId = deps.store.findSessionByAnyMessage(chatId, messageId, threadId);
    const s = sessionId ? deps.store.findSessionById(sessionId) : undefined;
    if (s) {
      await deps.status.publishCard(chatId, s).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
  }
  // Settings opened from the home panel: restore that panel in place too.
  const panel = await deps.panels.renderPanel(chatId, threadId).catch((err) => {
    console.warn("[callbacks] panel render failed", err?.message ?? err);
    return undefined;
  });
  if (!panel) return;
  const opts = { ...threadOpts(threadId), reply_markup: { inline_keyboard: panel.keyboard } };
  if (messageId !== undefined) await deps.tg.editRichMessage(chatId, messageId, panel.html, opts).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  else await deps.tg.sendRichMessage(chatId, panel.html, opts).catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

/** Button-driven SQLite overview: stats, refresh and admin-only compaction. */
async function handleDb(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const action = data.slice("db:".length);
  if (action === "back") {
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.panels.sendPanel(chatId, threadId);
    return;
  }
  const admin = isRouteAdmin(deps, chatId, threadId, cq.from?.id);
  if (action === "vacuum" && !admin) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo admin").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  if (action === "vacuum") {
    try {
      vacuum(deps.store.dataDir);
      await deps.tg.answerCallbackQuery(cq.id, "🧹 Base de datos compactada").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    } catch (err) {
      await deps.tg.answerCallbackQuery(cq.id, `❌ ${String(err)}`).catch((warn) => console.warn("[callbacks]", warn?.message ?? warn));
      return;
    }
  } else {
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
  const panel = renderDbPanel(dbStats(deps.store.dataDir), admin);
  const opts = { ...threadOpts(threadId), reply_markup: { inline_keyboard: panel.keyboard } };
  if (messageId !== undefined) {
    await deps.tg.editRichMessage(chatId, messageId, panel.html, opts).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  } else {
    await deps.tg.sendRichMessage(chatId, panel.html, opts).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

async function handlePanel(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const { tg, panels, sessions, files, oc, store, settings } = deps;
  // The pinned dashboard (M1) must not be replaced by panel views.
  const dash = store.getDashboard(chatId, threadId);
  const editId = dash && dash.messageId === messageId ? undefined : messageId;
  if (data === "panel:home" || data === "panel:help") {
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await panels.sendPanel(chatId, threadId);
    return;
  }
  if (data === "panel:settings") {
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    const s = settings.get(chatId);
    const opts = { ...threadOpts(threadId), reply_markup: { inline_keyboard: settingsKeyboard(s) } };
    // Replace the tapped message instead of stacking a new settings message.
    if (editId !== undefined) await tg.editRichMessage(chatId, editId, renderSettingsPanel(chatId, s), opts);
    else await tg.sendRichMessage(chatId, renderSettingsPanel(chatId, s), opts);
    return;
  }
  if (data === "panel:permissions") {
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (!deps.permissions) {
      await tg.sendRichMessage(chatId, "Permisos no disponibles.", threadOpts(threadId));
      return;
    }
    const routeKey = deps.store.routeKey(chatId, threadId);
    const globalAdmin = deps.config.ADMIN_TELEGRAM_USER_ID;
    const isAdmin = deps.permissions.isAdmin(routeKey, cq.from?.id, globalAdmin);
    if (!isAdmin) {
      await tg.sendRichMessage(chatId, "Solo el admin puede gestionar permisos.", threadOpts(threadId));
      return;
    }
    const panel = deps.permissions.renderPanel(routeKey, globalAdmin);
    await tg.sendRichMessage(chatId, panel.html, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: panel.keyboard },
    });
    return;
  }
  if (data === "panel:status") {
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await panels.showStatus(chatId, threadId, editId);
    return;
  }
  if (data === "panel:sessions") {
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    // Always send a fresh message (do not replace the clicked one) so the
    // sessions list stays visible and does not overwrite the current view.
    await panels.showSessions(chatId, 0, undefined, threadId);
    return;
  }
  if (data === "panel:new") {
    const repos = listRepoDirectories(deps.config);
    if (repos.length) {
      await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      const keyboard: InlineKeyboard = repos.map((name) => [{ text: name, callback_data: `repo:${name}` }]);
      keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
      await tg.sendRichMessage(chatId, "Elige el repositorio para la nueva sesión:", { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } });
      return;
    }
    await tg.answerCallbackQuery(cq.id, "Creando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await sessions.createNewSession(chatId, false, threadId);
    await panels.sendPanel(chatId, threadId);
    return;
  }
  if (data === "panel:commands") {
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await panels.showCommands(chatId, threadId);
    return;
  }
  if (data === "panel:files") {
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    try {
      await files.showListing(chatId, threadId, "", { messageId: editId });
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(fileErrorMessage(err))}`, threadOpts(threadId));
    }
    return;
  }
  if (data === "panel:models") {
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await panels.showModels(chatId, 0, editId, threadId, undefined, null, { userId: cq.from?.id });
    return;
  }
  if (data.startsWith("panel:ms:")) {
    const targetSessionId = data.slice("panel:ms:".length).trim();
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await panels.showModels(chatId, 0, editId, threadId, undefined, targetSessionId || null, { userId: cq.from?.id });
    return;
  }
  if (data === "panel:bg") {
    let s = store.getActiveSession(chatId, threadId);
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No hay sesión activa").catch(() => {});
      return;
    }
    try {
      await oc.background(s.sessionId);
      await tg.answerCallbackQuery(cq.id, "🔇 Herramientas en segundo plano").catch(() => {});
    } catch (err) {
      await tg.answerCallbackQuery(cq.id, "No se pudo pasar a segundo plano").catch(() => {});
      console.warn("[callbacks] background failed", err);
    }
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
      await tg.answerCallbackQuery(cq.id, "No hay sesión activa").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
    s.stopped = true;
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    if (s.deltaFlushTimer) {
      clearTimeout(s.deltaFlushTimer);
      s.deltaFlushTimer = undefined;
    }
    cancelAutoRetry(s.sessionId);
    await oc.interrupt(s.sessionId).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await tg.answerCallbackQuery(cq.id, "Detenido").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    // Close the turn like a normal finish: the card drops the Stop button and
    // keeps its transcript, and renders "⏹ Detenido" instead of "✅ Listo".
    // finishStatus is idempotent, so a later step.ended is harmless.
    const hadCard = Boolean(s.transcriptMessageId || s.statusMessageId);
    await deps.status.finishStatus(chatId, s).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    // Only chat with no card at all gets a short confirmation; the card itself
    // already reports the stopped state.
    if (!hadCard) {
      const stoppedMsg = await tg.sendRichMessage(chatId, "⏹ detenido", threadOpts(threadId)).catch(() => undefined);
      if (stoppedMsg?.message_id) store.rememberMessageSession(chatId, stoppedMsg.message_id, s.sessionId);
    }
    return;
  }
}

async function handleSessions(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const filterMatch = data.match(/^sessions:filter:(all|running|group)$/);
  if (filterMatch) {
    const mode = filterMatch[1];
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (mode === "running") await deps.panels.showSessions(chatId, 0, cq.message?.message_id, threadId, undefined, true);
    else if (mode === "group") await deps.panels.showSessions(chatId, 0, cq.message?.message_id, threadId, chatId);
    else await deps.panels.showSessions(chatId, 0, cq.message?.message_id, threadId);
    return;
  }
  const folderMatch = data.match(/^sessions:folder:(\d+)$/);
  if (folderMatch) {
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.panels.showSessions(chatId, 0, cq.message?.message_id, threadId, undefined, undefined, { folderIndex: Number(folderMatch[1]) });
    return;
  }
  if (data === "sessions:back") {
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.panels.showSessions(chatId, 0, cq.message?.message_id, threadId, undefined, undefined, { back: true });
    return;
  }
  const pageMatch = data.match(/^sessions:page:(\d+)(?::(all|running|group))?$/);
  if (pageMatch) {
    const page = parseInt(pageMatch[1], 10);
    const mode = pageMatch[2] ?? "all";
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (mode === "running") await deps.panels.showSessions(chatId, page, cq.message?.message_id, threadId, undefined, true);
    else if (mode === "group") await deps.panels.showSessions(chatId, page, cq.message?.message_id, threadId, chatId);
    else await deps.panels.showSessions(chatId, page, cq.message?.message_id, threadId);
    return;
  }
}

/** Run a bot command from an inline button (no slash command required). */
async function handleBotCommand(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, _messageId: number | undefined, data: string) {
  const name = data.slice("botcmd:".length).trim();
  if (!name) return;
  if (isChatAdminCommand(name) && !isRouteAdmin(deps, chatId, threadId, cq.from?.id)) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo admin").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  if (isDangerousCommand(name)) {
    await deps.tg.answerCallbackQuery(cq.id, "Escribe el comando manualmente").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.tg.sendRichMessage(chatId, "⚠️ Por seguridad, ejecuta este comando escribiéndolo.", threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, `/${esc(name)}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const send = (html: string, opts?: Record<string, unknown>) => deps.tg.sendRichMessage(chatId, html, { ...threadOpts(threadId), ...(opts ?? {}) });
  try {
    await handleCommand(deps, chatId, threadId, `/${name}`, send, cq.from?.id);
  } catch (err) {
    console.error("[botcmd]", name, err);
    await send(`❌ ${esc(String(err))}`).catch((warn) => console.warn("[callbacks]", warn?.message ?? warn));
  }
}

async function handleCmd(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^cmd:(.+)$/);
  if (!m) return;
  const name = m[1];
  if (isDangerousCommand(name)) {
    await deps.tg.answerCallbackQuery(cq.id, "Escribe el comando manualmente").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.tg.sendRichMessage(chatId, "⚠️ For safety, run this command by typing it.", threadOpts(threadId));
    return;
  }
  const s = deps.store.getActiveSession(chatId, threadId);
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, "No hay sesión activa").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const cmds = await deps.oc.listCommandsCached(s.directory);
  if (!(cmds as Array<{ name?: string }>).some((c) => c?.name === name)) {
    await deps.tg.answerCallbackQuery(cq.id, "Comando desconocido").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, `Running /${name}…`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
    await deps.tg.answerCallbackQuery(cq.id, "Perfil desconocido").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  if (settings.displayMode === "unified") {
    const s = deps.store.getActiveSession(chatId, threadId) ?? (await deps.sessions.restoreActiveSession(chatId, threadId).catch(() => undefined));
    if (s) await deps.dashboard.ensure(chatId, threadId, s, { working: !!s.statusMessageId && !s.statusFinished }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  } else {
    const dash = deps.store.getDashboard(chatId, threadId);
    if (dash) await deps.tg.unpinChatMessage(chatId, { message_id: dash.messageId }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
  await deps.tg.answerCallbackQuery(cq.id, `Perfil: ${name}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  if (messageId !== undefined) {
    await deps.tg
      .editRichMessage(chatId, messageId, renderSettingsPanel(chatId, settings), {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: settingsKeyboard(settings) },
      })
      .catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

async function handleViewFull(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const sessionId = data.slice("viewfull:".length);
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const s = deps.store.findSessionById(sessionId);
  const text = s?.lastFinalText;
  if (!s || !text) {
    await deps.tg.sendRichMessage(chatId, "No hay respuesta completa disponible.", threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const parts = splitMarkdown(text, 3200);
  if (parts.length <= 1) {
    await deps.tg.sendRichMessage(chatId, clampText(`${sessionHeader(s)}${markdownToHtml(text)}`, 3900), threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    const prefix = `<i>(${i + 1}/${parts.length})</i>\n`;
    const piece = `${sessionHeader(s)}${prefix}${markdownToHtml(chunk)}`;
    await deps.tg.sendRichMessage(chatId, clampText(piece, 3900), threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

/** Collapse or expand the resource indicators on the card. */
async function handleResourcesToggle(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, _threadId: number | undefined, _messageId: number | undefined, data: string) {
  const m = data.match(/^resources:(.+)$/);
  if (!m) return;
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const s = deps.store.findSessionById(m[1]);
  if (!s) return;
  s.resourcesCollapsed = !s.resourcesCollapsed;
  const refresh = s.statusFinished ? deps.status.publishCard(chatId, s) : deps.status.updateStatus(chatId, s, true);
  await refresh.catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

/** Show what a read tool actually opened, in the file browser. */
async function handleReadFile(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, _messageId: number | undefined, data: string) {
  const m = data.match(/^readfile:(.+)$/);
  if (!m) return;
  const key = m[1];
  const path = getActivityReadPath(key);
  if (!path) {
    await deps.tg.answerCallbackQuery(cq.id, "Esta lectura ya no está disponible. Abre /status para ver el turno actual.", { show_alert: true }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  // The key is `<sessionId>:<index>`; resolve the directory against that
  // session, not whichever one happens to be active in the tab now (the card
  // may belong to another session/tab or a session that is no longer active).
  const sep = key.lastIndexOf(":");
  const sessionId = sep > 0 ? key.slice(0, sep) : "";
  const s = (sessionId ? deps.store.findSessionById(sessionId) : undefined) ?? deps.store.getActiveSession(chatId, threadId);
  await deps.files.showFile(chatId, threadId, path, { base: s?.directory, forcePreview: true }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

/** Open the file of an edited entry directly in the file browser. */
async function handleEditFile(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^editfile:(\d+)$/);
  if (!m) return;
  if (messageId === undefined) return;
  const snap = deps.store.getPendingEditsSnapshot(chatId, messageId);
  const detail = snap?.edits?.[Number(m[1])];
  const raw = detail ? extractEditFile(detail.input) : undefined;
  if (!raw || !snap) {
    await deps.tg.answerCallbackQuery(cq.id, "Este archivo ya no está disponible. Abre /status para ver el turno actual.", { show_alert: true }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const base = deps.store.findSessionById(snap.sessionId)?.directory;
  const path = raw.startsWith("/") ? raw : base ? join(base, raw) : raw;
  await deps.files.showFile(chatId, threadId, path, { forcePreview: true }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

/** Show/hide the compact activity detail inline on the same card message. */
async function handleActivityToggle(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, _threadId: number | undefined, _messageId: number | undefined, data: string) {
  const m = data.match(/^activity:(.+)$/);
  if (!m) return;
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const s = deps.store.findSessionById(m[1]);
  if (!s) return;
  s.activityExpanded = !s.activityExpanded;
  // updateStatus bails out on finished cards; publishCard works in both states.
  const refresh = s.statusFinished ? deps.status.publishCard(chatId, s) : deps.status.updateStatus(chatId, s, true);
  await refresh.catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

/** P1.4: download the turn's edits as a .patch document. */
async function handlePatch(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, _messageId: number | undefined, data: string) {
  const m = data.match(/^patch:(\d+)$/);
  if (!m) return;
  await deps.tg.answerCallbackQuery(cq.id, "Generando .patch…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const ok = await deps.status.sendPatch?.(chatId, Number(m[1]), threadId).catch((err) => {
    console.warn("[callbacks] patch failed", err);
    return false;
  });
  if (!ok) {
    await deps.tg.answerCallbackQuery(cq.id, "Este diff ya no está disponible. Abre /status para ver el turno actual.", { show_alert: true }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

/**
 * Clipboard fallback for groups or texts longer than 256 characters: send the
 * content as a code block the user can long-press to copy. In private chats a
 * native copy_text button is attached when the text fits.
 */
async function handleCopy(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, _messageId: number | undefined, data: string) {
  const m = data.match(/^copy:(answer|prompt|command|diff):(.+)$/);
  if (!m) return;
  const kind = m[1];
  const rest = m[2];
  // diff carries "<sessionId>:<messageId>" so the snapshot can be resolved.
  const [sessionId, diffMessageId] = kind === "diff" ? rest.split(":") : [rest, undefined];
  const s = deps.store.findSessionById(sessionId);
  const lastShell = s ? [...(s.toolCallDetails ?? [])].reverse().find((d) => isShellTool(d.name)) : undefined;
  const lastCommand = lastShell ? parseShellCommand(lastShell.input ?? "") ?? lastShell.input?.trim() : undefined;
  const diffText = kind === "diff" && diffMessageId
    ? deps.status.plainDiffFor?.(chatId, Number(diffMessageId))
    : undefined;
  const text = (kind === "answer" ? s?.lastFinalText : kind === "prompt" ? deps.store.lastPromptBySession.get(sessionId) : kind === "command" ? lastCommand : diffText)?.trim();
  if (!text) {
    await deps.tg.answerCallbackQuery(cq.id, "No hay nada que copiar todavía.", { show_alert: true }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.tg.answerCallbackQuery(cq.id, "Abriendo…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const title = kind === "answer" ? "📄 Respuesta" : kind === "command" ? "🖥 Comando" : kind === "diff" ? "🧾 Diff" : "📝 Prompt";
  const body = text.slice(0, 3600);
  const copy = copyTextButton(chatId, "📋 Copiar", body);
  const hint = chatId < 0 ? "\n<i>Mantén pulsado el bloque para copiar.</i>" : "";
  await deps.tg.sendRichMessage(
    chatId,
    `<b>${title}</b>\n<pre><code>${esc(body)}</code></pre>${hint}`,
    { ...threadOpts(threadId), ...(copy ? { reply_markup: { inline_keyboard: [[copy]] } } : {}) },
  ).catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

export const CALLBACK_DISPATCH: Record<string, CallbackHandler> = {
  "activity:": handleActivityToggle,
  "editfile:": handleEditFile,
  "readfile:": handleReadFile,
  "resources:": handleResourcesToggle,
  "patch:": handlePatch,
  "copy:": handleCopy,
  "tpage:": handleTranscriptPage,
  "tpagep:": handlePickerJump,
  "tpick:": handlePagePicker,
  "read:": handleCardView,
  "back:": handleCardView,
  "menu:": handleCardView,
  "hist:": handleHistory,
  "histfmt:": handleHistoryFormatPicker,
  "ops:": handleOps,
  "permthread:": handlePermThread,
  "permui:": handlePermUI,
  "db:": handleDb,
  "settings:": handleSettingsBack,
  "panel:": handlePanel,
  "perm:": handlePerm,
  "spick:": async (deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) => {
    const m = data.match(/^spick:(\d+)$/);
    if (!m) return;
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    const page = parseInt(m[1], 10);
    if (messageId !== undefined) await deps.tg.deleteMessage(chatId, messageId).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await showSessionPicker(deps, chatId, threadId, page);
  },
  "use:": async (deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) => {
    const m = data.match(/^use:(.+)$/);
    if (!m) return;
    const sessionId = m[1];
    await deps.tg.answerCallbackQuery(cq.id, "Conectando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    try {
      const cs = await deps.sessions.activateSession(chatId, sessionId, true, threadId);
      // Rename the tab to the connected session (best-effort; works in
      // private threaded chats, silently fails in groups without permission).
      if (cs) {
        cs.topicTitle = undefined;
        await deps.sessions.syncTopicTitle(chatId, cs).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
            deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
          });
          return;
        }
      }
      await deps.panels.showStatus(chatId, threadId, cq.message?.message_id);
    } catch (err) {
      await deps.tg.answerCallbackQuery(cq.id, "Falló").catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
  "preset:": handlePreset,
  "goal:": handleGoal,
  "qswitch:": handleQswitch,
  "runcmd:": handleRuncmd,
  "connect:": handleConnect,
  "sessions:": handleSessions,
  "cmd:": handleCmd,
  "botcmd:": handleBotCommand,
  "profile:": handleProfile,
  "viewfull:": handleViewFull,
  "stats:": handleStats,
};

async function handleStats(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const { tg, store } = deps;
  const isAdmin = isRouteAdmin(deps, chatId, threadId, cq.from?.id);
  const parts = data.slice("stats:".length).split(":");
  const action = parts[0];
  await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));

  let period: StatsPeriod = "7d";
  let scope: StatsScope = "chat";
  if (action === "period") {
    period = (parts[1] as StatsPeriod) ?? "7d";
  } else if (action === "scope") {
    scope = (parts[1] as StatsScope) ?? "chat";
    period = (parts[2] as StatsPeriod) ?? "7d";
  } else if (action === "refresh") {
    period = (parts[1] as StatsPeriod) ?? "7d";
    scope = (parts[2] as StatsScope) ?? "chat";
  } else if (action === "export") {
    period = (parts[1] as StatsPeriod) ?? "7d";
    scope = (parts[2] as StatsScope) ?? "chat";
    if (scope === "all" && !isAdmin) {
      await tg.sendRichMessage(chatId, "📊 Solo un admin puede exportar el histórico de todos los chats.", threadOpts(threadId)).catch(() => {});
      return;
    }
    const data2 = collectStats({ period, scope, chatId, dataDir: store.dataDir });
    const { path, filename } = writeStatsReport(data2, { period, scope });
    await tg.sendDocument(chatId, path, filename, `📊 <b>Reporte de rendimiento</b>`, {
      ...threadOpts(threadId),
      parse_mode: "HTML",
    }).catch((err) => console.warn("[callbacks] stats export failed", err?.message ?? err));
    return;
  }

  if (scope === "all" && !isAdmin) scope = "chat";
  const collected = collectStats({ period, scope, chatId, dataDir: store.dataDir });
  const panel = renderStatsPanel(collected, { period, scope, isAdmin });
  if (messageId !== undefined) {
    await tg.editRichMessage(chatId, messageId, panel.html, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: panel.keyboard },
    }).catch((err) => console.warn("[callbacks] stats render failed", err?.message ?? err));
  } else {
    await tg.sendRichMessage(chatId, panel.html, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: panel.keyboard },
    }).catch((err) => console.warn("[callbacks] stats render failed", err?.message ?? err));
  }
}

export async function handleCallback(deps: BotDeps, cq: TelegramCallbackQuery): Promise<void> {
  const { config, tg, oc, store, panels, sessions, pendingModelByChat } = deps;
  const { getActiveSession } = store;
  const { showModels, sendPanel, providerListByChat, selectedProviderByChat } = panels;
  const { createNewSession } = sessions;

  const userId = cq.from?.id;
  const allowedUsers = buildGlobalAllowed(config);
  const chatId = cq.message?.chat?.id ?? cq.from.id;
  const threadId = cq.message?.message_thread_id;
  // The global allowlist is the floor, but a user granted only through the
  // per-thread ACL (operator/admin) must also reach the buttons; otherwise the
  // granular permissions would only apply to typed prompts.
  const routeKey = store.routeKey(chatId, threadId);
  const admin = isRouteAdmin(deps, chatId, threadId, userId);
  const threadAllowed = deps.permissions
    ? deps.permissions.canPrompt(routeKey, userId, allowedUsers) || deps.permissions.isReadOnly(routeKey)
    : false;
  if (allowedUsers.size === 0 || userId === undefined || (!allowedUsers.has(userId) && !threadAllowed && !admin)) {
    await tg.answerCallbackQuery(cq.id, "No autorizado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  // Learn usernames only after authorization (the map drives @name grants).
  if (userId !== undefined && cq.from?.username) deps.permissions?.rememberUser(userId, cq.from.username);

  const cbData = cq.data ?? "";
  const messageId = cq.message?.message_id;
  // Chat-wide state changes (delete sessions, shared settings) belong to route
  // admins only, no matter which button dispatched them.
  const adminOnly = ["set:", "cycle:", "preset:", "profile:", "del:", "delsessions:", "delconfirm:"];
  if (!admin && adminOnly.some((p) => cbData.startsWith(p))) {
    await tg.answerCallbackQuery(cq.id, "Solo admin").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  // A read-only route may browse, but never mutate. Admins keep control so they
  // can turn read-only off again (and manage permissions) from the same card.
  if (!admin && deps.permissions?.isReadOnly(routeKey)) {
    const mutating = [
      "panel:stop", "panel:bg", "panel:new", "retry:", "runcmd:", "botcmd:", "cmd:", "set:", "cycle:", "preset:",
      "profile:", "model:", "agent:", "variant:", "qswitch:", "use:", "del:", "delsessions:", "delconfirm:",
      "connect:", "mcp:", "stage:", "unstage:", "commit:", "branch:", "worktree:", "vcs:", "perm:",
      "permui:", "permthread:", "formreply:", "goal:", "edit:", "edits:", "spick:",
    ];
    if (mutating.some((p) => cbData === p || cbData.startsWith(p))) {
      await tg.answerCallbackQuery(cq.id, "🔒 Solo lectura").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
  }

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
      await tg.answerCallbackQuery(cq.id, "Botón expirado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
    await tg.answerCallbackQuery(cq.id, btn.label).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    const s = deps.store.getActiveSession(chatId, threadId);
    if (!s) {
      await tg.sendRichMessage(chatId, "No hay sesión activa.", threadOpts(threadId));
      return;
    }
    // Send the configured text as a prompt.
    const send = (html: string, opts: Record<string, unknown> = {}) => tg.sendRichMessage(chatId, html, { ...(threadId ? { message_thread_id: threadId } : {}), ...opts });
    await deps.status.startStatus(chatId, s).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    void deps.oc.prompt(s.sessionId, btn.text).catch(async (err) => {
      await send(`❌ ${esc(String(err))}`);
    });
    return;
  }

  const retryMatch = cbData.match(/^retry:(.+)$/);
  if (retryMatch) {
    const sessionId = retryMatch[1];
    await tg.answerCallbackQuery(cq.id, "Reintentando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    const prompt = deps.store.lastPromptBySession.get(sessionId);
    if (!prompt) {
      await tg.sendRichMessage(chatId, "No hay un prompt anterior para reintentar.", threadOpts(threadId));
      return;
    }
    try {
      await deps.sessions.activateSession(chatId, sessionId, true, threadId);
      const s = await deps.sessions.resolveSessionForRetry(chatId, threadId);
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
        deps.status.updateStatus(chatId, s).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      }, 5000);
      await deps.oc.prompt(s.sessionId, prompt).catch(async (err) => {
        if (s.statusTimer) {
          clearInterval(s.statusTimer);
          s.statusTimer = undefined;
        }
        await deps.status.finishStatus(chatId, s).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
    await tg.answerCallbackQuery(cq.id, "Eliminando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    try {
      await oc.interrupt(sessionId).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      await oc.deleteSession(sessionId);
      store.forgetSession(sessionId);
      if (cq.message?.message_id !== undefined) {
        await tg.editRichMessage(chatId, cq.message.message_id, `✅ Deleted <code>${esc(sessionId)}</code>`, {
          reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }]] },
        }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
        await deps.tg.answerCallbackQuery(cq.id, "Conectado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      } else if (action === "disconnect" && name) {
        await deps.oc.client.mcp.disconnect({ server: name, location: { directory } } as unknown as Parameters<typeof deps.oc.client.mcp.disconnect>[0]);
        await deps.tg.answerCallbackQuery(cq.id, "Desconectado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      } else if (action === "remove" && name) {
        await deps.oc.client.mcp.remove({ server: name, location: { directory } } as unknown as Parameters<typeof deps.oc.client.mcp.remove>[0]);
        await deps.tg.answerCallbackQuery(cq.id, "Eliminado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      } else if (action === "resources") {
        await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
        const { resources, templates } = await mcp.listMcpResources(deps.oc, directory);
        const all = [...resources, ...templates];
        if (!all.length) {
          await deps.tg.sendRichMessage(chatId, "No hay recursos MCP disponibles.", threadOpts(threadId));
          return;
        }
        const lines = all.map((resource) => `• <b>${esc(resource.name)}</b> (${esc(resource.server)})\n  <code>${esc(resource.uri)}</code>`);
        await deps.tg.sendRichMessage(chatId, `<b>MCP resources</b>\n${lines.join("\n\n")}\n\nUse /mcp read <uri>`, threadOpts(threadId));
        return;
      } else {
        await deps.tg.answerCallbackQuery(cq.id, "Acción MCP desconocida").catch((err) => console.warn("[callbacks]", err?.message ?? err));
        return;
      }
      const { text, keyboard } = await mcp.renderMcpList(deps.oc, directory);
      if (messageId !== undefined) {
        await deps.tg.editRichMessage(chatId, messageId, text, { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      } else {
        await deps.tg.sendRichMessage(chatId, text, { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } });
      }
    } catch (err) {
      await deps.tg.answerCallbackQuery(cq.id, "Falló").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
    return;
  }

  const formCallbackHandled = await handleFormCallback(deps, cq);
  if (formCallbackHandled) return;

  const fullEditsMatch = (cq.data ?? "").match(/^edits:full:(\d+)$/);
  if (fullEditsMatch && cq.message?.message_id !== undefined) {
    const handled = await deps.status.sendFullDiffs(chatId, Number(fullEditsMatch[1]), threadId);
    await deps.tg.answerCallbackQuery(
      cq.id,
      handled ? "Enviando diffs…" : "Este diff ya no está disponible. Abre /status para ver el turno actual.",
      handled ? {} : { show_alert: true },
    ).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }

  const editMatch = (cq.data ?? "").match(/^edit:(\d+)$/);
  if (editMatch && cq.message?.message_id !== undefined) {
    const handled = await deps.status.showEditDetail(chatId, cq.message.message_id, Number(editMatch[1]));
    if (handled) {
      await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
    await deps.tg.answerCallbackQuery(
      cq.id,
      "Este diff ya no está disponible. Abre /status para ver el turno actual.",
      { show_alert: true },
    ).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }

  if (cbData === "new:confirm") {
    await tg.answerCallbackQuery(cq.id, "Creando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    try {
      await createNewSession(chatId, false, threadId);
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
    }
    return;
  }
  if (cbData === "new:cancel") {
    await tg.answerCallbackQuery(cq.id, "Cancelado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }

  const repoMatch = cbData.match(/^(?:repo|newrepo|repos|new:repo|repo:new):(.+)$/);
  if (repoMatch) {
    const repoName = repoMatch[1].trim();
    await tg.answerCallbackQuery(cq.id, "Creando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    const directory = resolveRepoDirectory(deps.config, repoName) ?? repoName;
    try {
      await sessions.createNewSession(chatId, false, threadId, directory);
      await panels.sendPanel(chatId, threadId).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
      await tg.answerCallbackQuery(cq.id, "Cancelado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      if (messageId !== undefined) {
        await tg.editRichMessage(chatId, messageId, "Deletion cancelled.", { reply_markup: { inline_keyboard: [] } }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      }
      return;
    }
    if (!sessionId) {
      await tg.answerCallbackQuery(cq.id, "Sesión no encontrada").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
    await tg.answerCallbackQuery(cq.id, "Eliminando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    try {
      await oc.deleteSession(sessionId);
      store.forgetSession(sessionId);
      if (messageId !== undefined) {
        await tg.editRichMessage(chatId, messageId, `✅ Session deleted\n<code>${esc(sessionId)}</code>`, { reply_markup: { inline_keyboard: [] } }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      }
      await sendPanel(chatId, threadId);
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
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
      await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
      await showModels(chatId, 0, cq.message?.message_id, threadId, undefined, undefined, { userId });
      return;
    }
    const index = parseInt(raw, 10);
    const provider = providers[index];
    if (!provider) {
      await tg.answerCallbackQuery(cq.id, "Proveedor no encontrado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await showModels(chatId, 0, cq.message?.message_id, threadId, provider, undefined, { userId });
    return;
  }

  if (cbData === "modelcancel") {
    const userId = cq.from?.id;
    const scope = deps.panels.userScope(chatId, threadId, userId);
    pendingModelByChat.delete(scope);
    deps.panels.modelTargetSessionByScope.delete(scope);
    if (messageId !== undefined) deps.panels.modelPanels.delete(messageId);
    await tg.answerCallbackQuery(cq.id, "Cancelado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (cq.message?.message_id) {
      await tg.editRichMessage(chatId, cq.message.message_id, "Model selection cancelled.", {
        reply_markup: { inline_keyboard: [[{ text: "🧠 Models", callback_data: "panel:models" }, { text: "🏠 Panel", callback_data: "panel:home" }]] },
      }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
    return;
  }

  const modelsPageMatch = cbData.match(/^models:page:(\d+)$/);
  if (modelsPageMatch) {
    const userId = cq.from?.id;
    const scope = deps.panels.userScope(chatId, threadId, userId);
    const provider = selectedProviderByChat?.get(scope);
    await tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await showModels(chatId, parseInt(modelsPageMatch[1], 10), cq.message?.message_id, threadId, provider, undefined, { userId });
    return;
  }

  const skillMatch = cbData.match(/^skill:(.+)$/);
  if (skillMatch) {
    const id = skillMatch[1];
    const s = getActiveSession(chatId, threadId);
    if (!s) {
      await tg.answerCallbackQuery(cq.id, "No hay sesión activa").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return;
    }
    await tg.answerCallbackQuery(cq.id, `Loading ${id}…`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    try {
      await oc.loadSkill(s.sessionId, id);
      await tg.sendRichMessage(chatId, `Loaded skill <b>${esc(id)}</b>`, threadOpts(threadId));
    } catch (err) {
      await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId));
    }
    return;
  }

  // Unknown callback_data: acknowledge it so Telegram's spinner stops.
  await tg.answerCallbackQuery(cq.id, "Acción no disponible").catch((err) => console.warn("[callbacks]", err?.message ?? err));
}
async function handleFormCallback(deps: BotDeps, cq: TelegramCallbackQuery): Promise<boolean> {
  const data = cq.data ?? "";
  if (data !== "forms:submit" && data !== "forms:cancel" && !data.startsWith("fq:")) return false;

  const chatId = cq.message?.chat?.id ?? cq.from.id;
  const threadId = cq.message?.message_thread_id;
  const messageId = cq.message?.message_id;
  if (messageId === undefined) {
    await deps.tg.answerCallbackQuery(cq.id, "Expirado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return true;
  }
  const state = deps.pendingForms.get(messageId);
  if (!state) {
    await deps.tg.answerCallbackQuery(cq.id, "Formulario expirado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return true;
  }

  if (data === "forms:cancel") {
    await deps.tg.answerCallbackQuery(cq.id, "Cancelado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.tg
      .editRichMessage(chatId, messageId, `<b>Form cancelled</b>\n<code>${esc(state.formId)}</code>`, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    deps.pendingForms.delete(messageId);
    deps.pendingFormsById.delete(state.formId);
    return true;
  }

  if (data === "forms:submit") {
    if (state.submitted) {
      await deps.tg.answerCallbackQuery(cq.id, "Ya enviado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return true;
    }
    const allRequired = state.fields.filter((field) => field.required).every((field) => state.answers[field.key] !== undefined);
    if (!allRequired) {
      await deps.tg.answerCallbackQuery(cq.id, "Faltan campos obligatorios").catch((err) => console.warn("[callbacks]", err?.message ?? err));
      return true;
    }
    state.submitted = true;
    await deps.tg.answerCallbackQuery(cq.id, "Enviando…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    // Route the form's follow-up responses to the tab where the form lives.
    deps.store.rememberDelivery(state.sessionId, state.chatId, state.threadId);
    try {
      await deps.oc.replyForm(state.sessionId, state.formId, state.answers as Record<string, string | number | boolean | string[]>);
      await deps.tg
        .editRichMessage(chatId, messageId, `<b>Form submitted</b>\n<code>${esc(state.formId)}</code>`, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch((err) => console.warn("[callbacks]", err?.message ?? err));
    } catch (err) {
      state.submitted = false;
      await deps.tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`, threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    }
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    deps.pendingForms.delete(messageId);
    deps.pendingFormsById.delete(state.formId);
    return true;
  }

  const match = data.match(/^fq:(\d+):(-?\d+)$/);
  if (!match) {
    await deps.tg.answerCallbackQuery(cq.id, "Acción de formulario desconocida").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return true;
  }
  const fieldIndex = Number(match[1]);
  const optionIndex = Number(match[2]);
  const field = state.fields[fieldIndex];
  if (!field) {
    await deps.tg.answerCallbackQuery(cq.id, "Expirado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return true;
  }
  const multi = (() => {
    const t = (field.type || "").toLowerCase();
    if (t.includes("multi") || t.includes("array") || t.includes("list")) return true;
    return (field as { multiple?: boolean }).multiple === true;
  })();

  if (optionIndex === -1) {
    await deps.tg.answerCallbackQuery(cq.id, "Listo").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    await deps.tg
      .editRichMessage(chatId, messageId, renderForm(state), {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: formKeyboard(state) },
      })
      .catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return true;
  }

  const option = field.options?.[optionIndex];
  if (!option) {
    await deps.tg.answerCallbackQuery(cq.id, "Expirado").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return true;
  }

  if (multi) {
    const current = Array.isArray(state.answers[field.key]) ? [...(state.answers[field.key] as unknown as string[])] : [];
    const idx = current.indexOf(option.value);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(option.value);
    state.answers[field.key] = current;
    await deps.tg.answerCallbackQuery(cq.id, current.includes(option.value) ? `Added ${option.label}` : `Removed ${option.label}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  } else {
    state.answers[field.key] = option.value;
    await deps.tg.answerCallbackQuery(cq.id, `Selected ${option.label}`).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
  await deps.tg
    .editRichMessage(chatId, messageId, renderForm(state), {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: formKeyboard(state) },
    })
    .catch((err) => console.warn("[callbacks]", err?.message ?? err));
  return true;
}
