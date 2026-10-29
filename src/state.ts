import type { ChatSession } from "./types.js";

export type BotState = {
  sessionsByChat: Map<number, ChatSession>;
  sessionsByThread: Map<number, ChatSession>;
  lastChatBySession: Map<string, number>;
  threadBySession: Map<string, number>;
  forumChats: Set<number>;
  pendingPermissions: Map<string, { chatId: number; sessionId: string; messageId?: number; decided: boolean; label: string; resource: string }>;
  awaitingReason: Map<number, string>;
  modelListByChat: Map<number, any[]>;
  pendingModelByChat: Map<number, any>;
  sessionListByChat: Map<number, string[]>;
  commandListByChat: Map<number, string[]>;
  activeSessionMap: Map<number, string>;
  lastActiveChatId?: number;
  modelCache: { time: number; data: any[] } | null;
};

export function createState(): BotState {
  return {
    sessionsByChat: new Map(),
    sessionsByThread: new Map(),
    lastChatBySession: new Map(),
    threadBySession: new Map(),
    forumChats: new Set(),
    pendingPermissions: new Map(),
    awaitingReason: new Map(),
    modelListByChat: new Map(),
    pendingModelByChat: new Map(),
    sessionListByChat: new Map(),
    commandListByChat: new Map(),
    activeSessionMap: new Map(),
    lastActiveChatId: undefined,
    modelCache: null,
  };
}

export function findSessionById(state: BotState, sessionId: string): ChatSession | undefined {
  for (const s of state.sessionsByChat.values()) if (s.sessionId === sessionId) return s;
  return undefined;
}

export function findChatBySession(state: BotState, sessionId: string): number | undefined {
  for (const [cid, s] of state.sessionsByChat) if (s.sessionId === sessionId) return cid;
  return undefined;
}

export function getActiveSession(state: BotState, chatId: number, threadId?: number): ChatSession | undefined {
  if (threadId) {
    const byThread = state.sessionsByThread.get(threadId);
    if (byThread) return byThread;
    for (const s of state.sessionsByChat.values()) if (s.threadId === threadId) return s;
  }
  return state.sessionsByChat.get(chatId);
}
