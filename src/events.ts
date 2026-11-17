import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { FormField, FormState, PermissionInfo } from "./context.js";
import type { SettingsStore } from "./settings.js";
import { renderForm, formKeyboard } from "./formui.js";
import { clampText, esc, markdownToHtml, sessionHeader, threadOpts, toolIcon } from "./util.js";
import { splitBySections, splitMarkdown } from "./transcript.js";
import { logger } from "./logger.js";
import type { TodoItem } from "./todos.js";

const MAX_ARTIFACT_CANDIDATES = 20;
const MAX_ARTIFACTS = 5;
import { formatBytes, MAX_DOCUMENT_BYTES, prepareDocument } from "./files/index.js";
import { cancelAutoRetry, decideRetry, dispatchRetry, noteTurnCompleted, updateRetryPrompt } from "./autoretry.js";
import type { TranscriptManager } from "./transcriptmanager.js";
import { renderResourceBlock } from "./resources.js";

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
  s.reasoningBuffer += String(e.data?.delta ?? "");
  updateStatus(chatId, s).catch((err) => console.warn("[events]", err?.message ?? err));
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
  s.toolCallDetails.push({ id, name, status: "running" });
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
  applyToolEvent(deps, event, (detail, d) => {
    const input = d.input;
    detail.input = typeof input === "string" ? input : JSON.stringify(input ?? "");
  });

const handleSessionToolSuccess: EventHandler = async (event, deps) =>
  applyToolEvent(deps, event, (detail, d) => {
    detail.status = "success";
    const out = d.content ?? d.output;
    detail.output = typeof out === "string" ? out.slice(0, 2000) : JSON.stringify(out ?? "").slice(0, 2000);
  });

const handleSessionToolFailed: EventHandler = async (event, deps) =>
  applyToolEvent(deps, event, (detail, d) => {
    detail.status = "failed";
    detail.output = ((d.error as { message?: string } | undefined)?.message ?? "failed").slice(0, 2000);
  });

const handleSessionCompactionStarted: EventHandler = async (event, deps) => {
  const { tg, store, updateStatus } = deps;
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
    if (s && s.statusMessageId) updateStatus(chatId, s, true).catch((err) => console.warn("[events]", err?.message ?? err));
    else {
      const threadId = resolveThreadId(sessionId);
      const _cm = await tg.sendRichMessage(chatId, sessionHeader(s) + "📦 <b>Compacting context…</b>", threadOpts(threadId)).catch(() => undefined);
      if (_cm?.message_id) store.rememberMessageSession(chatId, _cm.message_id, sessionId);
    }
  } else {
    const threadId = resolveThreadId(sessionId);
    const _cm2 = await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + "📦 <b>Compacting context…</b>", threadOpts(threadId)).catch(() => undefined);
    if (_cm2?.message_id) store.rememberMessageSession(chatId, _cm2.message_id, sessionId);
  }
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
  const { tg, store, updateStatus } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = e.data?.sessionID as string | undefined;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !sessionId) return;
  const s = _s0;
  const threadId = resolveThreadId(sessionId) as number | undefined;
  const summary = String(e.data?.text ?? "").trim();
  const tokens = e.data?.tokens as { input?: number; output?: number } | undefined;
  const tokenText = tokens ? ` · ${((tokens.input ?? 0) + (tokens.output ?? 0)).toLocaleString()} tokens` : "";
  if (s) {
    s.compacting = false;
    s.compactionError = undefined;
    s.compactionSummary = summary ? (summary + (tokenText ? `\n${tokenText.trim()}` : "")) : (s.compactionSummary ?? "");
    if (s.statusMessageId) {
      updateStatus(chatId, s, true).catch((err) => console.warn("[events]", err?.message ?? err));
    } else {
      const shortSummary = summary.slice(0, 900);
      const truncated = summary.length > shortSummary.length;
      const body = summary
        ? `<blockquote expandable>📦 Summary\n<pre>${esc(shortSummary)}${truncated ? "\n…" : ""}</pre></blockquote>`
        : "";
      await tg
        .sendRichMessage(chatId, sessionHeader(s) + `📦 <b>Compaction complete</b>${tokenText}${body ? "\n" + body : ""}`, threadOpts(threadId))
        .catch((err) => console.warn("[events]", err?.message ?? err));
    }
  } else {
    const shortSummary = summary.slice(0, 900);
    const truncated = summary.length > shortSummary.length;
    const body = summary
      ? `<blockquote expandable>📦 Summary\n<pre>${esc(shortSummary)}${truncated ? "\n…" : ""}</pre></blockquote>`
      : "";
    await tg
      .sendRichMessage(chatId, sessionHeader(null, sessionId) + `📦 <b>Compaction complete</b>${tokenText}${body ? "\n" + body : ""}`, threadOpts(threadId))
      .catch((err) => console.warn("[events]", err?.message ?? err));
  }
  logger.info("events", "compaction.ended", { sessionId, chatId, threadId, summaryLen: summary.length, usedStatus: !!(s?.statusMessageId) });
};

