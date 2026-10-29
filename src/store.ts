import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatSession } from "./types.js";

export const routeKey = (chatId: number, threadId?: number): string => `${chatId}:${threadId ?? 0}`;

/**
 * In-memory routing tables plus their JSON persistence.
 *
 * Invariants:
 * - A topic (thread) belongs to exactly one session.
 * - A route (chat + topic) belongs to exactly one session.
 * - A session belongs to at most one route.
 */
export class SessionStore {
  readonly sessionsByChat = new Map<number, ChatSession>();
  readonly sessionsByThread = new Map<number, ChatSession>();
  readonly sessionsById = new Map<string, ChatSession>();
  readonly lastChatBySession = new Map<string, number>();
  readonly lastPromptBySession = new Map<string, string>();
  readonly activeSessionByRoute = new Map<string, string>();
  readonly threadBySession = new Map<string, number>();
  readonly chatBySession = new Map<string, number>();
  readonly messageToSession = new Map<number, string>();
  readonly topicTitleBySession = new Map<string, string>();

  readonly dataDir: string;
  private readonly threadsFile: string;
  private readonly chatsFile: string;
  private readonly activeFile: string;
  private readonly messagesFile: string;
  private readonly topicTitlesFile: string;

  constructor(dataDir = join(process.cwd(), "data")) {
    this.dataDir = dataDir;
    this.threadsFile = join(dataDir, "threads.json");
    this.chatsFile = join(dataDir, "chats.json");
    this.activeFile = join(dataDir, "active.json");
    this.messagesFile = join(dataDir, "messages.json");
    this.topicTitlesFile = join(dataDir, "topicTitles.json");
    this.load();
  }

  routeKey = routeKey;

  findSessionById = (sessionId: string): ChatSession | undefined => {
    const indexed = this.sessionsById.get(sessionId);
    if (indexed) return indexed;
    for (const s of this.sessionsByThread.values()) if (s.sessionId === sessionId) return s;
    for (const s of this.sessionsByChat.values()) if (s.sessionId === sessionId) return s;
    return undefined;
  };

  resolveChatId = (sessionId: string | undefined): number | undefined => {
    if (!sessionId) return undefined;
    const s = this.findSessionById(sessionId);
    if (s?.targetChatId !== undefined) return s.targetChatId;
    return this.chatBySession.get(sessionId) ?? this.lastChatBySession.get(sessionId);
  };

  resolveThreadId = (sessionId: string | undefined): number | undefined => {
    if (!sessionId) return undefined;
    const s = this.findSessionById(sessionId);
    if (s?.targetThreadId !== undefined) return s.targetThreadId;
    if (s?.threadId !== undefined) return s.threadId;
    return this.threadBySession.get(sessionId);
  };

  threadOptsFor = (s: ChatSession | undefined): Record<string, unknown> => {
    const tid = s?.targetThreadId ?? s?.threadId;
    return tid ? { message_thread_id: tid } : {};
  };

  getActiveSession = (chatId: number, threadId?: number): ChatSession | undefined => {
    // A topic must never fall back to another tab's session.
    if (threadId !== undefined) return this.sessionsByThread.get(threadId);
    return this.sessionsByChat.get(chatId);
  };

  rememberSessionChat = (sessionId: string, chatId: number) => {
    this.chatBySession.set(sessionId, chatId);
    this.saveChats();
  };

  rememberActiveRoute = (chatId: number, threadId: number | undefined, sessionId: string) => {
    const key = this.routeKey(chatId, threadId);
    const previous = this.activeSessionByRoute.get(key);
    if (previous && previous !== sessionId) {
      const stillUsed = [...this.activeSessionByRoute.entries()].some(([k, v]) => v === previous && k !== key);
      if (!stillUsed) this.forgetSession(previous);
    }
    // One session can only live in one tab at a time.
    for (const [k, v] of this.activeSessionByRoute) if (v === sessionId && k !== key) this.activeSessionByRoute.delete(k);
    this.activeSessionByRoute.set(key, sessionId);
    this.saveActiveSessions();
  };

  rememberMessageSession = (messageId: number, sessionId: string) => {
    this.messageToSession.set(messageId, sessionId);
    this.saveMessages();
  };

