import { RICH_MESSAGE_LIMIT, STREAM_FLUSH_MS } from "./constants.js";
import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { FormField, FormState, PermissionInfo } from "./context.js";
import type { SettingsStore } from "./settings.js";
import { renderForm, formKeyboard } from "./formui.js";
import { closeThoughts, createTurnActivity, finishTool, recordThought, recordThoughtDelta, recordTool, updateToolDetail } from "./activity.js";
import { clampText, esc, markdownToHtml, sessionHeader, threadOpts, toolIcon, truncate } from "./util.js";
import { splitBySections, splitMarkdown } from "./transcript.js";
import { logger } from "./logger.js";
import type { TodoItem } from "./todos.js";

const MAX_ARTIFACT_CANDIDATES = 20;
const MAX_ARTIFACTS = 5;
/**
 * Whether the final answer should become its own Telegram message.
 * In unified mode the card already carries it as a transcript block, so
 * "auto" must not double the messages in a busy group.
 */
export function wantsSeparateAnswer(st: {
  showFinalInCard: boolean;
  longAnswerDelivery: string;
  longAnswerThreshold: number;
  displayMode: string;
}, text: string): boolean {
  const answerInCard = st.showFinalInCard && text.length <= 2400;
  if (answerInCard) return false;
  if (st.longAnswerDelivery === "message") return true;
  return st.longAnswerDelivery === "auto"
    && st.displayMode !== "unified"
    && text.length > st.longAnswerThreshold;
}

import { formatBytes, MAX_DOCUMENT_BYTES, prepareDocument } from "./files/index.js";
import { cancelAutoRetry, classifyFailure, decideRetry, dispatchRetry, noteTurnCompleted, updateRetryPrompt } from "./autoretry.js";
import type { TranscriptManager } from "./transcriptmanager.js";
import { renderResourceBlock } from "./resources.js";
import { recordTurnStatFromSession } from "./stats.js";
import { cleanShellOutput } from "./status-render.js";
import { dtrace } from "./debuglog.js";

export type EventsDeps = {
  /** Telegram client used to send/edit messages. */
  tg: TelegramClient;
  /** Bridge to the local OpenCode HTTP server. */
  oc: OpenCodeBridge;
  /** Runtime configuration (optional; defaults applied internally). */
  config?: Config;
  /** In-memory route/session store with JSON persistence. */
  store: SessionStore;
  /** Pending permission requests awaiting a user decision. */
  pendingPermissions: Map<string, PermissionInfo>;
  /** Pending interactive forms shown in Telegram. */
  pendingForms: Map<number, FormState>;
  /** Index from OpenCode form id to the Telegram message id that shows it. */
  pendingFormsById: Map<string, number>;
  /** Map from Telegram message id to the session that produced it. */
  messageToSession: Map<string, string>;
  /** Per-chat settings (display mode, toggles, profiles). */
  settings: SettingsStore;
  /** Start the live status card for a turn. */
  startStatus: (chatId: number, s: ChatSession) => Promise<void>;
  /** Throttled edit of the live status card. */
  updateStatus: (chatId: number, s: ChatSession, force?: boolean) => Promise<void>;
  /** Freeze the status card when the turn ends. */
  finishStatus: (chatId: number, s: ChatSession) => Promise<unknown>;
  /** Sync the topic title with the session's latest activity. */
  syncTopicTitle: (chatId: number, s: ChatSession) => Promise<void>;
  /** Session card: one paginated message per session. */
  transcript?: TranscriptManager;
  /** Republish the session card (live strip or Done strip). */
  publishCard?: (chatId: number, s: ChatSession) => Promise<void>;
  /** Structured per-session trace (logging/metrics). */
  sessionTrace?: (event: string, fields: Record<string, unknown>) => void;
  /** Recent MCP events per session (experimental, 2.3.0). */
  mcpEvents?: Map<string, Array<{ at: number; server: string; text: string }>>;
};

const retryMessageBySession = new Map<string, { chatId: number; threadId?: number; messageId: number }>();

/** Drop the pending retry notice for a session (e.g. when the user sends a new prompt). */
export function clearRetryNotice(sessionId: string): void {
  retryMessageBySession.delete(sessionId);
}

type EventHandler = (event: { type: string; data?: unknown }, deps: EventsDeps) => Promise<void>;

/** Loose shape of a form field as sent by OpenCode (validated at runtime). */
type RawFormField = {
  key?: unknown;
  title?: unknown;
  description?: unknown;
  required?: unknown;
  type?: unknown;
  options?: unknown;
};
type RawFormOption = {
  value?: unknown;
  label?: unknown;
  description?: unknown;
};

/** Serialize a tool input without turning a missing payload into the string `""`. */
function toolInputText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

async function ensureLiveStatus(deps: EventsDeps, sessionId: string | undefined, chatId: number | undefined): Promise<ChatSession | undefined> {
  if (!sessionId || chatId === undefined) return undefined;
  const s = deps.store.findSessionById(sessionId);
  if (!s || s.stopped) return s;
  if (s.statusMessageId && !s.statusFinished) return s;
  // New autonomous/resumed activity: start a live status card so tool/step/text
  // updates edit in place instead of sending a new message per event.
  s.stopped = false;
  s.statusFinished = false;
  try {
    await deps.startStatus(chatId, s);
    if (s.statusMessageId) deps.store.rememberMessageSession(chatId, s.statusMessageId, sessionId);
  } catch (err) {
    logger.warn("events", "ensureLiveStatus.failed", { sessionId, chatId, error: String(err) });
  }
  return s;
}

// ---------- handlers ----------

const handleSessionTextStarted: EventHandler = async (event, deps) => {
  const { tg, store } = deps;
  const { resolveChatId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = (e.data?.sessionID ?? (e.data?.session as { id?: string } | undefined)?.id) as string | undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = await ensureLiveStatus(deps, sessionId, chatId);
  if (!s) return;
  // Ensure per-block buffer/typing state is reset even when status already live.
  s.buffer = "";
  s.stopped = false;
  if (s.typingTimer) clearInterval(s.typingTimer);
  s.typingTimer = setInterval(() => {
    tg.sendChatAction(chatId, "typing", s.threadId ?? s.targetThreadId).catch((err) => console.warn("[events]", err?.message ?? err));
  }, 3000);
  tg.sendChatAction(chatId, "typing", s.threadId ?? s.targetThreadId).catch((err) => console.warn("[events]", err?.message ?? err));
};

const handleSessionReasoningStarted: EventHandler = async (event, deps) => {
  const { store } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !sessionId) return;
  const s = _s0;
  if (!s) return;
  // Preserve earlier reasoning across multiple reasoning blocks in one turn.
  if (s.reasoningBuffer.trim()) s.reasoningBuffer += "\n\n---\n\n";
  if (s.activity) {
    closeThoughts(s.activity);
    recordThought(s.activity, "");
  }
};

const handleSessionReasoningDelta: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !sessionId) return;
  const s = _s0;
  if (!s) return;
  // Discard reasoning deltas from a turn that already ended: OpenCode may
  // still be streaming the previous answer when a new prompt starts.
  const gen = s.turnGeneration ?? 0;
  const deltaAid = e.data?.assistantMessageID as string | undefined;
  if (deltaAid && s.lastFinalMessageId && deltaAid === s.lastFinalMessageId) return;
  const delta = String(e.data?.delta ?? "");
  if (gen !== (s.turnGeneration ?? 0)) return;
  s.reasoningBuffer += delta;
  if (s.activity && delta) recordThoughtDelta(s.activity, delta);
  updateStatus(chatId, s).catch((err) => console.warn("[events]", err?.message ?? err));
};

/** Skill activation: show it in the virtual shell like any other tool. */
const handleSessionSkillActivated: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  if (!sid) return;
  const s = deps.store.findSessionById(sid);
  const chatId = deps.store.resolveChatId(sid);
  if (!s || chatId === undefined) return;
  const name = String(e.data?.name ?? e.data?.id ?? "skill");
  const id = String(e.data?.id ?? `skill-${Date.now()}`);
  s.toolCallDetails.push({ id, name: "skill", input: JSON.stringify({ name }), status: "success" });
  if (s.activity) recordTool(s.activity, "skill", name, { toolId: id });
  deps.updateStatus(chatId, s, true).catch((err) => console.warn("[events]", err?.message ?? err));
};

const handleSessionToolInputStarted: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !sessionId) return;
  const s = _s0;
  if (!s) return;
  const name = (e.data?.name as string | undefined) ?? "tool";
  if (name) s.toolCalls.push(name);
  const id = (e.data?.id as string | undefined) ?? String(s.toolCallDetails.length);
  const input = toolInputText(e.data?.input);
  s.toolCallDetails.push({ id, name, input, status: "running" });
  if (s.activity) recordTool(s.activity, name, input, { toolId: id });
  updateStatus(chatId, s, true).catch((err) => console.warn("[events]", err?.message ?? err));
};

/**
 * Shared wiring for tool events: resolve session + target detail by id (with
 * a running-tool fallback) and apply a mutation, then refresh the card.
 */
async function applyToolEvent(
  deps: EventsDeps,
  event: { type: string; data?: unknown },
  mutate: (detail: ChatSession["toolCallDetails"][number], d: Record<string, unknown>, id: string | undefined, s: ChatSession) => void,
): Promise<void> {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  // OpenCode 2.3.0 reports todo changes through the `todowrite` tool, not a
  // separate event. Capture them here so the card checklist stays in sync.
  if (sessionId) rememberTodosFromTool(deps, sessionId, e.data ?? {});
  const s = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (!s || chatId === undefined || !sessionId) return;
  const id = e.data?.id as string | undefined;
  let detail = id ? s.toolCallDetails.find((d) => d.id === id) : undefined;
  if (!detail && s.toolCallDetails.length) {
    // Fall back to the most recent running tool when the event omits an id.
    detail = [...s.toolCallDetails].reverse().find((d) => d.status === "running") ?? s.toolCallDetails[s.toolCallDetails.length - 1];
  }
  if (detail) {
    mutate(detail, e.data ?? {}, id, s);
    if (id && detail.id !== id) detail.id = id;
  }
  updateStatus(chatId, s, true).catch((err) => console.warn("[events]", err?.message ?? err));
}

