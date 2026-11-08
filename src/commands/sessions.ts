import { resolve } from "node:path";
import type { BotDeps, SendFn } from "../context.js";
import { createZipArchive, fileErrorMessage, formatBytes, prepareDocument, treeDirectory } from "../files/index.js";
import * as mcp from "../mcp.js";
import { isSettingsKey, renderSettings, settingsKeyboard } from "../settings.js";
import * as vcs from "../vcs.js";
import { clampText, colorDiff, esc, threadOpts, truncate } from "../util.js";
import { cancelAutoRetry, notePromptSent } from "../autoretry.js";
import { ctx } from "./shared.js";

export async function cmd_status(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/status" || text === "/session") {
    await C.showStatus(chatId, threadId);
    return true;
  }
  return false;
}

export async function cmd_new(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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
    const repos = (deps.sessions.listRepoDirectories?.() ?? []);
    if (repos.length) {
      const keyboard = repos.map((name) => [{ text: name, callback_data: `repo:${name}` }]);
      await send("Elige el repositorio para la nueva sesión:", { reply_markup: { inline_keyboard: keyboard } });
      return true;
    }
    await deps.sessions.createNewSession(chatId, false, threadId);
    return true;
  }
  if (text.startsWith("/new ")) {
    const arg = text.slice(5).trim();
    if (arg) {
      await deps.sessions.createNewSession(chatId, false, threadId, arg);
      return true;
    }
  }
  return false;
}

export async function cmd_stop(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_fork(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_rename(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_archive(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_unarchive(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_delete(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_compact(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_context(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_usage(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_sync(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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
      const userCount = meaningful.filter((m: any) => (m.role ?? m.type) === "user").length;
      const assistantCount = meaningful.filter((m: any) => (m.role ?? m.type) === "assistant").length;
      const toolOnlyLines: string[] = [];
      await send(`<b>Syncing ${meaningful.length} messages</b> (${userCount} 👤 / ${assistantCount} 🤖) from <code>${esc(s.sessionId.slice(0, 12))}</code>…`);
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
            const tools = parts.filter((p: any) => p.type === "tool");
            if (tools.length) {
              for (const t of tools) {
                const name = t.name ?? t.tool ?? "tool";
                const input = typeof t.input === "string" ? t.input : (t.input ? JSON.stringify(t.input) : "");
                toolOnlyLines.push(input ? `$ ${name}  ${input.slice(0, 80)}` : `$ ${name}`);
              }
              continue;
            }
            body = "(no text)";
          }
        } else if (role === "compaction") {
          body = (m.summary ?? "").toString().split("\n")[0].slice(0, 200);
        }
        body = body.replace(/\s+/g, " ").trim().slice(0, 1000);
        const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : "📦";
        await send(icon + " <b>" + esc(String(role)) + "</b>:\n" + esc(body || "(no text)"));
      }
      if (toolOnlyLines.length) {
        const shell = toolOnlyLines.join("\n");
        await send(`🔧 <b>Tool calls (${toolOnlyLines.length})</b>\n<blockquote expandable><pre><code class="language-bash">${esc(shell)}</code></pre></blockquote>`);
      }
      // Show latest thinking and tool from the live session state.
      const cot = (s.cotBuffer || "").trim();
      if (cot) {
        const lastThought = cot.split(/\n+/).filter(Boolean).pop() || "";
        if (lastThought) await send(`💭 <b>Latest thought:</b>\n<blockquote><mark>${esc(clampText(lastThought, 240))}</mark></blockquote>`);
      }
      const lastTool = s.toolCallDetails.length ? s.toolCallDetails[s.toolCallDetails.length - 1] : null;
      if (lastTool) {
        const toolInput = lastTool.input ? clampText(lastTool.input, 120) : "";
        let msg = `🔧 <b>Latest tool:</b> <code>${esc(lastTool.name)}</code>`;
        if (toolInput) msg += `\n<blockquote><code>${esc(toolInput)}</code></blockquote>`;
        await send(msg);
      }
      await send(`✅ Sync complete. Session <code>${esc(s.sessionId.slice(0, 12))}</code> is active.`);
    } catch (err) {
      await send("❌ " + esc(String(err)));
    }
    return true;
  }
  return false;
}

export async function cmd_running_sessions(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

export async function cmd_use(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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

function stripHiddenFlag(raw: string): { rest: string; hidden: boolean } {
  let hidden = false;
  const kept: string[] = [];
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    if (part === "-a" || part === "--all") hidden = true;
    else kept.push(part);
  }
  return { rest: kept.join(" "), hidden };
}

export function parseListArgs(raw: string): { path: string; hidden: boolean } {
  const { rest, hidden } = stripHiddenFlag(raw);
  return { path: rest, hidden };
}

export function parseFindArgs(raw: string): { query: string; hidden: boolean } {
  const { rest, hidden } = stripHiddenFlag(raw);
  return { query: rest, hidden };
}

export function parseReadArgs(raw: string): { path: string; startLine: number } {
  // `/read <path> [start_line]`; only the last numeric token is a line number.
  const match = raw.match(/^(.*?)\s+(\d+)$/s);
  if (match && match[1].trim()) {
    const line = parseInt(match[2], 10);
    if (Number.isFinite(line) && line > 0) return { path: match[1].trim(), startLine: line };
  }
  return { path: raw.trim(), startLine: 1 };
}

export async function cmd_diff(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean | void> {
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
          `<blockquote expandable><b>${esc(d.file ?? "")}</b> (+${d.additions ?? 0}/-${d.deletions ?? 0})\n<pre><code class="language-diff">${colorDiff(patch)}</code></pre></blockquote>`,
        );
      }
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

