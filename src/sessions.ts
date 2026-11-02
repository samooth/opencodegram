import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import { esc, threadOpts, projectLabel, projectEmoji, clampText } from "./util.js";
import { logger } from "./logger.js";

export type SessionsDeps = {
  config: Config;
  tg: TelegramClient;
  oc: OpenCodeBridge;
  store: SessionStore;
  topicsEnabled: boolean;
  finishStatus: (chatId: number, s: ChatSession) => Promise<unknown>;
};

export type SessionManager = ReturnType<typeof createSessionManager>;

export function createSessionManager({ config, tg, oc, store, topicsEnabled, finishStatus }: SessionsDeps) {
  const {
    sessionsByChat,
    sessionsByThread,
    sessionsById,
    activeSessionByRoute,
    threadBySession,
    routeKey,
    getActiveSession,
    rememberSessionChat,
    rememberActiveRoute,
    forgetSession,
    saveThreads,
  } = store;

  // A tab only ever shows one session. When its owner changes, stop the old
  // turn, remove its Stop button and drop it from the routing tables.
  const retireSession = async (chatId: number, previous: ChatSession) => {
    previous.stopped = true;
    if (previous.timer) {
      clearTimeout(previous.timer);
      previous.timer = undefined;
    }
    if (previous.typingTimer) {
      clearInterval(previous.typingTimer);
      previous.typingTimer = undefined;
    }
    if (previous.statusTimer) {
      clearInterval(previous.statusTimer);
      previous.statusTimer = undefined;
    }
    await oc.interrupt(previous.sessionId).catch(() => {});
    if (previous.statusMessageId) {
      await tg
        .editRichMessage(chatId, previous.statusMessageId, "⏹ <b>Replaced by another session</b>", {
          ...store.threadOptsFor(previous),
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      previous.statusMessageId = undefined;
    }
    forgetSession(previous.sessionId);
  };

  async function createNewSession(chatId: number, silent = false, threadId?: number): Promise<ChatSession | undefined> {
    const directory = config.OPENCODE_DIRECTORY ?? process.cwd();
    let model: { id: string; providerID: string; variant?: string } | undefined;
    try {
      const sessions = await oc.client.session.list();
      const list = (((sessions as { data?: unknown })?.data ?? (Array.isArray(sessions) ? sessions : [])) as unknown[]) as Array<{ model?: { id?: string; providerID?: string; variant?: string }; time?: { updated?: number } }>;
      const latest = [...list].sort((a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))[0];
      if (latest?.model?.id && latest?.model?.providerID) model = { id: latest.model.id as string, providerID: latest.model.providerID as string, variant: latest.model.variant };
    } catch {
      // ignore
    }
    if (!model) model = await oc.defaultModel(directory);
    const session = await oc.createSession({ title: "Telegram session", directory, model, agent: "build" });
    const _s = session as { id?: string; sessionID?: string; data?: { id?: string } } | undefined;
    const sessionId = (_s?.id ?? _s?.sessionID ?? _s?.data?.id) as string;
    const title = (session as { title?: string })?.title ?? "Telegram session";
    const cs: ChatSession = { sessionId, directory, model, draftId: 0, buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [], stopped: false, targetChatId: chatId, cotBuffer: "", cotCount: 0 };
    cs.topicTitle = store.topicTitleBySession.get(sessionId);

    let targetThread = threadId;
    if (targetThread === undefined && topicsEnabled && chatId > 0) {
      try {
        const topic = await tg.createForumTopic(chatId, title.slice(0, 120));
        targetThread = topic.message_thread_id;
      } catch {
        // Topic creation may fail in non-forum chats; fall back to general chat.
      }
    }

    if (targetThread !== undefined) {
      cs.threadId = targetThread;
      cs.targetThreadId = targetThread;
      const route = store.routeKey(chatId, targetThread);
      // One topic = one session. Retire the session previously shown there.
      const previous = sessionsByThread.get(route);
      if (previous && previous.sessionId !== sessionId) await retireSession(chatId, previous);
      for (const [key, existing] of sessionsByThread) if (key !== route && existing.sessionId === sessionId) sessionsByThread.delete(key);
      for (const [sid, tid] of threadBySession) if (tid === targetThread && sid !== sessionId && (store.chatBySession.get(sid) ?? chatId) === chatId) threadBySession.delete(sid);
      sessionsByThread.set(route, cs);
      threadBySession.set(sessionId, targetThread);
      saveThreads();
      cs.topicTitle = store.topicTitleBySession.get(sessionId);
      if (cs.topicTitle !== title.slice(0, 120)) {
        try {
          await tg.editForumTopic(chatId, targetThread, title.slice(0, 120));
          cs.topicTitle = title.slice(0, 120);
          store.rememberTopicTitle(sessionId, title.slice(0, 120));
          store.rememberTopicTitle(sessionId, title.slice(0, 120));
        } catch {
          // Topic titles are cosmetic; never block session creation on them.
        }
      } else {
        cs.topicTitle = title.slice(0, 120);
      }
    } else {
      const prev = sessionsByChat.get(chatId);
      if (prev && prev.sessionId !== sessionId) await retireSession(chatId, prev);
      sessionsByChat.set(chatId, cs);
    }

    sessionsById.set(sessionId, cs);
    rememberSessionChat(sessionId, chatId);
    rememberActiveRoute(chatId, targetThread, sessionId);
    if (!silent) {
      await tg.sendRichMessage(
        chatId,
        `${projectEmoji(directory)} <b>New session created</b>\n<code>${esc(sessionId)}</code>\nmodel: ${esc(model?.providerID ?? "")}/${esc(model?.id ?? "")}${model?.variant ? " (" + esc(model.variant) + ")" : ""}\ndir: <code>${esc(directory)}</code>`,
        threadOpts(targetThread),
      );
    }
    return cs;
  }

  async function resolveThread(chatId: number, sessionId: string, threadId?: number, topicsEnabled?: boolean, title?: string): Promise<number | undefined> {
    let targetThread = threadId;
    if (targetThread === undefined && chatId > 0) {
      const mappedThread = threadBySession.get(sessionId);
      if (mappedThread !== undefined && (store.chatBySession.get(sessionId) ?? chatId) === chatId) {
        targetThread = mappedThread;
      }
    }
    if (targetThread === undefined && topicsEnabled && chatId > 0) {
      let topicTitle = title;
      if (topicTitle === undefined) {
        try {
          const session = await oc.client.session.get({ sessionID: sessionId });
          const s = session as { title?: string };
          topicTitle = (s?.title || sessionId).slice(0, 120);
        } catch {
          topicTitle = sessionId.slice(0, 120);
        }
      }
      try {
        const topic = await tg.createForumTopic(chatId, topicTitle);
        targetThread = topic.message_thread_id;
      } catch {
        // Topic creation may fail in non-forum chats; fall back to general chat.
      }
    }
    return targetThread;
  }

  async function bindTab(chatId: number, cs: ChatSession, targetThread?: number): Promise<void> {
    if (targetThread !== undefined) {
      cs.threadId = targetThread;
      cs.targetThreadId = targetThread;
      const route = store.routeKey(chatId, targetThread);
      const previous = sessionsByThread.get(route);
      if (previous && previous.sessionId !== cs.sessionId) await retireSession(chatId, previous);
      for (const [key, existing] of sessionsByThread) {
        if (key !== route && existing.sessionId === cs.sessionId) sessionsByThread.delete(key);
      }
      for (const [sid, tid] of threadBySession) if (tid === targetThread && sid !== cs.sessionId && (store.chatBySession.get(sid) ?? chatId) === chatId) threadBySession.delete(sid);
      sessionsByThread.set(route, cs);
      threadBySession.set(cs.sessionId, targetThread);
      saveThreads();
    } else {
      for (const [key, existing] of sessionsByThread) if (existing.sessionId === cs.sessionId) sessionsByThread.delete(key);
      const prev = sessionsByChat.get(chatId);
      if (prev && prev.sessionId !== cs.sessionId) await retireSession(chatId, prev);
      sessionsByChat.set(chatId, cs);
    }
  }

  async function syncTitle(chatId: number, cs: ChatSession, title: string, threadId?: number): Promise<number | undefined> {
    let targetThread = cs.targetThreadId ?? cs.threadId;
    if (targetThread === undefined) return targetThread;
    if (cs.topicTitle === title) return targetThread;
    try {
      await tg.editForumTopic(chatId, targetThread, title);
      cs.topicTitle = title;
      store.rememberTopicTitle(cs.sessionId, title);
    } catch {
      if (threadId === undefined) {
        try {
          const topic = await tg.createForumTopic(chatId, title);
          const oldTarget = targetThread;
          if (oldTarget !== undefined) sessionsByThread.delete(store.routeKey(chatId, oldTarget));
          threadBySession.delete(cs.sessionId);
          const newTarget = topic.message_thread_id;
          if (oldTarget !== undefined) activeSessionByRoute.delete(routeKey(chatId, oldTarget));
          cs.threadId = newTarget;
          cs.targetThreadId = newTarget;
          sessionsByThread.set(store.routeKey(chatId, newTarget), cs);
          threadBySession.set(cs.sessionId, newTarget);
          saveThreads();
          targetThread = newTarget;
        } catch {
          // keep the previous binding
        }
      }
    }
    return targetThread;
  }

  async function activateSession(chatId: number, sessionId: string, silent = true, threadId?: number): Promise<ChatSession | undefined> {
    const session = await oc.client.session.get({ sessionID: sessionId });
    const s = session as { location?: { directory?: string }; directory?: string; model?: { id: string; providerID: string; variant?: string }; title?: string };
    const directory = s?.location?.directory ?? s?.directory;
    const model = s?.model ? { id: s.model.id, providerID: s.model.providerID, variant: s.model.variant } : undefined;
    const title = (s.title || sessionId).slice(0, 120);

    // Reuse the existing in-memory object when possible so tool details and
    // status state survive session restoration/switching.
    const existing = sessionsById.get(sessionId);
    const cs: ChatSession = existing ?? { sessionId, directory, model, draftId: 0, buffer: "", reasoningBuffer: "", toolCalls: [], toolCallDetails: [], stopped: false, targetChatId: chatId, cotBuffer: "", cotCount: 0, topicTitle: store.topicTitleBySession.get(sessionId) };
    cs.sessionId = sessionId;
    cs.directory = directory;
    cs.model = model;
    cs.stopped = false;
    cs.targetChatId = chatId;
    store.rememberSessionChat(sessionId, chatId);
    store.rememberLastChat(sessionId, chatId);
    cs.buffer = "";
    cs.reasoningBuffer = "";
    cs.toolCalls = [];
    cs.toolCallDetails = [];
    cs.draftId = 0;
    cs.topicTitle = cs.topicTitle ?? store.topicTitleBySession.get(sessionId);
    if (!cs.cotBuffer) cs.cotBuffer = "";
    if (!cs.cotCount) cs.cotCount = 0;
    cs.topicTitle = store.topicTitleBySession.get(sessionId);

    // If this session was already tracked, retire its old status message so it
    // doesn't keep a stale Stop button when the session moves to another tab.
    const stale = sessionsById.get(sessionId);
    if (stale && stale !== cs) {
      if (stale.statusTimer) {
        clearInterval(stale.statusTimer);
        stale.statusTimer = undefined;
      }
      await finishStatus(chatId, stale).catch(() => {});
    }

    let targetThread = await resolveThread(chatId, sessionId, threadId, topicsEnabled, title);

    await bindTab(chatId, cs, targetThread);

    if (targetThread !== undefined) {
      const newThread = await syncTitle(chatId, cs, title, threadId);
      if (newThread !== undefined) targetThread = newThread;
    }

    sessionsById.set(sessionId, cs);
    rememberSessionChat(sessionId, chatId);
    rememberActiveRoute(chatId, targetThread, sessionId);
    if (!silent) {
      const lastPrompt = store.lastPromptBySession.get(sessionId);
      const cot = store.getCotBuffer(sessionId);
      let text = `${projectEmoji(directory)} <b>Active session</b>\n<code>${esc(sessionId)}</code>\n${esc(title)}\nmodel: ${esc(model ? model.providerID + "/" + model.id : "default")}\ndir: <code>${esc(directory ?? "n/a")}</code>`;
      if (lastPrompt) text += `\n\n<b>Último prompt:</b> ${esc(clampText(lastPrompt, 200))}`;
      if (cot) text += `\n<b>COT:</b> ${esc(clampText(cot, 200))}`;
      await tg.sendRichMessage(chatId, text, threadOpts(targetThread)).catch(() => {});
    }
    return cs;
  }

  // Rebind the session that this exact tab had before a restart. Never creates.
  const restoreActiveSession = async (chatId: number, threadId?: number): Promise<ChatSession | undefined> => {
    const existing = getActiveSession(chatId, threadId);
    if (existing) return existing;

    // Restore the persisted binding for this exact tab.
    const mapped = activeSessionByRoute.get(routeKey(chatId, threadId));
    if (mapped) {
      try {
        await activateSession(chatId, mapped, true, threadId);
        return getActiveSession(chatId, threadId);
      } catch (err) {
        // Keep the persisted binding on transient failures so a restart
        // does not silently unlink the session; the next interaction retries.
        console.error("[session] restore failed (keeping binding)", mapped, err);
        logger.breadcrumb("sessions", "restore.failed", { sessionId: mapped });
        return getActiveSession(chatId, threadId);
      }
    }

    // One-time migration for installs that predate active.json: threads.json
    // already records which session belongs to each topic.
    if (threadId !== undefined) {
      const candidates = [...threadBySession.entries()]
        .filter(([sid, tid]) => tid === threadId && (store.chatBySession.get(sid) ?? chatId) === chatId)
        .map(([sid]) => sid);
      for (const sid of candidates) {
        try {
          await activateSession(chatId, sid, true, threadId);
          return getActiveSession(chatId, threadId);
        } catch {
          // try the next candidate
        }
      }
    }

    return undefined;
  };

  // Used only when a prompt needs a session: reuse the tab binding or create a
  // dedicated session. Commands use restoreActiveSession so they never spawn
  // sessions as a side effect.
  const ensureActiveSession = async (chatId: number, threadId?: number): Promise<ChatSession | undefined> => {
    const restored = await restoreActiveSession(chatId, threadId);
    if (restored) return restored;
    // In groups, do not silently spawn sessions on replies; require an
    // explicit activation to avoid cross-project surprises.
    if (chatId < 0) return undefined;
    await createNewSession(chatId, true, threadId);
    return getActiveSession(chatId, threadId);
  };

  // OpenCode renames sessions automatically (e.g. after the first prompt).
  // Mirror that title into the Telegram tab so both always match.
  const syncTopicTitle = async (chatId: number, s: ChatSession) => {
    const threadId = s.targetThreadId ?? s.threadId ?? store.threadBySession.get(s.sessionId);
    if (!threadId) { logger.breadcrumb("sessions", "syncTopicTitle.skip", { sessionId: s.sessionId, reason: "no-thread" }); return; }
    s.threadId = threadId;
    s.targetThreadId = threadId;
    try {
      const res = await oc.client.session.get({ sessionID: s.sessionId });
      const title = String((res as { title?: string })?.title ?? "").trim().slice(0, 120);
      if (!title || title === s.topicTitle) { logger.breadcrumb("sessions", "syncTopicTitle.skip", { sessionId: s.sessionId, reason: "same-or-empty" }); return; }
      const targetChat = s.targetChatId ?? chatId;
      await tg.editForumTopic(targetChat, threadId, title);
      s.topicTitle = title;
      store.rememberTopicTitle(s.sessionId, title);
      logger.breadcrumb("sessions", "syncTopicTitle.done", { sessionId: s.sessionId, threadId, title });
    } catch {
      // Cosmetic only: never fail a turn because a topic title could not be updated.
    }
  };

  const cleanupStaleSessions = async (maxAgeDays = 30): Promise<void> => {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    try {
      const res = await oc.client.session.list({ limit: 500, order: "desc" });
      const list = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as Array<{ id?: string; time?: { updated?: number } }>;
      for (const s of list) {
        const id = s?.id;
        const updated = s?.time?.updated ?? 0;
        if (id && updated && updated < cutoff) {
          try { await oc.archiveSession(id, true); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.error("[cleanup] stale sessions failed", err);
    }
  };
  return { createNewSession, activateSession, retireSession, restoreActiveSession, ensureActiveSession, syncTopicTitle, cleanupStaleSessions, resolveThread, bindTab, syncTitle };
}