const handleSessionToolCalled: EventHandler = async (event, deps) =>
  applyToolEvent(deps, event, (detail, d, _id, s) => {
    const input = toolInputText(d.input);
    detail.input = input;
    if (s.activity) updateToolDetail(s.activity, detail.id, input);
  });

const handleSessionToolSuccess: EventHandler = async (event, deps) =>
  applyToolEvent(deps, event, (detail, d, _id, s) => {
    detail.status = "success";
    const out = d.content ?? d.output;
    detail.output = typeof out === "string" ? out.slice(0, 2000) : JSON.stringify(out ?? "").slice(0, 2000);
    if (s.activity) finishTool(s.activity, detail.id, true);
  });

const handleSessionToolFailed: EventHandler = async (event, deps) =>
  applyToolEvent(deps, event, (detail, d, _id, s) => {
    detail.status = "failed";
    detail.output = ((d.error as { message?: string } | undefined)?.message ?? "failed").slice(0, 2000);
    if (s.activity) finishTool(s.activity, detail.id, false);
  });

/**
 * Shared notice for compaction start/end/failure: update the live card when
 * there is one, otherwise send a standalone message and remember it. Keeps the
 * session-present / session-missing branches from being duplicated 4×.
 */
async function compactionNotice(
  deps: EventsDeps,
  s: ChatSession | undefined,
  sessionId: string,
  chatId: number,
  threadId: number | undefined,
  text: string,
): Promise<void> {
  const { tg, store, updateStatus } = deps;
  if (s?.statusMessageId) {
    updateStatus(chatId, s, true).catch((err) => console.warn("[events]", err?.message ?? err));
    return;
  }
  const message = await tg.sendRichMessage(
    chatId,
    sessionHeader(s ?? null, sessionId) + text,
    threadOpts(threadId),
  ).catch(() => undefined);
  if (message?.message_id) store.rememberMessageSession(chatId, message.message_id, sessionId);
}

const handleSessionToolProgress: EventHandler = async (event, deps) =>
  applyToolEvent(deps, event, (detail, d) => {
    const chunk = typeof d.output === "string" ? d.output : typeof d.text === "string" ? d.text : undefined;
    if (chunk) detail.output = ((detail.output ?? "") + chunk).slice(0, 2000);
  });

const handleSessionInbox: EventHandler = async (event, deps) => {
  const { store, tg, settings } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  const s = sid ? store.findSessionById(sid) : undefined;
  if (!s) return;
  const chatId = store.resolveChatId(sid);
  if (chatId === undefined) return;
  const action = e.type.split(".").pop();
  // OpenCode 2.3 delivers TUI prompts as session.inbox.enqueued with
  // data.item = { type: "user", payload: { text, ... }, delivery }. Publish the
  // user's own text so it is visible in Telegram alongside the assistant card.
  if (action === "enqueued" && settings.get(chatId).showTuiPrompts) {
    const item = e.data?.item as { type?: string; payload?: { text?: string } } | undefined;
    const text = item?.type === "user" ? String(item.payload?.text ?? "").trim() : "";
    const inboxId = String(e.data?.inboxID ?? "");
    // Prompts the bot sent from Telegram come back as inbox.enqueued too — do
    // NOT label those as TUI input.
    const isTelegramEcho = text && sid ? isTelegramPromptEcho(sid, text) : false;
    // Inter-agent messages ([FROM @x | TO @y | ...]) are not TUI user input.
    const isAgentMessage = /^\[FROM @[^|]+\|\s*TO @/i.test(text);
    if (text && inboxId && !isTelegramEcho && !isAgentMessage && !publishedTuiPrompts.has(inboxId)) {
      publishedTuiPrompts.add(inboxId);
      if (sid) {
        noteUserPrompt(sid, text);
        // Put the prompt on the card instead of sending a standalone "⌨️ TUI:"
        // message: the card already has a 📝 line at the top, so a separate
        // notice duplicated it and flooded the group.
        deps.store.rememberLastPrompt?.(sid, text);
      }
      // TUI prompts skip the Telegram message path: without this the turn had
      // no promptStartTime and the footer showed "—" for duration/tok/s/ttft.
      s.promptStartTime = Date.now();
      deps.startStatus(chatId, s).catch((err) => console.warn("[events] startStatus (TUI prompt) failed", err?.message ?? err));
      if (publishedTuiPrompts.size > 500) {
        const oldest = publishedTuiPrompts.values().next().value;
        if (oldest) publishedTuiPrompts.delete(oldest);
      }
    }
  }
  // Refresh the card so the "background/inbox" state is visible in place.
  if (deps.publishCard) await deps.publishCard(chatId, s).catch(() => {});
  logger.debug("events", `[inbox.${action}]`, sid);
};
/** Dedupe set for TUI prompts already published (by inboxID). */
const publishedTuiPrompts = new Set<string>();
/** Prompts the bot itself sent to OpenCode (from Telegram) — not TUI input. */
const telegramPrompts = new Map<string, { text: string; at: number }[]>();
/** Real prompts typed in OpenCode's TUI (inbox.enqueued user items). */
const tuiPrompts = new Map<string, { text: string; at: number }[]>();
/** Record a prompt the bot is about to send so its inbox echo is not shown as TUI. */
export function noteTelegramPrompt(sessionId: string, text: string): void {
  const list = telegramPrompts.get(sessionId) ?? [];
  list.push({ text: text.trim(), at: Date.now() });
  if (list.length > 20) list.shift();
  telegramPrompts.set(sessionId, list);
}
/** Record any real user prompt (Telegram or TUI) with its arrival time. */
export function noteUserPrompt(sessionId: string, text: string): void {
  const list = tuiPrompts.get(sessionId) ?? [];
  list.push({ text: text.trim(), at: Date.now() });
  if (list.length > 20) list.shift();
  tuiPrompts.set(sessionId, list);
}
/** Timestamp of the most recent user prompt already answered; prevents
 * re-publishing an earlier assistant answer when a new prompt arrives. */
const answeredPromptAt = new Map<string, number>();
/** True if there is a user prompt newer than the last answered one. */
export function hasPendingUserPrompt(sessionId: string): boolean {
  const list = [...(telegramPrompts.get(sessionId) ?? []), ...(tuiPrompts.get(sessionId) ?? [])];
  const answeredAt = answeredPromptAt.get(sessionId) ?? 0;
  // There must be a prompt NEWER than the last one we already answered.
  return list.some((p) => p.at > answeredAt && Date.now() - p.at < 120_000);
}
function markPromptAnswered(sessionId: string): void {
  const list = [...(telegramPrompts.get(sessionId) ?? []), ...(tuiPrompts.get(sessionId) ?? [])];
  const newest = list.reduce((m, p) => Math.max(m, p.at), 0);
  if (newest) answeredPromptAt.set(sessionId, newest);
}
function isTelegramPromptEcho(sessionId: string, text: string): boolean {
  const list = telegramPrompts.get(sessionId) ?? [];
  const now = Date.now();
  return list.some((p) => p.text === text.trim() && now - p.at < 60_000);
}

const handleSessionModelSelected: EventHandler = async (event, deps) => {
  const { store } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  const s = sid ? store.findSessionById(sid) : undefined;
  if (!s) return;
  const m = (e.data?.model ?? e.data) as { id?: string; modelID?: string; providerID?: string; variant?: string } | undefined;
  const id = m?.id ?? m?.modelID;
  const providerID = m?.providerID;
  if (id && providerID) {
    s.model = { id, providerID, variant: typeof m?.variant === "string" ? m.variant : undefined };
    logger.info("events", "[model.selected]", sid, `${providerID}/${id}`);
    // Refresh the card so the model header reflects the TUI change.
    const chatId = store.resolveChatId(sid);
    if (chatId !== undefined && deps.publishCard) await deps.publishCard(chatId, s).catch(() => {});
  }
};

const handleSessionCompactionStarted: EventHandler = async (event, deps) => {
  const { store } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  logger.info("events", "compaction.started", { sessionId, chatId, hasSession: !!_s0 });
  if (chatId === undefined || !sessionId) return;
  const s = _s0;
  if (s) {
    s.compacting = true;
    s.compactionError = undefined;
    s.compactionSummary = undefined;
  }
  await compactionNotice(deps, s, sessionId!, chatId, resolveThreadId(sessionId), "📦 <b>Compacting context…</b>");
};

const handleSessionCompactionDelta: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !sessionId) return;
  const s = _s0;
  if (s) {
    s.compactionSummary = (s.compactionSummary ?? "") + String(e.data?.text ?? "");
    if (s.statusMessageId) updateStatus(chatId, s).catch((err) => console.warn("[events]", err?.message ?? err));
  }
};

