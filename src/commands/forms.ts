import { resolve } from "node:path";
import type { BotDeps, SendFn } from "../context.js";
import { createZipArchive, fileErrorMessage, formatBytes, prepareDocument, treeDirectory } from "../files/index.js";
import * as mcp from "../mcp.js";
import { isSettingsKey, renderSettings, settingsKeyboard } from "../settings.js";
import * as vcs from "../vcs.js";
import { clampText, colorDiff, esc, threadOpts, truncate } from "../util.js";
import { cancelAutoRetry, notePromptSent } from "../autoretry.js";
import { ctx } from "./shared.js";

export async function cmd_forms(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_formreply(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