const handleSessionCompactionFailed: EventHandler = async (event, deps) => {
  const { tg, store, updateStatus } = deps;
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
    if (s && s.statusMessageId) updateStatus(chatId, s, true).catch((err) => console.warn("[events]", err?.message ?? err));
    else { const _cf = await tg.sendRichMessage(chatId, sessionHeader(s) + `❌ <b>Compaction failed</b>: ${esc(msg)}`, threadOpts(threadId)).catch(() => undefined); if (_cf?.message_id) store.rememberMessageSession(chatId, _cf.message_id, sessionId); }
  } else {
    const _cf2 = await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + `❌ <b>Compaction failed</b>: ${esc(msg)}`, threadOpts(threadId)).catch(() => undefined);
    if (_cf2?.message_id) store.rememberMessageSession(chatId, _cf2.message_id, sessionId);
  }
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
  const delta = String(e.data?.delta ?? e.data?.text ?? "");
  if (delta) {
    s.buffer += delta;
    // First streamed token timestamp (authoritative metric for tok/s in 2.3.0).
    if (!s.turnFirstStreamedAt) s.turnFirstStreamedAt = Date.now();
  }
  // Coalesce a burst of deltas into a single card update (500ms). updateStatus
  // still applies its own throttle and the adaptive 429 backoff.
  if (!s.deltaFlushTimer) {
    s.deltaFlushTimer = setTimeout(() => {
      s.deltaFlushTimer = undefined;
      // Resolve the delivery target at flush time: the session may have moved
      // to another tab during the 500ms coalescing window.
      const targetChat = deps.store.resolveChatId(s.sessionId) ?? chatId;
      updateStatus(targetChat, s).catch((err) => console.warn("[events]", err?.message ?? err));
    }, 500);
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
  const out = (e.data?.tokens as { output?: number } | undefined)?.output;
  if (typeof out === "number") {
    s.lastOutputTokens = out;
    // Accumulate across all steps of this turn (multi-step tool calls).
    s.turnOutputTokens = (s.turnOutputTokens ?? 0) + out;
  }
  const inp = (e.data?.tokens as { input?: number } | undefined)?.input;
  const cacheRead = ((e.data?.tokens as { cache?: { read?: number } } | undefined)?.cache?.read) ?? 0;
  if (typeof inp === "number") s.lastContextTokens = inp + (typeof cacheRead === "number" ? cacheRead : 0);
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
        await tg.editRichMessage(retryNotice.chatId, retryNotice.messageId, "✅ Retry succeeded.").catch((err) => console.warn("[events]", err?.message ?? err));
      }
    }
  }
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  logger.breadcrumb("events", "text.ended.entry", { sessionId, hasSession: !!_s0, chatId });

  if (chatId === undefined) return;
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
    const candidateFinal = ((e.data?.text ?? "").toString().trim()) || s.buffer || "(empty response)";
    if (
      s.promptStartTime !== undefined &&
      s.lastFinalDeliveredPromptStart === s.promptStartTime &&
      s.lastFinalText === candidateFinal
    ) {
      logger.breadcrumb("events", "text.ended.duplicate", { sessionId, reason: "same-turn-content" });
      return;
    }
  }
  if (!s) {
    // No in-memory session (e.g. after restart). Still deliver the final text if available.
    const fallbackText = String((e as { data?: Record<string, unknown> }).data?.text ?? "").trim();
    if (fallbackText) {
      const sent = await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + markdownToHtml(fallbackText), threadOpts(resolveThreadId(sessionId as string))).catch((err) => { console.error("[send final]", err); return undefined; });
      if (sent?.message_id && sessionId) store.rememberMessageSession(chatId, sent.message_id, sessionId);
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
    logger.breadcrumb("events", "text.ended.flush", { sessionId, statusMsg: s.statusMessageId, finished: s.statusFinished, stopped: s.stopped });
    if (s && s.statusMessageId && !s.statusFinished) {
      await finishStatus(chatId, s).catch((err) => console.error("[finishStatus error]", err));
    }
    endedText = String(e.data?.text ?? "").trim();
    let finalText = endedText || s.buffer || "(empty response)";
    let elapsed = 0;
    // Tokens are accumulated across ALL steps of the turn (multi-step tool
    // calls), not just the last one (fix B1/B2).
    let tokens = s.turnOutputTokens ?? s.lastOutputTokens ?? 0;
    let streamedAt = s.turnFirstStreamedAt;
    try {
      const msgId = (e as { data?: Record<string, unknown> }).data?.assistantMessageID as string | undefined;
      if (msgId) {
        const m = await oc.client.session.message.get({ sessionID: s.sessionId, messageID: msgId });
        const t = (m as { time?: { completed?: number; streamed?: number; created?: number } })?.time;
        if (t?.streamed && !streamedAt) streamedAt = t.streamed;
        if (t?.completed) {
          // Prefer the API's streamed→completed window (OpenCode 2.3.0 metric).
          const start = t.streamed || streamedAt || t.created;
          if (start && t.completed > start) elapsed = (t.completed - start) / 1000;
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
      s.lastFinalDeliveredPromptStart = s.promptStartTime;
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
    const copyText = esc(finalText.slice(0, 200)).replace(/"/g, "&quot;");
    const answerHtml = markdownToHtml(finalText);
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
      if (publishCard) await publishCard(chatId, s).catch((err) => console.warn("[events] publishCard failed", err?.message ?? err));
      else await transcript.publish(chatId, s, { extraTop: "" }).catch((err) => console.warn("[events] transcript.publish failed", err?.message ?? err));
      if (s.transcriptMessageId) {
        s.lastFinalTelegramMessageId = s.transcriptMessageId;
        // Deep link button to jump to this message in the chat.
        if (chatId < 0) {
          const internalId = String(chatId).replace(/^-100/, "");
          const url = `https://t.me/c/${internalId}/${s.transcriptMessageId}`;
          const kb: Array<Array<Record<string, unknown>>> = [...(transcript.cardKeyboard(s, s.transcriptPage ?? 0, transcript.pageCount(s), { unified: settings.get(chatId).displayMode === "unified" }))];
          kb.push([{ text: "🔗 Ver en chat", url }]);
          // Do not block the turn-end handler: let the card publish settle,
          // then add the deep-link button (fire-and-forget).
          const cardId = s.transcriptMessageId;
          setTimeout(() => {
            void tg.editMessageReplyMarkup(chatId, cardId, { inline_keyboard: kb }).catch((err) => console.warn("[events] deep-link markup failed", err?.message ?? err));
          }, 400);
        }
      }
      // Optional: deliver the final answer as a separate rich-text message for readability.
      const st = settings.get(chatId);
      const sendSeparately =
        st.longAnswerDelivery === "message" ||
        (st.longAnswerDelivery === "auto" && finalText.length > st.longAnswerThreshold);
      if (sendSeparately) {
        if (s.lastFinalSeparatedPromptStart !== s.promptStartTime) {
          s.lastFinalSeparatedPromptStart = s.promptStartTime;
          // Prefer section-aware splitting: one part per markdown section
          // (headings) so code blocks are never cut mid-way. Falls back to
          // size-based splitting when there are no usable headings.
          const sections = splitBySections(finalText, 3200);
          const parts = sections.length ? sections : splitMarkdown(finalText, 3200);
          for (let i = 0; i < parts.length; i++) {
            const prefix = parts.length > 1 ? `<i>(${i + 1}/${parts.length})</i>\n` : "";
            const resourceSuffix = i === parts.length - 1 ? `\n${renderResourceBlock(s)}` : "";
            const piece = `${sessionHeader(s, undefined, (settings.get(chatId).sessionNameInMessages ?? true))}${prefix}<blockquote>${markdownToHtml(parts[i])}</blockquote>${resourceSuffix}`;
            await tg.sendRichMessage(chatId, clampText(piece, 3900), threadOpts2).catch((err) => console.warn("[events]", err?.message ?? err));
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
            const out = (d.output ?? "").toString().trim().slice(0, 400);
            return `$ ${esc(cmd)}${out ? `\n${esc(out)}` : ""}${d.status === "failed" ? "\n(failed)" : ""}`;
          }).join("\n\n");
          extraHtml += `\n\n<blockquote expandable>🖥 Shell (${shellDetails.length})\n<pre>${body}</pre></blockquote>`;
        }
        if (otherDetails.length) {
          const body = otherDetails.slice(-20).map((d) => {
            const inp = d.input ? esc(d.input.slice(0, 180)) : "";
            const out = (d.output ?? "").toString().trim();
            const outShort = out ? esc(out.slice(0, 220)) : "";
            return `${toolIcon(d.name)} <b>${esc(d.name)}</b>${inp ? `\n<i>${inp}</i>` : ""}${outShort ? `\n<code>${outShort}</code>` : ""}${d.status === "failed" ? " <i>(failed)</i>" : ""}`;
          }).join("\n\n");
          extraHtml += `\n\n<blockquote expandable>🔧 Tool calls (${otherDetails.length})\n${body}</blockquote>`;
        }
      }
      const finalHtml = sessionHeader(s, undefined, (settings.get(chatId).sessionNameInMessages ?? true)) + `<blockquote>${answerHtml}</blockquote>` + extraHtml + copyRow + `\n${renderResourceBlock(s)}`;
      // Always send a new message: editing the previous final is confusing.
      const finalMessage = await tg.sendRichMessage(chatId, clampText(finalHtml, 3900), { ...threadOpts2, reply_markup: { inline_keyboard: quickKeyboard } }).catch((err) => {
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
          { text: "✅ Always (admin)", callback_data: `perm:always:${requestId}` },
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
  }, 5 * 60 * 1000);
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
          { value: "true", label: "Yes" },
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
  }
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
    const isRateLimit = /rate limit|quota/i.test(msg);
    // OpenCode 2.3.0 retries exhausted rate limits internally (#59816). If the
    // error already mentions a retry/backoff, don't stack our own notice.
    const ocAlreadyRetrying = /retr(y|ying)|backoff|will retry|retrying in/i.test(msg);
    const hint = isRateLimit ? "\n\nTry switching model with /models." : "";
    if (ocAlreadyRetrying) {
      logger.info("events", "execution.failed.oc_retrying", { sessionId, msg: msg.slice(0, 120) });
    }
    const autoRetry = config?.AUTO_RETRY_ENABLED ?? true;
    const latestPrompt = sessionId ? lastPromptBySession.get(sessionId) : undefined;
    if (sessionId && latestPrompt) updateRetryPrompt(sessionId, latestPrompt);
    const promptForRetry = latestPrompt;
    if (s?.typingTimer) { clearInterval(s.typingTimer); s.typingTimer = undefined; }
    if (s) await finishStatus(chatId, s).catch((err) => console.warn("[events] finishStatus failed", err?.message ?? err));
    if (sessionId && !isRateLimit) cancelAutoRetry(sessionId);

    // Retry only prompts sent by this process and only up to
    // AUTO_RETRY_MAX_ATTEMPTS. Stale prompts restored from disk are ignored.
    const decision = autoRetry && isRateLimit && !ocAlreadyRetrying && sessionId && promptForRetry
      ? decideRetry(sessionId as string, promptForRetry as string, config)
      : ({ action: "none" } as const);

    if (decision.action === "retry") {
      const sid = sessionId as string;
      const prompt = promptForRetry as string;
      dispatchRetry(sid, decision.delay, async () => {
        // Start a fresh turn/card for the retry so the previous answer is not
        // re-rendered on the same page and stale blocks do not accumulate.
        const retrySession = store.findSessionById(sid);
        if (retrySession && chatId !== undefined) {
          retrySession.stopped = false;
          retrySession.statusFinished = false;
          retrySession.buffer = "";
          retrySession.reasoningBuffer = "";
          retrySession.toolCalls = [];
          retrySession.toolCallDetails = [];
          retrySession.transcriptFollow = true;
          await deps.startStatus(chatId, retrySession).catch((err) => console.warn("[events] retry startStatus failed", err?.message ?? err));
        }
        // Always use the latest prompt for this session, so a stale captured
        // prompt is never replayed even if state was not cleared in time.
        const latestPrompt = store.lastPromptBySession.get(sid) ?? prompt;
        await oc.prompt(sid, latestPrompt);
        const existing = retryMessageBySession.get(sid);
        if (existing) {
          await tg
            .editRichMessage(existing.chatId, existing.messageId, `⏳ Retry ${decision.attempt}/${decision.maxAttempts} sent; waiting for the model…`)
            .catch((err) => console.warn("[events]", err?.message ?? err));
        }
      });
      const existingRetryMsg = retryMessageBySession.get(sid);
      const retryText = `⏳ <b>Rate limited</b>\nRetrying in ${Math.round(decision.delay / 1000)}s (attempt ${decision.attempt}/${decision.maxAttempts})…`;
      let sent: { message_id?: number } | null = null;
      if (existingRetryMsg) {
        await tg.editRichMessage(existingRetryMsg.chatId, existingRetryMsg.messageId, retryText).catch((err) => console.warn("[events]", err?.message ?? err));
        sent = { message_id: existingRetryMsg.messageId };
      } else {
        sent = await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + retryText, threadOpts(threadId)).catch(() => null);
      }
      if (sent?.message_id) retryMessageBySession.set(sid, { chatId, threadId, messageId: sent.message_id });
    } else if (decision.action === "exhausted") {
      const sid = sessionId as string;
      await tg.sendRichMessage(
        chatId,
        sessionHeader(null, sessionId) + `❌ ${esc(msg)}${esc(hint)}\n\n⛔ Auto-retry limit reached (${decision.attempts}/${decision.maxAttempts}). Use /retry to try again manually.`,
        { ...threadOpts(threadId), reply_markup: { inline_keyboard: [[{ text: "🧠 Cambiar modelo", callback_data: `panel:ms:${sessionId}` }, { text: "📂 Sesiones", callback_data: "panel:sessions" }]] } },
      ).catch((err) => console.warn("[events] exhausted notice failed", err?.message ?? err));
      retryMessageBySession.delete(sid);
      cancelAutoRetry(sid);
    } else if (decision.action === "none") {
      await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + `❌ ${esc(msg)}${esc(hint)}`, threadOpts(threadId)).catch((err) => console.warn("[events] failure notice failed", err?.message ?? err));
      if (sessionId) retryMessageBySession.delete(sessionId);
    }
    // "wait": a retry is already pending for this prompt; avoid duplicate events.
  }
  // status tracking
  const sid = e.data?.sessionID as string | undefined;
  if (sid) store.setSessionStatus(sid, "idle");
};