const handleSessionCompactionEnded: EventHandler = async (event, deps) => {
  const { store } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !sessionId) return;
  const s = _s0;
  const threadId = resolveThreadId(sessionId) as number | undefined;
  const summary = String(e.data?.text ?? "").trim();
  const shortSummary = summary.slice(0, 900);
  const summaryTruncated = summary.length > shortSummary.length;
  const summaryBody = summary
    ? `<blockquote expandable>📦 Summary\n<pre>${esc(shortSummary)}${summaryTruncated ? "\n…" : ""}</pre></blockquote>`
    : "";
  const tokens = e.data?.tokens as { input?: number; output?: number } | undefined;
  const tokenText = tokens ? ` · ${((tokens.input ?? 0) + (tokens.output ?? 0)).toLocaleString()} tokens` : "";
  if (s) {
    s.compacting = false;
    s.compactionError = undefined;
    s.compactionSummary = summary ? (summary + (tokenText ? `\n${tokenText.trim()}` : "")) : (s.compactionSummary ?? "");
  }
  await compactionNotice(deps, s, sessionId!, chatId, threadId, `📦 <b>Compactación completada</b>${tokenText}${summaryBody ? "\n" + summaryBody : ""}`);
  logger.info("events", "compaction.ended", { sessionId, chatId, threadId, summaryLen: summary.length, usedStatus: !!(s?.statusMessageId) });
};

const handleSessionCompactionFailed: EventHandler = async (event, deps) => {
  const { store } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !sessionId) return;
  const s = _s0;
  const threadId = resolveThreadId(sessionId) as number | undefined;
  const msg = (e.data?.error as { message?: string } | undefined)?.message ?? "compaction failed";
  if (s) {
    s.compacting = false;
    s.compactionError = msg;
  }
  await compactionNotice(deps, s, sessionId!, chatId, threadId, `❌ <b>Error al compactar</b>: ${esc(msg)}`);
  logger.warn("events", "compaction.failed", { sessionId, chatId, threadId, error: msg });
};

const handleMcpStatusChanged: EventHandler = async (event, deps) => {
  const { tg, store } = deps;
  const { resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const d = (e.data ?? {}) as Record<string, unknown>;
  const server = d.server as string | undefined;
  const sid = d.sessionID as string | undefined;
  const chatId = resolveChatId(sid);
  if (chatId !== undefined && server && sid) {
    const threadId = resolveThreadId(sid as string);
    await tg.sendRichMessage(chatId, sessionHeader(store.findSessionById(sid), sid) + `🔌 MCP status changed: <b>${esc(server)}</b>\nUse /mcp to inspect.`, threadOpts(threadId)).catch((err) => console.warn("[events]", err?.message ?? err));
  }
  return;
};

const handleMcpResourcesChanged: EventHandler = async (event, deps) => {
  const { tg, store } = deps;
  const { resolveChatId, resolveThreadId } = store;
  const e = event;
  const d = (e as { data?: Record<string, unknown> }).data ?? {};
  const server = d.server as string | undefined;
  const sid = d.sessionID as string | undefined;
  const chatId = resolveChatId(sid);
  if (chatId !== undefined && server && sid) {
    const threadId = resolveThreadId(sid as string);
    await tg.sendRichMessage(chatId, sessionHeader(store.findSessionById(sid), sid) + `📚 MCP resources changed: <b>${esc(server)}</b>\nUse /mcp resources.`, threadOpts(threadId)).catch((err) => console.warn("[events]", err?.message ?? err));
  }
  return;
};

const handleSessionTextDelta: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  const gen = s.turnGeneration ?? 0;
  const deltaAid = (e.data?.assistantMessageID ?? e.data?.assistantMessageId) as string | undefined;
  if (deltaAid && s.lastFinalMessageId && deltaAid === s.lastFinalMessageId) return;
  const delta = String(e.data?.delta ?? e.data?.text ?? "");
  if (gen !== (s.turnGeneration ?? 0)) return;
  if (delta) {
    s.buffer += delta;
    // First streamed token timestamp (authoritative metric for tok/s in 2.3.0).
    if (!s.turnFirstStreamedAt) s.turnFirstStreamedAt = Date.now();
  }
  // Coalesce streamed text into one edit every 3s: the partial answer grows
  // in readable chunks instead of jittering on every token. updateStatus
  // still applies its own throttle and the adaptive 429 backoff.
  if (!s.deltaFlushTimer) {
    s.deltaFlushTimer = setTimeout(() => {
      s.deltaFlushTimer = undefined;
      // Resolve the delivery target at flush time: the session may have moved
      // to another tab during the coalescing window.
      const targetChat = deps.store.resolveChatId(s.sessionId) ?? chatId;
      // Force past the idle throttle: streamed reasoning must appear promptly.
      // The adaptive 429 backoff still gates the actual Telegram edit.
      updateStatus(targetChat, s, true).catch((err) => console.warn("[events]", err?.message ?? err));
    }, STREAM_FLUSH_MS);
  }
};

const handleSessionStepEnded: EventHandler = async (event, deps) => {
  const { tg, store, settings, finishStatus } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  // Capture the model on the step event too: finishStatus records the turn stat
  // here, and restored sessions have s.model undefined (→ "unknown/unknown").
  const stepModel = e.data?.model as { id?: string; providerID?: string } | undefined;
  const stepModelId = (e.data?.modelID as string | undefined) ?? stepModel?.id;
  const stepProvider = (e.data?.providerID as string | undefined) ?? stepModel?.providerID;
  if (stepModelId && stepProvider && s.model?.id !== stepModelId) {
    s.model = { id: stepModelId, providerID: stepProvider };
  }
  const usage = e.data?.tokens as
    | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    | undefined;
  const out = usage?.output;
  if (typeof out === "number") {
    s.lastOutputTokens = out;
    // Accumulate across all steps of this turn (multi-step tool calls).
    s.turnOutputTokens = (s.turnOutputTokens ?? 0) + out;
  }
  const inp = usage?.input;
  const cacheRead = usage?.cache?.read ?? 0;
  const cacheWrite = usage?.cache?.write ?? 0;
  if (typeof inp === "number") s.lastContextTokens = inp + cacheRead;
  if (typeof inp === "number") s.turnInputTokens = (s.turnInputTokens ?? 0) + inp;
  if (typeof usage?.reasoning === "number") s.turnReasoningTokens = (s.turnReasoningTokens ?? 0) + usage.reasoning;
  s.turnCacheReadTokens = (s.turnCacheReadTokens ?? 0) + cacheRead;
  s.turnCacheWriteTokens = (s.turnCacheWriteTokens ?? 0) + cacheWrite;
  const cost = e.data?.cost;
  if (typeof cost === "number") s.turnCost = (s.turnCost ?? 0) + cost;
  // "tool-calls" means the turn continues with another step; any other
  // finish reason (stop / length / error) is the real end of the turn.
  const finish = (e.data?.finish ?? e.data?.rawFinish) as string | undefined;
  if (finish && finish !== "tool-calls") {
    if (s.typingTimer) { clearInterval(s.typingTimer); s.typingTimer = undefined; }
    try {
      if (!s.stopped) await finishStatus(chatId, s);
    } catch (err) {
      console.error("[finishStatus error]", err);
    }
    // Deliver files produced by the turn as Telegram documents.
    if (!s.stopped) {
      const settings2 = settings.get(chatId);
      const artifacts = Array.isArray(e.data?.files) ? (e.data.files as unknown[]) : [];
      // OpenCode sometimes reports the whole working-tree snapshot here; sending
      // hundreds of files floods Telegram. Only treat small, de-duplicated sets
      // as real turn artifacts.
      const seen = (s.sentArtifacts ??= new Set<string>());
      const unique = artifacts
        .map((p: unknown) => String(p))
        .filter((p: string) => !seen.has(p));
      // A large set is a working-tree snapshot, not turn artifacts: skip it.
      if (settings2.autoArtifacts && unique.length && unique.length <= MAX_ARTIFACT_CANDIDATES) {
        const artifactThread = s.targetThreadId ?? s.threadId ?? resolveThreadId(sessionId);
        const base = s.directory ?? process.cwd();
        for (const relativePath of unique.slice(0, MAX_ARTIFACTS)) {
          seen.add(relativePath);
          try {
            const doc = await prepareDocument(base, relativePath);
            if (doc.size <= MAX_DOCUMENT_BYTES) {
              await tg.sendDocument(chatId, doc.absolute, doc.name, `<b>Artifact</b>\n<code>${esc(doc.relative || doc.name)}</code>\n${formatBytes(doc.size)}`, { ...threadOpts(artifactThread), parse_mode: "HTML" });
            }
          } catch (err) {
            console.error("[artifact]", err);
          }
        }
        if (unique.length > MAX_ARTIFACTS) {
          await tg.sendRichMessage(chatId, sessionHeader(s, sessionId) + `📎 ${unique.length - MAX_ARTIFACTS} more artifact(s) not sent (limit ${MAX_ARTIFACTS}).`, threadOpts(artifactThread)).catch((err) => console.warn("[events]", err?.message ?? err));
        }
      }
    }
  }
  // status tracking
  const sid = (e as { data?: Record<string, unknown> }).data?.sessionID as string | undefined;
  if (sid) store.setSessionStatus(sid, "idle");
};

