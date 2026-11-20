import type { BotDeps } from "./context.js";
import type { TelegramUpdate } from "./telegram.js";
import { join } from "node:path";
import { handleCallback } from "./callbacks.js";
import { handleMessage } from "./messages.js";
import { POLL_BACKOFF_MS } from "./constants.js";
import { readJsonSafe, writeJsonAtomic } from "./persist.js";

let stopRequested = false;
export function requestStopPolling(): void { stopRequested = true; }

export async function processUpdate(deps: BotDeps, update: TelegramUpdate): Promise<void> {
  const { metrics } = deps;
  try {
    if (update.callback_query) {
      const started = Date.now();
      await handleCallback(deps, update.callback_query);
      const elapsed = Date.now() - started;
      if (elapsed > 2000) {
        console.warn("[callbacks] slow handler", { data: update.callback_query.data, elapsed });
        metrics?.recordError?.(`slow callback ${update.callback_query.data}: ${elapsed}ms`);
      }
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

const chatQueues = new Map<string, Promise<void>>();

/**
 * Dispatch one polled update without ever blocking the polling loop. Callback
 * queries expire within seconds, and a slow /ls must not delay the next tap.
 * Messages are serialized per chat/topic so conversation state stays ordered.
 */
export function dispatchPolledUpdate(deps: BotDeps, update: TelegramUpdate): void {
  if (update.callback_query) {
    void processUpdate(deps, update);
    return;
  }
  const chatId = update.message?.chat?.id ?? 0;
  const key = `${chatId}:${update.message?.message_thread_id ?? 0}`;
  const previous = chatQueues.get(key) ?? Promise.resolve();
  const next = previous.then(() => processUpdate(deps, update)).catch(() => {});
  chatQueues.set(key, next);
  void next.then(() => {
    if (chatQueues.get(key) === next) chatQueues.delete(key);
  });
}

/** Telegram long-polling loop. Dispatches callbacks and messages. */
export async function startPolling(deps: BotDeps): Promise<void> {
  const { tg, metrics, store } = deps;
  const botId = deps.me?.id as number | undefined;
  const offsetFile = join(store.dataDir, "telegram_offset.json");
  let offset = loadOffset(offsetFile, botId);
  const seen = new Set<number>();

  const saveOffset = (value: number) => {
    try {
      writeJsonAtomic(offsetFile, { offset: value, botId }, false);
    } catch (err) {
      console.error("[poll] could not persist offset", err);
    }
  };

  // Persist bot identity even when no updates arrive yet, so future bot changes
  // can be detected reliably.
  saveOffset(offset);

  // Let any stale long-poll connection from a previous process expire before
  // we start polling (avoids 409 Conflict on restart).
  await new Promise((r) => setTimeout(r, 3000));

  let consecutiveFailures = 0;
  while (!stopRequested) {
    let updates: Awaited<ReturnType<typeof tg.getUpdates>> = [];
    try {
      updates = await tg.getUpdates(offset, 5);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[poll] getUpdates failed (${consecutiveFailures}): ${msg}`);
      metrics?.recordError(msg);
      const wait = Math.min(30000, POLL_BACKOFF_MS * Math.pow(2, Math.min(consecutiveFailures - 1, 4)));
      await new Promise((r) => setTimeout(r, wait));
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
      dispatchPolledUpdate(deps, u);
    }
  }
}

function loadOffset(file: string, botId?: number): number {
  try {
    const parsed = readJsonSafe<{ offset?: unknown; botId?: unknown }>(file, "poll");
    if (!parsed) return 0;
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
