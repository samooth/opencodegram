import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { FormField, FormState } from "./context.js";
import type { SettingsStore } from "./settings.js";
import { renderForm, formKeyboard } from "./formui.js";
import { clampText, esc, markdownToHtml, rateLimitRetryAt, sessionHeader, threadOpts, toolIcon } from "./util.js";
import { logger } from "./logger.js";
import { formatBytes, prepareDocument } from "./files/index.js";
import { cancelAutoRetry, decideRetry, dispatchRetry, noteTurnCompleted } from "./autoretry.js";
import type { TranscriptManager } from "./transcriptmanager.js";
import { renderResourceBlock } from "./resources.js";

export type PermissionInfo = {
  chatId: number;
  sessionId: string;
  messageId?: number;
  decided: boolean;
  label: string;
  resource: string;
};

export type EventsDeps = {
  tg: TelegramClient;
  oc: OpenCodeBridge;
  config?: Config;
  store: SessionStore;
  pendingPermissions: Map<string, PermissionInfo>;
  pendingForms: Map<number, FormState>;
  pendingFormsById: Map<string, number>;
  messageToSession: Map<string, string>;
  settings: SettingsStore;
  flushDraft: (chatId: number, s: ChatSession | undefined) => Promise<void>;
  startStatus: (chatId: number, s: ChatSession) => Promise<void>;
  updateStatus: (chatId: number, s: ChatSession, force?: boolean) => Promise<void>;
  finishStatus: (chatId: number, s: ChatSession) => Promise<unknown>;
  syncTopicTitle: (chatId: number, s: ChatSession) => Promise<void>;
  /** Session card: one paginated message per session. */
  transcript?: TranscriptManager;
  /** Republish the session card (live strip or Done strip). */
  publishCard?: (chatId: number, s: ChatSession) => Promise<void>;
  /** Structured per-session trace. */
  sessionTrace?: (event: string, fields: Record<string, unknown>) => void;
};

const retryMessageBySession = new Map<string, { chatId: number; threadId?: number; messageId: number }>();

type EventHandler = (event: { type: string; data?: any }, deps: EventsDeps) => Promise<void>;

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
  const e = event;
  const sessionId = e.data?.sessionID ?? e.data?.session?.id;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = await ensureLiveStatus(deps, sessionId, chatId);
  if (!s) return;
  // Ensure per-block buffer/typing state is reset even when status already live.
  s.buffer = "";
  if (!s.draftId) s.draftId = Math.floor(Math.random() * 2147483647) + 1;
  s.stopped = false;
  if (s.typingTimer) clearInterval(s.typingTimer);
  s.typingTimer = setInterval(() => {
    tg.sendChatAction(chatId, "typing", s.threadId ?? s.targetThreadId).catch(() => {});
  }, 4000);
  tg.sendChatAction(chatId, "typing", s.threadId ?? s.targetThreadId).catch(() => {});
};

const handleSessionReasoningStarted: EventHandler = async (event, deps) => {
  const { store } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  // Preserve earlier reasoning across multiple reasoning blocks in one turn.
  if (s.reasoningBuffer.trim()) s.reasoningBuffer += "\n\n---\n\n";
};

const handleSessionReasoningDelta: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  s.reasoningBuffer += e.data?.delta ?? "";
  updateStatus(chatId, s).catch(() => {});
};

const handleSessionToolInputStarted: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  if (e.data?.name) s.toolCalls.push(e.data.name);
  const id = e.data?.id ?? String(s.toolCallDetails.length);
  s.toolCallDetails.push({ id, name: e.data?.name ?? "tool", status: "running" });
  updateStatus(chatId, s, true).catch(() => {});
};