const handleSessionTextEnded: EventHandler = async (event, deps) => {
  const { tg, oc, store, settings, finishStatus, syncTopicTitle, transcript, publishCard } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  let endedText = String((e as { data?: Record<string, unknown> }).data?.text ?? "").trim();
  if (sessionId) {
    // Any terminal text event closes the turn: clear retry state even when the
    // answer is empty, so stale prompts are never replayed.
    noteTurnCompleted(sessionId);
    if (endedText) {
      const retryNotice = retryMessageBySession.get(sessionId);
      if (retryNotice) {
        retryMessageBySession.delete(sessionId);
        await tg.editRichMessage(retryNotice.chatId, retryNotice.messageId, "✅ Reintento correcto.").catch((err) => console.warn("[events]", err?.message ?? err));
      }
    }
  }
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  logger.breadcrumb("events", "text.ended.entry", { sessionId, hasSession: !!_s0, chatId });

  // OpenCode sometimes delivers a provider error as a text.ended event (with
  // the error string in `text`) instead of as execution.failed. Detect it here
  // so the retry / friendly-label logic applies instead of showing the raw
  // error as the final answer.
  const errorLike =
    (e.data?.error as { message?: string } | undefined)?.message ??
    (/^(error|fail(ed)?|exception)\b/i.test(endedText) &&
     /limit|quota|provider|rate|usage|exceeded|429|5\d\d/i.test(endedText)
      ? endedText
      : undefined);
  if (errorLike && chatId !== undefined) {
    const synthetic = {
      type: "session.execution.failed",
      data: { sessionID: sessionId, error: { message: errorLike } },
    };
    await handleSessionExecutionFailed(synthetic as any, deps);
    return;
  }

  if (chatId === undefined) return;
  // Only publish assistant answers that answer a REAL user prompt (Telegram or
  // TUI). The assistant's own streaming (e.g. this agent replying in its own
  // session) emits text.ended too, and must not create a Telegram card.
  // Publish whenever there is real streamed content in this turn. The guard
  // only drops answers with NO prompt at all in a long window (orphan
  // streaming from an unrelated background agent).
  if (sessionId && !hasPendingUserPrompt(sessionId) && !(_s0?.buffer?.trim())) {
    logger.breadcrumb("events", "text.ended.no-user-prompt", { sessionId, len: endedText.length });
    return;
  }
  let s = _s0;
  const msgId = (e as { data?: Record<string, unknown> }).data?.assistantMessageID as string | undefined;
  if (s) {
    if (msgId && s.lastFinalMessageId === msgId) {
      logger.breadcrumb("events", "text.ended.duplicate", { sessionId, msgId, reason: "msgId" });
      return;
    }
    if (!msgId && s.lastFinalSentAt && Date.now() - s.lastFinalSentAt < 3000) {
      logger.breadcrumb("events", "text.ended.duplicate", { sessionId, reason: "recent-no-msgId" });
      return;
    }
    // OpenCode 2.3.0 emits one `text.ended` per text PART of the assistant
    // message. Dedupe by assistantMessageID (the API's authoritative identity),
    // NOT by prompt timestamp: a timestamp can repeat across events and caused
    // duplicated/lost answers (OpenCode API skill §5/§12).
    if (msgId && s.lastFinalMessageId === msgId) {
      logger.breadcrumb("events", "text.ended.duplicate", { sessionId, msgId, reason: "delivered-msgId" });
      return;
    }
  }
  if (!s) {
    // No in-memory session (e.g. session created from the TUI, or after a
    // restart). The text.ended event often carries an empty `text` (the answer
    // streamed via text.delta), so fetch the full assistant message from the
    // API — otherwise the user gets no Telegram reply at all.
    let fallbackText = String((e as { data?: Record<string, unknown> }).data?.text ?? "").trim();
    if (!fallbackText && msgId && sessionId) {
      try {
        const m = await oc.client.session.message.get({ sessionID: sessionId, messageID: msgId });
        // Surface a recorded provider failure (e.g. 402 quota) gracefully.
        const err = (m as { error?: { message?: string; type?: string } })?.error;
        if (err?.message) {
          fallbackText = `⚠️ <b>${esc(classifyFailure(err.message).label)}</b>\n<i>${esc(classifyFailure(err.message).hint)}</i>`;
        } else {
          const content = (m as { parts?: Array<{ type?: string; text?: string }> })?.parts;
          if (Array.isArray(content)) {
            fallbackText = content.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text!).join("\n\n").trim();
          }
          if (!fallbackText) {
            const mt = (m as { text?: string })?.text;
            if (typeof mt === "string") fallbackText = mt.trim();
          }
        }
      } catch (err) {
        console.warn("[events] fallback message.get failed", String(err));
      }
    }
    if (fallbackText) {
      const sent = await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + markdownToHtml(fallbackText), threadOpts(resolveThreadId(sessionId as string))).catch((err) => { console.error("[send final]", err); return undefined; });
      if (sent?.message_id && sessionId) store.rememberMessageSession(chatId, sent.message_id, sessionId);
      logger.breadcrumb("events", "send.final.fallback", { sessionId, chatId, len: fallbackText.length });
    } else {
      logger.breadcrumb("events", "send.final.fallback.empty", { sessionId, chatId, msgId });
    }
    return;
  }
  // permanent breadcrumb for future debug
  logger.breadcrumb("events", "text.ended.process", { sessionId, statusMsg: s.statusMessageId, finished: s.statusFinished, stopped: s.stopped });
  if (s.typingTimer) {
    clearInterval(s.typingTimer);
    s.typingTimer = undefined;
  }
  if (!s.stopped) {
    // Claim the assistant message id BEFORE any await so a second text.ended
    // part cannot slip past the dedupe while message.get / publish are in
    // flight. Turn CLOSING is owned by session.idle / execution.succeeded —
    // text.ended only publishes the answer (OpenCode API skill §5/§12).
    if (msgId) s.lastFinalMessageId = msgId;
    s.lastFinalDeliveredPromptStart = s.promptStartTime;
    logger.breadcrumb("events", "text.ended.flush", { sessionId, statusMsg: s.statusMessageId, finished: s.statusFinished, stopped: s.stopped, msgId });
    // Some OpenCode builds put the model on the event itself; capture it as a
    // fallback in case message.get fails below.
    const evModel = e.data?.model as { id?: string; providerID?: string } | undefined;
    if (!s.model && evModel?.id && evModel?.providerID) {
      s.model = { id: evModel.id, providerID: evModel.providerID };
    }
    // OpenCode emits one text.ended per text PART of the assistant message.
    // s.buffer accumulates ALL streamed deltas, so prefer it over the single
    // part in this event: publishing endedText truncated the answer to the
    // first part while OpenCode kept generating the rest (skill §4/§5).
    const buffered = s.buffer?.trim() ?? "";
    const eventPart = String(e.data?.text ?? "").trim();
    let finalText = buffered || eventPart || endedText || "(empty response)";
    let elapsed = 0;
    // Tokens are accumulated across ALL steps of the turn (multi-step tool
    // calls), not just the last one (fix B1/B2).
    let tokens = s.turnOutputTokens ?? s.lastOutputTokens ?? 0;
    let streamedAt = s.turnFirstStreamedAt;
    try {
      const msgId = (e as { data?: Record<string, unknown> }).data?.assistantMessageID as string | undefined;
      if (msgId) {
        const m = await oc.client.session.message.get({ sessionID: s.sessionId, messageID: msgId });
        // OpenCode records provider failures (e.g. 402 quota) on the assistant
        // message itself while text.ended carries empty text. Surface them as
        // a graceful error card instead of an "(empty response)" final.
        const err = (m as { error?: { message?: string; type?: string } })?.error;
        if (err?.message) {
          const synthetic = {
            type: "session.execution.failed",
            data: { sessionID: s.sessionId, error: { message: `${err.type ?? "provider"}: ${err.message}` } },
          };
          await handleSessionExecutionFailed(synthetic as any, deps);
          return;
        }
        const t = (m as { time?: { completed?: number; streamed?: number; created?: number } })?.time;
        if (t?.streamed && !streamedAt) streamedAt = t.streamed;
        if (t?.completed) {
          // Prefer the API's streamed→completed window (OpenCode 2.3.0 metric).
          const start = t.streamed || streamedAt || t.created;
          if (start && t.completed > start) elapsed = (t.completed - start) / 1000;
        }
        // The assistant message carries the authoritative model for this turn.
        // Sessions restored from disk have s.model undefined, which previously
        // logged every such turn as "unknown/unknown" in stats.
        const mi = m as { modelID?: string; providerID?: string; model?: { id?: string; providerID?: string } };
        const resolvedModel = mi.modelID ?? mi.model?.id;
        const resolvedProvider = mi.providerID ?? mi.model?.providerID;
        if (resolvedModel && resolvedProvider && s.model?.id !== resolvedModel) {
          s.model = { id: resolvedModel, providerID: resolvedProvider };
        }
      }
    } catch {
      // ignore
    }
    if (!elapsed && streamedAt) {
      elapsed = (Date.now() - streamedAt) / 1000;
    }
    if (!elapsed && s.promptStartTime) {
      elapsed = (Date.now() - s.promptStartTime) / 1000;
    }
    if (elapsed > 0 && elapsed < 0.5) elapsed = 0.5;
    // The model/speed line is shown once per turn, in its own block, instead of
    // being appended to every answer (it would be duplicated on each step).
    let metaLine = "";
    if (tokens && elapsed > 0 && (settings.get(chatId).showTokenSpeed ?? true)) {
      const speed = (tokens / elapsed).toFixed(1);
      const modelName = s.model ? `${s.model.providerID}/${s.model.id}${s.model.variant ? " (" + s.model.variant + ")" : ""}` : "";
      metaLine = modelName ? `⚡ ${modelName} · ${speed} tok/s` : `⚡ ${speed} tok/s`;
    }
    const threadOpts2 = store.threadOptsFor(s);
    if (s) {
      s.lastFinalMessageId = msgId ?? s.lastFinalMessageId; // OpenCode assistant msg id
      s.lastFinalSentAt = Date.now();
    }
    logger.breadcrumb("events", "send.final", { chatId, thread: s.targetThreadId ?? s.threadId, len: finalText.length });
    deps.sessionTrace?.("turn.final", {
      sessionId: s.sessionId,
      chatId,
      threadId: s.targetThreadId ?? s.threadId,
      len: finalText.length,
      elapsedMs: s.promptStartTime ? Date.now() - s.promptStartTime : undefined,
      cardMessageId: s.transcriptMessageId,
      pages: deps.transcript?.pageCount(s),
    });
    s.lastFinalText = finalText;
    s.lastFinalTurn = s.turnSeq;
    if (sessionId) markPromptAnswered(sessionId);
    // Enrich the turn stat row with the final answer length (upsert).
    try {
      const promptText = deps.store.lastPromptBySession?.get?.(s.sessionId);
      recordTurnStatFromSession(s, chatId, s.targetThreadId ?? s.threadId, {
        outputChars: finalText.length,
        promptChars: promptText?.length ?? 0,
        dataDir: deps.store.dataDir,
      });
    } catch (err) {
      console.warn("[stats] enrich failed", err);
    }
    const copySource = finalText.trim() || "(sin texto)";
    const copyText = esc(copySource.slice(0, 200)).replace(/"/g, "&quot;");
    const answerHtml = markdownToHtml(finalText);
    // RICH_MESSAGE_BUTTON_TEXT_EMPTY: Telegram rejects an empty copy_text button.
    const copyRow = `\n\n<tg-button-row><tg-button type="copy_text" text="${copyText}">📋 Copy answer</tg-button></tg-button-row>`;

    if (transcript) {
      // The answer is appended to the session transcript and the session card
      // is edited in place: no new message per event.
      // Each chunk is rendered on its own so markdown keeps its rich text.
      transcript.addBlock(s, "answer", answerHtml + copyRow, finalText, (chunk) => {
        const partHtml = markdownToHtml(chunk);
        return partHtml + copyRow;
      });
      // The model/speed line is a single block, replaced on every step so it
      // is not duplicated across the answers of the same turn.
      if (metaLine) {
        transcript.addBlock(s, "meta", `<i>${esc(metaLine)}</i>`, metaLine);
      }
      s.transcriptFollow = true;
      s.transcriptPage = undefined;
      if (publishCard) await publishCard(chatId, s).catch((err) => console.warn("[events] publishCard failed", err?.message ?? err));
      else await transcript.publish(chatId, s, { extraTop: "" }).catch((err) => console.warn("[events] transcript.publish failed", err?.message ?? err));
      if (s.transcriptMessageId) {
        s.lastFinalTelegramMessageId = s.transcriptMessageId;
      }
        // Optional: deliver the final answer as a separate rich-text message for readability.
      const st = settings.get(chatId);
      // When the answer is already embedded in the card, sending it again as
      // separate messages only creates noise (parte 1/3, 2/3, …). Only deliver
      // separately when the user explicitly asked for it or the answer is too
      // long to fit in the card (showFinalInCard off / oversized).
      const sendSeparately = wantsSeparateAnswer(st, finalText);
      if (sendSeparately) {
        if (s.lastFinalSeparatedPromptStart !== s.promptStartTime) {
          s.lastFinalSeparatedPromptStart = s.promptStartTime;
          // Prefer section-aware splitting: one part per markdown section
          // (headings) so code blocks are never cut mid-way. Falls back to
          // size-based splitting when there are no usable headings.
          const sections = splitBySections(finalText, 30000);
          const parts = sections.length ? sections : splitMarkdown(finalText, 30000);
          for (let i = 0; i < parts.length; i++) {
            const prefix = parts.length > 1 ? `<i>(${i + 1}/${parts.length})</i>\n` : "";
            // The card already carries the indicators; don't duplicate them
            // in the separate long-answer message.
            const piece = `${sessionHeader(s, undefined, (settings.get(chatId).sessionNameInMessages ?? true))}${prefix}<blockquote>${markdownToHtml(parts[i])}</blockquote>`;
            await tg.sendRichMessage(chatId, clampText(piece, RICH_MESSAGE_LIMIT), threadOpts2).catch((err) => console.warn("[events]", err?.message ?? err));
          }
        }
      }
    } else {
      // Fallback without the session card: send a standalone message.
      const quickKeyboard: Array<Array<{ text: string; callback_data: string }>> = [
        [{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }],
      ];
      let extraHtml = "";
      if (s && s.toolCallDetails.length && (settings.get(chatId).showTools ?? true)) {
        const details = s.toolCallDetails;
        const isShell = (n: string) => /shell|bash|exec|run/i.test(n);
        const shellDetails = details.filter((d) => isShell(d.name));
        const otherDetails = details.filter((d) => !isShell(d.name));
        if (shellDetails.length) {
          const body = shellDetails.slice(-12).map((d) => {
            let cmd = d.name;
            if (d.input) {
              try {
                const p = JSON.parse(d.input) as Record<string, unknown>;
                cmd = String(p.command ?? p.cmd ?? d.input).slice(0, 220);
              } catch {
                cmd = d.input.slice(0, 220);
              }
            }
            const out = cleanShellOutput((d.output ?? "").toString()).trim().slice(0, 400);
            return `$ ${esc(cmd)}${out ? `\n${esc(out)}` : ""}${d.status === "failed" ? "\n(failed)" : ""}`;
          }).join("\n\n");
          extraHtml += `\n\n<blockquote expandable>🖥 Shell (${shellDetails.length})\n<pre>${body}</pre></blockquote>`;
        }
        if (otherDetails.length) {
          const body = otherDetails.slice(-20).map((d) => {
            const inp = d.input ? esc(d.input.slice(0, 180)) : "";
            const out = cleanShellOutput((d.output ?? "").toString()).trim();
            const outShort = out ? esc(out.slice(0, 220)) : "";
            return `${toolIcon(d.name)} <b>${esc(d.name)}</b>${inp ? `\n<i>${inp}</i>` : ""}${outShort ? `\n<code>${outShort}</code>` : ""}${d.status === "failed" ? " <i>(failed)</i>" : ""}`;
          }).join("\n\n");
          extraHtml += `\n\n<blockquote expandable>🔧 Tool calls (${otherDetails.length})\n${body}</blockquote>`;
        }
      }
      const finalSt = settings.get(chatId);
      const resourcesHtml = finalSt.showResourceUsage ? `\n${renderResourceBlock(s, { history: finalSt.resourceHistory, theme: finalSt.cardTheme })}` : "";
      const finalHtml = sessionHeader(s, undefined, (finalSt.sessionNameInMessages ?? true)) + `<blockquote>${answerHtml}</blockquote>` + extraHtml + copyRow + resourcesHtml;
      // Always send a new message: editing the previous final is confusing.
      // Clamp without a trailing "…": clampText already closes open tags, so
      // we just strip the ellipsis it appends, leaving a clean (if truncated)
      // message instead of one ending in "…".
      const clamped = clampText(finalHtml, RICH_MESSAGE_LIMIT).replace(/\n…$/, "");
      const finalMessage = await tg.sendRichMessage(chatId, clamped, { ...threadOpts2, reply_markup: { inline_keyboard: quickKeyboard } }).catch((err) => {
        console.error("[send final]", err);
        return undefined;
      });
      if (finalMessage?.message_id) {
        store.rememberMessageSession(chatId, finalMessage.message_id, s.sessionId);
        s.lastFinalTelegramMessageId = finalMessage.message_id;
      }
    }
    if (s && (settings.get(chatId).autoTopicTitle ?? true)) await syncTopicTitle(chatId, s).catch((err) => console.warn("[events]", err?.message ?? err));
  }
  s.buffer = "";
};

