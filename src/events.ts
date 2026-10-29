import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import { esc, rateLimitRetryAt, threadOpts } from "./util.js";
import { formatBytes, prepareDocument } from "./files.js";

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
  store: SessionStore;
  retryingSessions: Set<string>;
  pendingPermissions: Map<string, PermissionInfo>;
  flushDraft: (chatId: number, s: ChatSession | undefined) => Promise<void>;
  updateStatus: (chatId: number, s: ChatSession, force?: boolean) => Promise<void>;
  finishStatus: (chatId: number, s: ChatSession) => Promise<unknown>;
  syncTopicTitle: (chatId: number, s: ChatSession) => Promise<void>;
};

export async function handleEvent(event: { type: string; data?: any }, deps: EventsDeps): Promise<void> {
  const { tg, oc, store, retryingSessions, pendingPermissions, flushDraft, updateStatus, finishStatus, syncTopicTitle } = deps;
  const { findSessionById, resolveChatId, resolveThreadId, lastPromptBySession } = store;

  const e = event as { type: string; data?: any };
// Log a compact line for debugging.
if (e.type.startsWith("session.text") || e.type === "permission.asked" || e.type === "session.idle" || e.type.endsWith("failed") || e.type === "session.step.started" || e.type === "session.step.ended" || e.type.startsWith("session.reasoning")) {
  console.log("[event]", e.type, JSON.stringify(e.data ?? {}).slice(0, 300));
}

if (e.type === "session.text.started") {
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
}

if (e.type === "session.reasoning.started") {
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  s.reasoningBuffer = "";
}

if (e.type === "session.reasoning.delta") {
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (!s) return;
  s.reasoningBuffer += e.data?.delta ?? "";
  updateStatus(chatId, s).catch(() => {});
}

if (e.type === "session.tool.input.started") {
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
}

if (e.type === "session.tool.called") {
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
}

if (e.type === "session.tool.success") {
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
    detail.output = typeof out === "string" ? out : JSON.stringify(out ?? "").slice(0, 500);
  }
  updateStatus(chatId, s, true).catch(() => {});
}

if (e.type === "session.tool.failed") {
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
}

if (e.type === "session.text.delta") {
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
}

if (e.type === "session.step.ended") {
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
    if (!s.stopped) await finishStatus(chatId, s);
    // Deliver files produced by the turn as Telegram documents.
    if (!s.stopped) {
      const artifacts = Array.isArray(e.data?.files) ? e.data.files : [];
      if (artifacts.length) {
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
}

if (e.type === "session.text.ended") {
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  // debug removed
  // debug removed

  if (chatId === undefined) return;
  let s = _s0;
  if (!s) {
    // No in-memory session (e.g. after restart). Still deliver the final text if available.
    const fallbackText = (e.data?.text ?? "").toString().trim();
    if (fallbackText) {
      await tg.sendRichMessageMarkdown(chatId, fallbackText, threadOpts(resolveThreadId(sessionId))).catch((err) => console.error("[send final]", err));
    }
    return;
  }
  // debug removed
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
    const endedText = (e.data?.text ?? "").toString().trim();
    let finalText = endedText || s.buffer || "(empty response)";
    let elapsed = 0;
    let tokens = s.lastOutputTokens ?? 0;
    try {
      const msgId = e.data?.assistantMessageID;
      if (msgId) {
        const m = await oc.client.session.message.get({ sessionID: s.sessionId, messageID: msgId });
        const t = (m as any)?.time;
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
    const threadOpts = store.threadOptsFor(s);
    console.log("[send] final to chat=", chatId, "thread=", s.targetThreadId ?? s.threadId, "len=", finalText.length);
    await tg.sendRichMessageMarkdown(chatId, finalText, threadOpts).catch((err) => console.error("[send final]", err));
    await syncTopicTitle(chatId, s).catch(() => {});
  }
  s.buffer = "";
}

if (e.type === "permission.asked") {
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
}

if (e.type === "form.created") {
  const p = e.data ?? {};
  const sessionId = p.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId !== undefined) {
    const threadId = resolveThreadId(sessionId);
    const title = p.title ?? "Form";
    const formId = p.id ?? p.formID;
    await tg.sendRichMessage(chatId, `<b>Form created</b>: ${esc(title)}\nID: <code>${esc(formId ?? "")}</code>\nUse /forms to view and reply.`, threadOpts(threadId));
  }
}

if (e.type === "permission.replied") {
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
}

if (e.type === "session.execution.failed") {
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId !== undefined) {
    const msg = e.data?.error?.message ?? "execution failed";
    const threadId = resolveThreadId(sessionId);
    const isRateLimit = /rate limit|quota/i.test(msg);
    const hint = isRateLimit ? "\n\nTry switching model with /models." : "";
    const s2 = _s0;
    if (s2?.typingTimer) { clearInterval(s2.typingTimer); s2.typingTimer = undefined; }
    if (s2) await finishStatus(chatId, s2);
    await tg.sendRichMessage(chatId, `❌ ${esc(msg)}${esc(hint)}`, threadOpts(threadId));
    if (isRateLimit && sessionId && !retryingSessions.has(sessionId)) {
      const prompt = lastPromptBySession.get(sessionId);
      if (prompt) {
        retryingSessions.add(sessionId);
        const now = new Date();
        const retry = new Date(now);
        if (now.getMinutes() < 15) {
          retry.setMinutes(15, 0, 0);
        } else {
          retry.setHours(retry.getHours() + 1, 15, 0, 0);
        }
        const delay = retry.getTime() - now.getTime();
        const timeStr = retry.toISOString().slice(11, 16);
        await tg.sendRichMessage(chatId, `⏳ Rate limited. Will retry at ${timeStr} UTC.`, threadOpts(threadId));
        setTimeout(async () => {
          retryingSessions.delete(sessionId);
          try {
            await oc.prompt(sessionId, prompt);
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ Retry failed: ${esc(String(err))}`, threadOpts(threadId)).catch(() => {});
          }
        }, delay);
      }
    }
  }
}

if (e.type === "session.idle") {
  const sessionId = e.data?.sessionID;
  const s = sessionId ? findSessionById(sessionId) : undefined;
  if (s?.typingTimer) {
    clearInterval(s.typingTimer);
    s.typingTimer = undefined;
  }
  // Fallback turn-end signal for servers that emit session.idle.
  const chatId = resolveChatId(sessionId);
  if (s && chatId !== undefined && s.statusMessageId && !s.stopped) {
    await finishStatus(chatId, s).catch(() => {});
  }
}
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
