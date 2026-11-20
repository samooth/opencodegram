type Named = { name?: string; id?: string; description?: string };
import type { BotDeps, SendFn } from "../context.js";
import { renderSettingsPanel, settingsKeyboard } from "../settings.js";
import { esc, truncate } from "../util.js";
import { renderTodos } from "../todos.js";
import { notePromptSent } from "../autoretry.js";
import { ctx, isRouteAdmin } from "./shared.js";
import { buildGlobalAllowed } from "../permissions.js";
import { RESOURCE_WIDGET_HTML } from "../widgets.js";

export async function cmd_start(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  const onboarding = deps.settings.get(chatId).onboardingStep ?? 0;
  if (text === "/start") {
    // P2: progressive onboarding — a short demo first, then one tip each time.
    const tips = [
      "👋 <b>Bienvenido a opencodegram</b>\n\nDemo rápida: escribe un mensaje y verás un card con estado, acciones y recibo.\n\nPrueba <code>/status</code> para abrir el panel.",
      "💡 <b>Tip 1:</b> en el card, <code>▾ Más</code> abre todos los controles y <code>📖 Leer</code> muestra el historial paginado.",
      "💡 <b>Tip 2:</b> con <code>/settings</code> eliges un estilo (Minimal, Balanceado, Detallado, Terminal) y activas la celebración 🎉.",
      "✅ <b>Ya estás listo.</b> Usa <code>/commands</code> para descubrir todo.",
    ];
    const tip = tips[Math.min(onboarding, tips.length - 1)];
    deps.settings.set?.(chatId, "onboardingStep", Math.min(onboarding + 1, tips.length - 1));
    await send(tip);
    return true;
  }
  if (text === "/help") {
    await C.sendPanel(chatId, threadId);
    return true;
  }
  return false;
}

/** P2: private entry point for Mission Control. Groups only get buttons. */
export async function cmd_web(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  if (text !== "/web") return false;
  const token = deps.config.WEB_APP_TOKEN;
  if (!token) {
    await send("🎛 La web app no está configurada. Define <code>WEB_APP_TOKEN</code> en el entorno del bot.");
    return true;
  }
  if (chatId < 0) {
    // Groups: only inline buttons — no web links or tokens are shared here.
    await send("🎛 Mission Control solo está disponible en chat privado. Aquí tienes los controles:", {
      reply_markup: { inline_keyboard: [[
        { text: "📊 Estado", callback_data: "panel:status" },
        { text: "📂 Sesiones", callback_data: "panel:sessions" },
      ]] },
    });
    return true;
  }
  const base = deps.config.WEB_APP_URL ?? `http://${deps.config.OPS_HOST}:${deps.config.OPS_PORT}`;
  const url = `${base.replace(/\/$/, "")}/app?token=${encodeURIComponent(token)}`;
  await send(`🎛 <b>${esc(deps.config.WEB_APP_TITLE || "Mission Control")}</b>\n<i>Panel privado con estado de sesiones y métricas en vivo.</i>`, {
    reply_markup: { inline_keyboard: [[{ text: "🌐 Abrir Mission Control", url }]] },
  });
  return true;
}

export async function cmd_commands(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/commands") {
    await C.showCommands(chatId, threadId);
    return true;
  }
  return false;
}

/**
 * /ops — admin-only operations card: runtime health, Telegram rate-limit
 * counters, adaptive throttle state and error summary. Admin-only.
 */
export async function cmd_ops(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  if (text !== "/ops") return false;
  const routeKey = deps.store.routeKey(chatId, threadId);
  const isAdmin = deps.permissions
    ? deps.permissions.isAdmin(routeKey, userId, deps.config.ADMIN_TELEGRAM_USER_ID)
    : deps.config.ADMIN_TELEGRAM_USER_ID !== undefined && userId === deps.config.ADMIN_TELEGRAM_USER_ID;
  if (!isAdmin) {
    await send("🩺 <b>/ops</b> es solo para administradores.");
    return true;
  }
  const rendered = await deps.panels.renderOps();
  await send(rendered.html, { reply_markup: { inline_keyboard: rendered.keyboard } });
  return true;
}

export async function cmd_settings(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/settings") {
    // Settings apply to the whole chat, so only its admins may change them.
    if (!isRouteAdmin(deps, chatId, threadId, userId)) {
      await send("⚙️ Solo un admin de este chat puede cambiar los ajustes.");
      return true;
    }
    const settings = C.settings.get(chatId);
    await send(renderSettingsPanel(chatId, settings), { reply_markup: { inline_keyboard: settingsKeyboard(settings) } });
    return true;
  }
  return false;
}

