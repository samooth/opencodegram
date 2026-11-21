#!/usr/bin/env bun
import { mkdirSync, accessSync, constants } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";
import { OpenCodeBridge, resolveServerPassword } from "./opencode.js";
import { SessionStore } from "./store.js";
import { createStatusManager } from "./status.js";
import { createTranscriptManager } from "./transcriptmanager.js";
import { createDashboardManager } from "./dashboard.js";
import { renderResourceBlock } from "./resources.js";
import { SettingsStore } from "./settings.js";
import { MetricsStore } from "./metrics.js";
import { createOpsServer } from "./ops.js";
import { PermissionStore } from "./permissions.js";
import { importAllJson } from "./db.js";
import { createPanels } from "./panels.js";
import { createFileBrowser } from "./filebrowser.js";
import { createSessionManager } from "./sessions.js";
import { startEventLoop } from "./events.js";
import { startPolling, requestStopPolling, drainPolledUpdates } from "./updates.js";
import { createWebhookServer } from "./webhook.js";
import type { BotDeps } from "./context.js";
import { BOT_COMMANDS } from "./botcommands.js";

async function main() {
  const config = loadConfig();
  if (config.DEBUG && !process.env.DEBUG) process.env.DEBUG = config.DEBUG;
  const tg = new TelegramClient(config.TELEGRAM_BOT_TOKEN);
  // Dead-chat hygiene: when a chat is gone (deleted group, bot kicked), drop
  // its bindings after repeated failures so the bot stops trying to edit
  // unreachable cards ("chat not found" noise in logs).
  const chatFailureCounts = new Map<number, { count: number; firstAt: number }>();
  tg.onChatFailure = (chatId, error) => {
    const entry = chatFailureCounts.get(chatId) ?? { count: 0, firstAt: Date.now() };
    entry.count++;
    if (Date.now() - entry.firstAt > 10 * 60_000) {
      entry.count = 1;
      entry.firstAt = Date.now();
    }
    chatFailureCounts.set(chatId, entry);
    if (entry.count >= 3) {
      chatFailureCounts.delete(chatId);
      console.warn(`[telegram] chat ${chatId} unreachable (${error}); dropping bindings`);
      store.forgetChatBindings(chatId);
      metrics.inc("chats_dropped");
    }
  };
  const oc = new OpenCodeBridge(config.OPENCODE_BASE_URL, resolveServerPassword());

  const me = await tg.getMe();
  const topicsEnabled = me.has_topics_enabled === true;
  console.log(`[opencodegram] bot: @${me.username ?? me.first_name} (id ${me.id}) topics=${topicsEnabled}`);

  await tg.deleteMyCommands().catch(() => {});
  await tg.setMyCommands(BOT_COMMANDS).catch((err) => console.error("[commands]", err));
  await tg.setMyCommands(BOT_COMMANDS, { type: "all_private_chats" }).catch(() => {});
  await tg.setMyCommands(BOT_COMMANDS, { type: "all_group_chats" }).catch(() => {});
  // Wait for the OpenCode server to be ready; PM2 may start us before it.
  let info: Awaited<ReturnType<typeof oc.serverInfo>> | undefined;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      info = await oc.serverInfo();
      break;
    } catch (err) {
      const e = err as { message?: string; reason?: string; detail?: string; cause?: unknown } | null | undefined;
      const reason = e?.reason ? ` reason=${e.reason}` : "";
      const detail = e?.detail ? ` detail=${String(e.detail)}` : "";
      const cause = e?.cause ? ` cause=${e.cause instanceof Error ? e.cause.message : String(e.cause)}` : "";
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[opencodegram] waiting for opencode (attempt ${attempt}/30): ${msg}${reason}${detail}${cause}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!info) throw new Error("OpenCode server not reachable after retries");
  console.log(`[opencodegram] opencode: ${JSON.stringify(info)}`);

  const store = new SessionStore();
  // Bring every legacy JSON state file into the single SQLite database before
  // the daemon starts serving updates.
  const importedKeys = importAllJson(store.dataDir);
  if (importedKeys) console.log(`[opencodegram] imported ${importedKeys} JSON state files into SQLite`);
  const permissions = new PermissionStore(store.dataDir);
  // Fail fast with a helpful hint if the data directory is not writable
  // (common in Docker when ./data is owned by root instead of uid 1000).
  try {
    mkdirSync(store.dataDir, { recursive: true });
    accessSync(store.dataDir, constants.W_OK);
  } catch (err) {
    console.error("[opencodegram] data directory is not writable:", err);
    console.error("[opencodegram] hint: mkdir -p data && sudo chown -R 1000:1000 data (Docker) or fix permissions on the host");
  }
  const settings = new SettingsStore();
  const pendingEdits = new Map();
  const mcpEvents = new Map<string, Array<{ at: number; server: string; text: string }>>();
  const messageToSession = store.messageToSession;
  const metrics = new MetricsStore();
  const transcript = createTranscriptManager({
    tg,
    store,
    threadOptsFor: (s) => store.threadOptsFor(s),
    renderResources: (s) => {
      const chatId = store.resolveChatId(s.sessionId);
      if (chatId !== undefined) {
        const st = settings.get(chatId);
        if (st.displayMode === "unified" || !st.showResourceUsage) return "";
        return renderResourceBlock(s, { history: st.resourceHistory, theme: st.cardTheme });
      }
      return renderResourceBlock(s);
    },
  });
  const dashboard = createDashboardManager({ tg, store, settings, oc, threadOptsFor: (s) => store.threadOptsFor(s) });
  const status = createStatusManager({
    tg,
    threadOptsFor: (s) => store.threadOptsFor(s),
    getSettings: (chatId) => settings.get(chatId),
    pendingEdits,
    rememberCot: (sessionId, buffer, count) => store.rememberCot(sessionId, buffer, count),
    rememberStatusMessage: (sessionId, chatId, threadId, messageId) => store.rememberStatusMessage(sessionId, chatId, threadId, messageId),
    forgetStatusMessage: (sessionId) => store.forgetStatusMessage(sessionId),
    store,
    transcript,
    dashboard,
  });
  const sessions = createSessionManager({
    config,
    tg,
    oc,
    store,
    cleanupCard: transcript.cleanupCard,
    clearPublishTimers: transcript.clearPublishTimers,
    settings,
    dashboard,
    topicsEnabled,
    finishStatus: status.finishStatus,
  });
  const modelListByChat = new Map<string, Array<{ id: string; providerID: string; variant?: string; name?: string; variants?: Array<{ id?: string }> }>>();
  const pendingModelByChat = new Map<string, { id: string; providerID: string; variant?: string } | null>();
  const panels = createPanels({
    tg,
    oc,
    config,
    getActiveSession: store.getActiveSession,
    restoreActiveSession: sessions.restoreActiveSession,
    findSessionById: store.findSessionById,
    getLastCot: (sid) => store.getCotBuffer(sid),
    modelListByChat,
    routeKey: store.routeKey,
    chatBySession: store.chatBySession,
    deliveryBySession: store.deliveryBySession,
    getSessionStatus: (sid: string) => store.getSessionStatus(sid),
    metrics,
    rememberMessageSession: store.rememberMessageSession,
  });
  const files = createFileBrowser({
    tg,
    config,
    getActiveSession: store.getActiveSession,
    getSettings: (chatId, threadId) => settings.get(chatId),
  });
  const ops = createOpsServer({ config, oc, store, metrics, tg, adminChatId: config.ADMIN_TELEGRAM_USER_ID });
  console.log(`[opencodegram] ops: ${ops.url}`);
  // Clean up status messages left stale by a previous (crashed/restarted) process.
  // DISABLED: store.cleanupStaleStatusMessages(tg, oc).catch(() => {});
  // Proactively restore persisted sessions so their status cards are refreshed
  // instead of staying on "Reconnecting…". Run in parallel with a per-session
  // timeout so one stuck session cannot block the whole startup (and polling).
  (async () => {
    const globalTimeout = new Promise<void>((resolve) => setTimeout(resolve, 30000));
    const restoreAll = (async () => {
      const tasks = [...store.activeSessionByRoute.keys()].map(async (key) => {
        const [chatPart, threadPart] = key.split(":");
        const chatId = Number(chatPart);
        const threadId = Number(threadPart) || undefined;
        if (!Number.isFinite(chatId) || chatId === 0) return;
        try {
          const restore = sessions.restoreActiveSession(chatId, threadId);
          const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000));
          const s = await Promise.race([restore, timeout]);
          if (s?.statusMessageId) await status.updateStatus(chatId, s, true).catch(() => {});
        } catch {
          // ignore
        }
      });
      await Promise.allSettled(tasks);
    })();
    await Promise.race([restoreAll, globalTimeout]);
  })().catch(() => {});
  // Downloaded media lives in /tmp and must not depend on session archiving:
  // clean it unconditionally so attachments do not pile up forever.
  sessions.cleanupStaleAttachments(1).catch(() => {});
  if (config.AUTO_CLEANUP_DAYS > 0) {
    sessions.cleanupStaleSessions(config.AUTO_CLEANUP_DAYS).catch(() => {});
  }

  /** Append a line to a rotating log (1 MB -> `.1`). Never breaks the bot. */
  const appendRotatingLog = (name: "audit" | "sessions", line: string) => {
    void (async () => {
      try {
        const dataDir = join(process.cwd(), "data");
        await mkdir(dataDir, { recursive: true });
        const file = join(dataDir, name === "audit" ? "audit.log" : "sessions.log");
        try {
          const st = await stat(file);
          if (st.size > 1_000_000) await rename(file, file + ".1");
        } catch {
          // File does not exist yet.
        }
        await appendFile(file, line, "utf8");
      } catch {
        // Logging must never break the bot.
      }
    })();
  };

  const audit = (action: string, detail: string) => {
    const redacted = detail
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]");
    appendRotatingLog("audit", `${new Date().toISOString()} ${action} ${redacted}\n`);
  };

  /** Structured per-session trace: chat, topic, session and latency. */
  const sessionTrace = (event: string, fields: Record<string, unknown>) => {
    appendRotatingLog("sessions", `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`);
  };

  const deps: BotDeps = {
    config,
    tg,
    oc,
    store,
    me,
    topicsEnabled,
    sessions,
    status,
    transcript,
    dashboard,
    panels,
    files,
    settings,
    permissions,
    metrics,
    ops,
    pendingEdits,
    messageToSession,
    pendingPermissions: new Map(),
    pendingForms: new Map(),
    pendingFormsById: new Map(),
    pendingConfirmations: new Map(),
    awaitingReason: new Map(),
    awaitingPermissionAdd: new Map(),
    modelListByChat,
    pendingModelByChat,
    pendingGroupPrompts: new Map(),
    audit,
    sessionTrace,
  };

  startEventLoop({
    tg,
    oc,
    config,
    store,
    pendingPermissions: deps.pendingPermissions,
    pendingForms: deps.pendingForms,
    pendingFormsById: deps.pendingFormsById,
    settings: deps.settings,
    messageToSession: deps.messageToSession,
    startStatus: status.startStatus,
    updateStatus: status.updateStatus,
    finishStatus: status.finishStatus,
    syncTopicTitle: sessions.syncTopicTitle,
    transcript,
    publishCard: status.publishCard,
    sessionTrace,
    mcpEvents,
  });

  // Register signal handlers BEFORE starting either loop: in polling mode the
  // loop blocks forever, and in webhook mode there is no blocking call at all.
  let webhookServer: ReturnType<typeof createWebhookServer> | undefined;
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  const stopAll = (): Promise<void> => {
    if (stopping) return shutdownPromise ?? Promise.resolve();
    stopping = true;
    try { ops.stop(); } catch {}
    try { webhookServer?.stop(); } catch {}
    requestStopPolling();
    // The transcript save is debounced (2 s); without an explicit flush the
    // last turn (including the final answer) is lost on shutdown.
    shutdownPromise = Promise.allSettled([store.flushTranscripts(), drainPolledUpdates()])
      .then(() => undefined)
      .catch((err) => console.warn("[shutdown] drain failed", err?.message ?? err));
    return shutdownPromise;
  };
  process.on("SIGINT", () => { void stopAll().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { void stopAll().finally(() => process.exit(0)); });

  if (config.WEBHOOK_MODE) {
    if (!config.WEBHOOK_URL) {
      throw new Error("WEBHOOK_MODE is enabled but WEBHOOK_URL is not set");
    }
    const publicUrl = config.WEBHOOK_URL.replace(/\/$/, "") + config.WEBHOOK_PATH;
    const ok = await tg.setWebhook(publicUrl, config.WEBHOOK_SECRET).catch((err) => {
      console.error("[webhook] setWebhook failed", err);
      return false;
    });
    if (!ok) throw new Error("Failed to register Telegram webhook");
    console.log(`[opencodegram] webhook registered: ${publicUrl}`);
    webhookServer = createWebhookServer(deps);
    // Webhook mode is event-driven: do not exit here. The HTTP server keeps
    // the process alive until a signal calls stopAll().
  } else {
    await tg.deleteWebhook().catch(() => {});
    console.log("[opencodegram] starting polling...");
    await startPolling(deps);
    // The polling loop only returns after requestStopPolling() from a signal.
    await stopAll();
    console.log("[opencodegram] shutting down");
    process.exit(0);
  }
}

process.on("unhandledRejection", (err) => {
  console.error("[opencodegram] unhandled rejection", err);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
