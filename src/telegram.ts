import { readFile } from "node:fs/promises";
import { noteTelegramFailure, noteTelegramSuccess } from "./ratethrottle.js";

const API = "https://api.telegram.org";

/** Fatal chat-level errors: the chat cannot receive anything anymore. */
function chatIsGone(description: string): boolean {
  return /chat not found|chat not exists|chat was upgraded|bot was kicked|bot was blocked|kicked from the group chat/i.test(description);
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  has_topics_enabled?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  message_thread_id?: number;
  from?: { id: number; username?: string };
  text?: string;
  caption?: string;
  reply_to_message?: { from?: { id: number }; message_id?: number };
  date: number;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  document?: { file_id: string; file_unique_id: string; file_name?: string };
  audio?: { file_id: string; file_unique_id: string; file_name?: string };
  voice?: { file_id: string; file_unique_id: string };
  video?: { file_id: string; file_unique_id: string; file_name?: string };
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  stopped_message_generation?: {
    chat: { id: number };
    message_thread_id?: number;
    draft_id: number;
  };
}

function sanitizeUtf8(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i++;
      }
      // drop lone high surrogate
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // drop lone low surrogate
    } else if (c === 0x00 || (c > 0x00 && c < 0x09) || c === 0x0b || c === 0x0c || (c > 0x0e && c < 0x20) || c === 0x7f) {
      // drop control characters that Telegram rejects
    } else {
      out += input[i];
    }
  }
  return out;
}

function stripDraftOnlyRichBlocks(html: string): string {
  // <tg-thinking> is valid only in drafts; never send in finals/edits.
  return html.replace(/<tg-thinking\b[^>]*>[\s\S]*?<\/tg-thinking>/gi, "").replace(/<tg-thinking\b[^>]*\/>/gi, "");
}

export class TelegramClient {
  constructor(private readonly token: string) {}
  private editBackoff = new Map<number, number>();
  /**
   * Hook invoked when a request to a chat fails persistently (e.g. "chat not
   * found"). Wired by the host to clean dead chat bindings.
   */
  onChatFailure?: (chatId: number, error: string) => void;

  private editBackoffActive(chatId: number): boolean {
    const until = this.editBackoff.get(chatId) ?? 0;
    return Date.now() < until;
  }

  private setEditBackoff(chatId: number, ms: number): void {
    const until = Date.now() + ms;
    const prev = this.editBackoff.get(chatId) ?? 0;
    if (until > prev) this.editBackoff.set(chatId, until);
  }