export async function cmd_models(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/models" || text === "/model") {
    const placeholder = await send("⏳ Cargando modelos…").catch(() => undefined) as { message_id?: number } | undefined;
    await C.showModels(chatId, 0, placeholder?.message_id, threadId, undefined, undefined, { userId });
    return true;
  }
  return false;
}

export async function cmd_agents(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/agents" || text === "/agent") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("No hay sesión activa.");
      return true;
    }
    const directory = s.directory ?? C.config.OPENCODE_DIRECTORY;
    const agents = await C.oc.listAgents(directory);
    if (!agents.length) {
      await send("no agents available. Configure agents in OpenCode.");
      return true;
    }
    const rows = (agents as Named[]).map((a) => `<tr><td><b>${esc(a.name ?? a.id ?? "")}</b></td><td>${esc(truncate(a.description ?? "", 90))}</td></tr>`).join("");
    const table = `<table><tr><th>Agent</th><th>Description</th></tr>${rows}</table>`;
    const keyboard = (agents as Named[]).map((a) => [{ text: a.name ?? a.id ?? "", callback_data: `agent:${a.id ?? ""}` }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    await send(`<b>Agents</b>\n\n${table}`, { reply_markup: { inline_keyboard: keyboard } });
    return true;
  }
  return false;
}

export async function cmd_skills(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/skills" || text === "/skill") {
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    const skills = await C.oc.listSkills(directory);
    if (!skills.length) {
      await send("no skills available.");
      return true;
    }
    const rows = (skills as Named[]).map((k) => `<tr><td><b>${esc(k.name ?? k.id ?? "")}</b></td><td>${esc(truncate(k.description ?? "", 90))}</td></tr>`).join("");
    const table = `<table><tr><th>Skill</th><th>Description</th></tr>${rows}</table>`;
    const keyboard = (skills as Named[]).map((k) => [{ text: k.name ?? k.id ?? "", callback_data: `skill:${k.id ?? ""}` }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    await send(`<b>Skills</b>\n\n${table}`, { reply_markup: { inline_keyboard: keyboard } });
    return true;
  }
  if (text.startsWith("/skill ")) {
    let s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("Usa /sessions para activar una o envía un mensaje para crearla.", { reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] } });
      return true;
    }
    const id = text.slice(7).trim();
    if (!id) {
      await send("Uso: /skill <id>");
      return true;
    }
    try {
      await C.oc.loadSkill(s.sessionId, id);
      await send(`Loaded skill <b>${esc(id)}</b>.`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_retry(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/retry" || text.startsWith("/retry ")) {
    const s = await C.resolveSessionForRetry(chatId, threadId);
    if (!s) {
      await send("No hay sesión activa.");
      return true;
    }
    // Allow an explicit prompt: /retry <text>. Otherwise reuse the session's
    // last prompt, falling back to the most recent prompt in this chat so a
    // stale/missing binding never replays an unrelated old prompt.
    const argPrompt = text.slice("/retry".length).trim();
    let prompt: string | undefined = argPrompt || undefined;
    if (!prompt) prompt = C.store.lastPromptBySession.get(s.sessionId);
    if (!prompt) {
      // Fallback: most recent prompt across sessions bound to this chat.
      const candidates = [...C.store.sessionsById.values()]
        .filter((cs) => cs.targetChatId === chatId || C.store.lastChatBySession.get(cs.sessionId) === chatId)
        .sort((a, b) => (b.promptStartTime ?? 0) - (a.promptStartTime ?? 0));
      for (const cs of candidates) {
        const p = C.store.lastPromptBySession.get(cs.sessionId);
        if (p) { prompt = p; break; }
      }
    }
    if (!prompt) {
      await send("no previous prompt to retry.");
      return true;
    }
    try {
      s.targetChatId = chatId;
      s.targetThreadId = threadId;
      C.store.rememberSessionChat(s.sessionId, chatId);
      C.store.rememberActiveRoute(chatId, threadId, s.sessionId);
      s.promptStartTime = Date.now();
      C.store.rememberLastChat(s.sessionId, chatId);
      C.store.rememberLastPrompt(s.sessionId, prompt);
      notePromptSent(s.sessionId, prompt);
      await send("🔁 Retrying last prompt…");
      await deps.status.startStatus(chatId, s);
      if (s.statusMessageId) C.store.rememberMessageSession(chatId, s.statusMessageId, s.sessionId);
      s.statusTimer = setInterval(() => {
        deps.status.updateStatus(chatId, s).catch(() => {});
      }, 5000);
      void C.oc.prompt(s.sessionId, prompt).catch(async (err) => {
        if (s.statusTimer) {
          clearInterval(s.statusTimer);
          s.statusTimer = undefined;
        }
        await deps.status.finishStatus(chatId, s).catch(() => {});
        await send(`❌ ${esc(String(err))}`, C.store.threadOptsFor(s));
      });
    } catch (err) {
      if (s.statusTimer) {
        clearInterval(s.statusTimer);
        s.statusTimer = undefined;
      }
      await deps.status.finishStatus(chatId, s).catch(() => {});
      await send(`❌ ${esc(String(err))}`, C.store.threadOptsFor(s));
    }
    return true;
  }
  return false;
}

export async function cmd_todos(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/todos" || text.startsWith("/todos ")) {
    const s = await C.resolveSessionForRetry(chatId, threadId);
    if (!s) {
      await send("No hay sesión activa.");
      return true;
    }
    const todos = C.store.getTodos(s.sessionId);
    if (!todos.length) {
      await send("📋 No hay tareas registradas para esta sesión.");
      return true;
    }
    await send(renderTodos(todos));
    return true;
  }
  return false;
}