const handleSessionToolCalled: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  const id = e.data?.id;
  let detail = id ? s.toolCallDetails.find((d) => d.id === id) : undefined;
  if (!detail && s.toolCallDetails.length) {
    // Fall back to the most recent running tool when the event omits an id.
    detail = [...s.toolCallDetails].reverse().find((d) => d.status === "running") ?? s.toolCallDetails[s.toolCallDetails.length - 1];
  }
  if (detail) {
    const input = e.data?.input;
    detail.input = typeof input === "string" ? input : JSON.stringify(input ?? "");
    if (id && detail.id !== id) detail.id = id;
  }
  updateStatus(chatId, s, true).catch(() => {});
};

const handleSessionToolSuccess: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  const id = e.data?.id;
  let detail = id ? s.toolCallDetails.find((d) => d.id === id) : undefined;
  if (!detail && s.toolCallDetails.length) {
    detail = [...s.toolCallDetails].reverse().find((d) => d.status === "running") ?? s.toolCallDetails[s.toolCallDetails.length - 1];
  }
  if (detail) {
    detail.status = "success";
    const out = e.data?.content ?? e.data?.output;
    detail.output = typeof out === "string" ? out.slice(0, 2000) : JSON.stringify(out ?? "").slice(0, 2000);
    if (id && detail.id !== id) detail.id = id;
  }
  updateStatus(chatId, s, true).catch(() => {});
};

const handleSessionToolFailed: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  const id = e.data?.id;
  let detail = id ? s.toolCallDetails.find((d) => d.id === id) : undefined;
  if (!detail && s.toolCallDetails.length) {
    detail = [...s.toolCallDetails].reverse().find((d) => d.status === "running") ?? s.toolCallDetails[s.toolCallDetails.length - 1];
  }
  if (detail) {
    detail.status = "failed";
    detail.output = e.data?.error?.message ?? "failed";
    if (id && detail.id !== id) detail.id = id;
  }
  updateStatus(chatId, s, true).catch(() => {});
};

const handleSessionCompactionStarted: EventHandler = async (event, deps) => {
  const { tg, store, updateStatus } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  logger.info("events", "compaction.started", { sessionId, chatId, hasSession: !!_s0 });
  if (chatId === undefined) return;
  const s = _s0;
  if (s) {
    s.compacting = true;
    s.compactionError = undefined;
    s.compactionSummary = undefined;
    if (s.statusMessageId) updateStatus(chatId, s, true).catch(() => {});
    else {
      const threadId = resolveThreadId(sessionId);
      await tg.sendRichMessage(chatId, sessionHeader(s) + "📦 <b>Compacting context…</b>", threadOpts(threadId)).catch(() => {});
    }
  } else {
    const threadId = resolveThreadId(sessionId);
    await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + "📦 <b>Compacting context…</b>", threadOpts(threadId)).catch(() => {});
  }
};