const handleTodoUpdated: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const e = event as { type: string; data?: Record<string, unknown> };
  const sessionId = (e.data?.sessionID ?? (e.data?.session as { id?: string } | undefined)?.id) as string | undefined;
  const raw = Array.isArray(e.data?.todos) ? (e.data.todos as Array<Record<string, unknown>>) : [];
  if (!sessionId) return;
  const todos: TodoItem[] = raw.map((t) => ({
    content: String(t.content ?? ""),
    status: String(t.status ?? "pending"),
    priority: String(t.priority ?? "medium"),
  }));
  store.rememberTodos(sessionId, todos);
  const chatId = store.resolveChatId(sessionId);
  const s = store.findSessionById(sessionId);
  if (chatId !== undefined && s) updateStatus(chatId, s, true).catch(() => {});
};

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
  ["session.tool.input.started", handleSessionToolInputStarted],
  ["session.tool.called", handleSessionToolCalled],
  ["session.tool.success", handleSessionToolSuccess],
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
  ["permission.replied", handlePermissionReplied],
  ["session.execution.failed", handleSessionExecutionFailed],
  ["session.step.started", handleSessionStepStarted],
  ["session.idle", handleSessionIdle],
  ["experimental.mcp.event", handleMcpEvent],
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
  logger.debug("events", e.type, JSON.stringify(e.data ?? {}).slice(0, 300));

  let handler = eventHandlers.get(e.type);
  if (!handler && e.type.startsWith("session.text.ended")) {
    handler = eventHandlers.get("session.text.ended");
  }
  if (!handler) handler = defaultHandler;
  await handler(e, deps);
}

export function startEventLoop(deps: EventsDeps): void {
  (async () => {
    while (true) {
      try {
        for await (const event of deps.oc.events()) {
          await handleEvent(event as { type: string; data?: any }, deps);
        }
      } catch (err) {
        console.error("[events] stream ended", err);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
}