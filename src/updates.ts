import type { BotDeps } from "./context.js";
import { handleCallback } from "./callbacks.js";
import { handleMessage } from "./messages.js";
import { threadOpts } from "./util.js";

/** Telegram long-polling loop. Dispatches callbacks, messages and draft stops. */
export async function startPolling(deps: BotDeps): Promise<void> {
  const { tg, oc, store, metrics } = deps;
  let offset = 0;

  while (true) {
    let updates: Awaited<ReturnType<typeof tg.getUpdates>> = [];
    try {
      updates = await tg.getUpdates(offset, 25);
    } catch (err) {
      console.error("[poll]", err);
      metrics?.inc("poll_errors");
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      metrics?.inc("updates");

      try {
        if (u.stopped_message_generation) {
          const d = u.stopped_message_generation;
          // Find the session whose draft matches.
          for (const s of store.sessionsById.values()) {
            if (s.draftId !== d.draft_id) continue;
            s.stopped = true;
            if (s.timer) {
              clearTimeout(s.timer);
              s.timer = undefined;
            }
            if (s.typingTimer) {
              clearInterval(s.typingTimer);
              s.typingTimer = undefined;
            }
            const chatId = s.targetChatId ?? d.chat.id;
            await oc.interrupt(s.sessionId).catch(() => {});
            if (s.statusMessageId) {
              await tg
                .editRichMessage(chatId, s.statusMessageId, "⏹ <b>Stopped</b>", {
                  ...store.threadOptsFor(s),
                  reply_markup: { inline_keyboard: [] },
                })
                .catch(() => {});
              s.statusMessageId = undefined;
            }
            await tg.sendRichMessage(chatId, "⏹ stopped", threadOpts(s.targetThreadId ?? s.threadId)).catch(() => {});
            break;
          }
          continue;
        }

        if (u.callback_query) {
          await handleCallback(deps, u.callback_query);
          continue;
        }

        if (u.message) {
          await handleMessage(deps, u.message);
        }
      } catch (err) {
        // One bad update must never stop the bot from polling.
        console.error("[update]", err);
        metrics?.inc("update_errors");
      }
    }
  }
}