const handleSessionCompactionDelta: EventHandler = async (event, deps) => {
  const { store, updateStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (s) {
    s.compactionSummary = (s.compactionSummary ?? "") + (e.data?.text ?? "");
    if (s.statusMessageId) updateStatus(chatId, s).catch(() => {});
  }
};

const handleSessionCompactionEnded: EventHandler = async (event, deps) => {
  const { tg, store, updateStatus } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  const threadId = resolveThreadId(sessionId);
  const summary = (e.data?.text ?? "").trim();
  const tokens = e.data?.tokens;
  const tokenText = tokens ? ` · ${((tokens.input ?? 0) + (tokens.output ?? 0)).toLocaleString()} tokens` : "";
  if (s) {
    s.compacting = false;
    s.compactionError = undefined;
    s.compactionSummary = summary ? (summary + (tokenText ? `\n${tokenText.trim()}` : "")) : (s.compactionSummary ?? "");
    if (s.statusMessageId) {
      updateStatus(chatId, s, true).catch(() => {});
    } else {
      const shortSummary = summary.slice(0, 900);
      const truncated = summary.length > shortSummary.length;
      const body = summary
        ? `<blockquote expandable>📦 Summary\n<pre>${esc(shortSummary)}${truncated ? "\n…" : ""}</pre></blockquote>`
        : "";
      await tg
        .sendRichMessage(chatId, sessionHeader(s) + `📦 <b>Compaction complete</b>${tokenText}${body ? "\n" + body : ""}`, threadOpts(threadId))
        .catch(() => {});
    }
  } else {
    const shortSummary = summary.slice(0, 900);
    const truncated = summary.length > shortSummary.length;
    const body = summary
      ? `<blockquote expandable>📦 Summary\n<pre>${esc(shortSummary)}${truncated ? "\n…" : ""}</pre></blockquote>`
      : "";
    await tg
      .sendRichMessage(chatId, sessionHeader(null, sessionId) + `📦 <b>Compaction complete</b>${tokenText}${body ? "\n" + body : ""}`, threadOpts(threadId))
      .catch(() => {});
  }
  logger.info("events", "compaction.ended", { sessionId, chatId, threadId, summaryLen: summary.length, usedStatus: !!(s?.statusMessageId) });
};

const handleSessionCompactionFailed: EventHandler = async (event, deps) => {
  const { tg, store, updateStatus } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  const threadId = resolveThreadId(sessionId);
  const msg = e.data?.error?.message ?? "compaction failed";
  if (s) {
    s.compacting = false;
    s.compactionError = msg;
    if (s.statusMessageId) updateStatus(chatId, s, true).catch(() => {});
    else await tg.sendRichMessage(chatId, sessionHeader(s) + `❌ <b>Compaction failed</b>: ${esc(msg)}`, threadOpts(threadId)).catch(() => {});
  } else {
    await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + `❌ <b>Compaction failed</b>: ${esc(msg)}`, threadOpts(threadId)).catch(() => {});
  }
  logger.warn("events", "compaction.failed", { sessionId, chatId, threadId, error: msg });
};

const handleMcpStatusChanged: EventHandler = async (event, deps) => {
  const { tg, store } = deps;
  const { resolveChatId, resolveThreadId } = store;
  const e = event;
  const server = e.data?.server;
  const chatId = resolveChatId(e.data?.sessionID);
  if (chatId !== undefined && server) {
    const threadId = resolveThreadId(e.data?.sessionID);
    await tg.sendRichMessage(chatId, sessionHeader(store.findSessionById(e.data?.sessionID), e.data?.sessionID) + `🔌 MCP status changed: <b>${esc(server)}</b>\nUse /mcp to inspect.`, threadOpts(threadId)).catch(() => {});
  }
  return;
};

const handleMcpResourcesChanged: EventHandler = async (event, deps) => {
  const { tg, store } = deps;
  const { resolveChatId, resolveThreadId } = store;
  const e = event;
  const server = e.data?.server;
  const chatId = resolveChatId(e.data?.sessionID);
  if (chatId !== undefined && server) {
    const threadId = resolveThreadId(e.data?.sessionID);
    await tg.sendRichMessage(chatId, sessionHeader(store.findSessionById(e.data?.sessionID), e.data?.sessionID) + `📚 MCP resources changed: <b>${esc(server)}</b>\nUse /mcp resources.`, threadOpts(threadId)).catch(() => {});
  }
  return;
};

const handleSessionTextDelta: EventHandler = async (event, deps) => {
  const { store, flushDraft } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  const delta = e.data?.delta ?? e.data?.text ?? "";
  s.buffer += delta;
  if (!s.timer) {
    s.timer = setTimeout(() => void flushDraft(chatId, s), 250);
  }
};

