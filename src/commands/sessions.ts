import { t } from "../i18n.js";
import type { BotDeps, SendFn } from "../context.js";
import { colorDiff, esc } from "../util.js";
import { paginateTranscript } from "../transcript.js";
import { buildDigestParts } from "../syncview.js";
import { cancelAutoRetry } from "../autoretry.js";
import { ctx, isRouteAdmin } from "./shared.js";

export async function cmd_status(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/status" || text === "/session") {
    // Send the error directly with a hard timeout; never await a placeholder
    // that can hang on a flaky Telegram API before the timeout is armed.
    // Let the Telegram fetch (30 s) finish before declaring failure: a premature
    // 8 s timeout showed an error while the real message was still in flight.
    try {
      await C.showStatus(chatId, threadId, undefined);
    } catch (err) {
      const msg = `⚠️ No se pudo mostrar el estado: ${esc(err instanceof Error ? err.message : String(err))}`;
      await send(msg).catch(() => undefined);
    }
    return true;
  }
  return false;
}

export async function cmd_new(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/new") {
    const active = await C.restoreActiveSession(chatId, threadId);
    if (active) {
      await send(`⚠️ Ya hay una sesión activa: <code>${esc(active.sessionId)}</code>.\\n¿Crear una nueva y reemplazarla?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: t("confirmYes"), callback_data: "new:confirm" }, { text: t("cancel"), callback_data: "new:cancel" }],
          ],
        },
      });
      return true;
    }
    const repos = (deps.sessions.listRepoDirectories?.() ?? []);
    if (repos.length) {
      const keyboard = repos.map((name) => [{ text: name, callback_data: `repo:${name}` }]);
      await send(t("chooseRepo"), { reply_markup: { inline_keyboard: keyboard } });
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

export async function cmd_bg(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  if (text === "/bg" || text === "/background") {
    const C = ctx(deps);
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) { await send("No hay sesión activa"); return true; }
    try {
      await C.oc.background(s.sessionId);
      await send(t("changesBackground"));
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_stop(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/stop" || text === "/abort") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send("No hay sesión activa");
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
      // Close the turn like the ⏹ Detener button does: finishStatus renders
      // "⏹ Detenido" and removes the Stop button. updateStatus would republish
      // a still-working card with the Stop button intact.
      await C.finishStatus(chatId, s).catch(() => {});
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_fork(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/fork") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
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

export async function cmd_rename(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text.startsWith("/rename ")) {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
      return true;
    }
    const title = text.slice(8).trim();
    if (!title) {
      await send("Uso: /rename <title>");
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

export async function cmd_archive(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/archive") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
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

export async function cmd_unarchive(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/unarchive") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
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

export async function cmd_delete(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/delete" || text.startsWith("/delete ") || text === "/deletesessions" || text.startsWith("/deletesessions ")) {
    // Deleting sessions affects everyone in the route: admins only.
    if (!isRouteAdmin(deps, chatId, threadId, userId)) {
      await send(t("onlyAdminDelete"));
      return true;
    }
  }
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
      await send(t("noSession"));
      return true;
    }
    await send(`Delete session <code>${esc(s.sessionId)}</code>?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🗑 Borrar", callback_data: `delconfirm:${s.sessionId}` },
            { text: "Cancelar", callback_data: "panel:home" },
          ],
        ],
      },
    });
    return true;
  }
  if (text === "/delete confirm") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
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

