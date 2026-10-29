import { resolve } from "node:path";
import type { BotDeps, SendFn } from "./context.js";
import { fileErrorMessage, formatBytes, prepareDocument } from "./files.js";
import { esc, threadOpts } from "./util.js";

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
  "file",
  "ls",
  "find",
  "read",
  "model",
  "models",
  "agent",
  "agents",
  "fork",
  "rename",
  "archive",
  "unarchive",
  "delete",
  "diff",
  "context",
  "compact",
  "vcs",
  "worktrees",
  "usage",
  "forms",
  "formreply",
  "sync",
  "use",
]);

export async function handleCommand(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean> {
  const { config, tg, oc, panels, sessions, files } = deps;
  const { restoreActiveSession, activateSession } = sessions;
  const { sendPanel, showCommands, showModels, showSessions } = panels;

  if (text === "/start" || text === "/help" || text === "/status" || text === "/session") {
    await sendPanel(chatId, threadId);
    return true;
  }

  if (text === "/new") {
    await sessions.createNewSession(chatId, false, threadId);
    return true;
  }

  if (text === "/stop" || text === "/abort") {
    const s = await restoreActiveSession(chatId, threadId);
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
      await oc.interrupt(s.sessionId);
      if (s.statusMessageId) {
        await tg
          .editRichMessage(chatId, s.statusMessageId, "⏹ <b>Stopped</b>", {
            ...deps.store.threadOptsFor(s),
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => {});
        s.statusMessageId = undefined;
      }
      await send("⏹ stopped", deps.store.threadOptsFor(s));
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/commands") {
    await showCommands(chatId, threadId);
    return true;
  }

  if (text === "/file" || text.startsWith("/file ")) {
    const rawPath = text.slice("/file".length).trim();
    if (!rawPath) {
      await send("usage: /file <path> (relative to the session directory)");
      return true;
    }
    const s = await restoreActiveSession(chatId, threadId);
    const base = resolve(s?.directory ?? config.OPENCODE_DIRECTORY ?? process.cwd());
    try {
      // prepareDocument resolves symlinks and confines the real path to base.
      const doc = await prepareDocument(base, rawPath);
      await tg.sendDocument(
        chatId,
        doc.absolute,
        doc.name,
        `<b>${esc(doc.name)}</b>\n<code>${esc(doc.relative || doc.name)}</code>\n${formatBytes(doc.size)}`,
        { ...threadOpts(threadId), parse_mode: "HTML" },
      );
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }

  if (text === "/ls" || text.startsWith("/ls ")) {
    const { path, hidden } = parseListArgs(text.slice(3).trim());
    try {
      await files.showListing(chatId, threadId, path, { hidden });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }

  if (text === "/find" || text.startsWith("/find ")) {
    const { query, hidden } = parseFindArgs(text.slice(5).trim());
    if (!query) {
      await send("usage: /find <text> [-a]");
      return true;
    }
    try {
      await files.showFind(chatId, threadId, query, { hidden });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }

  if (text === "/read" || text.startsWith("/read ")) {
    const raw = text.slice(5).trim();
    if (!raw) {
      await send("usage: /read <path> [start_line]");
      return true;
    }
    const { path, startLine } = parseReadArgs(raw);
    try {
      await files.showFile(chatId, threadId, path, { startLine });
    } catch (err) {
      await send(`❌ ${esc(fileErrorMessage(err))}`);
    }
    return true;
  }

  if (text === "/models" || text === "/model") {
    await showModels(chatId, 0, undefined, threadId);
    return true;
  }

  if (text === "/agents" || text === "/agent") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    const directory = s.directory ?? config.OPENCODE_DIRECTORY;
    const agents = await oc.listAgents(directory);
    if (!agents.length) {
      await send("no agents available.");
      return true;
    }
    const lines = agents.map((a: any) => `• <b>${esc(a.name ?? a.id)}</b>${a.description ? " — " + esc(a.description) : ""}`);
    const keyboard = agents.map((a: any) => [{ text: a.name ?? a.id, callback_data: `agent:${a.id}` }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    await send(`<b>Agents</b>\n\n${lines.join("\n")}`, { reply_markup: { inline_keyboard: keyboard } });
    return true;
  }

  if (text === "/usage") {
    try {
      const stats = await oc.client.session.stats();
      const data = (stats as any)?.data ?? stats;
      const msg = [
        `<b>Usage</b>`,
        `Sessions: ${data.sessions ?? 0} · Prompts: ${data.prompts ?? 0} · Steps: ${data.steps ?? 0}`,
        `Tokens: in ${(data.tokens?.input ?? 0).toLocaleString()} · out ${(data.tokens?.output ?? 0).toLocaleString()} · reasoning ${(data.tokens?.reasoning ?? 0).toLocaleString()}`,
        `Cost: ${(data.cost ?? 0).toFixed(4)}`,
        `Tools: ${data.tools?.totals?.calls ?? 0} calls (${data.tools?.totals?.succeeded ?? 0} ok, ${data.tools?.totals?.failed ?? 0} failed)`,
      ].join("\n");
      await send(msg);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/vcs") {
    const s = await restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    try {
      const info = await oc.vcsGet(directory);
      const status = await oc.vcsStatus(directory);
      const data = (info as any)?.data ?? info;
      const st = (status as any)?.data ?? status;
      const branch = data?.branch?.current ?? "?";
      const files = Array.isArray(st) ? st.length : (st?.files?.length ?? 0);
      await send(`<b>VCS</b>\nBranch: <code>${esc(branch)}</code>\nChanged files: ${files}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/worktrees") {
    const s = await restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    try {
      const res = await oc.worktreeList(directory);
      const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
      if (!list.length) {
        await send("no worktrees.");
        return true;
      }
      const lines = list.map((w: any) => `• <code>${esc(w.path ?? w.directory ?? "")}</code>`);
      await send(`<b>Worktrees</b>\n${lines.join("\n")}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/forms") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const forms = await oc.listForms(s.sessionId);
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

  if (text.startsWith("/formreply ")) {
    const s = await restoreActiveSession(chatId, threadId);
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
      await oc.replyForm(s.sessionId, formId, answer as Record<string, string | number | boolean | string[]>);
      await send(`Form ${esc(formId)} answered.`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/fork") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const forked = await oc.forkSession(s.sessionId);
      const newId = (forked as any)?.id ?? (forked as any)?.sessionID ?? (forked as any)?.data?.id;
      await activateSession(chatId, newId, true, threadId);
      await send(`Forked session.\n<code>${esc(s.sessionId)}</code> → <code>${esc(newId)}</code>`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text.startsWith("/rename ")) {
    const s = await restoreActiveSession(chatId, threadId);
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
      await oc.renameSession(s.sessionId, title);
      if (s.threadId) {
        await tg.editForumTopic(chatId, s.threadId, title.slice(0, 120)).catch(() => {});
        s.topicTitle = title.slice(0, 120);
      }
      await send(`Renamed session to <b>${esc(title)}</b>.`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/archive") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await oc.archiveSession(s.sessionId, true);
      await send("Session archived.");
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/unarchive") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await oc.archiveSession(s.sessionId, false);
      await send("Session unarchived.");
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/delete") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    await send(`Delete session <code>${esc(s.sessionId)}</code>? Reply /delete confirm to proceed.`);
    return true;
  }

  if (text === "/delete confirm") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await oc.deleteSession(s.sessionId);
      deps.store.forgetSession(s.sessionId);
      await send("Session deleted.");
      await sendPanel(chatId, threadId);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/diff") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const diffs = await oc.diff(s.sessionId);
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
          `<details><summary><b>${esc(d.file ?? "")}</b> (+${d.additions ?? 0}/-${d.deletions ?? 0})</summary>\n<pre><code class="language-diff">${esc(patch)}</code></pre>\n</details>`,
        );
      }
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/sync") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const ctx = await oc.context(s.sessionId);
      const items = Array.isArray(ctx) ? ctx : ((ctx as any)?.data ?? []);
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
        await send(icon + " <b>" + esc(role) + "</b>:\n" + esc(body || "(no text)"));
      }
      await send("✅ Sync complete.");
    } catch (err) {
      await send("❌ " + esc(String(err)));
    }
    return true;
  }

  if (text === "/context") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      const session = await oc.client.session.get({ sessionID: s.sessionId });
      const modelInfo = await (async () => {
        try {
          const res = await oc.client.model.list();
          const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
          return list.find((m: any) => m.id === session.model?.id && m.providerID === session.model?.providerID);
        } catch {
          return null;
        }
      })();
      const ctxLimit = modelInfo?.limit?.context ?? 0;
      const tokens = session.tokens ?? {};
      const inTok = tokens.input ?? 0;
      const outTok = tokens.output ?? 0;
      const reasonTok = tokens.reasoning ?? 0;
      const cacheRead = tokens.cache?.read ?? 0;
      const ctx = await oc.context(s.sessionId);
      const items = Array.isArray(ctx) ? ctx : ((ctx as any)?.data ?? []);
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
          return icon + " <b>" + esc(role) + "</b>: " + esc(body || "(no text)");
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

  if (text === "/compact") {
    const s = await restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("no active session.");
      return true;
    }
    try {
      await oc.compactSession(s.sessionId);
      await send("Session compacted.");
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }

  if (text === "/sessions" || text.startsWith("/sessions ")) {
    const arg = text.slice("/sessions".length).trim();
    const page = /^\d+$/.test(arg) ? Math.max(0, parseInt(arg, 10) - 1) : 0;
    await showSessions(chatId, page, undefined, threadId);
    return true;
  }

  if (text === "/use" || text.startsWith("/use ")) {
    const sessionId = text.slice(4).trim();
    if (!sessionId) {
      await showSessions(chatId, 0, undefined, threadId);
      return true;
    }
    try {
      await activateSession(chatId, sessionId, true, threadId);
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
