import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { FormField, FormState } from "./context.js";
import type { SettingsStore } from "./settings.js";
import { renderForm, formKeyboard } from "./formui.js";
import { esc, rateLimitRetryAt, threadOpts, markdownToHtml } from "./util.js";
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
  pendingForms: Map<number, FormState>;
  pendingFormsById: Map<string, number>;
  messageToSession: Map<number, string>;
  settings: SettingsStore;
  flushDraft: (chatId: number, s: ChatSession | undefined) => Promise<void>;
  updateStatus: (chatId: number, s: ChatSession, force?: boolean) => Promise<void>;
  finishStatus: (chatId: number, s: ChatSession) => Promise<unknown>;
  syncTopicTitle: (chatId: number, s: ChatSession) => Promise<void>;
};

const lastGoalStatus = new Map<string, string>();

export async function handleEvent(event: { type: string; data?: any }, deps: EventsDeps): Promise<void> {
  const { tg, oc, store, retryingSessions, pendingPermissions, pendingForms, pendingFormsById, messageToSession, settings, flushDraft, updateStatus, finishStatus, syncTopicTitle } = deps;
  const { findSessionById, resolveChatId, resolveThreadId, lastPromptBySession } = store;

  const e = event as { type: string; data?: any };
// Log a compact line for debugging.
if (e.type.startsWith("session.text") || e.type === "permission.asked" || e.type === "session.idle" || e.type.endsWith("failed") || e.type === "session.step.started" || e.type === "session.step.ended" || e.type === "session.reasoning.started" || e.type === "session.reasoning.ended") {
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
    detail.output = typeof out === "string" ? out.slice(0, 2000) : JSON.stringify(out ?? "").slice(0, 2000);
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

if (e.type === "session.compaction.started") {
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
}

if (e.type === "session.compaction.delta") {
  const sessionId = e.data?.sessionID;
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined) return;
  const s = _s0;
  if (s) {
    s.compactionSummary = (s.compactionSummary ?? "") + (e.data?.text ?? "");
    updateStatus(chatId, s).catch(() => {});
  }
}

if (e.type === "session.compaction.ended") {
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
    .sendRichMessage(chatId, `📦 <b>Compaction complete</b>${tokenText}${body ? "\\n" + body : ""}`, threadOpts(threadId))
    .catch(() => {});
}

if (e.type === "session.compaction.failed") {
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
}

if (e.type === "mcp.status.changed") {
  const server = e.data?.server;
  const chatId = resolveChatId(e.data?.sessionID);
  if (chatId !== undefined && server) {
    const threadId = resolveThreadId(e.data?.sessionID);
    await tg.sendRichMessage(chatId, `🔌 MCP status changed: <b>${esc(server)}</b>\nUse /mcp to inspect.`, threadOpts(threadId)).catch(() => {});
  }
  return;
}

if (e.type === "mcp.resources.changed") {
  const server = e.data?.server;
  const chatId = resolveChatId(e.data?.sessionID);
  if (chatId !== undefined && server) {
    const threadId = resolveThreadId(e.data?.sessionID);
    await tg.sendRichMessage(chatId, `📚 MCP resources changed: <b>${esc(server)}</b>\nUse /mcp resources.`, threadOpts(threadId)).catch(() => {});
  }
  return;
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
    try {
      if (!s.stopped) await finishStatus(chatId, s);
    } catch (err) {
      console.error("[finishStatus error]", err);
    }
    // Deliver files produced by the turn as Telegram documents.
    if (!s.stopped) {
      const settings = deps.settings.get(chatId);
      const artifacts = Array.isArray(e.data?.files) ? e.data.files : [];
      if (settings.autoArtifacts && artifacts.length) {
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

console.log("@@@BEFORE_TEXTENDED_BLOCK", e.type);
if (e.type === "session.text.ended" || e.type.startsWith("session.text.ended")) {
  const sessionId = e.data?.sessionID;
  console.log("@@@TEXTENDED_ENTRY", JSON.stringify(e.type), sessionId);
  const _s0 = sessionId ? findSessionById(sessionId) : undefined;
  const chatId = resolveChatId(sessionId);
  console.log("@@@TEXTENDED", sessionId, "s=", !!_s0, "chatId=", chatId);

  if (chatId === undefined) return;
  let s = _s0;
  if (!s) {
    // No in-memory session (e.g. after restart). Still deliver the final text if available.
    const fallbackText = (e.data?.text ?? "").toString().trim();
    if (fallbackText) {
      const sent = await tg.sendRichMessage(chatId, markdownToHtml(fallbackText), threadOpts(resolveThreadId(sessionId))).catch((err) => { console.error("[send final]", err); return undefined; });
      if (sent?.message_id) store.rememberMessageSession(sent.message_id, sessionId);
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
    console.log("[text.ended]", sessionId, "s=", !!s, "statusMsg=", s.statusMessageId, "finished=", s.statusFinished, "stopped=", s.stopped);
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
    const threadOpts = store.threadOptsFor(s);
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
    console.log("[send] final to chat=", chatId, "thread=", s.targetThreadId ?? s.threadId, "len=", finalText.length);
    const finalHtml = markdownToHtml(finalText) + `\n\n<tg-button-row><tg-button type="copy_text" text="${esc(finalText.slice(0, 200))}">📋 Copy answer</tg-button></tg-button-row>`;
    const finalMessage = await tg.sendRichMessage(chatId, finalHtml, { ...threadOpts, reply_markup: { inline_keyboard: quickKeyboard } }).catch((err) => {
      console.error("[send final]", err);
      return undefined;
    });
    if (finalMessage?.message_id) store.rememberMessageSession(finalMessage.message_id, s.sessionId);
    // Deep link button to jump to this message in the chat.
    if (finalMessage?.message_id && chatId < 0) {
      const internalId = String(chatId).replace(/^-100/, "");
      const url = `https://t.me/c/${internalId}/${finalMessage.message_id}`;
      const kb: any[] = [...(quickKeyboard ?? []), [{ text: "🔗 Ver en chat", url }]];
      await tg.editRichMessage(chatId, finalMessage.message_id, finalHtml, { ...threadOpts, reply_markup: { inline_keyboard: kb } }).catch(() => {});
    }
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
  if (sent?.message_id) store.rememberMessageSession(sent.message_id, sessionId);
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
    if (sent?.message_id) store.rememberMessageSession(sent.message_id, sessionId);
    pendingForms.set(sent.message_id, state);
    pendingFormsById.set(formId, sent.message_id);
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

if (e.type === "rpc.opencode.goal.changed") {
  const sessionId = e.data?.sessionID;
  const goal = e.data?.goal;
  const chatId = resolveChatId(sessionId);
  if (chatId === undefined || !goal) return;
  const threadId = resolveThreadId(sessionId);
  const status = String(goal.status ?? "");
  const objective = goal.objective ? String(goal.objective) : "";
  const reason = goal.reason ? String(goal.reason) : "";
  const signature = `${status}|${objective}|${reason}`;
  const prev = lastGoalStatus.get(String(sessionId ?? ""));
  if (prev === signature) return;
  lastGoalStatus.set(String(sessionId ?? ""), signature);
  let msg = "";
  const emoji = status === "active" ? "🎯" : status === "complete" ? "✅" : status === "blocked" ? "⛔" : status === "paused" ? "⏸" : "🎯";
  msg = `${emoji} <b>Goal ${esc(status)}</b>`;
  if (objective) msg += `\n\n<blockquote>${esc(objective)}</blockquote>`;
  if (reason) msg += `\n\n<b>Reason:</b>\n${esc(reason)}`;
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  if (status === "active") {
    keyboard.push([{ text: "⏸ Pause", callback_data: `goal:pause:${sessionId}` }, { text: "🛑 Clear", callback_data: `goal:clear:${sessionId}` }]);
  } else if (status === "paused") {
    keyboard.push([{ text: "▶ Resume", callback_data: `goal:resume:${sessionId}` }, { text: "🛑 Clear", callback_data: `goal:clear:${sessionId}` }]);
  }
  const opts: Record<string, unknown> = { ...threadOpts(threadId) };
  if (keyboard.length) opts.reply_markup = { inline_keyboard: keyboard };
  const sent = await tg.sendRichMessage(chatId, msg, opts).catch(() => null);
  if (!sent && threadId) {
    // Thread may have been deleted; retry in the main chat.
    await tg.sendRichMessage(chatId, msg, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}).catch(() => {});
  }
  return;
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