export async function cmd_compact(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/compact") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
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

export async function cmd_context(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/context") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
      return true;
    }
    try {
      const session = await C.oc.client.session.get({ sessionID: s.sessionId });
      const modelInfo = await (async () => {
        try {
          const res = await C.oc.client.model.list();
          const list = (((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[]) as Array<Record<string, unknown>>;
          return list.find((m: Record<string, unknown>) => m.id === session.model?.id && m.providerID === session.model?.providerID);
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
      const ctxData = await Promise.race([
        C.oc.context(s.sessionId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OpenCode no responde (timeout)")), 8000)),
      ]);
      const items = (Array.isArray(ctxData) ? ctxData : ((ctxData as { data?: unknown })?.data ?? [])) as Array<Record<string, unknown>>;
      const meaningful = items.filter((m: Record<string, unknown>) => {
        const role = m.role ?? m.type;
        if (role === "idle") return false;
        if (role === "assistant") {
          const parts = Array.isArray(m.content) ? m.content : [];
          const hasText = parts.some((p: Record<string, unknown>) => p.type === "text" && p.text);
          const hasTool = parts.some((p: Record<string, unknown>) => p.type === "tool");
          return hasText || hasTool;
        }
        return role === "user" || role === "compaction";
      });
      const sliced = meaningful.slice(-6);
      const summaries = sliced
        .map((m: Record<string, unknown>) => {
          const role = m.role ?? m.type ?? "msg";
          let body = "";
          if (role === "user") {
            const t = m.text;
            body = typeof t === "string" ? t : t ? JSON.stringify(t) : "";
          } else if (role === "assistant") {
            const parts = Array.isArray(m.content) ? m.content : [];
            const texts = parts
              .filter((p: Record<string, unknown>) => p.type === "text")
              .map((p: Record<string, unknown>) => {
                const t = p.text;
                return typeof t === "string" ? t : t ? JSON.stringify(t) : "";
              });
            const tools = parts.filter((p: Record<string, unknown>) => p.type === "tool").map((p: Record<string, unknown>) => p.name ?? p.tool ?? "tool");
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
      const lastUser = [...items].reverse().find((m: Record<string, unknown>) => (m.role ?? m.type) === "user");
      const lastAssistant = [...items].reverse().find((m: Record<string, unknown>) => (m.role ?? m.type) === "assistant");
      const lastUserText = lastUser ? (typeof lastUser.text === "string" ? lastUser.text : JSON.stringify(lastUser.text ?? "")).slice(0, 200) : "";
      const lastAssistantText = lastAssistant
        ? (Array.isArray(lastAssistant.content)
            ? lastAssistant.content
                .filter((p: Record<string, unknown>) => p.type === "text")
                .map((p: Record<string, unknown>) => (typeof p.text === "string" ? p.text : JSON.stringify(p.text ?? "")))
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

export async function cmd_usage(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
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

export async function cmd_sync(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/sync") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
      return true;
    }
    try {
      const ctxData = await Promise.race([
        C.oc.context(s.sessionId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OpenCode no responde (timeout)")), 8000)),
      ]);
      const items = (Array.isArray(ctxData) ? ctxData : ((ctxData as { data?: unknown })?.data ?? [])) as Array<Record<string, unknown>>;
      const parts = buildDigestParts(s, items, { title: t("sessionContent"), sessionId: s.sessionId });
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const markup = i === parts.length - 1 ? { inline_keyboard: part.keyboard } : undefined;
        const sent = await send(part.html, markup ? { reply_markup: markup } : {}) as { message_id?: number } | undefined;
        // Link EVERY part to the session so replying to any digest message
        // routes back to the correct session.
        if (sent?.message_id) C.store.rememberMessageSession(chatId, sent.message_id, s.sessionId);
      }
    } catch (err) {
      await send("❌ " + esc(String(err)));
    }
    return true;
  }
  return false;
}

export async function cmd_running_sessions(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  const safeShow = async (page: number, filter?: number, busy?: boolean): Promise<void> => {
    // No t("more") placeholder: a hung OpenCode call left it stuck forever.
    // Let showSessions send the list directly; on timeout/error send a fresh
    // message so there is always a visible answer.
    try {
      await C.showSessions(chatId, page, undefined, threadId, filter, busy);
    } catch (err) {
      const msg = `⚠️ No se pudieron listar las sesiones: ${esc(err instanceof Error ? err.message : String(err))}`;
      await send(msg).catch(() => undefined);
    }
  };
  if (text === "/running" || text === "/sessions running" || text === "/sessions busy") {
    await safeShow(0, undefined, true);
    return true;
  }
  if (text === "/sessions" || text.startsWith("/sessions ")) {
    const arg = text.slice("/sessions".length).trim();
    if (arg === "group" || arg === "g" || arg === "here") {
      await safeShow(0, chatId);
      return true;
    }
    const page = /^\d+$/.test(arg) ? Math.max(0, parseInt(arg, 10) - 1) : 0;
    await safeShow(page);
    return true;
  }
  return false;
}

export async function cmd_use(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/use" || text.startsWith("/use ")) {
    const sessionId = text.slice(4).trim();
    if (!sessionId) {
      const placeholder = await send(t("loadingSessions")).catch(() => undefined) as { message_id?: number } | undefined;
      await C.showSessions(chatId, 0, placeholder?.message_id, threadId);
      return true;
    }
    try {
      const cs = await C.activateSession(chatId, sessionId, true, threadId);
      if (cs) { cs.topicTitle = undefined; await deps.sessions.syncTopicTitle(chatId, cs).catch(() => {}); }
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

export async function cmd_diff(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/diff") {
    const s = await C.restoreActiveSession(chatId, threadId);
    if (!s) {
      await send(t("noSession"));
      return true;
    }
    try {
      const diffs = await C.oc.diff(s.sessionId);
      if (!diffs.length) {
        await send("No changes.");
        return true;
      }
      const rows = diffs
        .map((d: { file?: string; additions?: number; deletions?: number; status?: string }) => `<tr><td><code>${esc(d.file ?? "")}</code></td><td>+${d.additions ?? 0}/-${d.deletions ?? 0}</td><td>${esc(d.status ?? "")}</td></tr>`)
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

export async function cmd_search(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  const m = text.match(/^\/search(?:\s+(.+))?$/);
  if (!m) return false;
  const term = (m[1] ?? "").trim();
  if (!term) {
    await send("Uso: <code>/search &lt;término&gt;</code>");
    return true;
  }
  const s = await C.restoreActiveSession(chatId, threadId);
  const transcript = deps.transcript;
  if (!s || !transcript) {
    await send(t("noSession"));
    return true;
  }
  const blocks = transcript.blocksOf(s);
  const lower = term.toLowerCase();
  // P2: search the whole conversation — assistant/tool blocks AND the user
  // prompts that started each turn (which are not stored as blocks).
  const pages = paginateTranscript(blocks);
  const pageOf = new Map<number, number>();
  pages.forEach((p, i) => p.blocks.forEach((b, j) => pageOf.set(blocks.indexOf(b, j ? undefined : 0), i)));
  const hits: Array<{ page: number; snippet: string; turn?: number }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.text.toLowerCase().includes(lower)) continue;
    const pg = (pageOf.get(i) ?? Math.min(pages.length - 1, Math.floor(i / 8))) + 1;
    const idx = b.text.toLowerCase().indexOf(lower);
    const start = Math.max(0, idx - 40);
    const end = Math.min(b.text.length, idx + term.length + 40);
    const snippet = esc(b.text.slice(start, end).replace(/\s+/g, " "));
    const highlighted = snippet.replace(new RegExp(esc(term), "gi"), (x) => `<mark>${x}</mark>`);
    hits.push({ page: pg, snippet: highlighted, turn: b.turn });
  }
  const turns = [...new Set(blocks.map((b) => b.turn).filter((t): t is number => typeof t === "number"))];
  for (const turn of turns) {
    const prompt = deps.store.getTurnPrompt(s.sessionId, turn);
    if (prompt?.toLowerCase().includes(lower)) {
      const page = pages.findIndex((p) => p.blocks.some((b) => b.turn === turn));
      const idx = prompt.toLowerCase().indexOf(lower);
      const snippet = esc(prompt.slice(Math.max(0, idx - 40), idx + term.length + 40).replace(/\s+/g, " "));
      hits.unshift({ page: page + 1 || 1, snippet: `👤 ${snippet.replace(new RegExp(esc(term), "gi"), (x) => `<mark>${x}</mark>`)}`, turn });
    }
  }
  if (!hits.length) {
    await send(`🔍 Sin resultados para <code>${esc(term)}</code>.`);
    return true;
  }
  const lines = [`🔍 <b>${hits.length} resultado(s)</b> para <code>${esc(term)}</code>:`];
  const seen = new Set<number>();
  const buttons: Array<{ text: string; callback_data: string }> = [];
  for (const h of hits.slice(0, 20)) {
    if (seen.has(h.page)) continue;
    seen.add(h.page);
    const where = h.turn ? `Turno ${h.turn}` : `Pág. ${h.page}`;
    lines.push(`📄 ${where}: …${h.snippet}…`);
    if (buttons.length < 12) buttons.push({ text: `${where}`, callback_data: `tpagep:${s.sessionId}:${h.page - 1}` });
  }
  if (hits.length > 20) lines.push(`<i>… y ${hits.length - 20} más.</i>`);
  await send(lines.join("\n") + "\n<i>Toca un turno para ir directamente.</i>", buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : undefined);
  return true;
}
