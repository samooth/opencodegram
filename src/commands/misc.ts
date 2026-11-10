import { resolve } from "node:path";
import type { BotDeps, SendFn } from "../context.js";
import { createZipArchive, fileErrorMessage, formatBytes, prepareDocument, treeDirectory } from "../files/index.js";
import * as mcp from "../mcp.js";
import { isSettingsKey, renderSettings, settingsKeyboard } from "../settings.js";
import * as vcs from "../vcs.js";
import { clampText, colorDiff, esc, threadOpts, truncate } from "../util.js";
import { cancelAutoRetry, notePromptSent } from "../autoretry.js";
import { ctx } from "./shared.js";

export async function cmd_start(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/start" || text === "/help") {
    await C.sendPanel(chatId, threadId);
    return true;
  }
  return false;
}

export async function cmd_commands(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/commands") {
    await C.showCommands(chatId, threadId);
    return true;
  }
  return false;
}

export async function cmd_settings(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/settings") {
    const settings = C.settings.get(chatId);
    await send(renderSettings(chatId, settings), { reply_markup: { inline_keyboard: settingsKeyboard(settings) } });
    return true;
  }
  return false;
}

export async function cmd_models(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/models" || text === "/model") {
    await C.showModels(chatId, 0, undefined, threadId, undefined, undefined, { userId });
    return true;
  }
  return false;
}

export async function cmd_agents(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/agents" || text === "/agent") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    const directory = s.directory ?? C.config.OPENCODE_DIRECTORY;
    const agents = await C.oc.listAgents(directory);
    if (!agents.length) {
      await send("no agents available. Configure agents in OpenCode.");
      return true;
    }
    const rows = agents.map((a: any) => `<tr><td><b>${esc(a.name ?? a.id)}</b></td><td>${esc(truncate(a.description ?? "", 90))}</td></tr>`).join("");
    const table = `<table><tr><th>Agent</th><th>Description</th></tr>${rows}</table>`;
    const keyboard = agents.map((a: any) => [{ text: a.name ?? a.id, callback_data: `agent:${a.id}` }]);
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
    const rows = skills.map((k: any) => `<tr><td><b>${esc(k.name ?? k.id)}</b></td><td>${esc(truncate(k.description ?? "", 90))}</td></tr>`).join("");
    const table = `<table><tr><th>Skill</th><th>Description</th></tr>${rows}</table>`;
    const keyboard = skills.map((k: any) => [{ text: k.name ?? k.id, callback_data: `skill:${k.id}` }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    await send(`<b>Skills</b>\n\n${table}`, { reply_markup: { inline_keyboard: keyboard } });
    return true;
  }
  if (text.startsWith("/skill ")) {
    let s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session. Usa /sessions para activar una o envía un mensaje para crearla.", { reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "➕ New", callback_data: "panel:new" }]] } });
      return true;
    }
    const id = text.slice(7).trim();
    if (!id) {
      await send("usage: /skill <id>");
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
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    const prompt = C.store.lastPromptBySession.get(s.sessionId);
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

export async function cmd_buttons(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  const isAdmin = !!C.config.ADMIN_TELEGRAM_USER_ID && deps.me?.id === C.config.ADMIN_TELEGRAM_USER_ID;
  if (text === "/buttons" || text.startsWith("/buttons ")) {
    const args = text.slice("/buttons".length).trim();
    if (!isAdmin) {
      await send("Solo el admin puede gestionar botones.");
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

