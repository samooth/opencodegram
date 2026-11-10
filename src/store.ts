import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatSession } from "./types.js";
import type { TranscriptBlock } from "./transcript.js";
import { TRANSCRIPT_MAX_BLOCKS, TRANSCRIPT_MAX_THINKING_BLOCKS, TRANSCRIPT_MAX_TOOLS_BLOCKS } from "./transcript.js";
import { esc } from "./util.js";

export const routeKey = (chatId: number, threadId?: number): string => `${chatId}:${threadId ?? 0}`;

/**
 * Delivery target of a session: the chat/topic its current turn must be
 * answered in. A session can be referenced from several chats (e.g. a group
 * topic and a private chat), so events must be routed to the place where the
 * prompt was actually sent, not to whatever chat was recorded last.
 */
export type DeliveryTarget = { chatId: number; threadId?: number };

/** Maximum number of remembered message→session mappings kept on disk. */
const MAX_MESSAGE_MAPPINGS = 4000;

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
  readonly sessionsByThread = new Map<string, ChatSession>();
  readonly sessionsById = new Map<string, ChatSession>();
  readonly lastChatBySession = new Map<string, number>();
  readonly lastPromptBySession = new Map<string, string>();
  readonly activeSessionByRoute = new Map<string, string>();
  readonly threadBySession = new Map<string, number>();
  readonly chatBySession = new Map<string, number>();
  readonly messageToSession = new Map<string, string>();
  readonly topicTitleBySession = new Map<string, string>();
  readonly cotBySession = new Map<string, { buffer: string; count: number }>();
  readonly sessionStatusBySession = new Map<string, string>();
  readonly statusMessageBySession = new Map<string, { chatId: number; threadId?: number; messageId: number }>();
  readonly pendingEditsByMessage = new Map<number, string>();

  readonly customButtonsByChat = new Map<number, Array<{ label: string; text: string }>>();
  /** Last session the user interacted with per route (for @tag / reply routing). */
  readonly lastInteractedSessionByRoute = new Map<string, { sessionId: string; at: number }>();
  /** Where each session's events must be delivered (chat + topic). */
  readonly deliveryBySession = new Map<string, DeliveryTarget>();
  /**
   * Transcript of every session: blocks of output (answers, thinking, tools).
   * Rendered as ONE paginated message per session instead of one message per
   * event, which keeps the chat readable without losing any output.
   */
  readonly transcriptBySession = new Map<string, TranscriptBlock[]>();

  readonly dataDir: string;
  private readonly threadsFile: string;
  private readonly chatsFile: string;
  private readonly activeFile: string;
  private readonly messagesFile: string;
  private readonly topicTitlesFile: string;
  private readonly cotFile: string;
  private readonly lastChatsFile: string;
  private readonly lastPromptsFile: string;
  private readonly statusMessagesFile: string;
  private readonly pendingEditsFile: string;
  private readonly buttonsFile: string;
  private readonly lastInteractedFile: string;
  private readonly deliveryFile: string;
  private readonly transcriptsFile: string;

  constructor(dataDir = join(process.cwd(), "data")) {
    this.dataDir = dataDir;
    this.threadsFile = join(dataDir, "threads.json");
    this.chatsFile = join(dataDir, "chats.json");
    this.activeFile = join(dataDir, "active.json");
    this.messagesFile = join(dataDir, "messages.json");
    this.topicTitlesFile = join(dataDir, "topicTitles.json");
    this.cotFile = join(dataDir, "cot.json");
    this.lastChatsFile = join(dataDir, "lastChats.json");
    this.lastPromptsFile = join(dataDir, "lastPrompts.json");
    this.statusMessagesFile = join(dataDir, "statusMessages.json");
    this.pendingEditsFile = join(dataDir, "pendingEdits.json");
    this.buttonsFile = join(dataDir, "buttons.json");
    this.lastInteractedFile = join(dataDir, "lastInteracted.json");
    this.deliveryFile = join(dataDir, "delivery.json");
    this.transcriptsFile = join(dataDir, "transcripts.json");
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
    // The delivery target is the most precise source: it holds the chat and
    // the topic the current turn belongs to.
    const delivery = this.deliveryBySession.get(sessionId);
    if (delivery) return delivery.chatId;
    // Prefer the persisted chat binding over the in-memory targetChatId, which
    // can be stale when a session object is reused across chats.
    const persisted = this.chatBySession.get(sessionId) ?? this.lastChatBySession.get(sessionId);
    if (persisted !== undefined) return persisted;
    const s = this.findSessionById(sessionId);
    return s?.targetChatId;
  };

  resolveThreadId = (sessionId: string | undefined): number | undefined => {
    if (!sessionId) return undefined;
    const delivery = this.deliveryBySession.get(sessionId);
    if (delivery?.threadId !== undefined) return delivery.threadId;
    const s = this.findSessionById(sessionId);
    if (s?.targetThreadId !== undefined) return s.targetThreadId;
    if (s?.threadId !== undefined) return s.threadId;
    return this.threadBySession.get(sessionId);
  };

  /** Bind a session to the chat/topic its events must be delivered to. */
  rememberDelivery = (sessionId: string, chatId: number, threadId?: number) => {
    if (!sessionId || !Number.isFinite(chatId)) return;
    const current = this.deliveryBySession.get(sessionId);
    if (current && current.chatId === chatId && current.threadId === threadId) return;
    this.deliveryBySession.set(sessionId, { chatId, threadId });
    this.saveDelivery();
  };

  forgetDelivery = (sessionId: string) => {
    if (this.deliveryBySession.delete(sessionId)) this.saveDelivery();
  };

  threadOptsFor = (s: ChatSession | undefined): Record<string, unknown> => {
    const tid = s?.targetThreadId ?? s?.threadId;
    return tid ? { message_thread_id: tid } : {};
  };

  getActiveSession = (chatId: number, threadId?: number): ChatSession | undefined => {
    // A topic must never fall back to another tab's session, and topics from
    // different chats must never collide even when their thread ids match.
    const key = this.routeKey(chatId, threadId);
    // The persisted route binding is the source of truth; resolve it to the
    // in-memory session object when it is still known.
    const bound = this.activeSessionByRoute.get(key);
    if (bound) {
      const s = this.sessionsById.get(bound);
      if (s) return s;
    }
    // Fall back to the in-memory tables (legacy installs, tests).
    if (threadId !== undefined) return this.sessionsByThread.get(key);
    return this.sessionsByChat.get(chatId);
  };

  rememberSessionChat = (sessionId: string, chatId: number) => {
    this.chatBySession.set(sessionId, chatId);
    this.saveChats();
  };

  setSessionStatus = (sessionId: string, status: string) => {
    if (sessionId) this.sessionStatusBySession.set(sessionId, status);
  };

  getSessionStatus = (sessionId: string): string | undefined => this.sessionStatusBySession.get(sessionId);

  rememberActiveRoute = (chatId: number, threadId: number | undefined, sessionId: string) => {
    const key = this.routeKey(chatId, threadId);
    // Unbind previous session from this route without forgetting it: sessions can
    // be resumed (reply-to / multi-session navigation) and may still receive events.
    // One session can only live in one tab at a time.
    for (const [k, v] of this.activeSessionByRoute) if (v === sessionId && k !== key) this.activeSessionByRoute.delete(k);
    // The previous owner of this route leaves the in-memory tables so both
    // sources of truth agree on who owns the tab.
    const previousId = this.activeSessionByRoute.get(key);
    if (previousId && previousId !== sessionId) {
      if (this.sessionsByThread.get(key)?.sessionId === previousId) this.sessionsByThread.delete(key);
      if (this.sessionsByChat.get(chatId)?.sessionId === previousId) this.sessionsByChat.delete(chatId);
    }
    this.activeSessionByRoute.set(key, sessionId);
    // The session owns exactly this route now: drop it from the other tables.
    for (const [k, cs] of this.sessionsByThread) if (cs.sessionId === sessionId && k !== key) this.sessionsByThread.delete(k);
    if (threadId === undefined) {
      for (const [cid, cs] of this.sessionsByChat) if (cs.sessionId === sessionId && cid !== chatId) this.sessionsByChat.delete(cid);
    } else {
      // A session bound to a topic no longer owns the main chat of that chat.
      for (const [cid, cs] of this.sessionsByChat) if (cs.sessionId === sessionId) this.sessionsByChat.delete(cid);
    }
    this.saveActiveSessions();
  };

  rememberMessageSession = (chatId: number, messageId: number, sessionId: string) => {
    const key = `${chatId}:${messageId}`;
    // Refresh insertion order so the oldest mapping can be pruned later.
    this.messageToSession.delete(key);
    this.messageToSession.set(key, sessionId);
    // Keep the map bounded: it is persisted on every write, so an unbounded
    // map makes every message a full-file rewrite.
    while (this.messageToSession.size > MAX_MESSAGE_MAPPINGS) {
      const oldest = this.messageToSession.keys().next();
      if (oldest.done) break;
      this.messageToSession.delete(oldest.value);
    }
    this.saveMessages();
  };

  rememberStatusMessage = (sessionId: string, chatId: number, threadId: number | undefined, messageId: number) => {
    this.statusMessageBySession.set(sessionId, { chatId, threadId, messageId });
    this.saveStatusMessages();
  };

  /** Session that owns a given status card message (for Stop/Detach buttons). */
  findSessionByStatusMessage = (chatId: number, messageId: number): string | undefined => {
    for (const [sid, info] of this.statusMessageBySession) {
      if (info.chatId === chatId && info.messageId === messageId) return sid;
    }
    return undefined;
  };

  forgetStatusMessage = (sessionId: string) => {
    this.statusMessageBySession.delete(sessionId);
    this.saveStatusMessages();
  };

  saveStatusMessages = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, { chatId: number; threadId?: number; messageId: number }> = {};
      for (const [sid, info] of this.statusMessageBySession) obj[sid] = info;
      writeFileSync(this.statusMessagesFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[statusMessages] save failed", err);
    }
  };

  cleanupStaleStatusMessages = async (tg: { editRichMessage: (chatId: number, messageId: number, html: string, opts?: Record<string, unknown>) => Promise<unknown>; sendRichMessage: (chatId: number, html: string, opts?: Record<string, unknown>) => Promise<{ message_id?: number }> }) => {
    const entries = [...this.statusMessageBySession.entries()];
    for (const [sessionId, info] of entries) {
      try {
        await tg.editRichMessage(info.chatId, info.messageId, "⏹ <b>Interrupted by restart</b>", {
          ...(info.threadId ? { message_thread_id: info.threadId } : {}),
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        // ignore
      }
      // On restart, update the stale status message with the current session
      // and its last activity instead of offering a retry prompt.
      const lastPrompt = this.lastPromptBySession.get(sessionId);
      const activity = lastPrompt ? `\n<b>Última actividad:</b> ${esc(lastPrompt.slice(0, 200))}` : "";
      try {
        await tg.editRichMessage(info.chatId, info.messageId, `🔄 <b>Reiniciado</b>\nSesión en curso: <code>${esc(sessionId)}</code>${activity}\nContinúa con tu próximo mensaje.`, {
          ...(info.threadId ? { message_thread_id: info.threadId } : {}),
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        // ignore
      }
      this.statusMessageBySession.delete(sessionId);
    }
    this.saveStatusMessages();
  };

  rememberTopicTitle = (sessionId: string, title: string) => {
    this.topicTitleBySession.set(sessionId, title);
    this.saveTopicTitles();
  };

  rememberCot = (sessionId: string, buffer: string, count: number) => {
    this.cotBySession.set(sessionId, { buffer, count });
    this.saveCot();
  };

  getCotBuffer = (sessionId: string): string | undefined => this.cotBySession.get(sessionId)?.buffer;
  getCotCount = (sessionId: string): number | undefined => this.cotBySession.get(sessionId)?.count;

  rememberLastChat = (sessionId: string, chatId: number) => {
    this.lastChatBySession.set(sessionId, chatId);
    this.saveLastChats();
  };

  rememberLastPrompt = (sessionId: string, prompt: string) => {
    this.lastPromptBySession.set(sessionId, prompt);
    this.saveLastPrompts();
  };

  rememberLastInteracted = (chatId: number, threadId: number | undefined, sessionId: string) => {
    const key = this.routeKey(chatId, threadId);
    const current = this.lastInteractedSessionByRoute.get(key);
    if (current?.sessionId === sessionId) return;
    this.lastInteractedSessionByRoute.set(key, { sessionId, at: Date.now() });
    this.saveLastInteracted();
  };

  getLastInteractedSession = (chatId: number, threadId?: number): string | undefined => {
    if (threadId !== undefined) {
      return this.lastInteractedSessionByRoute.get(this.routeKey(chatId, threadId))?.sessionId;
    }
    // Route-specific first, then most recent across any route of this chat.
    const direct = this.lastInteractedSessionByRoute.get(this.routeKey(chatId, undefined))?.sessionId;
    if (direct) return direct;
    let best: { sessionId: string; at: number } | undefined;
    const prefix = `${chatId}:`;
    for (const [key, value] of this.lastInteractedSessionByRoute) {
      if (!key.startsWith(prefix)) continue;
      if (!best || value.at > best.at) best = value;
    }
    return best?.sessionId;
  };

  getCustomButtons = (chatId: number): Array<{ label: string; text: string }> => {
    return this.customButtonsByChat.get(chatId) ?? [];
  };

  setCustomButtons = (chatId: number, buttons: Array<{ label: string; text: string }>) => {
    this.customButtonsByChat.set(chatId, buttons);
    this.saveButtons();
  };

  addCustomButton = (chatId: number, label: string, text: string) => {
    const list = this.customButtonsByChat.get(chatId) ?? [];
    list.push({ label, text });
    this.customButtonsByChat.set(chatId, list);
    this.saveButtons();
  };

  removeCustomButton = (chatId: number, index: number) => {
    const list = this.customButtonsByChat.get(chatId);
    if (!list || index < 0 || index >= list.length) return false;
    list.splice(index, 1);
    this.customButtonsByChat.set(chatId, list);
    this.saveButtons();
    return true;
  };

  rememberPendingEdits = (messageId: number, sessionId: string) => {
    this.pendingEditsByMessage.set(messageId, sessionId);
    this.savePendingEdits();
  };

  getPendingEditsSession = (messageId: number): string | undefined => {
    return this.pendingEditsByMessage.get(messageId);
  };

  forgetPendingEdits = (messageId: number) => {
    this.pendingEditsByMessage.delete(messageId);
    this.savePendingEdits();
  };

  saveButtons = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, Array<{ label: string; text: string }>> = {};
      for (const [chatId, buttons] of this.customButtonsByChat) obj[String(chatId)] = buttons;
      writeFileSync(this.buttonsFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[buttons] save failed", err);
    }
  };

  savePendingEdits = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, string> = {};
      for (const [mid, sid] of this.pendingEditsByMessage) obj[String(mid)] = sid;
      writeFileSync(this.pendingEditsFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[pendingEdits] save failed", err);
    }
  };

  forgetSession = (sessionId: string) => {
    this.sessionsById.delete(sessionId);
    for (const [cid, cs] of this.sessionsByChat) if (cs.sessionId === sessionId) this.sessionsByChat.delete(cid);
    for (const [key, cs] of this.sessionsByThread) if (cs.sessionId === sessionId) this.sessionsByThread.delete(key);
    for (const [k, v] of this.activeSessionByRoute) if (v === sessionId) this.activeSessionByRoute.delete(k);
    for (const [k, v] of this.lastInteractedSessionByRoute) if (v.sessionId === sessionId) this.lastInteractedSessionByRoute.delete(k);
    this.threadBySession.delete(sessionId);
    this.chatBySession.delete(sessionId);
    this.lastChatBySession.delete(sessionId);
    this.lastPromptBySession.delete(sessionId);
    for (const [mid, sid] of this.messageToSession) if (sid === sessionId) this.messageToSession.delete(mid);
    for (const [mid, sid] of this.pendingEditsByMessage) if (sid === sessionId) this.pendingEditsByMessage.delete(mid);
    this.statusMessageBySession.delete(sessionId);
    this.topicTitleBySession.delete(sessionId);
    this.cotBySession.delete(sessionId);
    this.deliveryBySession.delete(sessionId);
    this.transcriptBySession.delete(sessionId);
    this.saveThreads();
    this.saveChats();
    this.saveActiveSessions();
    this.saveMessages();
    this.saveStatusMessages();
    this.saveTopicTitles();
    this.saveCot();
    this.saveLastChats();
    this.saveLastPrompts();
    this.savePendingEdits();
    this.saveLastInteracted();
    this.saveDelivery();
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
      for (const [mid, sid] of this.messageToSession) obj[mid] = sid;
      writeFileSync(this.messagesFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[messages] save failed", err);
    }
  };

  saveTopicTitles = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, string> = {};
      for (const [sid, title] of this.topicTitleBySession) obj[sid] = title;
      writeFileSync(this.topicTitlesFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[topicTitles] save failed", err);
    }
  };

  saveCot = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, { buffer: string; count: number }> = {};
      for (const [sid, value] of this.cotBySession) obj[sid] = value;
      writeFileSync(this.cotFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[cot] save failed", err);
    }
  };

  saveLastChats = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, number> = {};
      for (const [sid, chatId] of this.lastChatBySession) obj[sid] = chatId;
      writeFileSync(this.lastChatsFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[lastChats] save failed", err);
    }
  };

  saveLastPrompts = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, string> = {};
      for (const [sid, prompt] of this.lastPromptBySession) obj[sid] = prompt;
      writeFileSync(this.lastPromptsFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[lastPrompts] save failed", err);
    }
  };

  saveLastInteracted = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, { sessionId: string; at: number }> = {};
      for (const [k, v] of this.lastInteractedSessionByRoute) obj[k] = v;
      writeFileSync(this.lastInteractedFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[lastInteracted] save failed", err);
    }
  };

  saveDelivery = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, DeliveryTarget> = {};
      for (const [sid, target] of this.deliveryBySession) obj[sid] = target;
      writeFileSync(this.deliveryFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[delivery] save failed", err);
    }
  };

  // ---------- transcripts ----------

  getTranscript = (sessionId: string): TranscriptBlock[] => this.transcriptBySession.get(sessionId) ?? [];

  /**
   * Apply the per-kind and total limits to a block list.
   * Used both when appending and when loading from disk.
   */
  private limitTranscript = (list: TranscriptBlock[]): TranscriptBlock[] => {
    const out = list.slice(-TRANSCRIPT_MAX_BLOCKS);
    for (const kind of ["thinking", "tools"] as const) {
      const limit = kind === "thinking" ? TRANSCRIPT_MAX_THINKING_BLOCKS : TRANSCRIPT_MAX_TOOLS_BLOCKS;
      let seen = 0;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].kind !== kind) continue;
        seen++;
        if (seen > limit) out.splice(i, 1);
      }
    }
    return out;
  };

  appendTranscript = (sessionId: string, block: TranscriptBlock): void => {
    const list = this.transcriptBySession.get(sessionId) ?? [];
    // Skip an exact repeat of the last block: the same event can be delivered
    // twice and it must not flood the transcript.
    const last = list[list.length - 1];
    if (last && last.kind === block.kind && last.text === block.text && last.text.trim()) {
      // Replace it so the newer timestamp wins without duplicating content.
      list[list.length - 1] = block;
      this.transcriptBySession.set(sessionId, list);
      this.scheduleSaveTranscripts();
      return;
    }
    list.push(block);
    // The model/speed line is a single block: replace the previous one instead
    // of stacking a copy per step.
    if (block.kind === "meta") {
      for (let i = list.length - 2; i >= 0; i--) {
        if (list[i].kind === "meta") {
          list.splice(i, 1);
          break;
        }
      }
    }
    // Bound the memory and disk usage per session. Answers are the valuable
    // part and are kept in full; thinking and tools are only useful for the
    // recent turns, so they are capped separately.
    this.transcriptBySession.set(sessionId, this.limitTranscript(list));
    this.scheduleSaveTranscripts();
  };

  clearTranscript = (sessionId: string): void => {
    if (this.transcriptBySession.delete(sessionId)) this.saveTranscripts();
  };

  saveTranscripts = () => {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, TranscriptBlock[]> = {};
      for (const [sid, blocks] of this.transcriptBySession) obj[sid] = blocks;
      writeFileSync(this.transcriptsFile, JSON.stringify(obj));
    } catch (err) {
      console.error("[transcripts] save failed", err);
    }
  };

  /**
   * Debounced transcript persistence: a turn can add many blocks and the file
   * is rewritten for each one, which blocks the event loop.
   */
  private transcriptsSaveTimer: ReturnType<typeof setTimeout> | undefined;

  scheduleSaveTranscripts = (delayMs = 2000) => {
    if (this.transcriptsSaveTimer) return;
    this.transcriptsSaveTimer = setTimeout(() => {
      this.transcriptsSaveTimer = undefined;
      this.saveTranscripts();
    }, delayMs);
    // Do not keep the process alive just for the pending save.
    this.transcriptsSaveTimer.unref?.();
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
      if (existsSync(this.statusMessagesFile)) {
        const parsed = JSON.parse(readFileSync(this.statusMessagesFile, "utf8")) as Record<string, { chatId?: number; threadId?: number; messageId?: number }>;
        for (const [sid, info] of Object.entries(parsed)) {
          if (sid && info && typeof info.chatId === "number" && typeof info.messageId === "number") {
            this.statusMessageBySession.set(sid, { chatId: info.chatId, threadId: info.threadId, messageId: info.messageId });
          }
        }
      }
    } catch (err) {
      console.error("[statusMessages] load failed", err);
    }
    try {
      if (existsSync(this.messagesFile)) {
        const parsed = JSON.parse(readFileSync(this.messagesFile, "utf8")) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) {
          if (k && v) this.messageToSession.set(k, v);
        }
      }
    } catch (err) {
      console.error("[messages] load failed", err);
    }
    try {
      if (existsSync(this.topicTitlesFile)) {
        const parsed = JSON.parse(readFileSync(this.topicTitlesFile, "utf8")) as Record<string, string>;
        for (const [sid, title] of Object.entries(parsed)) {
          if (sid && title) this.topicTitleBySession.set(sid, title);
        }
      }
    } catch (err) {
      console.error("[topicTitles] load failed", err);
    }
    try {
      if (existsSync(this.cotFile)) {
        const parsed = JSON.parse(readFileSync(this.cotFile, "utf8")) as Record<string, { buffer?: string; count?: number }>;
        for (const [sid, value] of Object.entries(parsed)) {
          if (sid && value) this.cotBySession.set(sid, { buffer: value.buffer ?? "", count: value.count ?? 0 });
        }
      }
    } catch (err) {
      console.error("[cot] load failed", err);
    }
    try {
      if (existsSync(this.lastChatsFile)) {
        const parsed = JSON.parse(readFileSync(this.lastChatsFile, "utf8")) as Record<string, number>;
        for (const [sid, chatId] of Object.entries(parsed)) {
          if (sid && Number.isFinite(chatId)) this.lastChatBySession.set(sid, chatId);
        }
      }
    } catch (err) {
      console.error("[lastChats] load failed", err);
    }
    try {
      if (existsSync(this.lastPromptsFile)) {
        const parsed = JSON.parse(readFileSync(this.lastPromptsFile, "utf8")) as Record<string, string>;
        for (const [sid, prompt] of Object.entries(parsed)) {
          if (sid && prompt) this.lastPromptBySession.set(sid, prompt);
        }
      }
    } catch (err) {
      console.error("[lastPrompts] load failed", err);
    }
    try {
      if (existsSync(this.lastInteractedFile)) {
        const parsed = JSON.parse(readFileSync(this.lastInteractedFile, "utf8")) as Record<string, { sessionId?: string; at?: number }>;
        for (const [key, value] of Object.entries(parsed)) {
          if (key && value?.sessionId && Number.isFinite(value.at)) {
            this.lastInteractedSessionByRoute.set(key, { sessionId: value.sessionId, at: Number(value.at) });
          }
        }
      }
    } catch (err) {
      console.error("[lastInteracted] load failed", err);
    }
    try {
      if (existsSync(this.deliveryFile)) {
        const parsed = JSON.parse(readFileSync(this.deliveryFile, "utf8")) as Record<string, { chatId?: number; threadId?: number }>;
        for (const [sid, value] of Object.entries(parsed)) {
          if (sid && value && Number.isFinite(value.chatId)) {
            this.deliveryBySession.set(sid, { chatId: Number(value.chatId), threadId: Number.isFinite(value.threadId) ? Number(value.threadId) : undefined });
          }
        }
      }
    } catch (err) {
      console.error("[delivery] load failed", err);
    }
    try {
      if (existsSync(this.transcriptsFile)) {
        const parsed = JSON.parse(readFileSync(this.transcriptsFile, "utf8")) as Record<string, TranscriptBlock[]>;
        for (const [sid, blocks] of Object.entries(parsed)) {
          if (sid && Array.isArray(blocks)) this.transcriptBySession.set(sid, this.limitTranscript(blocks));
        }
      }
    } catch (err) {
      console.error("[transcripts] load failed", err);
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
    // Load custom reply buttons.
    try {
      if (existsSync(this.buttonsFile)) {
        const parsed = JSON.parse(readFileSync(this.buttonsFile, "utf8")) as Record<string, Array<{ label: string; text: string }>>;
        for (const [chatId, buttons] of Object.entries(parsed)) {
          const id = Number(chatId);
          if (Number.isFinite(id) && Array.isArray(buttons)) {
            this.customButtonsByChat.set(id, buttons.filter((b) => b && typeof b.label === "string" && typeof b.text === "string"));
          }
        }
      }
    } catch (err) {
      console.error("[buttons] load failed", err);
    }

    // Load persisted pending-edits mapping (messageId -> sessionId).
    try {
      if (existsSync(this.pendingEditsFile)) {
        const parsed = JSON.parse(readFileSync(this.pendingEditsFile, "utf8")) as Record<string, string>;
        for (const [mid, sid] of Object.entries(parsed)) {
          const id = Number(mid);
          if (Number.isFinite(id) && sid) this.pendingEditsByMessage.set(id, sid);
        }
      }
    } catch (err) {
      console.error("[pendingEdits] load failed", err);
    }

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