export async function cmd_unlink(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/unlink" || text.startsWith("/unlink ")) {
    // Unlinking interrupts every session bound to the group: admins only.
    if (!isRouteAdmin(deps, chatId, threadId, userId)) {
      await send("🔗 Solo un admin de este chat puede desvincular las sesiones.");
      return true;
    }
    if (chatId >= 0) {
      await send("⚠️ <code>/unlink</code> solo tiene sentido en grupos (desvincula las sesiones del chat).");
      return true;
    }
    const affected = C.store.unlinkChat(chatId);
    // Retire (interrupt) each session that was bound to this chat.
    for (const sid of affected) {
      const cs = C.store.findSessionById(sid);
      if (cs?.statusTimer) { clearInterval(cs.statusTimer); cs.statusTimer = undefined; }
      if (cs?.sessionId) await C.oc.interrupt(cs.sessionId).catch(() => {});
    }
    await send(
      affected.length
        ? `✅ Desvinculadas ${affected.length} sesión(es) de este grupo.\n<i>Los topics quedan libres; las sesiones siguen existiendo en OpenCode.</i>`
        : "ℹ️ No había sesiones vinculadas a este grupo.",
    );
    return true;
  }
  return false;
}

export async function cmd_cancel(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/cancel") {
    const reasonKey = C.store.routeKey(chatId, threadId);
    // Cancel any pending text capture for this route as well.
    deps.awaitingPermissionAdd?.delete(reasonKey);
    // Cancel pending permission reason.
    if (deps.awaitingReason.has(reasonKey)) {
      const requestId = deps.awaitingReason.get(reasonKey)!;
      deps.awaitingReason.delete(reasonKey);
      const info = deps.pendingPermissions.get(requestId);
      if (info && !info.decided) {
        info.decided = true;
        deps.pendingPermissions.delete(requestId);
      }
      await send("🚫 Cancelado.");
      return true;
    }
    // Cancel any active turn.
    for (const [sid, cs] of C.store.sessionsById) {
      if (cs.targetChatId === chatId || C.store.lastChatBySession.get(sid) === chatId) {
        if (cs.statusMessageId && !cs.statusFinished) {
          cs.stopped = true;
          if (cs.statusTimer) { clearInterval(cs.statusTimer); cs.statusTimer = undefined; }
          if (cs.deltaFlushTimer) { clearTimeout(cs.deltaFlushTimer); cs.deltaFlushTimer = undefined; }
          await deps.status.finishStatus(chatId, cs).catch(() => {});
        }
      }
    }
    await send("🚫 Cancelado.");
    return true;
  }
  return false;
}

