import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";
import { OpenCodeBridge, resolveServerPassword } from "./opencode.js";
import { SessionStore } from "./store.js";
import { createStatusManager } from "./status.js";
import { SettingsStore } from "./settings.js";
import { createPanels } from "./panels.js";
import { createFileBrowser } from "./filebrowser.js";
import { createSessionManager } from "./sessions.js";
import { startEventLoop } from "./events.js";
import { startPolling } from "./updates.js";
import type { BotDeps } from "./context.js";

const BOT_COMMANDS = [
  { command: "start", description: "Welcome and control panel" },
  { command: "help", description: "Show help and panel" },
  { command: "status", description: "Show active session" },
  { command: "sessions", description: "List and switch sessions" },
  { command: "use", description: "Switch to a session by ID" },
  { command: "new", description: "Create a new session" },
  { command: "models", description: "List and switch models" },
  { command: "agents", description: "List and switch agents" },
  { command: "usage", description: "Show usage and cost stats" },
  { command: "vcs", description: "Show VCS status" },
  { command: "mcp", description: "MCP servers and resources" },
  { command: "branches", description: "List branches" },
  { command: "branch", description: "Switch branches" },
  { command: "stage", description: "Stage a file" },
  { command: "unstage", description: "Unstage a file" },
  { command: "commit", description: "Commit staged changes" },
  { command: "worktrees", description: "List worktrees" },
  { command: "worktree", description: "Create, remove or switch worktrees" },
  { command: "forms", description: "List pending forms" },
  { command: "formreply", description: "Reply to a form" },
  { command: "commands", description: "List OpenCode commands" },
  { command: "settings", description: "Bot settings and toggles" },
  { command: "file", description: "Send a local file as a document" },
  { command: "ls", description: "Browse a directory with buttons" },
  { command: "find", description: "Search files in the session directory" },
  { command: "read", description: "Preview a text file" },
  { command: "zip", description: "Archive a directory and send it" },
  { command: "fork", description: "Fork the active session" },
  { command: "rename", description: "Rename the active session" },
  { command: "archive", description: "Archive the active session" },
  { command: "unarchive", description: "Unarchive the active session" },
  { command: "delete", description: "Delete the active session" },
  { command: "diff", description: "Show session diff" },
  { command: "context", description: "Show session context" },
  { command: "sync", description: "Sync session history to Telegram" },
  { command: "compact", description: "Compact session history" },
  { command: "stop", description: "Stop the active turn" },
];

async function main() {
  const config = loadConfig();
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
  const settings = new SettingsStore();
  const pendingEdits = new Map();
  const messageToSession = store.messageToSession;
  const status = createStatusManager({
    tg,
    threadOptsFor: (s) => store.threadOptsFor(s),
    getSettings: (chatId) => settings.get(chatId),
    pendingEdits,
  });
  const sessions = createSessionManager({
    config,
    tg,
    oc,
    store,
    topicsEnabled,
    finishStatus: status.finishStatus,
  });
  const modelListByChat = new Map<string, Array<any>>();
  const pendingModelByChat = new Map<string, any>();
  const panels = createPanels({
    tg,
    oc,
    config,
    getActiveSession: store.getActiveSession,
    modelListByChat,
    routeKey: store.routeKey,
  });
  const files = createFileBrowser({
    tg,
    config,
    getActiveSession: store.getActiveSession,
    getSettings: (chatId, threadId) => settings.get(chatId),
  });

  const audit = (action: string, detail: string) => {
    try {
      mkdirSync(join(process.cwd(), "data"), { recursive: true });
      const line = `${new Date().toISOString()} ${action} ${detail}\n`;
      writeFileSync(join(process.cwd(), "data", "audit.log"), line, { flag: "a" });
    } catch {
      // Audit logging must never break the bot.
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
    panels,
    files,
    settings,
    pendingEdits,
    messageToSession,
    pendingPermissions: new Map(),
    pendingForms: new Map(),
    pendingFormsById: new Map(),
    awaitingReason: new Map(),
    modelListByChat,
    pendingModelByChat,
    audit,
  };

  startEventLoop({
    tg,
    oc,
    store,
    retryingSessions: new Set(),
    pendingPermissions: deps.pendingPermissions,
    pendingForms: deps.pendingForms,
    pendingFormsById: deps.pendingFormsById,
    settings: deps.settings,
    messageToSession: deps.messageToSession,
    flushDraft: status.flushDraft,
    updateStatus: status.updateStatus,
    finishStatus: status.finishStatus,
    syncTopicTitle: sessions.syncTopicTitle,
  });

  await startPolling(deps);
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
