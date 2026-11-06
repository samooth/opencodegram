import { resolve } from "node:path";
import type { BotDeps, SendFn } from "../context.js";
import { createZipArchive, fileErrorMessage, formatBytes, prepareDocument, treeDirectory } from "../files/index.js";
import * as mcp from "../mcp.js";
import { isSettingsKey, renderSettings, settingsKeyboard } from "../settings.js";
import * as vcs from "../vcs.js";
import { clampText, colorDiff, esc, threadOpts, truncate } from "../util.js";
import { cancelAutoRetry, notePromptSent } from "../autoretry.js";
import { ctx } from "./shared.js";

export async function cmd_mcp(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

