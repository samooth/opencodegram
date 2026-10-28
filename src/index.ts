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
};

async function main() {
  const config = loadConfig();
  const tg = new TelegramClient(config.TELEGRAM_BOT_TOKEN);
  const oc = new OpenCodeBridge(config.OPENCODE_BASE_URL, resolveServerPassword());

  const me = await tg.getMe();
  console.log(`[opencodegram] bot: @${me.username ?? me.first_name} (id ${me.id}) topics=${me.has_topics_enabled ?? false}`);
  const info = await oc.serverInfo();
  console.log(`[opencodegram] opencode: ${JSON.stringify(info)}`);

  const sessionsByChat = new Map<number, ChatSession>();
  const chatBySession = new Map<string, number>();
  const pendingPermissions = new Map<string, { chatId: number; sessionId: string }>(); // requestId -> info

  const flushDraft = async (chatId: number) => {
    const s = sessionsByChat.get(chatId);
    if (!s) return;
    s.timer = undefined;
    try {
      await tg.sendRichMessageDraft(chatId, s.draftId, esc(s.buffer || "…"), { can_stop: true });
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
            await tg.sendRichMessage(chatId, `<pre>${esc(s.buffer || "(empty response)")}</pre>`);
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
          await tg.sendRichMessage(chatId, `<b>Permission requested</b>\n<i>${esc(label)}</i>\n<code>${esc(resource)}</code>`, {
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
            await tg.sendRichMessage(chatId, `❌ ${esc(msg)}`);
          }
        }

        if (e.type === "session.idle") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? chatBySession.get(sessionId) : undefined;
          if (chatId !== undefined) {
            await tg.sendRichMessage(chatId, "✓ session idle");
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

      if (text === "/start") {
        await tg.sendRichMessage(chatId, "opencodegram ready. Send a prompt to create a session. Commands: /help /status /new");
        continue;
      }

      if (text === "/help") {
        await tg.sendRichMessage(chatId, "Send any text to prompt the active session. /status shows the active session. /new creates a new session. Other /commands are forwarded to OpenCode.");
        continue;
      }

      if (text === "/status") {
        const s = sessionsByChat.get(chatId);
        await tg.sendRichMessage(chatId, s ? `active session: ${s.sessionId}\ndir: ${s.directory}` : "no active session");
        continue;
      }

      if (text === "/new") {
        const old = sessionsByChat.get(chatId);
        if (old) chatBySession.delete(old.sessionId);
        sessionsByChat.delete(chatId);
        await tg.sendRichMessage(chatId, "cleared active session; next message creates a new one.");
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
          await tg.sendRichMessage(chatId, "⏹ stopped");
        } catch (err) {
          await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/commands") {
        const s = sessionsByChat.get(chatId);
        const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
        const cmds = await oc.listCommands(directory);
        if (!cmds.length) {
          await tg.sendRichMessage(chatId, "no commands available");
          continue;
        }
        const lines = cmds.map((c: any) => `/${c.name}${c.description ? " — " + c.description : ""}`);
        await tg.sendRichMessage(chatId, "OpenCode commands:\n" + lines.map(esc).join("\n"));
        continue;
      }

      if (text === "/sessions" || text.startsWith("/sessions ")) {
        const arg = text.slice("/sessions".length).trim();
        const all = arg === "all";
        const limit = all ? 100 : 20;
        const lines: string[] = [];
        let cursor: string | undefined;
        let count = 0;
        const max = all ? 10000 : 20;
        while (count < max) {
          const res = await oc.client.session.list({ limit, order: "desc", cursor });
          const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
          if (!list.length) break;
          for (const s of list) {
            if (count >= max) break;
            const title = s.title ?? "(untitled)";
            const model = s.model ? `${s.model.providerID}/${s.model.id}` : "";
            const updated = s.time?.updated ? new Date(s.time.updated).toISOString().slice(0, 16).replace("T", " ") : "";
            lines.push(`• ${title}\n  ${s.id}${model ? "  " + model : ""}${updated ? "  " + updated : ""}`);
            count++;
          }
          const c = (res as any)?.cursor;
          cursor = typeof c === "string" ? c : (c?.next ?? (res as any)?.nextCursor);
          if (!cursor || !all) break;
        }
        if (!lines.length) {
          await tg.sendRichMessage(chatId, "no sessions found.");
          continue;
        }
        // Send in chunks to respect Telegram's 4096-char limit.
        let chunk = "";
        for (const line of lines) {
          if (chunk.length + line.length + 2 > 3800) {
            await tg.sendRichMessage(chatId, chunk);
            chunk = "";
          }
          chunk += (chunk ? "\n\n" : "") + line;
        }
        if (chunk) await tg.sendRichMessage(chatId, chunk);
        await tg.sendRichMessage(chatId, `listed ${count} session(s). Use <code>/use &lt;session_id&gt;</code> to switch.`);
        continue;
      }

      if (text.startsWith("/use ")) {
        const sessionId = text.slice(5).trim();
        if (!sessionId) {
          await tg.sendRichMessage(chatId, "usage: /use <session_id>");
          continue;
        }
        try {
          const session = await oc.client.session.get({ sessionID: sessionId });
          const s = session as any;
          const directory = s?.location?.directory ?? s?.directory;
          const model = s?.model ? { id: s.model.id, providerID: s.model.providerID, variant: s.model.variant } : undefined;
          const old = sessionsByChat.get(chatId);
          if (old) chatBySession.delete(old.sessionId);
          const cs: ChatSession = { sessionId, directory, draftId: 0, buffer: "", stopped: false };
          sessionsByChat.set(chatId, cs);
          chatBySession.set(sessionId, chatId);
          await tg.sendRichMessage(chatId, `active session: ${sessionId}\nmodel: ${model ? model.providerID + "/" + model.id : "default"}\ndir: ${directory ?? "n/a"}`);
        } catch (err) {
          await tg.sendRichMessage(chatId, `failed to switch: ${esc(err instanceof Error ? err.message : String(err))}`);
        }
        continue;
      }

      // Create or reuse session
      let s = sessionsByChat.get(chatId);
      if (!s) {
        const directory = config.OPENCODE_DIRECTORY ?? (await oc.latestSessionDirectory()) ?? process.cwd();
        // Reuse the most recent session's model when possible, otherwise ask OpenCode for the default.
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
        s = { sessionId, directory, draftId: 0, buffer: "", stopped: false };
        sessionsByChat.set(chatId, s);
        chatBySession.set(sessionId, chatId);
        await tg.sendRichMessage(chatId, `<b>Session created</b>\n<code>${esc(sessionId)}</code>\nmodel: ${esc(model?.providerID ?? "")}/${esc(model?.id ?? "")}${model?.variant ? " (" + esc(model.variant) + ")" : ""}\ndir: <code>${esc(directory)}</code>`);
      }

      const slash = text.match(/^\/([a-zA-Z0-9_-]+)(?:\\s+(.*))?$/s);
      const known = new Set(["start", "help", "status", "new", "stop", "abort", "commands"]);
      if (slash && !known.has(slash[1])) {
        const name = slash[1];
        const args = (slash[2] ?? "").trim();
        try {
          await oc.runCommand(s.sessionId, name, args);
          await tg.sendRichMessage(chatId, `ran /${name}`);
        } catch (err) {
          await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
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