const handlePermissionAsked: EventHandler = async (event, deps) => {
  const { tg, oc, store, pendingPermissions } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const p = (e.data ?? {}) as Record<string, unknown>;
  const requestId = p.id as string | undefined;
  const sessionId = p.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !requestId || !sessionId) return;
  const label = (p.tool ?? p.action ?? "permission") as string;
  const resource = Array.isArray(p.resources) ? (p.resources as string[]).join(", ") : String(p.message ?? "");
  const threadId = resolveThreadId(sessionId);
  const sent = await tg.sendRichMessage(chatId, sessionHeader(_s0, sessionId) + `<b>Permission requested</b>\n<i>${esc(label)}</i>\n<code>${esc(resource)}</code>\n\n<i>Expires in 5 minutes</i>`, {
    ...threadOpts(threadId),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Allow once", callback_data: `perm:allow:${requestId}` },
          { text: "✅ Always", callback_data: `perm:always:${requestId}` },
        ],
        [
          { text: "⛔ Reject", callback_data: `perm:reject:${requestId}` },
          { text: "🚫 Reject with reason", callback_data: `perm:rejectreason:${requestId}` },
        ],
      ],
    },
  });
  if (sent?.message_id) store.rememberMessageSession(chatId, sent.message_id, sessionId);
  pendingPermissions.set(requestId, { chatId, sessionId, messageId: sent.message_id, decided: false, label, resource });
  // Auto-reject on timeout. Store the handle so decisions can cancel it.
  const timeoutHandle = setTimeout(async () => {
    const info = pendingPermissions.get(requestId);
    if (info && !info.decided) {
      info.decided = true;
      try {
        await oc.replyPermission(info.sessionId, requestId, "reject");
      } catch {
        // ignore
      }
      if (info.messageId) {
        await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission auto-rejected (timeout)</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`).catch((err) => console.warn("[events]", err?.message ?? err));
      }
      pendingPermissions.delete(requestId);
    }
  }, deps.config?.PERMISSION_TTL_MS ?? 5 * 60_000);
  const permInfo = pendingPermissions.get(requestId);
  if (permInfo) permInfo.timeoutHandle = timeoutHandle;
};

const handleFormCreated: EventHandler = async (event, deps) => {
  const { tg, store, pendingForms, pendingFormsById } = deps;
  const { resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const p = (e.data ?? {}) as Record<string, unknown>;
  const form = (p.form ?? p) as Record<string, unknown>;
  const sessionId = String(p.sessionID ?? form.sessionID ?? "");
  const formId = String(form.id ?? form.formID ?? p.id ?? p.formID ?? "");
  const title = String(form.title ?? p.title ?? "Form");
  const chatId = resolveChatId(sessionId);
  if (chatId !== undefined && formId) {
    const threadId = resolveThreadId(sessionId);
    // Make sure the form's follow-up responses are delivered back to the tab
    // where the form was shown, not to a stale delivery target.
    store.rememberDelivery(sessionId, chatId, threadId);
    const rawFields = Array.isArray(form.fields) ? form.fields : [];
    const fields: FormField[] = rawFields.map((field: unknown) => {
      const f = field as RawFormField;
      const normalized: FormField = {
        key: String(f.key ?? ""),
        title: String(f.title ?? f.key ?? ""),
        description: typeof f.description === "string" ? f.description : undefined,
        required: f.required === true,
        type: (f.type as FormField["type"]) ?? "text",
        options: Array.isArray(f.options)
          ? (f.options as RawFormOption[]).map((option) => ({
              value: String(option.value),
              label: option.label != null ? String(option.label) : String(option.value),
              description: typeof option.description === "string" ? option.description : undefined,
            }))
          : undefined,
      };
      if (normalized.type === "boolean" && !normalized.options) {
        normalized.options = [
          { value: "true", label: "Sí" },
          { value: "false", label: "No" },
        ];
      }
      return normalized;
    });
    const state: FormState = {
      formId,
      sessionId,
      chatId,
      threadId,
      title,
      fields,
      answers: {},
      submitted: false,
    };
    const sent = await tg.sendRichMessage(chatId, sessionHeader(store.findSessionById(state.sessionId), state.sessionId) + renderForm(state), {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: formKeyboard(state) },
    });
    state.messageId = sent.message_id;
    if (sent?.message_id) store.rememberMessageSession(chatId, sent.message_id, sessionId);
    pendingForms.set(sent.message_id, state);
    pendingFormsById.set(formId, sent.message_id);
    // Expire the form in-place after the configured TTL so the user is not
    // left staring at an interactive form that OpenCode already discarded.
    const formTtl = deps.config?.FORM_TTL_MS ?? 30 * 60_000;
    state.timeoutHandle = setTimeout(async () => {
      const pending = pendingForms.get(sent.message_id);
      if (pending && !pending.submitted) {
        pendingForms.delete(sent.message_id);
        pendingFormsById.delete(formId);
        await tg.editRichMessage(chatId, sent.message_id, `<b>⏰ Formulario expirado</b>\n<code>${esc(formId)}</code>\n<i>Envía un nuevo prompt para continuar.</i>`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
    }, formTtl);
  }
};

/**
 * OpenCode emits form.replied / form.cancelled when the form is answered
 * outside Telegram (e.g. in the TUI). Reflect it in the same Telegram message
 * so the card is not left with a live keyboard nobody can use.
 */
const handleFormExternal: EventHandler = async (event, deps) => {
  const { tg, pendingForms, pendingFormsById } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const formId = String((e.data?.form as { id?: unknown } | undefined)?.id ?? e.data?.id ?? e.data?.formID ?? "");
  const messageId = pendingFormsById.get(formId);
  if (messageId === undefined) return; // already answered from Telegram
  const state = pendingForms.get(messageId);
  if (!state) {
    pendingFormsById.delete(formId);
    return;
  }
  const cancelled = e.type === "form.cancelled";
  const answer = (e.data?.answer ?? {}) as Record<string, unknown>;
  const lines = state.fields.map((field) => {
    const value = answer[field.key];
    const text = Array.isArray(value) ? value.join(", ") : String(value ?? "—");
    return `<b>${esc(field.title ?? field.key)}</b>: <code>${esc(text)}</code>`;
  });
  const html = cancelled
    ? `<b>Formulario cancelado (TUI)</b>\n<code>${esc(formId)}</code>`
    : `<b>Formulario respondido (TUI)</b>\n<code>${esc(formId)}</code>\n\n${lines.join("\n")}`;
  if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
  pendingForms.delete(messageId);
  pendingFormsById.delete(formId);
  await tg.editRichMessage(state.chatId, messageId, html, {
    ...threadOpts(state.threadId),
    reply_markup: { inline_keyboard: [] },
  }).catch((err) => console.warn("[events] external form reply failed", String(err)));
};

const handlePermissionReplied: EventHandler = async (event, deps) => {
  const { tg, pendingPermissions } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const p = (e.data ?? {}) as Record<string, unknown>;
  const requestId = p.requestID as string | undefined;
  const info = requestId ? pendingPermissions.get(requestId as string) : undefined;
  if (info && !info.decided) {
    info.decided = true;
    if (info.timeoutHandle) clearTimeout(info.timeoutHandle);
    const reply = (p.reply as string | undefined) ?? "replied";
    if (info.messageId) {
      await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission ${reply} (via OpenCode)</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`).catch((err) => console.warn("[events]", err?.message ?? err));
    }
    if (requestId) pendingPermissions.delete(requestId);
  }
};

