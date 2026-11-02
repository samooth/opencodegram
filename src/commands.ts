import { resolve } from "node:path";
import type { BotDeps, SendFn } from "./context.js";
import { createZipArchive, fileErrorMessage, formatBytes, prepareDocument, treeDirectory } from "./files/index.js";
import * as mcp from "./mcp.js";
import { isSettingsKey, renderSettings, settingsKeyboard } from "./settings.js";
import * as vcs from "./vcs.js";
import { clampText, colorDiff, esc, threadOpts, truncate } from "./util.js";
import { cancelAutoRetry, notePromptSent } from "./autoretry.js";

/**
 * Slash commands that do not prompt the model. Returns true when the text was
 * fully handled; false means the caller should send it as a prompt.
 */
export const KNOWN_COMMANDS = new Set([
  "start",
  "help",
  "status",
  "session",
  "sessions",
  "new",
  "stop",
  "abort",
  "commands",
  "settings",
  "file",
  "ls",
  "find",
  "read",
  "zip",
  "model",
  "models",
  "agent",
  "agents",
  "skill",
  "skills",
  "fork",
  "rename",
  "archive",
  "unarchive",
  "delete",
  "deletesessions",
  "diff",
  "context",
  "compact",
  "retry",
  "vcs",
  "mcp",
  "branches",
  "branch",
  "stage",
  "unstage",
  "commit",
  "worktrees",
  "worktree",
  "usage",
  "forms",
  "formreply",
  "sync",
  "use",
]);

export const COMMANDS = new Map<string, (deps: BotDeps, chatId: number, threadId: number | undefined, args: string, send: SendFn) => Promise<void>>();

function ctx(deps: BotDeps) {
  const { config, tg, oc, panels, sessions, files, store } = deps;
  const settings = deps.settings;
  const updateStatus = deps.status?.updateStatus ?? (async () => {});
  const { restoreActiveSession, activateSession } = sessions;
  const { sendPanel, showCommands, showModels, showSessions, showDeleteSessions, showStatus } = panels;
  return { config, tg, oc, panels, sessions, files, store, settings, updateStatus, restoreActiveSession, activateSession, sendPanel, showCommands, showModels, showSessions, showDeleteSessions, showStatus };
}

async function cmd_start(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/start" || text === "/help") {
    await C.sendPanel(chatId, threadId);
    return true;
  }
  return false;
}

async function cmd_status(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/status" || text === "/session") {
    await C.showStatus(chatId, threadId);
    return true;
  }
  return false;
}

