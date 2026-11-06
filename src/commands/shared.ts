import type { BotDeps, SendFn } from "../context.js";

export function ctx(deps: BotDeps) {
  const { config, tg, oc, panels, sessions, files, store } = deps;
  const settings = deps.settings;
  const updateStatus = deps.status?.updateStatus ?? (async () => {});
  const startStatus = deps.status?.startStatus ?? (async () => {});
  const finishStatus = deps.status?.finishStatus ?? (async () => {});
  const { restoreActiveSession, activateSession, ensureActiveSession, createNewSession } = sessions;
  const { sendPanel, showCommands, showModels, showSessions, showDeleteSessions, showStatus } = panels;
  return {
    config, tg, oc, panels, sessions, files, store, settings,
    updateStatus, startStatus, finishStatus,
    restoreActiveSession, activateSession, ensureActiveSession, createNewSession,
    sendPanel, showCommands, showModels, showSessions, showDeleteSessions, showStatus,
  };
}

export type { BotDeps, SendFn };