const handleSessionExecutionFailed: EventHandler = async (event, deps) => {
  const { tg, oc, store, finishStatus, config } = deps;
  const { findSessionById, resolveChatId, resolveThreadId, lastPromptBySession } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const s = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId !== undefined) {
    const msg = (e.data?.error as { message?: string } | undefined)?.message ?? "execution failed";
    const threadId = resolveThreadId(sessionId);
    // "Provider returned error" and network hiccups are transient too. The
    // classifier keeps deterministic errors (auth/model/context) out of the
    // retry loop while letting rate limits and 5xx/network failures back in.
    const failure = classifyFailure(msg);
    if (failure.ocAlreadyRetrying) {
      logger.info("events", "execution.failed.oc_retrying", { sessionId, msg: msg.slice(0, 120) });
    }
    const autoRetry = config?.AUTO_RETRY_ENABLED ?? true;
    const latestPrompt = sessionId ? lastPromptBySession.get(sessionId) : undefined;
    if (sessionId && latestPrompt) updateRetryPrompt(sessionId, latestPrompt);
    const promptForRetry = latestPrompt;
    if (s?.typingTimer) { clearInterval(s.typingTimer); s.typingTimer = undefined; }
    if (s) {
      s.lastTurnError = msg;
      await finishStatus(chatId, s).catch((err) => console.warn("[events] finishStatus failed", err?.message ?? err));
    }
    if (sessionId && !failure.retryable) cancelAutoRetry(sessionId);

    // Retry only prompts sent by this process and only up to
    // AUTO_RETRY_MAX_ATTEMPTS. Stale prompts restored from disk are ignored.
    const decision = autoRetry && failure.retryable && !failure.ocAlreadyRetrying && sessionId && promptForRetry
      ? decideRetry(sessionId as string, promptForRetry as string, config)
      : ({ action: "none" } as const);

    if (decision.action === "retry") {
      const sid = sessionId as string;
      const prompt = promptForRetry as string;
      dispatchRetry(sid, decision.delay, async () => {
        // Reuse the SAME card message for the retry instead of creating a new
        // one: reset the turn state in place (no refloat) so there is only one
        // message per turn, and the blocks update instead of being duplicated.
        const retrySession = store.findSessionById(sid);
        if (retrySession && chatId !== undefined) {
          retrySession.stopped = false;
          retrySession.statusFinished = false;
          retrySession.buffer = "";
          retrySession.reasoningBuffer = "";
          retrySession.toolCalls = [];
          retrySession.toolCallDetails = [];
          retrySession.activity = createTurnActivity();
          retrySession.transcriptFollow = true;
          retrySession.readingMode = false;
          retrySession.cardMenuExpanded = false;
          retrySession.turnOutputTokens = 0;
          retrySession.turnInputTokens = 0;
          retrySession.turnReasoningTokens = 0;
          retrySession.turnCacheReadTokens = 0;
          retrySession.turnCacheWriteTokens = 0;
          retrySession.turnCost = 0;
          retrySession.turnFirstStreamedAt = undefined;
          retrySession.turnFinishedAt = undefined;
          retrySession.lastTurnError = undefined;
          retrySession.transcriptPage = undefined;
          retrySession.lastFinalMessageId = undefined;
          retrySession.lastFinalTelegramMessageId = undefined;
          retrySession.lastFinalDeliveredPromptStart = undefined;
          retrySession.lastFinalSeparatedPromptStart = undefined;
          retrySession.textEndedHandled = undefined;
          retrySession.sentArtifacts = new Set();
          if (retrySession.transcriptMessageId) {
            retrySession.statusMessageId = retrySession.transcriptMessageId;
            store.rememberStatusMessage(retrySession.sessionId, chatId, retrySession.targetThreadId ?? retrySession.threadId, retrySession.transcriptMessageId);
          }
          await (deps.publishCard ? deps.publishCard(chatId, retrySession) : Promise.resolve()).catch((err) => console.warn("[events] retry publishCard failed", err?.message ?? err));
          // Drop the now-stale retry notice: the card itself shows progress.
          const notice = retryMessageBySession.get(sid);
          if (notice) {
            retryMessageBySession.delete(sid);
            await tg.deleteMessage?.(notice.chatId, notice.messageId).catch(() => {});
          }
          // Restart the live-update interval for the retried turn.
          if (retrySession.statusTimer) { clearInterval(retrySession.statusTimer); retrySession.statusTimer = undefined; }
          retrySession.statusTimer = setInterval(() => {
            deps.updateStatus(chatId, retrySession).catch((err) => console.warn("[events]", String(err)));
          }, 2000);
        }
        // Always use the latest prompt for this session, so a stale captured
        // prompt is never replayed even if state was not cleared in time.
        const latestPrompt = store.lastPromptBySession.get(sid) ?? prompt;
        await oc.prompt(sid, latestPrompt);
      });
      const existingRetryMsg = retryMessageBySession.get(sid);
      const retryText = `${failure.label}\n⏳ Reintentando en ${Math.round(decision.delay / 1000)}s (intento ${decision.attempt}/${decision.maxAttempts})…\n<i>${esc(failure.hint)}</i>`;
      let sent: { message_id?: number } | null = null;
      if (existingRetryMsg) {
        await tg.editRichMessage(existingRetryMsg.chatId, existingRetryMsg.messageId, retryText).catch((err) => console.warn("[events]", err?.message ?? err));
        sent = { message_id: existingRetryMsg.messageId };
      } else {
        sent = await tg.sendRichMessage(chatId, sessionHeader(s ?? null, sessionId) + retryText, threadOpts(threadId)).catch(() => null);
      }
      if (sent?.message_id) retryMessageBySession.set(sid, { chatId, threadId, messageId: sent.message_id });
    } else if (decision.action === "exhausted") {
      const sid = sessionId as string;
      await tg.sendRichMessage(
        chatId,
        sessionHeader(s ?? null, sessionId) + `${failure.label}\n⛔ Reintentos automáticos agotados (${decision.attempts}/${decision.maxAttempts}).\n<i>${esc(failure.hint)}</i>`,
        {
          ...threadOpts(threadId),
          reply_markup: {
            inline_keyboard: [[
              { text: "🔁 Reintentar", callback_data: `retry:${sessionId}` },
              { text: "🧠 Cambiar modelo", callback_data: `panel:ms:${sessionId}` },
            ], [{ text: "📂 Sesiones", callback_data: "panel:sessions" }]],
          },
        },
      ).catch((err) => console.warn("[events] exhausted notice failed", err?.message ?? err));
      retryMessageBySession.delete(sid);
      cancelAutoRetry(sid);
    } else if (decision.action === "none") {
      await tg.sendRichMessage(
        chatId,
        sessionHeader(s ?? null, sessionId) +
          `${failure.label}\n<blockquote expandable>${esc(truncate(msg, 600))}</blockquote>\n<i>${esc(failure.hint)}</i>`,
        {
          ...threadOpts(threadId),
          reply_markup: {
            inline_keyboard: [[
              { text: "🔁 Reintentar", callback_data: `retry:${sessionId}` },
              { text: "🧠 Cambiar modelo", callback_data: `panel:ms:${sessionId}` },
            ]],
          },
        },
      ).catch((err) => console.warn("[events] failure notice failed", err?.message ?? err));
      if (sessionId) retryMessageBySession.delete(sessionId);
    }
    // "wait": a retry is already pending for this prompt; avoid duplicate events.
  }
  // status tracking
  const sid = e.data?.sessionID as string | undefined;
  if (sid) store.setSessionStatus(sid, "idle");
};