  private async call<T>(method: string, body?: unknown, attempt = 0): Promise<T> {
    const isEdit = method.toLowerCase().includes("edit");
    const chatId = Number((body as { chat_id?: unknown } | undefined)?.chat_id);
    // Timeout: long-poll (getUpdates) gets body.timeout + 10s; others 30s.
    const bodyTimeout = Number((body as { timeout?: unknown } | undefined)?.timeout);
    const timeoutMs = Number.isFinite(bodyTimeout) && bodyTimeout > 0 ? (bodyTimeout + 10) * 1000 : 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2 && !isEdit) {
        await new Promise((r) => setTimeout(r, 1000));
        return this.call<T>(method, body, attempt + 1);
      }
      throw err;
    }
    clearTimeout(timer);
    if (res.status >= 500 && attempt < 2 && !isEdit) {
      await new Promise((r) => setTimeout(r, 1000));
      return this.call<T>(method, body, attempt + 1);
    }
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!json.ok) {
      if (Number.isFinite(chatId)) {
        noteTelegramFailure(chatId, `${json.error_code ?? ""} ${json.description ?? ""}`);
        if (chatIsGone(json.description ?? "")) this.onChatFailure?.(chatId, json.description ?? "");
      }
      // Treat "message is not modified" as success for edit calls (no-op).
      if (json.error_code === 400 && /not modified/i.test(json.description ?? "") && method.toLowerCase().includes("edit")) {
        return (undefined as unknown) as T;
      }
      if (method === "editMessageText" && json.error_code !== 429) {
        // "message not found" is recovered by callers (resend); avoid spamming the log.
        if (!/message to edit not found|message can't be edited|message was deleted/i.test(json.description ?? "")) {
          console.error("[telegram] editMessageText error:", json.description, "method=", method);
        }
      }
      if (json.error_code === 429 && attempt < 3 && !isEdit) {
        const wait = (json.parameters?.retry_after ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        return this.call<T>(method, body, attempt + 1);
      }
      throw new Error(`Telegram ${method} failed: ${json.error_code ?? res.status} ${json.description ?? ""}`);
    }
    if (Number.isFinite(chatId)) noteTelegramSuccess(chatId);
    return json.result as T;
  }

  /** Multipart upload endpoint (documents/photos), with the same retry policy. */
  private async callForm<T>(method: string, form: FormData, attempt = 0): Promise<T> {
    const chatId = Number(form.get("chat_id"));
    const res = await fetch(`${API}/bot${this.token}/${method}`, { method: "POST", body: form });
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000));
      return this.callForm<T>(method, form, attempt + 1);
    }
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!json.ok) {
      if (Number.isFinite(chatId)) {
        noteTelegramFailure(chatId, `${json.error_code ?? ""} ${json.description ?? ""}`);
        if (chatIsGone(json.description ?? "")) this.onChatFailure?.(chatId, json.description ?? "");
      }
      if (json.error_code === 429 && attempt < 3) {
        const wait = (json.parameters?.retry_after ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        return this.callForm<T>(method, form, attempt + 1);
      }
      throw new Error(`Telegram ${method} failed: ${json.error_code ?? res.status} ${json.description ?? ""}`);
    }
    if (Number.isFinite(chatId)) noteTelegramSuccess(chatId);
    return json.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  getUpdates(offset?: number, timeout = 25): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query", "stopped_message_generation"],
    });
  }

  sendMessage(chatId: number, text: string, opts: Record<string, unknown> = {}): Promise<TelegramMessage> {
    const safe = sanitizeUtf8(text);
    const body = { chat_id: chatId, text: safe, ...opts };
    return this.call<TelegramMessage>("sendMessage", body).catch(async (err) => {
      const msg = String(err);
      if (opts.message_thread_id && /message thread not found/i.test(msg)) {
        const retryBody: Record<string, unknown> = { chat_id: chatId, text: safe };
        for (const [key, value] of Object.entries(opts)) {
          if (key === "message_thread_id" || value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendMessage", retryBody);
      }
      if (/message is too long|RICH_MESSAGE_TEXT_TOO_LONG|MESSAGE_TOO_LONG/i.test(msg)) {
        const retryBody: Record<string, unknown> = { chat_id: chatId, text: safe.slice(0, 3900) };
        for (const [key, value] of Object.entries(opts)) {
          if (value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendMessage", retryBody);
      }
      throw err;
    });
  }

  /** Send a local file as a document (multipart upload). */
  async sendDocument(chatId: number, filePath: string, filename: string, caption?: string, opts: Record<string, unknown> = {}): Promise<TelegramMessage> {
    const data = await readFile(filePath);
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", new Blob([data]), filename);
    if (caption) form.set("caption", caption);
    for (const [key, value] of Object.entries(opts)) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    try {
      return await this.callForm<TelegramMessage>("sendDocument", form);
    } catch (err) {
      if (opts.message_thread_id && /message thread not found/i.test(String(err))) {
        const { message_thread_id, ...rest } = opts;
        const retryForm = new FormData();
        retryForm.set("chat_id", String(chatId));
        retryForm.set("document", new Blob([data]), filename);
        if (caption) retryForm.set("caption", caption);
        for (const [key, value] of Object.entries(rest)) {
          if (value === undefined || value === null) continue;
          retryForm.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
        }
        return this.callForm<TelegramMessage>("sendDocument", retryForm);
      }
      throw err;
    }
  }

  sendRichMessage(chatId: number, html: string, opts: Record<string, unknown> = {}): Promise<TelegramMessage> {
    const safe = sanitizeUtf8(stripDraftOnlyRichBlocks(html));
    const body = { chat_id: chatId, rich_message: { html: safe }, ...opts };
    return this.call<TelegramMessage>("sendRichMessage", body).catch(async (err) => {
      const msg = String(err);
      if (opts.message_thread_id && /message thread not found/i.test(msg)) {
        const retryBody: Record<string, unknown> = { chat_id: chatId, rich_message: { html: safe } };
        for (const [key, value] of Object.entries(opts)) {
          if (key === "message_thread_id" || value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendRichMessage", retryBody);
      }
      // Message too long: fall back to truncated plain text to avoid losing it.
      if (/message is too long|RICH_MESSAGE_TEXT_TOO_LONG|MESSAGE_TOO_LONG/i.test(msg)) {
        const plain = safe.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').slice(0, 3900);
        const retryBody: Record<string, unknown> = { chat_id: chatId, text: plain };
        for (const [key, value] of Object.entries(opts)) {
          if (value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendMessage", retryBody);
      }
      // Definite parse failure: fall back to plain text to avoid losing the message.
      if (/can't parse entities|can't find end of|unsupported start tag|parse/i.test(msg) && /400|Bad Request/i.test(msg)) {
        const plain = safe.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').slice(0, 3900);
        const retryBody: Record<string, unknown> = { chat_id: chatId, text: plain };
        for (const [key, value] of Object.entries(opts)) {
          if (value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendMessage", retryBody);
      }
      throw err;
    });
  }

  sendRichMessageMarkdown(chatId: number, markdown: string, opts: Record<string, unknown> = {}): Promise<TelegramMessage> {
    const safe = sanitizeUtf8(markdown);
    const body = { chat_id: chatId, rich_message: { markdown: safe }, ...opts };
    return this.call<TelegramMessage>("sendRichMessage", body).catch(async (err) => {
      const msg = String(err);
      if (opts.message_thread_id && /message thread not found/i.test(msg)) {
        const retryBody: Record<string, unknown> = { chat_id: chatId, rich_message: { markdown: safe } };
        for (const [key, value] of Object.entries(opts)) {
          if (key === "message_thread_id" || value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendRichMessage", retryBody);
      }
      if (/message is too long|RICH_MESSAGE_TEXT_TOO_LONG|MESSAGE_TOO_LONG/i.test(msg)) {
        const retryBody: Record<string, unknown> = { chat_id: chatId, text: safe.slice(0, 3900) };
        for (const [key, value] of Object.entries(opts)) {
          if (value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendMessage", retryBody);
      }
      throw err;
    });
  }

  sendMessageDraft(chatId: number, draftId: number, text: string, opts: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: sanitizeUtf8(text), ...opts });
  }

  sendRichMessageDraft(chatId: number, draftId: number, html: string, opts: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>("sendRichMessageDraft", { chat_id: chatId, draft_id: draftId, rich_message: { html: sanitizeUtf8(html) }, ...opts });
  }

  sendRichMessageDraftMarkdown(chatId: number, draftId: number, markdown: string, opts: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>("sendRichMessageDraft", { chat_id: chatId, draft_id: draftId, rich_message: { markdown: sanitizeUtf8(markdown) }, ...opts });
  }

  editMessageText(chatId: number, messageId: number, text: string, opts: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: sanitizeUtf8(text), ...opts });
  }

  editRichMessage(chatId: number, messageId: number, html: string, opts: Record<string, unknown> = {}): Promise<unknown> {
    if (this.editBackoffActive(chatId)) return Promise.resolve(undefined);
    const safe = sanitizeUtf8(stripDraftOnlyRichBlocks(html));
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: { html: safe }, ...opts }).catch((err) => {
      const msg = String(err);
      const m = msg.match(/retry after (\d+)/i);
      if (m) this.setEditBackoff(chatId, (Number(m[1]) + 1) * 1000);
      if (!/429|Too Many Requests/i.test(msg) && !/not modified/i.test(msg) && !/message was deleted/i.test(msg)) {
        console.error("[telegram] editRichMessage failed", chatId, messageId, "len=", safe.length, "err=", msg);
      }
      // The message is gone: let callers recover (e.g. resend the card).
      // Other failures are swallowed to avoid breaking existing callers; the
      // rate-limit backoff above prevents tight retry loops on 429.
      if (/message to edit not found|message can't be edited|message was deleted|message_id_invalid|MESSAGE_ID_INVALID/i.test(msg)) {
        throw err;
      }
      return undefined;
    });
  }
  editMessageReplyMarkup(chatId: number, messageId: number, markup: Record<string, unknown>): Promise<unknown> {
    if (this.editBackoffActive(chatId)) return Promise.resolve(undefined);
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup }).catch((err) => {
      const msg = String(err);
      const m = msg.match(/retry after (\d+)/i);
      if (m) this.setEditBackoff(chatId, (Number(m[1]) + 1) * 1000);
      return undefined;
    });
  }

  editRichMessageMarkdown(chatId: number, messageId: number, markdown: string, opts: Record<string, unknown> = {}): Promise<unknown> {
    if (this.editBackoffActive(chatId)) return Promise.resolve(undefined);
    const safe = sanitizeUtf8(markdown);
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: { markdown: safe }, ...opts }).catch((err) => {
      const msg = String(err);
      const m = msg.match(/retry after (\d+)/i);
      if (m) this.setEditBackoff(chatId, (Number(m[1]) + 1) * 1000);
      if (!/429|Too Many Requests/i.test(msg) && !/not modified/i.test(msg) && !/message was deleted/i.test(msg)) {
        console.error("[telegram] editRichMessageMarkdown failed", chatId, messageId, "len=", safe.length, "err=", msg);
      }
      if (/message to edit not found|message can't be edited|message was deleted|message_id_invalid|MESSAGE_ID_INVALID/i.test(msg)) {
        throw err;
      }
      return undefined;
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  createForumTopic(chatId: number, name: string, iconEmojiId?: string): Promise<{ message_thread_id: number; name: string }> {
    const body: Record<string, unknown> = { chat_id: chatId, name };
    if (iconEmojiId) body.icon_custom_emoji_id = iconEmojiId;
    return this.call("createForumTopic", body);
  }

  editForumTopic(chatId: number, messageThreadId: number, name: string): Promise<boolean> {
    return this.call<boolean>("editForumTopic", { chat_id: chatId, message_thread_id: messageThreadId, name });
  }

  closeForumTopic(chatId: number, messageThreadId: number): Promise<boolean> {
    return this.call<boolean>("closeForumTopic", { chat_id: chatId, message_thread_id: messageThreadId });
  }

  setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<boolean> {
    return this.call<boolean>("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] });
  }

  sendChatAction(chatId: number, action: string, messageThreadId?: number): Promise<boolean> {
    return this.call<boolean>("sendChatAction", { chat_id: chatId, action, ...(messageThreadId ? { message_thread_id: messageThreadId } : {}) });
  }

  pinChatMessage(chatId: number, messageId: number, opts: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true, ...opts }).catch(() => false);
  }

  unpinChatMessage(chatId: number, opts: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>("unpinChatMessage", { chat_id: chatId, ...opts }).catch(() => false);
  }

  setMyCommands(commands: Array<{ command: string; description: string }>, scope?: Record<string, unknown>): Promise<boolean> {
    return this.call<boolean>("setMyCommands", { commands, ...(scope ? { scope } : {}) });
  }

  deleteMyCommands(scope?: Record<string, unknown>): Promise<boolean> {
    return this.call<boolean>("deleteMyCommands", scope ? { scope } : {});
  }

  setWebhook(url: string, secretToken?: string): Promise<boolean> {
    return this.call<boolean>("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "callback_query", "stopped_message_generation"] });
  }

  deleteWebhook(): Promise<boolean> {
    return this.call<boolean>("deleteWebhook", { drop_pending_updates: false });
  }

  getFile(fileId: string): Promise<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }> {
    return this.call("getFile", { file_id: fileId });
  }
}