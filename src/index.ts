import { mkdirSync, writeFileSync, statSync, renameSync, accessSync, constants } from "node:fs";
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
import { createPanels } from "./panels.js";
import { createFileBrowser } from "./filebrowser.js";
import { createSessionManager } from "./sessions.js";
import { startEventLoop } from "./events.js";
import { startPolling } from "./updates.js";
import { createWebhookServer } from "./webhook.js";
import type { BotDeps } from "./context.js";
import { BOT_COMMANDS } from "./botcommands.js";

async function main() {
  const config = loadConfig();
  if (config.DEBUG && !process.env.DEBUG) process.env.DEBUG = config.DEBUG;
  const tg = new TelegramClient(config.TELEGRAM_BOT_TOKEN);
  const oc = new OpenCodeBridge(config.OPENCODE_BASE_URL, resolveServerPassword());

  const me = await tg.getMe();
  const topicsEnabled = me.has_topics_enabled === true;
  console.log(`[opencodegram] bot: @${me.username ?? me.first_name} (id ${me.id}) topics=${topicsEnabled}`);

  await tg.deleteMyCommands().catch(() => {});
  await tg.setMyCommands(BOT_COMMANDS).catch((err) => console.error("[commands]", err));
  await tg.setMyCommands(BOT_COMMANDS, { type: "all_private_chats" }).catch(() => {});
  await tg.setMyCommands(BOT_COMMANDS, { type: "all_group_chats" }).catch(() => {});
  // Wait for the OpenCode server to be ready; PM2 may start us before it.
  let info: any;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      info = await oc.serverInfo();
      break;
    } catch (err) {
      console.error(`[opencodegram] waiting for opencode (attempt ${attempt}/30): ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!info) throw new Error("OpenCode server not reachable after retries");
  console.log(`[opencodegram] opencode: ${JSON.stringify(info)}`);

  const store = new SessionStore();
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
  const messageToSession = store.messageToSession;
  const metrics = new MetricsStore();
  const transcript = createTranscriptManager({
    tg,
    store,
    threadOptsFor: (s) => store.threadOptsFor(s),
    renderResources: (s) => {
      const chatId = store.resolveChatId(s.sessionId);
      if (chatId !== undefined && settings.get(chatId).displayMode === "unified") return "";
      return renderResourceBlock(s);
    },
  });
  const dashboard = createDashboardManager({ tg, store, settings, threadOptsFor: (s) => store.threadOptsFor(s) });
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
    getLastPrompt: (sid) => store.lastPromptBySession.get(sid),
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
  store.cleanupStaleStatusMessages(tg).catch(() => {});
  // Proactively restore persisted sessions so their status cards are refreshed
  // instead of staying on "Reconnecting…".
  (async () => {
    for (const [key] of store.activeSessionByRoute) {
      const [chatPart, threadPart] = key.split(":");
      const chatId = Number(chatPart);
      const threadId = Number(threadPart) || undefined;
      if (!Number.isFinite(chatId) || chatId === 0) continue;
      try {
        const s = await sessions.restoreActiveSession(chatId, threadId);
        if (s?.statusMessageId) await status.updateStatus(chatId, s, true).catch(() => {});
      } catch {
        // ignore
      }
    }
  })().catch(() => {});
  if (config.AUTO_CLEANUP_DAYS > 0) {
    sessions.cleanupStaleSessions(config.AUTO_CLEANUP_DAYS).catch(() => {});
  }

  const audit = (action: string, detail: string) => {
    try {
      mkdirSync(join(process.cwd(), "data"), { recursive: true });
      const auditFile = join(process.cwd(), "data", "audit.log");
      try {
        const stat = statSync(auditFile);
        if (stat.size > 1_000_000) renameSync(auditFile, auditFile + ".1");
      } catch {
        // File does not exist yet.
      }
      const redacted = detail
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]");
      const line = `${new Date().toISOString()} ${action} ${redacted}\n`;
      writeFileSync(auditFile, line, { flag: "a" });
    } catch {
      // Audit logging must never break the bot.
    }
  };

  /** Structured per-session trace: chat, topic, session and latency. */
  const sessionTrace = (event: string, fields: Record<string, unknown>) => {
    try {
      const line = `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`;
      writeFileSync(join(process.cwd(), "data", "sessions.log"), line, { flag: "a" });
    } catch {
      // Tracing must never break the bot.
    }
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
    metrics,
    ops,
    pendingEdits,
    messageToSession,
    pendingPermissions: new Map(),
    pendingForms: new Map(),
    pendingFormsById: new Map(),
    pendingConfirmations: new Map(),
    awaitingReason: new Map(),
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
    flushDraft: status.flushDraft,
    startStatus: status.startStatus,
    updateStatus: status.updateStatus,
    finishStatus: status.finishStatus,
    syncTopicTitle: sessions.syncTopicTitle,
    transcript,
    publishCard: status.publishCard,
    sessionTrace,
  });

  let webhookServer: ReturnType<typeof createWebhookServer> | undefined;
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
  } else {
    await tg.deleteWebhook().catch(() => {});
    await startPolling(deps);
  }

  // Graceful shutdown handling for servers.
  const stopAll = () => {
    try { ops.stop(); } catch {}
    try { webhookServer?.stop(); } catch {}
  };
  process.on("SIGINT", () => { stopAll(); shutdown("SIGINT"); });
  process.on("SIGTERM", () => { stopAll(); shutdown("SIGTERM"); });
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