  forgetSession = (sessionId: string) => {
    this.sessionsById.delete(sessionId);
    for (const [cid, cs] of this.sessionsByChat) if (cs.sessionId === sessionId) this.sessionsByChat.delete(cid);
    for (const [tid, cs] of this.sessionsByThread) if (cs.sessionId === sessionId) this.sessionsByThread.delete(tid);
    for (const [k, v] of this.activeSessionByRoute) if (v === sessionId) this.activeSessionByRoute.delete(k);
    this.threadBySession.delete(sessionId);
    this.chatBySession.delete(sessionId);
    this.lastChatBySession.delete(sessionId);
    this.lastPromptBySession.delete(sessionId);
    for (const [mid, sid] of this.messageToSession) if (sid === sessionId) this.messageToSession.delete(mid);
    this.saveThreads();
    this.saveChats();
    this.saveActiveSessions();
    this.saveMessages();
  };

  saveThreads = () => {
    this.saveNumberMap(this.threadsFile, this.threadBySession, "[threads]");
  };

  saveChats = () => {
    this.saveNumberMap(this.chatsFile, this.chatBySession, "[chats]");
  };

  saveActiveSessions = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, { sessionId: string; updated: number }> = {};
      for (const [k, v] of this.activeSessionByRoute) obj[k] = { sessionId: v, updated: Date.now() };
      writeFileSync(this.activeFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[active] save failed", err);
    }
  };

  saveMessages = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, string> = {};
      for (const [mid, sid] of this.messageToSession) obj[String(mid)] = sid;
      writeFileSync(this.messagesFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[messages] save failed", err);
    }
  };

  private saveNumberMap(file: string, map: Map<string, number>, tag: string) {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, number> = {};
      for (const [k, v] of map) obj[k] = v;
      writeFileSync(file, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error(`${tag} save failed`, err);
    }
  }

  private load() {
    try {
      if (existsSync(this.threadsFile)) {
        const parsed = JSON.parse(readFileSync(this.threadsFile, "utf8")) as Record<string, number>;
        for (const [k, v] of Object.entries(parsed)) this.threadBySession.set(k, v);
      }
    } catch (err) {
      console.error("[threads] load failed", err);
    }
    try {
      if (existsSync(this.chatsFile)) {
        const parsed = JSON.parse(readFileSync(this.chatsFile, "utf8")) as Record<string, number>;
        for (const [k, v] of Object.entries(parsed)) this.chatBySession.set(k, v);
      }
    } catch (err) {
      console.error("[chats] load failed", err);
    }
    try {
      if (existsSync(this.messagesFile)) {
        const parsed = JSON.parse(readFileSync(this.messagesFile, "utf8")) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) {
          const messageId = Number(k);
          if (Number.isFinite(messageId) && v) this.messageToSession.set(messageId, v);
        }
      }
    } catch (err) {
      console.error("[messages] load failed", err);
    }

    // Explicit tab bindings.
    try {
      if (existsSync(this.activeFile)) {
        const parsed = JSON.parse(readFileSync(this.activeFile, "utf8")) as Record<string, string | { sessionId?: string }>;
        for (const [key, value] of Object.entries(parsed)) {
          const entry = typeof value === "string" ? { sessionId: value } : value;
          if (!entry?.sessionId) continue;
          const [chatPart, threadPart] = key.split(":");
          const chatId = Number(chatPart);
          const threadId = Number(threadPart) || undefined;
          if (!Number.isFinite(chatId) || chatId === 0) continue;
          this.activeSessionByRoute.set(this.routeKey(chatId, threadId), entry.sessionId);
          if (threadId) this.threadBySession.set(entry.sessionId, threadId);
          this.chatBySession.set(entry.sessionId, chatId);
        }
      }
    } catch (err) {
      console.error("[active] load failed", err);
    }

    // Migration for installs created before active.json existed: threads.json
    // already records which session belongs to each topic, so reuse it.
    for (const [sessionId, threadId] of this.threadBySession) {
      const chatId = this.chatBySession.get(sessionId);
      if (chatId === undefined) continue;
      const key = this.routeKey(chatId, threadId);
      if (!this.activeSessionByRoute.has(key)) this.activeSessionByRoute.set(key, sessionId);
    }
    if (this.activeSessionByRoute.size) this.saveActiveSessions();
  }
}
