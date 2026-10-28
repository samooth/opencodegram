import { loadConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";
import { OpenCodeBridge, resolveServerPassword } from "./opencode.js";

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
      await tg.sendMessageDraft(chatId, s.draftId, s.buffer || "…", { can_stop: true });
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
        if (e.type.startsWith("session.text") || e.type === "permission.asked" || e.type === "session.idle") {
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
            await tg.sendMessage(chatId, s.buffer || "(empty response)");
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
          await tg.sendMessage(chatId, `Permission requested: ${label}\n${resource}`, {
            reply_markup: {
              inline_keyboard: [[
                { text: "Allow once", callback_data: `perm:allow:${requestId}` },
                { text: "Deny", callback_data: `perm:deny:${requestId}` },
              ]],
            },
          });
        }

        if (e.type === "session.idle") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? chatBySession.get(sessionId) : undefined;
          if (chatId !== undefined) {
            await tg.sendMessage(chatId, "✓ session idle");
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
            await tg.sendMessage(chatId, "⏹ stopped");
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
        await tg.sendMessage(msg.chat.id, "Not authorized.");
        continue;
      }

      const chatId = msg.chat.id;
      const text = msg.text.trim();

      if (text === "/start") {
        await tg.sendMessage(chatId, "opencodegram ready. Send a prompt to create a session.");
        continue;
      }

      // Create or reuse session
      let s = sessionsByChat.get(chatId);
      if (!s) {
        const session = await oc.createSession("Telegram session");
        const sessionId = (session as any)?.id ?? (session as any)?.sessionID ?? (session as any)?.data?.id;
        s = { sessionId, directory: config.OPENCODE_DIRECTORY, draftId: 0, buffer: "", stopped: false };
        sessionsByChat.set(chatId, s);
        chatBySession.set(sessionId, chatId);
        await tg.sendMessage(chatId, `Session created: ${sessionId}`);
      }

      await oc.prompt(s.sessionId, text);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});