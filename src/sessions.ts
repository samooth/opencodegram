import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import { esc, threadOpts } from "./util.js";

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
      const list = (sessions as any)?.data ?? (Array.isArray(sessions) ? sessions : []);
      const latest = [...list].sort((a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))[0];
      if (latest?.model?.id && latest?.model?.providerID) model = { id: latest.model.id, providerID: latest.model.providerID, variant: latest.model.variant };
    } catch {
      // ignore
    }
    if (!model) model = await oc.defaultModel(directory);
    const session = await oc.createSession({ title: "Telegram session", directory, model, agent: "build" });
    const sessionId = (session as any)?.id ?? (session as any)?.sessionID ?? (session as any)?.data?.id;
    const title = (session as any)?.title ?? "Telegram session";
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
      // One topic = one session. Retire the session previously shown there.
      const previous = sessionsByThread.get(targetThread);
      if (previous && previous.sessionId !== sessionId) await retireSession(chatId, previous);
      for (const [tid, existing] of sessionsByThread) if (tid !== targetThread && existing.sessionId === sessionId) sessionsByThread.delete(tid);
      for (const [sid, tid] of threadBySession) if (tid === targetThread && sid !== sessionId) threadBySession.delete(sid);
      sessionsByThread.set(targetThread, cs);
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
        `<b>New session created</b>\n<code>${esc(sessionId)}</code>\nmodel: ${esc(model?.providerID ?? "")}/${esc(model?.id ?? "")}${model?.variant ? " (" + esc(model.variant) + ")" : ""}\ndir: <code>${esc(directory)}</code>`,
        threadOpts(targetThread),
      );
    }
    return cs;
  }

  async function activateSession(chatId: number, sessionId: string, silent = true, threadId?: number): Promise<ChatSession | undefined> {
    const session = await oc.client.session.get({ sessionID: sessionId });
    const s = session as any;
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

    let targetThread = threadId;
    if (targetThread === undefined && chatId > 0) {
      targetThread = threadBySession.get(sessionId);
    }
    if (targetThread === undefined && topicsEnabled && chatId > 0) {
      try {
        const topic = await tg.createForumTopic(chatId, title);
        targetThread = topic.message_thread_id;
      } catch {
        // Topic creation may fail in non-forum chats; fall back to general chat.
      }
    }

    if (targetThread !== undefined) {
      cs.threadId = targetThread;
      cs.targetThreadId = targetThread;
      // A tab always shows exactly one session. Retire whatever was there before.
      const previous = sessionsByThread.get(targetThread);
      if (previous && previous.sessionId !== sessionId) await retireSession(chatId, previous);
      // Move the session to this tab and remove duplicates from other tabs.
      for (const [tid, existing] of sessionsByThread) {
        if (tid !== targetThread && existing.sessionId === sessionId) sessionsByThread.delete(tid);
      }
      for (const [sid, tid] of threadBySession) if (tid === targetThread && sid !== sessionId) threadBySession.delete(sid);
      sessionsByThread.set(targetThread, cs);
      threadBySession.set(sessionId, targetThread);
      saveThreads();

      // Keep the tab title in sync with the OpenCode session title.
      if (cs.topicTitle !== title) {
        try {
          await tg.editForumTopic(chatId, targetThread, title);
          cs.topicTitle = title;
          store.rememberTopicTitle(sessionId, title);
        } catch {
        // Topic may have been deleted. Only recreate when we weren't explicitly
        // asked to bind to this particular tab.
        if (threadId === undefined) {
          try {
            const topic = await tg.createForumTopic(chatId, title);
            const oldTarget = targetThread;
            sessionsByThread.delete(targetThread);
            threadBySession.delete(sessionId);
            targetThread = topic.message_thread_id;
            if (oldTarget !== undefined) activeSessionByRoute.delete(routeKey(chatId, oldTarget));
            cs.threadId = targetThread;
            cs.targetThreadId = targetThread;
            sessionsByThread.set(targetThread, cs);
            threadBySession.set(sessionId, targetThread);
            saveThreads();
          } catch {
            // keep the previous binding
          }
        }
      }
      }
    } else {
      for (const [tid, existing] of sessionsByThread) if (existing.sessionId === sessionId) sessionsByThread.delete(tid);
      const prev = sessionsByChat.get(chatId);
      if (prev && prev.sessionId !== sessionId) await retireSession(chatId, prev);
      sessionsByChat.set(chatId, cs);
    }

    sessionsById.set(sessionId, cs);
    rememberSessionChat(sessionId, chatId);
    rememberActiveRoute(chatId, targetThread, sessionId);
    if (!silent) {
      const text = `<b>Active session</b>\n<code>${esc(sessionId)}</code>\n${esc(title)}\nmodel: ${esc(model ? model.providerID + "/" + model.id : "default")}\ndir: <code>${esc(directory ?? "n/a")}</code>`;
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
        console.error("[session] restore failed", mapped, err);
        forgetSession(mapped);
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
    const threadId = s.targetThreadId ?? s.threadId;
    if (!threadId) return;
    try {
      const res = await oc.client.session.get({ sessionID: s.sessionId });
      const title = String((res as any)?.title ?? "").trim().slice(0, 120);
      if (!title || title === s.topicTitle) return;
      await tg.editForumTopic(chatId, threadId, title);
      s.topicTitle = title;
      store.rememberTopicTitle(s.sessionId, title);
    } catch {
      // Cosmetic only: never fail a turn because a topic title could not be updated.
    }
  };

  return { createNewSession, activateSession, retireSession, restoreActiveSession, ensureActiveSession, syncTopicTitle };
}
