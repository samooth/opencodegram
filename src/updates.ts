import type { BotDeps } from "./context.js";
import type { TelegramUpdate } from "./telegram.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleCallback } from "./callbacks.js";
import { handleMessage } from "./messages.js";
import { threadOpts } from "./util.js";
import { cancelAutoRetry } from "./autoretry.js";

export async function processUpdate(deps: BotDeps, update: TelegramUpdate): Promise<void> {
  const { tg, oc, store, metrics } = deps;
  try {
    if (update.stopped_message_generation) {
      const d = update.stopped_message_generation;
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
        cancelAutoRetry(s.sessionId);
        const chatId = s.targetChatId ?? d.chat.id;
        await oc.interrupt(s.sessionId).catch(() => {});
        if (s.statusMessageId) {
          await deps.status.updateStatus(chatId, s, true).catch(() => {});
        }
        break;
      }
      return;
    }

    if (update.callback_query) {
      await handleCallback(deps, update.callback_query);
      return;
    }

    if (update.message) {
      await handleMessage(deps, update.message);
    }
  } catch (err) {
    console.error("[update]", err);
    metrics?.recordError(String(err));
  }
}

/** Telegram long-polling loop. Dispatches callbacks, messages and draft stops. */
export async function startPolling(deps: BotDeps): Promise<void> {
  const { tg, metrics, store } = deps;
  const offsetFile = join(store.dataDir, "telegram_offset.json");
  let offset = loadOffset(offsetFile);
  const seen = new Set<number>();

  const saveOffset = (value: number) => {
    try {
      mkdirSync(store.dataDir, { recursive: true });
      writeFileSync(offsetFile, JSON.stringify({ offset: value }));
    } catch (err) {
      console.error("[poll] could not persist offset", err);
    }
  };

  while (true) {
    let updates: Awaited<ReturnType<typeof tg.getUpdates>> = [];
    try {
      updates = await tg.getUpdates(offset, 25);
    } catch (err) {
      console.error("[poll]", err);
      metrics?.recordError(String(err));
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const u of updates) {
      // Skip updates that were already confirmed before a restart and
      // duplicates that Telegram may redeliver. This prevents replaying an
      // old user prompt after a reload.
      if (u.update_id < offset || seen.has(u.update_id)) continue;
      offset = u.update_id + 1;
      seen.add(u.update_id);
      if (seen.size > 2000) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      saveOffset(offset);
      metrics?.inc("updates");
      await processUpdate(deps, u);
    }
  }
}

function loadOffset(file: string): number {
  try {
    if (!existsSync(file)) return 0;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { offset?: unknown };
    const value = Number(parsed?.offset);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
