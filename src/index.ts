import { loadConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";
import { OpenCodeBridge, resolveServerPassword } from "./opencode.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type ChatSession = {
  sessionId: string;
  directory?: string;
  draftId: number;
  buffer: string;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  threadId?: number;
};

async function main() {
  const config = loadConfig();
  const tg = new TelegramClient(config.TELEGRAM_BOT_TOKEN);
  const oc = new OpenCodeBridge(config.OPENCODE_BASE_URL, resolveServerPassword());

  const me = await tg.getMe();
  const topicsEnabled = me.has_topics_enabled === true;
  console.log(`[opencodegram] bot: @${me.username ?? me.first_name} (id ${me.id}) topics=${topicsEnabled}`);
  const info = await oc.serverInfo();
  console.log(`[opencodegram] opencode: ${JSON.stringify(info)}`);

  const sessionsByChat = new Map<number, ChatSession>();
  const chatBySession = new Map<string, number>();
  const sessionListByChat = new Map<number, string[]>();
  const commandListByChat = new Map<number, string[]>();
  const modelListByChat = new Map<number, Array<{ id: string; providerID: string; variant?: string }>>();
  const threadBySession = new Map<string, number>();

  async function createNewSession(chatId: number): Promise<void> {
    const old = sessionsByChat.get(chatId);
    if (old) chatBySession.delete(old.sessionId);
    sessionsByChat.delete(chatId);
    const directory = config.OPENCODE_DIRECTORY ?? (await oc.latestSessionDirectory()) ?? process.cwd();
    let model: { id: string; providerID: string; variant?: string } | undefined;
    try {
      const sessions = await oc.client.session.list();
      const list = (sessions as any)?.data ?? (Array.isArray(sessions) ? sessions : []);
      const latest = [...list].sort((a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))[0];
      if (latest?.model?.id && latest?.model?.providerID) model = { id: latest.model.id, providerID: latest.model.providerID, variant: latest.model.variant };
    } catch {
      // ignore
    }
    if (!model) model = await oc.defaultModel(directory);
    const session = await oc.createSession({ title: "Telegram session", directory, model, agent: "build" });
    const sessionId = (session as any)?.id ?? (session as any)?.sessionID ?? (session as any)?.data?.id;
    const cs: ChatSession = { sessionId, directory, draftId: 0, buffer: "", stopped: false };
    if (topicsEnabled) {
      try {
        const topic = await tg.createForumTopic(chatId, (model ? `${model.id}` : "session").slice(0, 120));
        cs.threadId = topic.message_thread_id;
        threadBySession.set(sessionId, cs.threadId!);
      } catch (err) {
        console.error("[topic]", err);
      }
    }
    sessionsByChat.set(chatId, cs);
    chatBySession.set(sessionId, chatId);
    await tg.sendRichMessage(chatId, `<b>New session created</b>\n<code>${esc(sessionId)}</code>\nmodel: ${esc(model?.providerID ?? "")}/${esc(model?.id ?? "")}${model?.variant ? " (" + esc(model.variant) + ")" : ""}\ndir: <code>${esc(directory)}</code>`, cs.threadId ? { message_thread_id: cs.threadId } : {});
  }

  async function activateSession(chatId: number, sessionId: string): Promise<void> {
    const session = await oc.client.session.get({ sessionID: sessionId });
    const s = session as any;
    const directory = s?.location?.directory ?? s?.directory;
    const model = s?.model ? { id: s.model.id, providerID: s.model.providerID, variant: s.model.variant } : undefined;
    const old = sessionsByChat.get(chatId);
    if (old) chatBySession.delete(old.sessionId);
    const cs: ChatSession = { sessionId, directory, draftId: 0, buffer: "", stopped: false };
    if (topicsEnabled) {
      if (threadBySession.has(sessionId)) {
        cs.threadId = threadBySession.get(sessionId);
      } else {
        try {
          const topic = await tg.createForumTopic(chatId, (s.title ?? sessionId).slice(0, 120));
          cs.threadId = topic.message_thread_id;
          threadBySession.set(sessionId, cs.threadId!);
        } catch (err) {
          console.error("[topic]", err);
        }
      }
    }
    sessionsByChat.set(chatId, cs);
    chatBySession.set(sessionId, chatId);
    await tg.sendRichMessage(chatId, `<b>Active session</b>\n<code>${esc(sessionId)}</code>\nmodel: ${esc(model ? model.providerID + "/" + model.id : "default")}\ndir: <code>${esc(directory ?? "n/a")}</code>`, cs.threadId ? { message_thread_id: cs.threadId } : {});
  }

  async function showSessions(chatId: number, page = 0): Promise<void> {
    const pageSize = 8;
    const res = await oc.client.session.list({ limit: 100, order: "desc" });
    const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
    if (!list.length) {
      await tg.sendRichMessage(chatId, "no sessions found.");
      return;
    }
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    sessionListByChat.set(chatId, slice.map((s: any) => s.id));
    const lines = slice.map((s: any, i: number) => {
      const title = esc(s.title ?? "(untitled)");
      const model = s.model ? esc(`${s.model.providerID}/${s.model.id}`) : "";
      return `${start + i + 1}. <b>${title}</b>\n   <code>${esc(s.id)}</code>${model ? " · " + model : ""}`;
    });
    const keyboard: any[][] = slice.map((_: any, i: number) => [{ text: `Open ${i + 1}`, callback_data: `use:${i}` }]);
    const nav: any[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", callback_data: `sessions:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Next ▶", callback_data: `sessions:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "➕ New session", callback_data: "panel:new" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    await tg.sendRichMessage(chatId, `<h4>Sessions</h4>\n<i>${start + 1}-${Math.min(start + pageSize, total)} of ${total}</i>\n\n${lines.join("\n\n")}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function showCommands(chatId: number): Promise<void> {
    const s = sessionsByChat.get(chatId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    const cmds = await oc.listCommands(directory);
    if (!cmds.length) {
      await tg.sendRichMessage(chatId, "no commands available.");
      return;
    }
    commandListByChat.set(chatId, cmds.map((c: any) => c.name));
    const lines = cmds.map((c: any) => `• <b>/${esc(c.name)}</b>${c.description ? " — " + esc(c.description) : ""}`);
    const keyboard = cmds.map((c: any) => [{ text: `/${c.name}`, callback_data: `cmd:${c.name}` }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    await tg.sendRichMessage(chatId, `<b>OpenCode commands</b>\n\n${lines.join("\n")}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function showModels(chatId: number, page = 0): Promise<void> {
    const s = sessionsByChat.get(chatId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    const res = await oc.client.model.list(directory ? { location: { directory } } as any : undefined);
    const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
    if (!list.length) {
      await tg.sendRichMessage(chatId, "no models available.");
      return;
    }
    // Flatten: each model entry already has providerID.
    const pageSize = 8;
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    modelListByChat.set(chatId, slice.map((m: any) => ({ id: m.id, providerID: m.providerID, variant: m.variants?.[0]?.id })));
    const lines = slice.map((m: any, i: number) => {
      const name = esc(m.name ?? m.id);
      const variant = m.variants?.length ? ` · ${esc(m.variants.map((v: any) => v.id).join(", "))}` : "";
      return `${start + i + 1}. <b>${name}</b>\n   <code>${esc(m.providerID)}/${esc(m.id)}</code>${variant}`;
    });
    const keyboard: any[][] = slice.map((_: any, i: number) => [{ text: `Use ${i + 1}`, callback_data: `model:${i}` }]);
    const nav: any[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", callback_data: `models:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Next ▶", callback_data: `models:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    await tg.sendRichMessage(chatId, `<h4>Models</h4>\n<i>${start + 1}-${Math.min(start + pageSize, total)} of ${total}</i>\n\n${lines.join("\n\n")}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function sendPanel(chatId: number): Promise<void> {
    const s = sessionsByChat.get(chatId);
    const ocInfo = await oc.serverInfo().catch(() => null);
    const text = [
      `<h3>OpenCodegram</h3>`,
      ``,
      s ? `<b>Session</b>: <code>${esc(s.sessionId)}</code>` : `<b>Session</b>: none`,
      s?.directory ? `<b>Directory</b>: <code>${esc(s.directory)}</code>` : "",
      ocInfo ? `<b>OpenCode</b>: v${esc((ocInfo as any).version ?? "")} · pid ${(ocInfo as any).pid ?? ""}` : "",
    ].filter(Boolean).join("\n");
    const keyboard = [
      [{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🧠 Models", callback_data: "panel:models" }],
      [{ text: "➕ New", callback_data: "panel:new" }, { text: "⚡ Commands", callback_data: "panel:commands" }],
      [{ text: "📊 Status", callback_data: "panel:status" }, { text: "⏹ Stop", callback_data: "panel:stop" }],
      [{ text: "❓ Help", callback_data: "panel:help" }],
    ];
    await tg.sendRichMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
  const pendingPermissions = new Map<string, { chatId: number; sessionId: string }>(); // requestId -> info

  const flushDraft = async (chatId: number) => {
    const s = sessionsByChat.get(chatId);
    if (!s) return;
    s.timer = undefined;
    try {
      await tg.sendRichMessageDraft(chatId, s.draftId, esc(s.buffer || "…"), { can_stop: true, ...(s.threadId ? { message_thread_id: s.threadId } : {}) });
    } catch (err) {
      console.error("[draft]", err);
    }
  };

  // Event stream
  (async () => {
    try {
      for await (const event of oc.events()) {
        const e = event as { type: string; data?: any };
        // Log a compact line for debugging.
        if (e.type.startsWith("session.text") || e.type === "permission.asked" || e.type === "session.idle" || e.type.endsWith("failed") || e.type === "session.step.started" || e.type === "session.step.ended") {
          console.log("[event]", e.type, JSON.stringify(e.data ?? {}).slice(0, 300));
        }

        if (e.type === "session.text.started") {
          const sessionId = e.data?.sessionID ?? e.data?.session?.id;
          const chatId = sessionId ? chatBySession.get(sessionId) : undefined;
          if (chatId === undefined) continue;
          const s = sessionsByChat.get(chatId);
          if (!s) continue;
          s.buffer = "";
          s.draftId = Date.now();
          s.stopped = false;
        }

        if (e.type === "session.text.delta") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? chatBySession.get(sessionId) : undefined;
          if (chatId === undefined) continue;
          const s = sessionsByChat.get(chatId);
          if (!s) continue;
          const delta = e.data?.delta ?? e.data?.text ?? "";
          s.buffer += delta;
          if (!s.timer) {
            s.timer = setTimeout(() => void flushDraft(chatId), 250);
          }
        }

        if (e.type === "session.text.ended") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? chatBySession.get(sessionId) : undefined;
          if (chatId === undefined) continue;
          const s = sessionsByChat.get(chatId);
          if (!s) continue;
          if (s.timer) {
            clearTimeout(s.timer);
            s.timer = undefined;
          }
          if (!s.stopped) {
            await flushDraft(chatId);
            await tg.sendRichMessage(chatId, `<pre>${esc(s.buffer || "(empty response)")}</pre>`, s.threadId ? { message_thread_id: s.threadId } : {});
          }
          s.buffer = "";
        }

        if (e.type === "permission.asked") {
          const p = e.data ?? {};
          const requestId = p.id;
          const sessionId = p.sessionID;
          const chatId = sessionId ? chatBySession.get(sessionId) : undefined;
          if (chatId === undefined || !requestId || !sessionId) continue;
          pendingPermissions.set(requestId, { chatId, sessionId });
          const label = p.tool ?? p.action ?? "permission";
          const resource = Array.isArray(p.resources) ? p.resources.join(", ") : (p.message ?? "");
          const threadId = threadBySession.get(sessionId);
          await tg.sendRichMessage(chatId, `<b>Permission requested</b>\n<i>${esc(label)}</i>\n<code>${esc(resource)}</code>`, {
            ...(threadId ? { message_thread_id: threadId } : {}),
            reply_markup: {
              inline_keyboard: [[
                { text: "Allow once", callback_data: `perm:allow:${requestId}` },
                { text: "Deny", callback_data: `perm:deny:${requestId}` },
              ]],
            },
          });
        }

        if (e.type === "session.execution.failed") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? chatBySession.get(sessionId) : undefined;
          if (chatId !== undefined) {
            const msg = e.data?.error?.message ?? "execution failed";
            const threadId = sessionId ? threadBySession.get(sessionId) : undefined;
            await tg.sendRichMessage(chatId, `❌ ${esc(msg)}`, threadId ? { message_thread_id: threadId } : {});
          }
        }

        if (e.type === "session.idle") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? chatBySession.get(sessionId) : undefined;
          if (chatId !== undefined) {
            const threadId = sessionId ? threadBySession.get(sessionId) : undefined;
            await tg.sendRichMessage(chatId, "✓ session idle", threadId ? { message_thread_id: threadId } : {});
          }
        }
      }
    } catch (err) {
      console.error("[events] stream ended", err);
    }
  })();

  // Telegram polling
  let offset = 0;
  while (true) {
    let updates: any[] = [];
    try {
      updates = await tg.getUpdates(offset, 25);
    } catch (err) {
      console.error("[poll]", err);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;

      if (u.stopped_message_generation) {
        const d = u.stopped_message_generation;
        // find session whose draft matches
        for (const [chatId, s] of sessionsByChat) {
          if (s.draftId === d.draft_id) {
            s.stopped = true;
            if (s.timer) {
              clearTimeout(s.timer);
              s.timer = undefined;
            }
            await oc.interrupt(s.sessionId);
            await tg.sendRichMessage(chatId, "⏹ stopped");
          }
        }
        continue;
      }

      if (u.callback_query) {
        const cq = u.callback_query;
        console.log("[telegram] callback from", cq.from?.id, "data=", cq.data, "chat=", cq.message?.chat?.id);
        const userId = cq.from?.id;
        if (config.ADMIN_TELEGRAM_USER_ID && userId !== config.ADMIN_TELEGRAM_USER_ID) {
          await tg.answerCallbackQuery(cq.id, "Not authorized");
          continue;
        }
        const data = cq.data ?? "";
        const m = data.match(/^perm:(allow|deny):(.+)$/);
        if (m) {
          const decision = m[1] === "allow" ? "once" : "reject";
          const requestId = m[2];
          const info = pendingPermissions.get(requestId);
          if (info) {
            await oc.replyPermission(info.sessionId, requestId, decision);
            await tg.answerCallbackQuery(cq.id, decision === "once" ? "Allowed" : "Denied");
            if (cq.message?.message_id) {
              await tg.editMessageText(info.chatId, cq.message.message_id, `Permission ${decision}: ${requestId}`);
            }
          } else {
            await tg.answerCallbackQuery(cq.id, "Unknown permission");
          }
          pendingPermissions.delete(requestId);
        }

        const chatId = cq.message?.chat?.id ?? cq.from.id;
        const cbData = cq.data ?? "";

        if (cbData === "panel:home" || cbData === "panel:status" || cbData === "panel:help") {
          await tg.answerCallbackQuery(cq.id);
          await sendPanel(chatId);
          continue;
        }
        if (cbData === "panel:sessions") {
          await tg.answerCallbackQuery(cq.id);
          await showSessions(chatId, 0);
          continue;
        }
        if (cbData === "panel:new") {
          await tg.answerCallbackQuery(cq.id, "Creating…");
          await createNewSession(chatId);
          await sendPanel(chatId);
          continue;
        }
        if (cbData === "panel:commands") {
          await tg.answerCallbackQuery(cq.id);
          await showCommands(chatId);
          continue;
        }
        if (cbData === "panel:models") {
          await tg.answerCallbackQuery(cq.id);
          await showModels(chatId, 0);
          continue;
        }
        if (cbData === "panel:stop") {
          const s = sessionsByChat.get(chatId);
          if (s) {
            await oc.interrupt(s.sessionId);
            await tg.answerCallbackQuery(cq.id, "Stopped");
            await tg.sendRichMessage(chatId, "⏹ stopped");
          } else {
            await tg.answerCallbackQuery(cq.id, "No active session");
          }
          continue;
        }
        const useMatch = cbData.match(/^use:(\d+)$/);
        if (useMatch) {
          const idx = parseInt(useMatch[1], 10);
          const ids = sessionListByChat.get(chatId) ?? [];
          const sessionId = ids[idx];
          if (sessionId) {
            await tg.answerCallbackQuery(cq.id, "Switching…");
            await activateSession(chatId, sessionId);
          } else {
            await tg.answerCallbackQuery(cq.id, "Session not found");
          }
          continue;
        }
        const pageMatch = cbData.match(/^sessions:page:(\d+)$/);
        if (pageMatch) {
          await tg.answerCallbackQuery(cq.id);
          await showSessions(chatId, parseInt(pageMatch[1], 10));
          continue;
        }
        const modelsPageMatch = cbData.match(/^models:page:(\d+)$/);
        if (modelsPageMatch) {
          await tg.answerCallbackQuery(cq.id);
          await showModels(chatId, parseInt(modelsPageMatch[1], 10));
          continue;
        }
        const modelMatch = cbData.match(/^model:(\d+)$/);
        if (modelMatch) {
          const idx = parseInt(modelMatch[1], 10);
          const models = modelListByChat.get(chatId) ?? [];
          const model = models[idx];
          const s = sessionsByChat.get(chatId);
          if (!model || !s) {
            await tg.answerCallbackQuery(cq.id, "No active session/model");
            continue;
          }
          await tg.answerCallbackQuery(cq.id, "Switching model…");
          try {
            await oc.switchModel(s.sessionId, model);
            await tg.sendRichMessage(chatId, `<b>Model switched</b>\n<code>${esc(model.providerID)}/${esc(model.id)}</code>${model.variant ? " (" + esc(model.variant) + ")" : ""}`, s.threadId ? { message_thread_id: s.threadId } : {});
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }
        const cmdMatch = cbData.match(/^cmd:(.+)$/);
        if (cmdMatch) {
          const name = cmdMatch[1];
          const s = sessionsByChat.get(chatId);
          if (!s) {
            await tg.answerCallbackQuery(cq.id, "No active session");
            continue;
          }
          await tg.answerCallbackQuery(cq.id, `Running /${name}…`);
          try {
            await oc.runCommand(s.sessionId, name, "");
            await tg.sendRichMessage(chatId, `ran /${esc(name)}`);
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }

        continue;
      }

      const msg = u.message;
      if (!msg?.text) continue;
      console.log("[telegram] message from", msg.from?.id, msg.chat.id, JSON.stringify(msg.text.slice(0, 80)));
      const userId = msg.from?.id;
      if (config.ADMIN_TELEGRAM_USER_ID && userId !== config.ADMIN_TELEGRAM_USER_ID) {
        await tg.sendRichMessage(msg.chat.id, "Not authorized.");
        continue;
      }

      const chatId = msg.chat.id;
      const text = msg.text.trim();

      if (text === "/start" || text === "/help") {
        await sendPanel(chatId);
        continue;
      }

      if (text === "/status") {
        await sendPanel(chatId);
        continue;
      }

      if (text === "/status") {
        const s = sessionsByChat.get(chatId);
        await tg.sendRichMessage(chatId, s ? `active session: ${s.sessionId}\ndir: ${s.directory}` : "no active session");
        continue;
      }

      if (text === "/new") {
        await createNewSession(chatId);
        continue;
      }

      if (text === "/stop" || text === "/abort") {
        const s = sessionsByChat.get(chatId);
        if (!s) {
          await tg.sendRichMessage(chatId, "no active session");
          continue;
        }
        try {
          await oc.interrupt(s.sessionId);
          await tg.sendRichMessage(chatId, "⏹ stopped", s.threadId ? { message_thread_id: s.threadId } : {});
        } catch (err) {
          await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/commands") {
        await showCommands(chatId);
        continue;
      }

      if (text === "/models") {
        await showModels(chatId, 0);
        continue;
      }

      if (text === "/sessions" || text.startsWith("/sessions ")) {
        const arg = text.slice("/sessions".length).trim();
        const page = /^\d+$/.test(arg) ? Math.max(0, parseInt(arg, 10) - 1) : 0;
        await showSessions(chatId, page);
        continue;
      }

      if (text === "/use" || text.startsWith("/use ")) {
        const sessionId = text.slice(4).trim();
        if (!sessionId) {
          await showSessions(chatId, 0);
          continue;
        }
        try {
          await activateSession(chatId, sessionId);
        } catch (err) {
          await tg.sendRichMessage(chatId, `failed to switch: ${esc(err instanceof Error ? err.message : String(err))}`);
        }
        continue;
      }

      // Create or reuse session
      let s = sessionsByChat.get(chatId);
      if (!s) {
        await createNewSession(chatId);
        s = sessionsByChat.get(chatId)!;
      }

      const slash = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
      const known = new Set(["start", "help", "status", "new", "stop", "abort", "commands"]);
      if (slash && !known.has(slash[1])) {
        const name = slash[1];
        const args = (slash[2] ?? "").trim();
        try {
          await oc.runCommand(s.sessionId, name, args);
          await tg.sendRichMessage(chatId, `ran /${name}`);
        } catch (err) {
          await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}\n\nUse /commands to see available commands.`, { reply_markup: { inline_keyboard: [[{ text: "⚡ Commands", callback_data: "panel:commands" }, { text: "🏠 Panel", callback_data: "panel:home" }]] } });
        }
        continue;
      }

      await oc.prompt(s.sessionId, text);
    }
  }
}

const shutdown = (signal: string) => {
  console.log(`[opencodegram] ${signal} received, shutting down`);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
  console.error("[opencodegram] unhandled rejection", err);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});