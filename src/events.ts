import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { FormField, FormState } from "./context.js";
import type { SettingsStore } from "./settings.js";
import { renderForm, formKeyboard } from "./formui.js";
import { esc, rateLimitRetryAt, threadOpts, markdownToHtml } from "./util.js";
import { logger } from "./logger.js";
import { formatBytes, prepareDocument } from "./files/index.js";

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
  retryingSessions: Set<string>;
  pendingPermissions: Map<string, PermissionInfo>;
  pendingForms: Map<number, FormState>;
  pendingFormsById: Map<string, number>;
  messageToSession: Map<string, string>;
  settings: SettingsStore;
  flushDraft: (chatId: number, s: ChatSession | undefined) => Promise<void>;
  updateStatus: (chatId: number, s: ChatSession, force?: boolean) => Promise<void>;
  finishStatus: (chatId: number, s: ChatSession) => Promise<unknown>;
  syncTopicTitle: (chatId: number, s: ChatSession) => Promise<void>;
};

const lastGoalStatus = new Map<string, string>();
const retryMessageBySession = new Map<string, { chatId: number; threadId?: number; messageId: number }>();
const retryAttemptBySession = new Map<string, number>();

type EventHandler = (event: { type: string; data?: any }, deps: EventsDeps) => Promise<void>;

// ---------- handlers ----------