/** Normalize the todo items carried by either a todo event or `todowrite`. */
function todoItemsFrom(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((t) => ({
    content: String(t.content ?? ""),
    status: String(t.status ?? "pending"),
    priority: String(t.priority ?? "medium"),
  }));
}

const handleTodoUpdated: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = (e.data?.sessionID ?? (e.data?.session as { id?: string } | undefined)?.id) as string | undefined;
  const todos = todoItemsFrom(e.data?.todos);
  // An empty array is meaningful: the agent cleared the checklist.
  if (!sessionId) return;
  store.rememberTodos(sessionId, todos);
  const chatId = store.resolveChatId(sessionId);
  const s = store.findSessionById(sessionId);
  if (chatId !== undefined && s) updateStatus(chatId, s, true).catch(() => {});
};

/**
 * OpenCode 2.3.0 does not emit a dedicated `todo.updated` event: the agent
 * calls the `todowrite` tool instead, and the items travel in
 * `session.tool.called` (`input.todos`) / `session.tool.success`
 * (`metadata.todos`). Mirror those into the store so the same checklist
 * renders in the card regardless of which event shape OpenCode uses.
 */
function rememberTodosFromTool(deps: EventsDeps, sessionId: string, d: Record<string, unknown>): boolean {
  const name = String(d.name ?? "").toLowerCase();
  // `session.tool.called` / `session.tool.success` omit the tool name, so the
  // todos payload itself is the reliable signal. A name, when present, must
  // still be the todo tool.
  if (name && name !== "todowrite" && name !== "todo") return false;
  const input = (d.input ?? {}) as Record<string, unknown>;
  const metadata = (d.metadata ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(input.todos) ? input.todos
    : Array.isArray(metadata.todos) ? metadata.todos
    : undefined;
  if (!Array.isArray(raw)) return false;
  const todos = todoItemsFrom(raw).filter((t) => t.content.length > 0);
  // `todos: []` clears the checklist; only a missing payload is ignored.
  dtrace("todos", "from_tool", { sessionID: sessionId, name, count: todos.length });
  deps.store.rememberTodos(sessionId, todos);
  return true;
}

const handleMcpEvent: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = (e.data?.sessionID ?? (e.data?.session as { id?: string } | undefined)?.id) as string | undefined;
  if (!sessionId) return;
  const server = String(e.data?.server ?? e.data?.serverName ?? "mcp");
  const text = String(e.data?.text ?? e.data?.message ?? JSON.stringify(e.data ?? {}).slice(0, 200)).slice(0, 300);
  const events = deps.mcpEvents;
  if (events) {
    const list = events.get(sessionId) ?? [];
    list.push({ at: Date.now(), server, text });
    while (list.length > 5) list.shift();
    events.set(sessionId, list);
  }
  const chatId = store.resolveChatId(sessionId);
  const s = store.findSessionById(sessionId);
  if (chatId !== undefined && s) updateStatus(chatId, s, true).catch(() => {});
};

/** Authoritative first-token timestamp from OpenCode (used for ttft). */
const handleSessionStepFirstToken: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  if (!sid) return;
  const s = deps.store.findSessionById(sid);
  if (!s || !s.promptStartTime) return;
  if (!s.turnFirstStreamedAt) s.turnFirstStreamedAt = Date.now();
};

const handleSessionStepStarted: EventHandler = async (event, deps) => {
  const { store } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  if (sid) {
    store.setSessionStatus(sid, "busy");
    logger.debug("events", "[step.started]", sid);
    const chatId = store.resolveChatId(sid);
    await ensureLiveStatus(deps, sid, chatId).catch((err) => console.warn("[events]", err?.message ?? err));
  }
};

const handleSessionRetryScheduled: EventHandler = async (event, deps) => {
  const { tg } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  const attempt = (e.data?.attempt as number | undefined) ?? (e.data?.retryAttempt as number | undefined);
  const delay = (e.data?.delay as number | undefined) ?? (e.data?.retryDelay as number | undefined);
  const reason = (e.data?.error as { message?: string } | undefined)?.message ?? (e.data?.reason as string | undefined);
  if (!sid) return;
  const failure = reason ? classifyFailure(reason) : undefined;
  const label = failure?.label ?? "⏳ Reintentando…";
  const retryText = `${label}\n⏳ Reintento${attempt ? ` ${attempt}` : ""} programado${delay ? ` en ${Math.round(delay / 1000)}s` : ""}…${failure?.hint ? `\n<i>${esc(failure.hint)}</i>` : ""}`;
  const existing = retryMessageBySession.get(sid);
  let sent: { message_id?: number } | null = null;
  const chatId = deps.store.resolveChatId(sid);
  const threadId = deps.store.resolveThreadId(sid);
  if (existing) {
    await tg.editRichMessage(existing.chatId, existing.messageId, retryText).catch((err) => console.warn("[events]", err?.message ?? err));
    sent = { message_id: existing.messageId };
  } else if (chatId !== undefined) {
    const s2 = deps.store.findSessionById(sid);
    sent = await tg.sendRichMessage(chatId, retryText, deps.store.threadOptsFor ? deps.store.threadOptsFor(s2 as any) : {}).catch(() => null);
  }
  if (sent?.message_id && chatId !== undefined) retryMessageBySession.set(sid, { chatId, threadId, messageId: sent.message_id });
};

const handleSessionExecutionStarted: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  if (sid) {
    deps.store.setSessionStatus(sid, "busy");
    logger.debug("events", "[execution.started]", sid);
  }
};

const handleSessionExecutionSucceeded: EventHandler = async (event, deps) => {
  const { store } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  if (sid) {
    store.setSessionStatus(sid, "idle");
    const existing = retryMessageBySession.get(sid);
    if (existing) {
      retryMessageBySession.delete(sid);
      await deps.tg.editRichMessage(existing.chatId, existing.messageId, "✅ Reintento correcto.").catch(() => {});
    }
    logger.debug("events", "[execution.succeeded]", sid);
  }
};

const handleSessionExecutionInterrupted: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  // Do NOT mark the session as user-stopped: OpenCode emits this when a turn
  // pauses for external input (form/permission). Setting stopped=true here
  // made ensureLiveStatus ignore the resumed turn, so no card updates arrived
  // after the user replied to a form.
  if (sid) {
    deps.store.setSessionStatus(sid, "idle");
    logger.info("events", "[execution.interrupted]", sid);
  }
};

const handleSessionStepFailed: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  const err = (e.data?.error as { message?: string } | undefined)?.message;
  logger.debug("events", "[step.failed]", sid, err?.slice(0, 120));
  if (sid) deps.store.setSessionStatus(sid, "idle");
};

const handleSessionUsageUpdated: EventHandler = async (event, deps) => {
  const { store } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  const s = sid ? store.findSessionById(sid) : undefined;
  if (!s) return;
  const usage = (e.data?.usage ?? e.data) as Record<string, unknown> | undefined;
  if (usage) {
    const num = (k: string, alt?: string) => {
      const v = usage[k] ?? (alt ? usage[alt] : undefined);
      return typeof v === "number" ? (v as number) : undefined;
    };
    const inTok = num("inputTokens", "input");
    const outTok = num("outputTokens", "output");
    const reasTok = num("reasoningTokens", "reasoning");
    const crTok = num("cacheReadTokens", "cacheRead");
    const cwTok = num("cacheWriteTokens", "cacheWrite");
    if (inTok !== undefined) s.turnInputTokens = inTok;
    if (outTok !== undefined) s.turnOutputTokens = outTok;
    if (reasTok !== undefined) s.turnReasoningTokens = reasTok;
    if (crTok !== undefined) s.turnCacheReadTokens = crTok;
    if (cwTok !== undefined) s.turnCacheWriteTokens = cwTok;
    if (typeof usage.cost === "number") s.turnCost = usage.cost as number;
  }
  logger.debug("events", "[usage.updated]", sid);
};