async function cmd_new(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/new") {
    const active = await C.restoreActiveSession(chatId, threadId);
    if (active) {
      await send(`⚠️ Ya hay una sesión activa: <code>${esc(active.sessionId)}</code>.\\n¿Crear una nueva y reemplazarla?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Sí, crear nueva", callback_data: "new:confirm" }, { text: "❌ Cancelar", callback_data: "new:cancel" }],
          ],
        },
      });
      return true;
    }
    await deps.sessions.createNewSession(chatId, false, threadId);
    return true;
  }
  return false;
}

async function cmd_stop(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/stop" || text === "/abort") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session");
      return true;
    }
    try {
      s.stopped = true;
      if (s.statusTimer) {
        clearInterval(s.statusTimer);
        s.statusTimer = undefined;
      }
      cancelAutoRetry(s.sessionId);
      await C.oc.interrupt(s.sessionId);
      if (s.statusMessageId) {
        await C.updateStatus(chatId, s, true).catch(() => {});
      }
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_commands(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/commands") {
    await C.showCommands(chatId, threadId);
    return true;
  }
  return false;
}

async function cmd_settings(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/settings") {
    const settings = C.settings.get(chatId);
    await send(renderSettings(chatId, settings), { reply_markup: { inline_keyboard: settingsKeyboard(settings) } });
    return true;
  }
  return false;
}

async function cmd_file(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/file" || text.startsWith("/file ")) {
    const rawPath = text.slice("/file".length).trim();
    if (!rawPath) {
      await send("usage: /file <path> (relative to the session directory)");
      return true;
    }
    const s = await C.restoreActiveSession(chatId, threadId);
    const base = resolve(s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd());
    try {
      const doc = await prepareDocument(base, rawPath);
      const progress = await C.tg.sendRichMessage(chatId, `📎 Sending <b>${esc(doc.name)}</b> (${formatBytes(doc.size)})…`, threadOpts(threadId));
      try {
        await C.tg.sendDocument(
          chatId,
          doc.absolute,
          doc.name,
          `<b>${esc(doc.name)}</b>\n<code>${esc(doc.relative || doc.name)}</code>\n${formatBytes(doc.size)}`,
          { ...threadOpts(threadId), parse_mode: "HTML" },
        );
      } finally {
        await C.tg.deleteMessage(chatId, progress.message_id).catch(() => {});
      }
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_ls(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/ls" || text.startsWith("/ls ")) {
    const { path, hidden } = parseListArgs(text.slice(3).trim());
    try {
      await C.files.showListing(chatId, threadId, path, { hidden });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_find(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/find" || text.startsWith("/find ")) {
    const { query, hidden } = parseFindArgs(text.slice(5).trim());
    if (!query) {
      await send("usage: /find <text> [-a]");
      return true;
    }
    try {
      await C.files.showFind(chatId, threadId, query, { hidden });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_zip(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/zip" || text.startsWith("/zip ")) {
    const rawPath = text.slice("/zip".length).trim() || ".";
    const s = await C.restoreActiveSession(chatId, threadId);
    const base = resolve(s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd());
    let archive: Awaited<ReturnType<typeof createZipArchive>> | undefined;
    const progress = await C.tg.sendRichMessage(chatId, "🗜 Creating archive…", threadOpts(threadId));
    try {
      archive = await createZipArchive(base, rawPath);
      await C.tg.editRichMessage(chatId, progress.message_id, `📎 Sending <b>${esc(archive.name)}</b> (${formatBytes(archive.size)})…`, threadOpts(threadId)).catch(() => {});
      await C.tg.sendDocument(
        chatId,
        archive.absolute,
        archive.name,
        `<b>${esc(archive.name)}</b>\n<code>${esc(rawPath)}</code>\n${formatBytes(archive.size)}`,
        { ...threadOpts(threadId), parse_mode: "HTML" },
      );
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    } finally {
      await archive?.cleanup();
      await C.tg.deleteMessage(chatId, progress.message_id).catch(() => {});
    }
    return true;
  }
  return false;
}

async function cmd_read(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/read" || text.startsWith("/read ")) {
    const raw = text.slice(5).trim();
    if (!raw) {
      await send("usage: /read <path> [start_line | summary]");
      return true;
    }
    if (raw.toLowerCase().endsWith(" summary")) {
      const path = raw.slice(0, -8).trim();
      try {
        await C.files.showSummary(chatId, threadId, path);
      } catch (err) {
        await send(`❌ ${esc(fileErrorMessage(err))}`);
      }
      return true;
    }
    const grepMatch = raw.match(/^(.*?)\s+grep\s+(.+)$/is);
    if (grepMatch && grepMatch[1].trim() && grepMatch[2].trim()) {
      const path = grepMatch[1].trim();
      const pattern = grepMatch[2].trim();
      try {
        await C.files.showSearch(chatId, threadId, path, pattern);
      } catch (err) {
        await send(`❌ ${esc(fileErrorMessage(err))}`);
      }
      return true;
    }
    const { path, startLine } = parseReadArgs(raw);
    try {
      await C.files.showFile(chatId, threadId, path, { startLine, maxLines: C.settings.get(chatId).previewLines });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_tree(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/tree" || text.startsWith("/tree ")) {
    const raw = text.slice(5).trim();
    const [pathPart, depthPart] = raw.split(/\s+/);
    const path = pathPart || ".";
    const depth = depthPart ? parseInt(depthPart, 10) : 3;
    const base = (await (async () => {
      const s = await C.restoreActiveSession(chatId, threadId);
      return s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    })());
    try {
      const t = await treeDirectory(base, path, Number.isFinite(depth) ? depth : 3);
      const body = t.lines.slice(0, 200).map((l) => esc(l)).join("\n");
      await send(`<b>🌳 ${esc(t.relative || ".")}</b>\n<pre>${body}</pre>`);
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_models(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/models" || text === "/model") {
    await C.showModels(chatId, 0, undefined, threadId);
    return true;
  }
  return false;
}

async function cmd_agents(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

async function cmd_skills(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

async function cmd_usage(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/usage") {
    try {
      const stats = await C.oc.client.session.stats();
      const data = ((stats as { data?: unknown })?.data ?? stats) as {
        sessions?: number; prompts?: number; steps?: number;
        tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } };
        cost?: number;
        tools?: { totals?: { calls?: number; succeeded?: number; failed?: number } };
      };
      const msg = [
        `<b>Usage</b>`,
        `Sessions: ${data.sessions ?? 0} · Prompts: ${data.prompts ?? 0} · Steps: ${data.steps ?? 0}`,
        `Tokens: in ${(data.tokens?.input ?? 0).toLocaleString()} · out ${(data.tokens?.output ?? 0).toLocaleString()} · reasoning ${(data.tokens?.reasoning ?? 0).toLocaleString()}`,
        `Rate: <tg-math>tokens \\times rate</tg-math>`,
        `Cost: ${(data.cost ?? 0).toFixed(4)}`,
        `Tools: ${data.tools?.totals?.calls ?? 0} calls (${data.tools?.totals?.succeeded ?? 0} ok, ${data.tools?.totals?.failed ?? 0} failed)`,
      ].join("\n");
      await send(msg);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_vcs(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/vcs" || text.startsWith("/vcs ")) {
    const args = text.slice(4).trim().split(/\s+/).filter(Boolean);
    const subcommand = args[0]?.toLowerCase();
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();

    if (!subcommand || subcommand === "status") {
      try {
        const status = await vcs.vcsStatus(directory);
        const lines = status.files.slice(0, 20).map((file) => `• <code>${esc(file)}</code>`);
        const fileList = status.clean ? "Working tree clean." : lines.join("\n");
        await send(`<b>VCS</b>\nBranch: <code>${esc(status.branch)}</code>\nChanged: ${status.changed}\n\n${fileList}\n\nUse /branches, /vcs diff, /stage, /unstage, /commit.`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "diff") {
      const cached = args.includes("--cached");
      const path = args.filter((arg) => arg !== "diff" && arg !== "--cached").join(" ") || undefined;
      try {
        const diff = await vcs.vcsDiff(directory, cached, path);
        if (!diff) {
          await send(cached ? "No staged changes." : "No changes.");
          return true;
        }
        await send(`<b>${cached ? "Staged diff" : "Working tree diff"}${path ? " · " + esc(path) : ""}</b>\n<pre><code class="language-diff">${colorDiff(diff.slice(0, 3500))}</code></pre>`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "log") {
      try {
        const log = await vcs.vcsLog(directory);
        await send(`<b>Recent commits</b>\n<pre>${esc(log || "(none)")}</pre>`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    await send("usage: /vcs [status|diff [--cached] [path]|log]");
    return true;
  }
  return false;
}

async function cmd_mcp(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/mcp" || text.startsWith("/mcp ")) {
    const args = text.slice(4).trim().split(/\s+/).filter(Boolean);
    const subcommand = (args[0] ?? "list").toLowerCase();
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();

    if (subcommand === "list" || subcommand === "ls" || subcommand === "status") {
      try {
        const { text: listText, keyboard } = await mcp.renderMcpList(C.oc, directory);
        await send(listText, { reply_markup: { inline_keyboard: keyboard } });
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "connect") {
      const name = args[1];
      if (!name) {
        await send("usage: /mcp connect <name>");
        return true;
      }
      try {
        await mcp.connectMcpServer(C.oc, name, directory);
        const { text: listText, keyboard } = await mcp.renderMcpList(C.oc, directory);
        await send(`✅ Connected ${esc(name)}\n\n${listText}`, { reply_markup: { inline_keyboard: keyboard } });
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "disconnect") {
      const name = args[1];
      if (!name) {
        await send("usage: /mcp disconnect <name>");
        return true;
      }
      try {
        await mcp.disconnectMcpServer(C.oc, name, directory);
        const { text: listText, keyboard } = await mcp.renderMcpList(C.oc, directory);
        await send(`✅ Disconnected ${esc(name)}\n\n${listText}`, { reply_markup: { inline_keyboard: keyboard } });
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "remove" || subcommand === "rm") {
      const name = args[1];
      if (!name) {
        await send("usage: /mcp remove <name>");
        return true;
      }
      try {
        await mcp.removeMcpServer(C.oc, name, directory);
        const { text: listText, keyboard } = await mcp.renderMcpList(C.oc, directory);
        await send(`✅ Removed ${esc(name)}\n\n${listText}`, { reply_markup: { inline_keyboard: keyboard } });
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "resources" || subcommand === "catalog") {
      try {
        const { resources, templates } = await mcp.listMcpResources(C.oc, directory);
        const all = [...resources, ...templates];
        if (!all.length) {
          await send("No MCP resources available.");
          return true;
        }
        const lines = all.map((resource) => `• <b>${esc(resource.name)}</b> (${esc(resource.server)})\n  <code>${esc(resource.uri)}</code>${resource.description ? "\n  " + esc(resource.description) : ""}`);
        await send(`<b>MCP resources</b>\n${lines.join("\n\n")}\n\nUse /mcp read <uri>`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "read") {
      const uri = args.slice(1).join(" ");
      if (!uri) {
        await send("usage: /mcp read <uri>");
        return true;
      }
      try {
        const result = await mcp.readMcpResource(uri, directory);
        if (result.error) {
          await send(`❌ ${esc(result.error)}`);
          return true;
        }
        if (result.text !== undefined) {
          await send(clampText(result.text, 3500));
        } else {
          await send("Binary or unsupported MCP resource.");
        }
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    await send("usage: /mcp [list|connect <name>|disconnect <name>|remove <name>|resources|read <uri>]");
    return true;
  }
  return false;
}

async function cmd_branches(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/branches" || text === "/branch" || text.startsWith("/branch ")) {
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    const parts = text.split(/\s+/).filter(Boolean);
    const subcommand = parts[1]?.toLowerCase();
    if (!subcommand || subcommand === "list" || subcommand === "ls") {
      try {
        const branches = await vcs.vcsBranches(directory);
        const status = await vcs.vcsStatus(directory);
        const current = status.branch;
        if (!branches.length) {
          await send("no branches found.");
          return true;
        }
        const lines = branches.map((branch) => (branch === current ? `• <b>${esc(branch)}</b> ✅` : `• <code>${esc(branch)}</code>`));
        await send(`<b>Branches</b>\n${lines.join("\n")}`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }
    if (subcommand === "switch" || subcommand === "checkout" || subcommand === "use") {
      const branch = parts.slice(2).join(" ");
      if (!branch) {
        await send("usage: /branch switch <name>");
        return true;
      }
      try {
        const result = await vcs.vcsSwitch(directory, branch);
        await send(`✅ ${esc(result.output)}`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }
    const branch = parts.slice(1).join(" ");
    try {
      const result = await vcs.vcsSwitch(directory, branch);
      await send(`✅ ${esc(result.output)}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_stage(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/stage" || text.startsWith("/stage ")) {
    const path = text.slice(6).trim();
    if (!path) {
      await send("usage: /stage <path>");
      return true;
    }
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    try {
      const result = await vcs.vcsStage(directory, path);
      await send(`✅ ${esc(result.output)}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_unstage(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/unstage" || text.startsWith("/unstage ")) {
    const path = text.slice(8).trim();
    if (!path) {
      await send("usage: /unstage <path>");
      return true;
    }
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    try {
      const result = await vcs.vcsUnstage(directory, path);
      await send(`✅ ${esc(result.output)}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_commit(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/commit" || text.startsWith("/commit ")) {
    const rest = text.slice(7).trim();
    if (!rest) {
      await send("usage: /commit <message>");
      return true;
    }
    if (rest.startsWith("confirm ")) {
      const message = rest.slice(8).trim();
      if (!message) {
        await send("usage: /commit confirm <message>");
        return true;
      }
      const s = await C.restoreActiveSession(chatId, threadId);
      const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
      try {
        const result = await vcs.vcsCommit(directory, message);
        await send(`✅ ${esc(result.output)}`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }
    await send(`Commit message:\n<code>${esc(rest)}</code>\nReply /commit confirm ${esc(rest)} to proceed.`);
    return true;
  }
  return false;
}

async function cmd_worktree(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/worktrees") {
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY;
    try {
      const list = await C.oc.worktreeList(directory);
      if (!list.length) {
        await send("no worktrees.");
        return true;
      }
      const lines = list.map((w: any) => `• <code>${esc(w.directory ?? w.path ?? "")}</code>`);
      await send(`<b>Worktrees</b>\n${lines.join("\n")}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  if (text === "/worktree" || text.startsWith("/worktree ")) {
    const args = text.slice("/worktree".length).trim().split(/\s+/).filter(Boolean);
    const subcommand = (args[0] ?? "list").toLowerCase();
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();

    if (subcommand === "list" || subcommand === "ls") {
      try {
        const list = await C.oc.worktreeList(directory);
        if (!list.length) {
          await send("no worktrees.");
          return true;
        }
        const lines = list.map((w: any) => `• <code>${esc(w.directory ?? w.path ?? "")}</code>`);
        await send(`<b>Worktrees</b>\n${lines.join("\n")}`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "create" || subcommand === "add") {
      const name = args[1];
      if (!name) {
        await send("usage: /worktree create <name> [branch]");
        return true;
      }
      const branch = args[2];
      try {
        await send("Creating worktree…");
        void C.oc.worktreeCreate(directory, name, branch)
          .then((info) => {
            const created = (info as { directory?: string; path?: string })?.directory ?? (info as { directory?: string; path?: string })?.path ?? name;
            return send(`✅ Worktree created\n<code>${esc(created)}</code>\nUse /worktree switch ${esc(created)}`);
          })
          .catch((err) => send(`❌ ${esc(String(err))}`));
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
      if (args[1] === "confirm") {
        const target = args.slice(2).join(" ");
        if (!target) {
          await send("usage: /worktree remove confirm <directory>");
          return true;
        }
        try {
          await send("Removing worktree…");
          void C.oc.worktreeRemove(directory, target, true)
            .then(() => send(`✅ Worktree removed\n<code>${esc(target)}</code>`))
            .catch((err) => send(`❌ ${esc(String(err))}`));
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        return true;
      }
      const target = args.slice(1).join(" ");
      if (!target) {
        await send("usage: /worktree remove <directory>");
        return true;
      }
      await send(`Remove worktree <code>${esc(target)}</code>?\nReply /worktree remove confirm ${esc(target)} to proceed.`);
      return true;
    }

    if (subcommand === "switch" || subcommand === "use" || subcommand === "cd") {
      const target = args.slice(1).join(" ");
      if (!target) {
        await send("usage: /worktree switch <directory>");
        return true;
      }
      if (!s) {
        await send("no active session.");
        return true;
      }
      try {
        const list = await C.oc.worktreeList(directory);
        const directories = list.map((w: any) => w.directory ?? w.path).filter(Boolean);
        if (!directories.includes(target)) {
          await send(`❌ Not a known worktree:\n<code>${esc(target)}</code>`);
          return true;
        }
        await send("Switching worktree…");
        void C.oc.sessionMove(s.sessionId, target)
          .then(() => {
            s.directory = target;
            return send(`✅ Switched session to\n<code>${esc(target)}</code>`);
          })
          .catch((err) => send(`❌ ${esc(String(err))}`));
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    await send("usage: /worktree [list|create <name> [branch]|remove <directory>|switch <directory>]");
    return true;
  }
  return false;
}

async function cmd_forms(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/forms") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const forms = await C.oc.listForms(s.sessionId);
      if (!forms.length) {
        await send("no pending forms.");
        return true;
      }
      for (const f of forms) {
        const fields = Array.isArray(f.fields) ? f.fields : [];
        const fieldLines = fields.map(
          (fld: any) => `• <b>${esc(fld.key)}</b> (${esc(fld.type)})${fld.required ? " *" : ""}${fld.description ? " — " + esc(fld.description) : ""}`,
        );
        await send(
          `<b>Form: ${esc(f.title)}</b>\nID: <code>${esc(f.id)}</code>\n\n${fieldLines.join("\n")}\n\nReply with <code>/formreply ${esc(f.id)} {"key":"value"}</code>`,
        );
      }
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_formreply(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text.startsWith("/formreply ")) {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    const rest = text.slice(11).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) {
      await send("usage: /formreply <form_id> <json>");
      return true;
    }
    const formId = rest.slice(0, spaceIdx).trim();
    const jsonStr = rest.slice(spaceIdx + 1).trim();
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(jsonStr);
    } catch {
      await send("invalid JSON.");
      return true;
    }
    try {
      await C.oc.replyForm(s.sessionId, formId, answer as Record<string, string | number | boolean | string[]>);
      await send(`Form ${esc(formId)} answered.`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_fork(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/fork") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await send("Forking session…");
      void C.oc.forkSession(s.sessionId)
        .then(async (forked) => {
          const _f = forked as { id?: string; sessionID?: string; data?: { id?: string } } | undefined;
          const newId = _f?.id ?? _f?.sessionID ?? _f?.data?.id;
          if (!newId) {
            await send("❌ Could not determine forked session id.");
            return;
          }
          await C.activateSession(chatId, newId, true, threadId);
          await send(`Forked session.\n<code>${esc(s.sessionId)}</code> → <code>${esc(newId)}</code>`);
        })
        .catch((err) => send(`❌ ${esc(String(err))}`));
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_rename(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text.startsWith("/rename ")) {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    const title = text.slice(8).trim();
    if (!title) {
      await send("usage: /rename <title>");
      return true;
    }
    try {
      await C.oc.renameSession(s.sessionId, title);
      const threadIdToEdit = s.targetThreadId ?? s.threadId ?? C.store.threadBySession.get(s.sessionId);
      if (threadIdToEdit) {
        try {
          const targetChat = s.targetChatId ?? chatId;
          const ok = await C.tg.editForumTopic(targetChat, threadIdToEdit, title.slice(0, 120));
          if (ok) {
            s.threadId = threadIdToEdit;
            s.targetThreadId = threadIdToEdit;
            s.topicTitle = title.slice(0, 120);
            C.store.rememberTopicTitle(s.sessionId, s.topicTitle);
          } else {
            console.error("[rename] editForumTopic returned false for", chatId, threadIdToEdit);
          }
        } catch (err) {
          console.error("[rename] editForumTopic failed", chatId, threadIdToEdit, err);
        }
      } else {
        console.error("[rename] no thread id for session", s.sessionId);
      }
      await send(`Renamed session to <b>${esc(title)}</b>.`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_archive(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/archive") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await send("Archiving session…");
      void C.oc.archiveSession(s.sessionId, true)
        .then(() => send("Session archived."))
        .catch((err) => send(`❌ ${esc(String(err))}`));
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_unarchive(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/unarchive") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await send("Unarchiving session…");
      void C.oc.archiveSession(s.sessionId, false)
        .then(() => send("Session unarchived."))
        .catch((err) => send(`❌ ${esc(String(err))}`));
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_delete(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/deletesessions group" || text === "/delete sessions group" || text === "/deletesessions g") {
    await C.showDeleteSessions(chatId, 0, undefined, threadId, chatId);
    return true;
  }
  if (text === "/deletesessions" || text === "/delete sessions" || text === "/delete list") {
    await C.showDeleteSessions(chatId, 0, undefined, threadId);
    return true;
  }
  if (text === "/delete") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    await send(`Delete session <code>${esc(s.sessionId)}</code>?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🗑 Delete", callback_data: `delete:confirm:${s.sessionId}` },
            { text: "Cancel", callback_data: "delete:cancel" },
          ],
        ],
      },
    });
    return true;
  }
  if (text === "/delete confirm") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await send("Deleting session…");
      void C.oc.deleteSession(s.sessionId)
        .then(() => {
          C.store.forgetSession(s.sessionId);
          return send("Session deleted.");
        })
        .then(() => C.sendPanel(chatId, threadId))
        .catch((err) => send(`❌ ${esc(String(err))}`));
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_diff(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/diff") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const diffs = await C.oc.diff(s.sessionId);
      if (!diffs.length) {
        await send("No changes.");
        return true;
      }
      const rows = diffs
        .map((d: any) => `<tr><td><code>${esc(d.file ?? "")}</code></td><td>+${d.additions ?? 0}/-${d.deletions ?? 0}</td><td>${esc(d.status ?? "")}</td></tr>`)
        .join("");
      await send(`<b>Diff summary</b>\n<table><tr><th>File</th><th>Changes</th><th>Status</th></tr>${rows}</table>`);
      for (const d of diffs) {
        const patch = (d.patch ?? "").slice(0, 3500);
        await send(
          `<details><summary><b>${esc(d.file ?? "")}</b> (+${d.additions ?? 0}/-${d.deletions ?? 0})</summary>\n<pre><code class="language-diff">${colorDiff(patch)}</code></pre>\n</details>`,
        );
      }
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_sync(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/sync") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const ctxData = await C.oc.context(s.sessionId);
      const items = (Array.isArray(ctxData) ? ctxData : ((ctxData as { data?: unknown })?.data ?? [])) as Array<Record<string, unknown>>;
      const meaningful = items
        .filter((m: any) => {
          const role = m.role ?? m.type;
          return role === "user" || role === "assistant" || role === "compaction";
        })
        .slice(-20);
      if (!meaningful.length) {
        await send("No context to sync.");
        return true;
      }
      await send("<b>Syncing " + meaningful.length + " messages…</b>");
      for (const m of meaningful) {
        const role = m.role ?? m.type ?? "msg";
        let body = "";
        if (role === "user") {
          const t = m.text;
          body = typeof t === "string" ? t : t ? JSON.stringify(t) : "";
        } else if (role === "assistant") {
          const parts = Array.isArray(m.content) ? m.content : [];
          const texts = parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => {
              const t = p.text;
              return typeof t === "string" ? t : t ? JSON.stringify(t) : "";
            });
          body = texts.join(" ").trim();
          if (!body) {
            const tools = parts.filter((p: any) => p.type === "tool").map((p: any) => p.name ?? p.tool ?? "tool");
            if (tools.length) body = "🔧 " + tools.join(", ");
          }
        } else if (role === "compaction") {
          body = (m.summary ?? "").toString().split("\n")[0].slice(0, 200);
        }
        body = body.replace(/\s+/g, " ").trim().slice(0, 1000);
        const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : "📦";
        await send(icon + " <b>" + esc(String(role)) + "</b>:\n" + esc(body || "(no text)"));
      }
      await send("✅ Sync complete.");
    } catch (err) {
      await send("❌ " + esc(String(err)));
    }
    return true;
  }
  return false;
}

async function cmd_context(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/context") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const session = await C.oc.client.session.get({ sessionID: s.sessionId });
      const modelInfo = await (async () => {
        try {
          const res = await C.oc.client.model.list();
          const list = (((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[]) as Array<Record<string, unknown>>;
          return list.find((m: any) => m.id === session.model?.id && m.providerID === session.model?.providerID);
        } catch {
          return null;
        }
      })();
      const ctxLimit = (modelInfo as { limit?: { context?: number } })?.limit?.context ?? 0;
      const tokens = session.tokens ?? {};
      const inTok = tokens.input ?? 0;
      const outTok = tokens.output ?? 0;
      const reasonTok = tokens.reasoning ?? 0;
      const cacheRead = tokens.cache?.read ?? 0;
      const ctxData = await C.oc.context(s.sessionId);
      const items = (Array.isArray(ctxData) ? ctxData : ((ctxData as { data?: unknown })?.data ?? [])) as Array<Record<string, unknown>>;
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
      const summaries = sliced
        .map((m: any) => {
          const role = m.role ?? m.type ?? "msg";
          let body = "";
          if (role === "user") {
            const t = m.text;
            body = typeof t === "string" ? t : t ? JSON.stringify(t) : "";
          } else if (role === "assistant") {
            const parts = Array.isArray(m.content) ? m.content : [];
            const texts = parts
              .filter((p: any) => p.type === "text")
              .map((p: any) => {
                const t = p.text;
                return typeof t === "string" ? t : t ? JSON.stringify(t) : "";
              });
            const tools = parts.filter((p: any) => p.type === "tool").map((p: any) => p.name ?? p.tool ?? "tool");
            body = texts.join(" ").trim();
            if (!body && tools.length) body = "🔧 " + tools.join(", ");
          } else if (role === "compaction") {
            body = (m.summary ?? "").toString().split("\n")[0].slice(0, 120);
          }
          body = body.replace(/\s+/g, " ").trim().slice(0, 160);
          const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : role === "compaction" ? "📦" : "•";
          return icon + " <b>" + esc(String(role)) + "</b>: " + esc(body || "(no text)");
        })
        .filter(Boolean);
      const lastUser = [...items].reverse().find((m: any) => (m.role ?? m.type) === "user");
      const lastAssistant = [...items].reverse().find((m: any) => (m.role ?? m.type) === "assistant");
      const lastUserText = lastUser ? (typeof lastUser.text === "string" ? lastUser.text : JSON.stringify(lastUser.text ?? "")).slice(0, 200) : "";
      const lastAssistantText = lastAssistant
        ? (Array.isArray(lastAssistant.content)
            ? lastAssistant.content
                .filter((p: any) => p.type === "text")
                .map((p: any) => (typeof p.text === "string" ? p.text : JSON.stringify(p.text ?? "")))
                .join(" ")
            : ""
          )
            .toString()
            .slice(0, 200)
        : "";
      const tokenTable =
        "<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Input</td><td>" +
        inTok.toLocaleString() +
        "</td></tr><tr><td>Output</td><td>" +
        outTok.toLocaleString() +
        "</td></tr><tr><td>Reasoning</td><td>" +
        reasonTok.toLocaleString() +
        "</td></tr><tr><td>Cache read</td><td>" +
        cacheRead.toLocaleString() +
        "</td></tr><tr><td>Cost</td><td>" +
        (session.cost ?? 0).toFixed(4) +
        "</td></tr></table>";
      const msg = [
        "<b>🧠 Context</b>",
        "",
        "<table><tr><td><b>Model</b></td><td><code>" +
          esc(session.model?.providerID ?? "") +
          "/" +
          esc(session.model?.id ?? "") +
          "</code>" +
          (session.model?.variant ? " (" + esc(session.model.variant) + ")" : "") +
          "</td></tr>",
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
      ]
        .filter(Boolean)
        .join("\n");
      await send(msg);
    } catch (err) {
      await send("❌ " + esc(String(err)));
    }
    return true;
  }
  return false;
}

async function cmd_compact(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/compact") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await send("Compacting session…");
      void C.oc.compactSession(s.sessionId)
        .then(() => send("Session compacted."))
        .catch((err) => send(`❌ ${esc(String(err))}`));
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

async function cmd_retry(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

async function cmd_running_sessions(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/running" || text === "/sessions running" || text === "/sessions busy") {
    await C.showSessions(chatId, 0, undefined, threadId, undefined, true);
    return true;
  }
  if (text === "/sessions" || text.startsWith("/sessions ")) {
    const arg = text.slice("/sessions".length).trim();
    if (arg === "group" || arg === "g") {
      await C.showSessions(chatId, 0, undefined, threadId, chatId);
      return true;
    }
    const page = /^\d+$/.test(arg) ? Math.max(0, parseInt(arg, 10) - 1) : 0;
    await C.showSessions(chatId, page, undefined, threadId);
    return true;
  }
  return false;
}

async function cmd_use(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/use" || text.startsWith("/use ")) {
    const sessionId = text.slice(4).trim();
    if (!sessionId) {
      await C.showSessions(chatId, 0, undefined, threadId);
      return true;
    }
    try {
      await C.activateSession(chatId, sessionId, true, threadId);
      await send(`✅ Switched to session\n<code>${esc(sessionId)}</code>`);
    } catch (err) {
      await send(`failed to switch: ${esc(err instanceof Error ? err.message : String(err))}`);
    }
    return true;
  }
  return false;
}

export async function handleCommand(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean> {
  const name = text.startsWith("/") ? (text.slice(1).split(/\s/, 1)[0] ?? "") : "";
  // normalize command name: strip trailing? keep as-is
  const handler = COMMANDS.get(name);
  if (!handler) return false;
  const result = await (handler as any)(deps, chatId, threadId, text, send);
  return result !== false;
}

// Register handlers
COMMANDS.set("start", cmd_start as any);
COMMANDS.set("help", cmd_start as any);
COMMANDS.set("status", cmd_status as any);
COMMANDS.set("session", cmd_status as any);
COMMANDS.set("new", cmd_new as any);
COMMANDS.set("stop", cmd_stop as any);
COMMANDS.set("abort", cmd_stop as any);
COMMANDS.set("commands", cmd_commands as any);
COMMANDS.set("settings", cmd_settings as any);
COMMANDS.set("file", cmd_file as any);
COMMANDS.set("ls", cmd_ls as any);
COMMANDS.set("find", cmd_find as any);
COMMANDS.set("zip", cmd_zip as any);
COMMANDS.set("read", cmd_read as any);
COMMANDS.set("tree", cmd_tree as any);
COMMANDS.set("model", cmd_models as any);
COMMANDS.set("models", cmd_models as any);
COMMANDS.set("agent", cmd_agents as any);
COMMANDS.set("agents", cmd_agents as any);
COMMANDS.set("skill", cmd_skills as any);
COMMANDS.set("skills", cmd_skills as any);
COMMANDS.set("usage", cmd_usage as any);
COMMANDS.set("vcs", cmd_vcs as any);
COMMANDS.set("mcp", cmd_mcp as any);
COMMANDS.set("branches", cmd_branches as any);
COMMANDS.set("branch", cmd_branches as any);
COMMANDS.set("stage", cmd_stage as any);
COMMANDS.set("unstage", cmd_unstage as any);
COMMANDS.set("commit", cmd_commit as any);
COMMANDS.set("worktrees", cmd_worktree as any);
COMMANDS.set("worktree", cmd_worktree as any);
COMMANDS.set("forms", cmd_forms as any);
COMMANDS.set("formreply", cmd_formreply as any);
COMMANDS.set("fork", cmd_fork as any);
COMMANDS.set("rename", cmd_rename as any);
COMMANDS.set("archive", cmd_archive as any);
COMMANDS.set("unarchive", cmd_unarchive as any);
COMMANDS.set("delete", cmd_delete as any);
COMMANDS.set("deletesessions", cmd_delete as any);
COMMANDS.set("diff", cmd_diff as any);
COMMANDS.set("sync", cmd_sync as any);
COMMANDS.set("context", cmd_context as any);
COMMANDS.set("compact", cmd_compact as any);
COMMANDS.set("retry", cmd_retry as any);
COMMANDS.set("running", cmd_running_sessions as any);
COMMANDS.set("sessions", cmd_running_sessions as any);
COMMANDS.set("use", cmd_use as any);

function stripHiddenFlag(raw: string): { rest: string; hidden: boolean } {
  let hidden = false;
  const kept: string[] = [];
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    if (part === "-a" || part === "--all") hidden = true;
    else kept.push(part);
  }
  return { rest: kept.join(" "), hidden };
}

function parseListArgs(raw: string): { path: string; hidden: boolean } {
  const { rest, hidden } = stripHiddenFlag(raw);
  return { path: rest, hidden };
}

function parseFindArgs(raw: string): { query: string; hidden: boolean } {
  const { rest, hidden } = stripHiddenFlag(raw);
  return { query: rest, hidden };
}

function parseReadArgs(raw: string): { path: string; startLine: number } {
  // `/read <path> [start_line]`; only the last numeric token is a line number.
  const match = raw.match(/^(.*?)\s+(\d+)$/s);
  if (match && match[1].trim()) {
    const line = parseInt(match[2], 10);
    if (Number.isFinite(line) && line > 0) return { path: match[1].trim(), startLine: line };
  }
  return { path: raw.trim(), startLine: 1 };
}