const handleSessionTextStarted: EventHandler = async (event, deps) => {
  const { tg, store, flushDraft } = deps;
  const { findSessionById, resolveChatId } = store;
  const e = event;
  const sessionId = e.data?.sessionID ?? e.data?.session?.id;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  s.buffer = "";
  s.draftId = Math.floor(Math.random() * 2147483647) + 1;
  s.stopped = false;
  if (s.typingTimer) clearInterval(s.typingTimer);
  s.typingTimer = setInterval(() => {
    tg.sendChatAction(chatId, "typing", s.threadId).catch(() => {});
  }, 4000);
  tg.sendChatAction(chatId, "typing", s.threadId).catch(() => {});
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
  s.reasoningBuffer = "";
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
  const detail = s.toolCallDetails.find((d) => d.id === id);
  if (detail) {
    const input = e.data?.input;
    detail.input = typeof input === "string" ? input : JSON.stringify(input ?? "");
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
  const detail = s.toolCallDetails.find((d) => d.id === id);
  if (detail) {
    detail.status = "success";
    const out = e.data?.content;
    detail.output = typeof out === "string" ? out.slice(0, 2000) : JSON.stringify(out ?? "").slice(0, 2000);
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
  const detail = s.toolCallDetails.find((d) => d.id === id);
  if (detail) {
    detail.status = "failed";
    detail.output = e.data?.error?.message ?? "failed";
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
  if (chatId === undefined) return;
  const s = _s0;
  if (s) {
    s.compacting = true;
    s.compactionSummary = undefined;
    updateStatus(chatId, s, true).catch(() => {});
  } else {
    const threadId = resolveThreadId(sessionId);
    await tg.sendRichMessage(chatId, "📦 <b>Compacting context…</b>", threadOpts(threadId)).catch(() => {});
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
    updateStatus(chatId, s).catch(() => {});
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
    s.compactionSummary = summary || s.compactionSummary;
    updateStatus(chatId, s, true).catch(() => {});
  }
  const shortSummary = summary.slice(0, 900);
  const truncated = summary.length > shortSummary.length;
  const body = summary
    ? `<details><summary>📦 Summary</summary>\n<pre>${esc(shortSummary)}${truncated ? "\n…" : ""}</pre>\n</details>`
    : "";
  await tg
    .sendRichMessage(chatId, `📦 <b>Compaction complete</b>${tokenText}${body ? "\n" + body : ""}`, threadOpts(threadId))
    .catch(() => {});
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
    updateStatus(chatId, s, true).catch(() => {});
  }
  await tg.sendRichMessage(chatId, `❌ <b>Compaction failed</b>: ${esc(msg)}`, threadOpts(threadId)).catch(() => {});
};

const handleMcpStatusChanged: EventHandler = async (event, deps) => {
  const { tg, store } = deps;
  const { resolveChatId, resolveThreadId } = store;
  const e = event;
  const server = e.data?.server;
  const chatId = resolveChatId(e.data?.sessionID);
  if (chatId !== undefined && server) {
    const threadId = resolveThreadId(e.data?.sessionID);
    await tg.sendRichMessage(chatId, `🔌 MCP status changed: <b>${esc(server)}</b>\nUse /mcp to inspect.`, threadOpts(threadId)).catch(() => {});
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
    await tg.sendRichMessage(chatId, `📚 MCP resources changed: <b>${esc(server)}</b>\nUse /mcp resources.`, threadOpts(threadId)).catch(() => {});
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
      if (settings2.autoArtifacts && artifacts.length) {
        const artifactThread = s.targetThreadId ?? s.threadId ?? resolveThreadId(sessionId);
        const base = s.directory ?? process.cwd();
        const maxArtifacts = 5;
        for (const relativePath of artifacts.slice(0, maxArtifacts)) {
          try {
            const doc = await prepareDocument(base, String(relativePath));
            if (doc.size <= 45 * 1024 * 1024) {
              await tg.sendDocument(chatId, doc.absolute, doc.name, `<b>Artifact</b>\n<code>${esc(doc.relative || doc.name)}</code>\n${formatBytes(doc.size)}`, { ...threadOpts(artifactThread), parse_mode: "HTML" });
            }
          } catch (err) {
            console.error("[artifact]", err);
          }
        }
        if (artifacts.length > maxArtifacts) {
          await tg.sendRichMessage(chatId, `📎 ${artifacts.length - maxArtifacts} more artifact(s) not sent (limit ${maxArtifacts}).`, threadOpts(artifactThread)).catch(() => {});
        }
      }
    }
  }
  // status tracking
  const sid = e.data?.sessionID;
  if (sid) store.setSessionStatus(sid, "idle");
};

const handleSessionTextEnded: EventHandler = async (event, deps) => {
  const { tg, oc, store, settings, flushDraft, updateStatus, finishStatus, syncTopicTitle } = deps;
  const { findSessionById, resolveChatId, resolveThreadId, lastPromptBySession } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  logger.breadcrumb("events", "text.ended.entry", { sessionId, hasSession: !!_s0, chatId });

  if (chatId === undefined) return;
  let s = _s0;
  if (!s) {
    // No in-memory session (e.g. after restart). Still deliver the final text if available.
    const fallbackText = (e.data?.text ?? "").toString().trim();
    if (fallbackText) {
      const sent = await tg.sendRichMessage(chatId, markdownToHtml(fallbackText), threadOpts(resolveThreadId(sessionId))).catch((err) => { console.error("[send final]", err); return undefined; });
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
    const endedText = (e.data?.text ?? "").toString().trim();
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
    if (tokens && elapsed > 0) {
      const speed = (tokens / elapsed).toFixed(1);
      finalText += "\n\n⚡ " + speed + " tok/s";
    }
    const threadOpts2 = store.threadOptsFor(s);
    // Build quick-switch keyboard (prev/next session in the project).
    const quickKeyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    try {
      const res = await oc.client.session.list();
      const list = (((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[]) as Array<{ id?: string }>;
      const ids = list.map((x) => x.id).filter((x): x is string => !!x);
      const idx = ids.indexOf(s.sessionId);
      const nav: Array<{ text: string; callback_data: string }> = [];
      if (idx > 0) nav.push({ text: "◀ Prev", callback_data: `qswitch:${ids[idx - 1]}` });
      if (idx >= 0 && idx < ids.length - 1) nav.push({ text: "Next ▶", callback_data: `qswitch:${ids[idx + 1]}` });
      if (nav.length) quickKeyboard.push(nav);
      quickKeyboard.push([{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    } catch {
      quickKeyboard.push([{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    }
    logger.breadcrumb("events", "send.final", { chatId, thread: s.targetThreadId ?? s.threadId, len: finalText.length });
    const copyText = esc(finalText.slice(0, 200)).replace(/"/g, "&quot;");
    const finalHtml = markdownToHtml(finalText) + `\n\n<tg-button-row><tg-button type="copy_text" text="${copyText}">📋 Copy answer</tg-button></tg-button-row>`;
    const finalMessage = await tg.sendRichMessage(chatId, finalHtml, { ...threadOpts2, reply_markup: { inline_keyboard: quickKeyboard } }).catch((err) => {
      console.error("[send final]", err);
      return undefined;
    });
    if (finalMessage?.message_id) store.rememberMessageSession(chatId, finalMessage.message_id, s.sessionId);
    // Deep link button to jump to this message in the chat.
    if (finalMessage?.message_id && chatId < 0) {
      const internalId = String(chatId).replace(/^-100/, "");
      const url = `https://t.me/c/${internalId}/${finalMessage.message_id}`;
      const kb: any[] = [...(quickKeyboard ?? []), [{ text: "🔗 Ver en chat", url }]];
      await tg.editMessageReplyMarkup(chatId, finalMessage.message_id, { inline_keyboard: kb }).catch(() => {});
    }
    await syncTopicTitle(chatId, s).catch(() => {});
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
  const sent = await tg.sendRichMessage(chatId, `<b>Permission requested</b>\n<i>${esc(label)}</i>\n<code>${esc(resource)}</code>\n\n<i>Expires in 5 minutes</i>`, {
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
    const sent = await tg.sendRichMessage(chatId, renderForm(state), {
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
  const { tg, oc, store, settings, finishStatus, retryingSessions, config } = deps as any;
  const { findSessionById, resolveChatId, resolveThreadId, lastPromptBySession } = store;
  const e = event;
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId !== undefined) {
    const msg = e.data?.error?.message ?? "execution failed";
    const threadId = resolveThreadId(sessionId);
    const isRateLimit = /rate limit|quota/i.test(msg);
    const hint = isRateLimit ? "\n\nTry switching model with /models." : "";
    const autoRetry = config?.AUTO_RETRY_ENABLED ?? true;
    const promptForRetry = sessionId ? lastPromptBySession.get(sessionId) : undefined;
    const willRetry = isRateLimit && !!sessionId && !retryingSessions.has(sessionId) && autoRetry && !!promptForRetry;
    const s2 = _s0;
    if (s2?.typingTimer) { clearInterval(s2.typingTimer); s2.typingTimer = undefined; }
    if (s2) await finishStatus(chatId, s2);
    if (!willRetry) {
      await tg.sendRichMessage(chatId, `❌ ${esc(msg)}${esc(hint)}`, threadOpts(threadId));
    }
    if (isRateLimit && sessionId && !retryingSessions.has(sessionId) && autoRetry) {
      const prompt = promptForRetry;
      if (prompt) {
        retryingSessions.add(sessionId);
        const base = config?.RETRY_BACKOFF_BASE_MS ?? 60000;
        const max = config?.RETRY_BACKOFF_MAX_MS ?? 900000;
        const factor = config?.RETRY_BACKOFF_FACTOR ?? 2;
        const attempt = retryAttemptBySession.get(sessionId) ?? 0;
        const delay = Math.min(base * Math.pow(factor, attempt), max);
        retryAttemptBySession.set(sessionId, attempt + 1);
        const sent = await tg.sendRichMessage(chatId, `⏳ Rate limited. Retrying in ${Math.round(delay / 1000)}s…`, threadOpts(threadId)).catch(() => null);
        if (sent?.message_id) retryMessageBySession.set(sessionId, { chatId, threadId, messageId: sent.message_id });
        setTimeout(async () => {
          retryingSessions.delete(sessionId);
          try {
            await oc.prompt(sessionId, prompt);
            const existing = retryMessageBySession.get(sessionId);
            if (existing) await tg.editRichMessage(existing.chatId, existing.messageId, "✅ Retry succeeded.").catch(() => {});
            retryMessageBySession.delete(sessionId);
            retryAttemptBySession.delete(sessionId);
          } catch (err) {
            const existing = retryMessageBySession.get(sessionId);
            if (existing) {
              await tg.editRichMessage(existing.chatId, existing.messageId, `❌ Retry failed: ${esc(String(err))}`).catch(() => {});
            } else {
              await tg.sendRichMessage(chatId, `❌ Retry failed: ${esc(String(err))}`, threadOpts(threadId)).catch(() => {});
            }
          }
        }, delay);
      }
    }
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

const handleRpcGoalChanged: EventHandler = async (event, deps) => {
  const { tg, store } = deps;
  const { resolveChatId, resolveThreadId } = store;
  const e = event;
  logger.debug("events", "[goal]", JSON.stringify(e.data ?? {}).slice(0, 1000));
  const sessionId = e.data?.sessionID;
  const goal = e.data?.goal;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !goal) return;
  const threadId = resolveThreadId(sessionId);
  const status = String(goal.status ?? "");
  const objective = goal.objective ? String(goal.objective) : "";
  const reason = goal.reason ? String(goal.reason) : "";
  const progress = goal.progress !== undefined ? String(goal.progress) : "";
  const iteration = goal.iteration !== undefined ? String(goal.iteration) : (goal.step !== undefined ? String(goal.step) : "");
  const signature = `${status}|${objective}|${progress}|${iteration}|${reason}`;
  const prev = lastGoalStatus.get(String(sessionId ?? ""));
  if (prev === signature) return;
  lastGoalStatus.set(String(sessionId ?? ""), signature);
  let msg = "";
  const emoji = status === "active" ? "🎯" : status === "complete" ? "✅" : status === "blocked" ? "⛔" : status === "paused" ? "⏸" : "🎯";
  msg = `${emoji} <b>Goal ${esc(status)}</b>`;
  if (objective) msg += `\n\n<blockquote>${esc(objective)}</blockquote>`;
  if (progress) msg += `\n<b>Progress:</b> ${esc(progress)}`;
  if (iteration) msg += `\n<b>Iteration:</b> ${esc(iteration)}`;
  if (reason) msg += `\n\n<b>Reason:</b>\n${esc(reason)}`;
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  if (status === "active") {
    keyboard.push([{ text: "⏸ Pause", callback_data: `goal:pause:${sessionId}` }, { text: "🛑 Clear", callback_data: `goal:clear:${sessionId}` }]);
  } else if (status === "paused") {
    keyboard.push([{ text: "▶ Resume", callback_data: `goal:resume:${sessionId}` }, { text: "🛑 Clear", callback_data: `goal:clear:${sessionId}` }]);
  }
  const opts: Record<string, unknown> = { ...threadOpts(threadId) };
  if (keyboard.length) opts.reply_markup = { inline_keyboard: keyboard };
  const existing = store.goalMessageBySession.get(String(sessionId ?? ""));
  if (existing && existing.chatId === chatId) {
    // Update the existing goal message instead of spamming a new one.
    try {
      await tg.editRichMessage(existing.chatId, existing.messageId, msg, {
        ...(existing.threadId ? { message_thread_id: existing.threadId } : {}),
        ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch {
      const sent = await tg.sendRichMessage(chatId, msg, opts).catch(() => null);
      if (sent?.message_id) store.goalMessageBySession.set(String(sessionId ?? ""), { chatId, threadId, messageId: sent.message_id });
    }
  } else {
    const sent = await tg.sendRichMessage(chatId, msg, opts).catch(() => null);
    if (sent?.message_id) store.goalMessageBySession.set(String(sessionId ?? ""), { chatId, threadId, messageId: sent.message_id });
    if (!sent && threadId) {
      await tg.sendRichMessage(chatId, msg, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}).catch(() => {});
    }
  }
  return;
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
  ["rpc.opencode.goal.changed", handleRpcGoalChanged],
]);

export async function handleEvent(event: { type: string; data?: any }, deps: EventsDeps): Promise<void> {
  const e = event as { type: string; data?: any };
  // Debug-gated compact event log (use DEBUG=events).
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