const handleSessionStepEnded: EventHandler = async (event, deps) => {
  const { tg, oc, store, settings, finishStatus, flushDraft } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  const out = e.data?.tokens?.output;
  if (typeof out === "number") s.lastOutputTokens = out;
  // "tool-calls" means the turn continues with another step; any other
  // finish reason (stop / length / error) is the real end of the turn.
  const finish = e.data?.finish ?? e.data?.rawFinish;
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
      const artifacts = Array.isArray(e.data?.files) ? e.data.files : [];
      // OpenCode sometimes reports the whole working-tree snapshot here; sending
      // hundreds of files floods Telegram. Only treat small, de-duplicated sets
      // as real turn artifacts.
      const seen = (s.sentArtifacts ??= new Set<string>());
      const unique = artifacts
        .map((p: unknown) => String(p))
        .filter((p: string) => !seen.has(p));
      if (settings2.autoArtifacts && unique.length && unique.length <= 20) {
        const artifactThread = s.targetThreadId ?? s.threadId ?? resolveThreadId(sessionId);
        const base = s.directory ?? process.cwd();
        const maxArtifacts = 5;
        for (const relativePath of unique.slice(0, maxArtifacts)) {
          seen.add(relativePath);
          try {
            const doc = await prepareDocument(base, relativePath);
            if (doc.size <= 45 * 1024 * 1024) {
              await tg.sendDocument(chatId, doc.absolute, doc.name, `<b>Artifact</b>\n<code>${esc(doc.relative || doc.name)}</code>\n${formatBytes(doc.size)}`, { ...threadOpts(artifactThread), parse_mode: "HTML" });
            }
          } catch (err) {
            console.error("[artifact]", err);
          }
        }
        if (unique.length > maxArtifacts) {
          await tg.sendRichMessage(chatId, sessionHeader(s, sessionId) + `📎 ${unique.length - maxArtifacts} more artifact(s) not sent (limit ${maxArtifacts}).`, threadOpts(artifactThread)).catch(() => {});
        }
      } else if (unique.length > 20) {
      }
    }
  }
  // status tracking
  const sid = e.data?.sessionID;
  if (sid) store.setSessionStatus(sid, "idle");
};