export async function cmd_permissions(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  const routeKey = deps.store.routeKey(chatId, threadId);
  const globalAdmin = deps.config.ADMIN_TELEGRAM_USER_ID;
  const isAdmin = deps.permissions
    ? deps.permissions.isAdmin(routeKey, userId, globalAdmin)
    : (globalAdmin !== undefined && userId === globalAdmin);
  if (!isAdmin) {
    await send("Solo el admin puede gestionar permisos de este thread.");
    return true;
  }
  const parts = text.trim().split(/\s+/);
  const store = deps.permissions;
  if (parts.length === 1) {
    if (!store) { await send("Permisos no disponibles."); return true; }
    const panel = store.renderPanel(routeKey, globalAdmin);
    await send(panel.html, { reply_markup: { inline_keyboard: panel.keyboard } });
    return true;
  }
  if (parts[1] === "readonly" && parts[2]) {
    const v = parts[2] === "on";
    store?.setReadOnly(routeKey, v);
    await send("🔒 Solo lectura: " + (v ? "sí" : "no"));
    return true;
  }
  if (parts[1] === "inherit" && parts[2]) {
    const v = parts[2] === "on";
    store?.set(routeKey, { inherit: v });
    await send("Heredar allowlist: " + (v ? "sí" : "no"));
    return true;
  }
  if (parts[1] === "add" && parts[2]) {
    const id = store?.resolveUser(parts[2]);
    if (id === undefined) {
      await send(`No conozco a <code>${esc(parts[2])}</code>. Pídele que escriba al bot y vuelve a intentarlo, o usa su ID numérico.`);
      return true;
    }
    const role = parts[3] === "admin" ? "admin" : "operator";
    store?.addUser(routeKey, id, role);
    await send("✅ Añadido " + (store?.label(id) ?? String(id)) + " como " + role + ".");
    return true;
  }
  if (parts[1] === "remove" && parts[2]) {
    const id = store?.resolveUser(parts[2]);
    if (id === undefined) { await send("Usuario no reconocido. Usa @username conocido o el ID numérico."); return true; }
    store?.removeUser(routeKey, id);
    await send("🗑 Eliminado " + (store?.label(id) ?? String(id)) + ".");
    return true;
  }
  await send("Uso: /permissions [readonly on|off | inherit on|off | add @usuario|id [operator|admin] | remove @usuario|id]");
  return true;
}

export async function cmd_buttons(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  const isAdmin = isRouteAdmin(deps, chatId, threadId, userId);
  if (text === "/buttons" || text.startsWith("/buttons ")) {
    const args = text.slice("/buttons".length).trim();
    if (!isAdmin) {
      await send("Solo un admin de este chat puede gestionar los botones.");
      return true;
    }
    if (args === "clear") {
      C.store.setCustomButtons(chatId, []);
      await send("Botones eliminados.");
      return true;
    }
    const removeMatch = args.match(/^remove\s+(\d+)$/);
    if (removeMatch) {
      const idx = Number(removeMatch[1]) - 1;
      const ok = C.store.removeCustomButton(chatId, idx);
      await send(ok ? "Botón eliminado." : "Índice inválido.");
      return true;
    }
    const addMatch = args.match(/^add\s+(.+)$/);
    if (addMatch) {
      const rest = addMatch[1];
      const sep = rest.indexOf("|");
      if (sep === -1) {
        await send("Uso: /buttons add <etiqueta> | <texto a enviar>");
        return true;
      }
      const label = rest.slice(0, sep).trim();
      const btnText = rest.slice(sep + 1).trim();
      if (!label || !btnText) {
        await send("Uso: /buttons add <etiqueta> | <texto a enviar>");
        return true;
      }
      C.store.addCustomButton(chatId, label, btnText);
      await send(`Botón añadido: <b>${esc(label)}</b> → ${esc(btnText)}`);
      return true;
    }
    const buttons = C.store.getCustomButtons(chatId);
    if (!buttons.length) {
      await send("No hay botones custom.\nUso: /buttons add <etiqueta> | <texto>");
      return true;
    }
    const lines = buttons.map((b, i) => `${i + 1}. <b>${esc(b.label)}</b> → ${esc(b.text)}`);
    await send(`<b>Botones custom</b>\n${lines.join("\n")}\n\n/buttons add <etiqueta> | <texto>\n/buttons remove <n>\n/buttons clear`);
    return true;
  }
  return false;
}


export async function cmd_widget(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/widget" || text.startsWith("/widget ")) {
    // Widgets only work in private chats in production.
    if (chatId >= 0) {
      await send("🧩 Los widgets solo funcionan en el chat privado con el bot (limitación de Telegram). Escríbeme por privado y usa /widget.");
      return true;
    }
    try {
      await C.tg.sendWidget(chatId, RESOURCE_WIDGET_HTML, {
        caption: "🧩 Monitor del sistema (CPU/RAM/GPU). Se actualiza cada 5 s.",
        allow_queries: true,
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      await send("🧩 Widget enviado. Toca «Actualizar» o espera la auto-actualización (cada 5 s).");
    } catch (err) {
      await send(`❌ No se pudo enviar el widget: ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}