const handleSessionShellStarted: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  logger.debug("events", "[shell.started]", sid, (e.data?.command as string | undefined)?.slice(0, 80));
};

const handleSessionShellEnded: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  logger.debug("events", "[shell.ended]", sid);
};

const handleFilesystemChanged: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  logger.debug("events", "[filesystem.changed]", e.data?.path);
};

const handleProviderUpdated: EventHandler = async (_event, deps) => {
  try { deps.oc.invalidateModelCache(); } catch { /* ignore */ }
  logger.debug("events", "[provider.updated]");
};

const handleModelUpdated: EventHandler = async (_event, deps) => {
  try { deps.oc.invalidateModelCache(); } catch { /* ignore */ }
  logger.debug("events", "[model.updated]");
};

const handleSessionMetadataUpdated: EventHandler = async (event, deps) => {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sid = e.data?.sessionID as string | undefined;
  logger.debug("events", "[session.metadata.updated]", sid);
};

const handleSessionIdle: EventHandler = async (event, deps) => {
  const { store, finishStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const s = sessionId ? findSessionById(sessionId) : undefined;
  // status tracking (set idle) first, preserving original ordering
  const sid = e.data?.sessionID as string | undefined;
  if (sid) store.setSessionStatus(sid, "idle");
  if (s?.typingTimer) {
    clearInterval(s.typingTimer);
    s.typingTimer = undefined;
  }
  // Fallback turn-end signal for servers that emit session.idle.
  const chatId = resolveChatId(sessionId);
  if (s && chatId !== undefined && s.statusMessageId && !s.stopped) {
    await finishStatus(chatId, s).catch((err) => console.warn("[events]", err?.message ?? err));
  }
};

export const defaultHandler: EventHandler = async () => {};

export const eventHandlers = new Map<string, EventHandler>([
  ["todo.updated", handleTodoUpdated],
  ["session.todo.updated", handleTodoUpdated],
  ["session.text.started", handleSessionTextStarted],
  ["session.reasoning.started", handleSessionReasoningStarted],
  ["session.reasoning.delta", handleSessionReasoningDelta],
  ["session.skill.activated", handleSessionSkillActivated],
  ["session.tool.input.started", handleSessionToolInputStarted],
  ["session.tool.called", handleSessionToolCalled],
  ["session.tool.success", handleSessionToolSuccess],
  ["session.tool.progress", handleSessionToolProgress],
  ["session.model.selected", handleSessionModelSelected],
  ["session.inbox.enqueued", handleSessionInbox],
  ["session.inbox.delivered", handleSessionInbox],
  ["session.inbox.cancelled", handleSessionInbox],
  ["session.inbox.delivery.changed", handleSessionInbox],
  ["session.tool.failed", handleSessionToolFailed],
  ["session.compaction.started", handleSessionCompactionStarted],
  ["session.compaction.delta", handleSessionCompactionDelta],
  ["session.compaction.ended", handleSessionCompactionEnded],
  ["session.compaction.failed", handleSessionCompactionFailed],
  ["mcp.status.changed", handleMcpStatusChanged],
  ["mcp.resources.changed", handleMcpResourcesChanged],
  ["session.text.delta", handleSessionTextDelta],
  ["session.step.ended", handleSessionStepEnded],
  ["session.text.ended", handleSessionTextEnded],
  ["permission.asked", handlePermissionAsked],
  ["form.created", handleFormCreated],
  ["form.replied", handleFormExternal],
  ["form.cancelled", handleFormExternal],
  ["permission.replied", handlePermissionReplied],
  ["session.execution.failed", handleSessionExecutionFailed],
  ["session.step.started", handleSessionStepStarted],
  ["session.step.first-token", handleSessionStepFirstToken],
  ["session.idle", handleSessionIdle],
  ["experimental.mcp.event", handleMcpEvent],
  ["session.retry.scheduled", handleSessionRetryScheduled],
  ["session.execution.started", handleSessionExecutionStarted],
  ["session.execution.succeeded", handleSessionExecutionSucceeded],
  ["session.execution.interrupted", handleSessionExecutionInterrupted],
  ["session.step.failed", handleSessionStepFailed],
  ["session.usage.updated", handleSessionUsageUpdated],
  ["session.usage.recorded", handleSessionUsageUpdated],
  ["session.shell.started", handleSessionShellStarted],
  ["session.shell.ended", handleSessionShellEnded],
  ["filesystem.changed", handleFilesystemChanged],
  ["provider.updated", handleProviderUpdated],
  ["model.updated", handleModelUpdated],
  ["session.metadata.updated", handleSessionMetadataUpdated],
  ["session.renamed", handleSessionMetadataUpdated],
]);

export async function handleEvent(event: { type: string; data?: unknown }, deps: EventsDeps): Promise<void> {
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = (e.data?.sessionID ?? (e.data?.session as { id?: string } | undefined)?.id) as string | undefined;
  // Register sub-sessions (e.g. spawned by a goal) to their parent's chat so
  // their events are not dropped.
  if (sessionId && !deps.store.findSessionById(sessionId)) {
    try {
      const res = await deps.oc.client.session.get({ sessionID: sessionId });
      const sess = (res as { data?: Record<string, unknown> })?.data ?? res;
      const parentId = (sess as { parentID?: string; parent?: string })?.parentID
        ?? (sess as { parent?: string })?.parent;
      // Register the child even when the parent has no bound chat: the card
      // must be able to list which subagent sessions exist, not just count
      // the ones that happen to have a Telegram route.
      if (parentId) {
        deps.store.rememberSubagent(parentId, sessionId, (sess as { title?: string })?.title);
      }
      const parentChat = parentId ? deps.store.resolveChatId(parentId) : undefined;
      if (parentChat !== undefined) {
        deps.store.rememberSessionChat(sessionId, parentChat);
        deps.store.rememberLastChat(sessionId, parentChat);
        const cs: ChatSession = {
          sessionId,
          directory: (sess as { location?: { directory?: string }; directory?: string })?.location?.directory
            ?? (sess as { directory?: string })?.directory,
          model: undefined,
          buffer: "",
          reasoningBuffer: "",
          toolCalls: [],
          toolCallDetails: [],
          stopped: false,
          targetChatId: parentChat,
          cotBuffer: "",
          cotCount: 0,
          topicTitle: (sess as { title?: string })?.title,
          parentId,
        };
        deps.store.sessionsById.set(sessionId, cs);
      }
    } catch (err) {
    }
  }
  const knownChild = sessionId ? deps.store.findSessionById(sessionId) : undefined;
  if (knownChild?.parentId) {
    deps.store.rememberSubagent(knownChild.parentId, knownChild.sessionId, knownChild.topicTitle);
  }
  logger.debug("events", e.type, JSON.stringify(e.data ?? {}).slice(0, 300));
  const _item = e.data?.item as { type?: string; payload?: { text?: string } } | undefined;
  dtrace("evt", "in", { type: e.type, sessionID: (e.data?.sessionID ?? (e.data?.session as { id?: string } | undefined)?.id) as string | undefined, text: typeof e.data?.text === "string" ? (e.data.text as string).slice(0, 80) : undefined, itemType: _item?.type, itemText: _item?.payload?.text?.slice(0, 80), inboxID: e.data?.inboxID });

  let handler = eventHandlers.get(e.type);
  if (!handler && e.type.startsWith("session.text.ended")) {
    handler = eventHandlers.get("session.text.ended");
  }
  if (!handler) handler = defaultHandler;
  await handler(e, deps);
}

const EVENT_HANDLER_SLOW_MS = 15_000;

/**
 * Run a handler in order. A slow/stuck await must NOT be "timed out" by
 * advancing the chain: Promise.race never cancels the losing handler, so the
 * next event would run concurrently over the same session and corrupt state
 * (e.g. a text.ended still writing while a newer prompt started). Instead we
 * keep the chain strictly serial and only WARN when a handler is slow, so a
 * stalled final answer can still be delivered instead of being silently lost.
 */
function handleEventGuarded(event: { type: string; data?: unknown }, deps: EventsDeps): Promise<void> {
  const type = (event as { type?: string }).type;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Advance the chain even if a handler hangs (e.g. editRichMessage waiting on
  // Telegram backoff). Turn guards (turnGeneration / lastFinalTurn /
  // answeredPromptAt) prevent the late handler from corrupting newer turns.
  return Promise.race([
    handleEvent(event as { type: string; data?: Record<string, unknown> }, deps),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, EVENT_HANDLER_SLOW_MS); }),
  ]).then(() => {
    if (timer) clearTimeout(timer);
  }).catch((err) => {
    console.error("[events] handler failed", type, err);
    if (timer) clearTimeout(timer);
  });
}

export function startEventLoop(deps: EventsDeps): void {
  // Chain handlers globally so ordering is preserved, but never block the
  // stream: each event is dispatched as soon as it arrives, with a timeout so
  // a single stuck handler cannot stall every subsequent event.
  let chain: Promise<void> = Promise.resolve();
  (async () => {
    while (true) {
      try {
        for await (const event of deps.oc.events()) {
          chain = chain.then(() => handleEventGuarded(event, deps));
        }
      } catch (err) {
        console.error("[events] stream ended", err);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
}