const handleSessionTextEnded: EventHandler = async (event, deps) => {
  const { tg, oc, store, settings, flushDraft, updateStatus, finishStatus, syncTopicTitle, transcript, publishCard } = deps;
  const { findSessionById, resolveChatId, resolveThreadId, lastPromptBySession } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  let endedText = (e.data?.text ?? "").toString().trim();
  if (sessionId && endedText) {
    noteTurnCompleted(sessionId);
    const retryNotice = retryMessageBySession.get(sessionId);
    if (retryNotice) {
      retryMessageBySession.delete(sessionId);
      await tg.editRichMessage(retryNotice.chatId, retryNotice.messageId, "✅ Retry succeeded.").catch(() => {});
    }
  }
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  logger.breadcrumb("events", "text.ended.entry", { sessionId, hasSession: !!_s0, chatId });

  if (chatId === undefined) return;
  let s = _s0;
  const msgId = e.data?.assistantMessageID;
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
    const fallbackText = (e.data?.text ?? "").toString().trim();
    if (fallbackText) {
      const sent = await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + markdownToHtml(fallbackText), threadOpts(resolveThreadId(sessionId))).catch((err) => { console.error("[send final]", err); return undefined; });
      if (sent?.message_id) store.rememberMessageSession(chatId, sent.message_id, sessionId);
    }
    return;
  }
  // permanent breadcrumb for future debug
  logger.breadcrumb("events", "text.ended.process", { sessionId, statusMsg: s.statusMessageId, finished: s.statusFinished, stopped: s.stopped });
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = undefined;
  }
  if (s.typingTimer) {
    clearInterval(s.typingTimer);
    s.typingTimer = undefined;
  }
  if (!s.stopped) {
    await flushDraft(chatId, s);
    logger.breadcrumb("events", "text.ended.flush", { sessionId, statusMsg: s.statusMessageId, finished: s.statusFinished, stopped: s.stopped });
    if (s && s.statusMessageId && !s.statusFinished) {
      await finishStatus(chatId, s).catch((err) => console.error("[finishStatus error]", err));
    }
    endedText = (e.data?.text ?? "").toString().trim();
    let finalText = endedText || s.buffer || "(empty response)";
    let elapsed = 0;
    let tokens = s.lastOutputTokens ?? 0;
    try {
      const msgId = e.data?.assistantMessageID;
      if (msgId) {
        const m = await oc.client.session.message.get({ sessionID: s.sessionId, messageID: msgId });
        const t = (m as { time?: { completed?: number; streamed?: number; created?: number } })?.time;
        if (t?.completed) {
          const start = t.streamed || t.created;
          if (start && t.completed > start) {
            elapsed = (t.completed - start) / 1000;
          }
        }
      }
    } catch {
      // ignore
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
      if (publishCard) await publishCard(chatId, s);
      else await transcript.publish(chatId, s, { extraTop: "" });
      if (s.transcriptMessageId) {
        s.lastFinalTelegramMessageId = s.transcriptMessageId;
        // Deep link button to jump to this message in the chat.
        if (chatId < 0) {
          const internalId = String(chatId).replace(/^-100/, "");
          const url = `https://t.me/c/${internalId}/${s.transcriptMessageId}`;
          const kb: any[] = [...(transcript.cardKeyboard(s, s.transcriptPage ?? 0, transcript.pageCount(s), { unified: settings.get(chatId).displayMode === "unified" }))];
          kb.push([{ text: "🔗 Ver en chat", url }]);
          // The markup edit must not race with the card edits.
          await new Promise((r) => setTimeout(r, 400));
          await tg.editMessageReplyMarkup(chatId, s.transcriptMessageId, { inline_keyboard: kb }).catch(() => {});
        }
      }
      // Optional: deliver the final answer as a separate rich-text message for readability.
      const st = settings.get(chatId);
      // Linear mode (private chats): try to turn the transient "Working…"
      // message into the final answer so nothing disappears; fall back to a
      // separate message (and drop the transient) only when it does not fit.
      const linear = chatId >= 0;
      let linearEditedStatus = false;
      if (linear && s.statusMessageId && finalText.length <= 3500) {
        const finalHtml = sessionHeader(s) + markdownToHtml(finalText);
        const ok = await tg.editRichMessage(chatId, s.statusMessageId, clampText(finalHtml, 3900), threadOpts2)
          .then(() => true).catch(() => false);
        if (ok) {
          linearEditedStatus = true;
          if (s) s.lastFinalTelegramMessageId = s.statusMessageId;
          s.statusMessageId = undefined;
        }
      }
      const sendSeparately =
        (linear && !linearEditedStatus) ||
        st.longAnswerDelivery === "message" ||
        (st.longAnswerDelivery === "auto" && finalText.length > st.longAnswerThreshold);
      if (sendSeparately) {
        if (s.lastFinalSeparatedPromptStart !== s.promptStartTime) {
          s.lastFinalSeparatedPromptStart = s.promptStartTime;
          // Prefer section-aware splitting: one part per markdown section
          // (headings) so code blocks are never cut mid-way. Falls back to
          // size-based splitting when there are no usable headings.
          const { splitMarkdown, splitBySections } = await import("./transcript.js");
          const sections = splitBySections(finalText, 3200);
          const parts = sections.length ? sections : splitMarkdown(finalText, 3200);
          for (let i = 0; i < parts.length; i++) {
            const prefix = parts.length > 1 ? `<i>(${i + 1}/${parts.length})</i>\n` : "";
            const piece = `${sessionHeader(s)}${prefix}${markdownToHtml(parts[i])}`;
            await tg.sendRichMessage(chatId, clampText(piece, 3900), threadOpts2).catch(() => {});
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
      const finalHtml = sessionHeader(s) + answerHtml + extraHtml + copyRow + `\n${renderResourceBlock(s)}`;
      const prevFinalSentAt = s?.lastFinalSentAt ?? 0;
      const prevFinalTelegramMessageId = s?.lastFinalTelegramMessageId;
      const rapidFinal = !!(s && !linear && prevFinalTelegramMessageId && Date.now() - prevFinalSentAt < 12000);
      let finalMessage: { message_id?: number } | undefined;
      if (rapidFinal) {
        await tg.editRichMessage(chatId, prevFinalTelegramMessageId!, clampText(finalHtml, 3900), { ...threadOpts2, reply_markup: { inline_keyboard: quickKeyboard } }).catch(() => {});
        finalMessage = { message_id: prevFinalTelegramMessageId };
      } else {
        finalMessage = await tg.sendRichMessage(chatId, clampText(finalHtml, 3900), { ...threadOpts2, reply_markup: { inline_keyboard: quickKeyboard } }).catch((err) => {
          console.error("[send final]", err);
          return undefined;
        });
        if (finalMessage?.message_id) store.rememberMessageSession(chatId, finalMessage.message_id, s.sessionId);
      }
      if (finalMessage?.message_id && s) s.lastFinalTelegramMessageId = finalMessage.message_id;
    }
    // Linear mode: keep the transient "Working…" message (with the streamed
    // partial) instead of deleting it, so nothing disappears; the final answer
    // is appended below as a normal message. Only clear the reference.
    if (chatId >= 0 && s?.statusMessageId) {
      s.statusMessageId = undefined;
    }
    if ((settings.get(chatId).autoTopicTitle ?? true)) await syncTopicTitle(chatId, s).catch(() => {});
  }
  s.buffer = "";
};

const handlePermissionAsked: EventHandler = async (event, deps) => {
  const { tg, oc, store, pendingPermissions } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event;
  const p = e.data ?? {};
  const requestId = p.id;
  const sessionId = p.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !requestId || !sessionId) return;
  const label = p.tool ?? p.action ?? "permission";
  const resource = Array.isArray(p.resources) ? p.resources.join(", ") : (p.message ?? "");
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
  // Auto-reject on timeout
  setTimeout(async () => {
    const info = pendingPermissions.get(requestId);
    if (info && !info.decided) {
      info.decided = true;
      try {
        await oc.replyPermission(info.sessionId, requestId, "reject");
      } catch {
        // ignore
      }
      if (info.messageId) {
        await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission auto-rejected (timeout)</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`).catch(() => {});
      }
      pendingPermissions.delete(requestId);
    }
  }, 5 * 60 * 1000);
};

const handleFormCreated: EventHandler = async (event, deps) => {
  const { tg, store, pendingForms, pendingFormsById } = deps;
  const { findSessionById, resolveChatId, resolveThreadId } = store;
  const e = event;
  const p = e.data ?? {};
  const form = p.form ?? p;
  const sessionId = p.sessionID ?? form.sessionID;
  const formId = form.id ?? form.formID ?? p.id ?? p.formID;
  const title = form.title ?? p.title ?? "Form";
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId !== undefined && formId) {
    const threadId = resolveThreadId(sessionId);
    // Make sure the form's follow-up responses are delivered back to the tab
    // where the form was shown, not to a stale delivery target.
    store.rememberDelivery(sessionId, chatId, threadId);
    const rawFields = Array.isArray(form.fields) ? form.fields : [];
    const fields: FormField[] = rawFields.map((field: any) => {
      const normalized: FormField = {
        key: field.key,
        title: field.title,
        description: field.description,
        required: field.required,
        type: field.type,
        options: Array.isArray(field.options)
          ? field.options.map((option: any) => ({
              value: String(option.value),
              label: option.label ?? String(option.value),
              description: option.description,
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
  const { tg, store, pendingPermissions } = deps;
  const e = event;
  const p = e.data ?? {};
  const requestId = p.requestID;
  const info = requestId ? pendingPermissions.get(requestId) : undefined;
  if (info && !info.decided) {
    info.decided = true;
    const reply = p.reply ?? "replied";
    if (info.messageId) {
      await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission ${reply} (via OpenCode)</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`).catch(() => {});
    }
    pendingPermissions.delete(requestId);
  }
};

const handleSessionExecutionFailed: EventHandler = async (event, deps) => {
  const { tg, oc, store, finishStatus, config } = deps;
  const { findSessionById, resolveChatId, resolveThreadId, lastPromptBySession } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const s = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId !== undefined) {
    const msg = e.data?.error?.message ?? "execution failed";
    const threadId = resolveThreadId(sessionId);
    const isRateLimit = /rate limit|quota/i.test(msg);
    const hint = isRateLimit ? "\n\nTry switching model with /models." : "";
    const autoRetry = config?.AUTO_RETRY_ENABLED ?? true;
    const promptForRetry = sessionId ? lastPromptBySession.get(sessionId) : undefined;
    if (s?.typingTimer) { clearInterval(s.typingTimer); s.typingTimer = undefined; }
    if (s) await finishStatus(chatId, s);

    // Retry only prompts sent by this process and only up to
    // AUTO_RETRY_MAX_ATTEMPTS. Stale prompts restored from disk are ignored.
    const decision = autoRetry && isRateLimit && sessionId && promptForRetry
      ? decideRetry(sessionId, promptForRetry, config)
      : ({ action: "none" } as const);

    if (decision.action === "retry") {
      const sid = sessionId as string;
      const prompt = promptForRetry as string;
      dispatchRetry(sid, decision.delay, async () => {
        await oc.prompt(sid, prompt);
        const existing = retryMessageBySession.get(sid);
        if (existing) {
          await tg
            .editRichMessage(existing.chatId, existing.messageId, `⏳ Retry ${decision.attempt}/${decision.maxAttempts} sent; waiting for the model…`)
            .catch(() => {});
        }
      });
      const existingRetryMsg = retryMessageBySession.get(sid);
      const retryText = `⏳ Rate limited. Retrying in ${Math.round(decision.delay / 1000)}s (attempt ${decision.attempt}/${decision.maxAttempts})…`;
      let sent: { message_id?: number } | null = null;
      if (existingRetryMsg) {
        await tg.editRichMessage(existingRetryMsg.chatId, existingRetryMsg.messageId, retryText).catch(() => {});
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
        threadOpts(threadId),
      );
      retryMessageBySession.delete(sid);
      cancelAutoRetry(sid);
    } else if (decision.action === "none") {
      await tg.sendRichMessage(chatId, sessionHeader(null, sessionId) + `❌ ${esc(msg)}${esc(hint)}`, threadOpts(threadId));
      if (sessionId) retryMessageBySession.delete(sessionId);
    }
    // "wait": a retry is already pending for this prompt; avoid duplicate events.
  }
  // status tracking
  const sid = e.data?.sessionID;
  if (sid) store.setSessionStatus(sid, "idle");
};

const handleSessionStepStarted: EventHandler = async (event, deps) => {
  const { store } = deps;
  const e = event;
  const sid = e.data?.sessionID;
  if (sid) {
    store.setSessionStatus(sid, "busy");
    logger.debug("events", "[step.started]", sid);
    const chatId = store.resolveChatId(sid);
    await ensureLiveStatus(deps, sid, chatId).catch(() => {});
  }
};

const handleSessionIdle: EventHandler = async (event, deps) => {
  const { store, finishStatus } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const s = sessionId ? findSessionById(sessionId) : undefined;
  // status tracking (set idle) first, preserving original ordering
  const sid = e.data?.sessionID;
  if (sid) store.setSessionStatus(sid, "idle");
  if (s?.typingTimer) {
    clearInterval(s.typingTimer);
    s.typingTimer = undefined;
  }
  // Fallback turn-end signal for servers that emit session.idle.
  const chatId = resolveChatId(sessionId);
  if (s && chatId !== undefined && s.statusMessageId && !s.stopped) {
    await finishStatus(chatId, s).catch(() => {});
  }
};

export const defaultHandler: EventHandler = async () => {};

export const eventHandlers = new Map<string, EventHandler>([
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
]);

export async function handleEvent(event: { type: string; data?: any }, deps: EventsDeps): Promise<void> {
  const e = event as { type: string; data?: any };
  const sessionId = e.data?.sessionID ?? e.data?.session?.id;
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
          draftId: 0,
          buffer: "",
          reasoningBuffer: "",
          toolCalls: [],
          toolCallDetails: [],
          stopped: false,
          targetChatId: parentChat,
          cotBuffer: "",
          cotCount: 0,
          topicTitle: (sess as { title?: string })?.title,
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