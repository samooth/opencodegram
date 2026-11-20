import type { BotDeps, SendFn } from "../context.js";

export function ctx(deps: BotDeps) {
  const { config, tg, oc, panels, sessions, files, store } = deps;
  const settings = deps.settings;
  const updateStatus = deps.status?.updateStatus ?? (async () => {});
  const startStatus = deps.status?.startStatus ?? (async () => {});
  const finishStatus = deps.status?.finishStatus ?? (async () => {});
  const { restoreActiveSession, resolveSessionForRetry, activateSession, ensureActiveSession, createNewSession } = sessions;
  const { sendPanel, showCommands, showModels, showSessions, showDeleteSessions, showStatus } = panels;
  return {
    config, tg, oc, panels, sessions, files, store, settings,
    updateStatus, startStatus, finishStatus,
    restoreActiveSession, resolveSessionForRetry, activateSession, ensureActiveSession, createNewSession,
    sendPanel, showCommands, showModels, showSessions, showDeleteSessions, showStatus,
  };
}

/** True when the user is the global admin or an admin of this route. */
export function isRouteAdmin(deps: BotDeps, chatId: number, threadId: number | undefined, userId?: number): boolean {
  if (deps.permissions) {
    return deps.permissions.isAdmin(deps.store.routeKey(chatId, threadId), userId, deps.config.ADMIN_TELEGRAM_USER_ID);
  }
  return !!deps.config.ADMIN_TELEGRAM_USER_ID && userId === deps.config.ADMIN_TELEGRAM_USER_ID;
}

export type { BotDeps, SendFn };
