import type { BotDeps } from "./context.js";
import type { TelegramUpdate } from "./telegram.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleCallback } from "./callbacks.js";
import { handleMessage } from "./messages.js";
import { POLL_BACKOFF_MS } from "./constants.js";

export async function processUpdate(deps: BotDeps, update: TelegramUpdate): Promise<void> {
  const { metrics } = deps;
  try {
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

/** Telegram long-polling loop. Dispatches callbacks and messages. */
export async function startPolling(deps: BotDeps): Promise<void> {
  const { tg, metrics, store } = deps;
  const botId = (deps as any).me?.id as number | undefined;
  const offsetFile = join(store.dataDir, "telegram_offset.json");
  let offset = loadOffset(offsetFile, botId);
  const seen = new Set<number>();

  const saveOffset = (value: number) => {
    try {
      mkdirSync(store.dataDir, { recursive: true });
      writeFileSync(offsetFile, JSON.stringify({ offset: value, botId }));
    } catch (err) {
      console.error("[poll] could not persist offset", err);
    }
  };

  // Persist bot identity even when no updates arrive yet, so future bot changes
  // can be detected reliably.
  saveOffset(offset);

  while (true) {
    let updates: Awaited<ReturnType<typeof tg.getUpdates>> = [];
    try {
      updates = await tg.getUpdates(offset, 25);
    } catch (err) {
      console.error("[poll]", err);
      metrics?.recordError(String(err));
      await new Promise((r) => setTimeout(r, POLL_BACKOFF_MS));
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

function loadOffset(file: string, botId?: number): number {
  try {
    if (!existsSync(file)) return 0;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { offset?: unknown; botId?: unknown };
    const storedBotId = Number(parsed?.botId);
    if (botId && Number.isFinite(storedBotId) && storedBotId > 0 && storedBotId !== botId) {
      console.warn(`[poll] telegram bot changed (${storedBotId} -> ${botId}); resetting update offset`);
      return 0;
    }
    const value = Number(parsed?.offset);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
