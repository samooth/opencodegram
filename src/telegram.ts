import { readFile } from "node:fs/promises";

const API = "https://api.telegram.org";

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

export class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!json.ok) {
      // Treat "message is not modified" as success for edit calls (no-op).
      if (json.error_code === 400 && /not modified/i.test(json.description ?? "") && method.toLowerCase().includes("edit")) {
        return (undefined as unknown) as T;
      }
      if (json.error_code === 429 && attempt < 3) {
        const wait = (json.parameters?.retry_after ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        return this.call<T>(method, body, attempt + 1);
      }
      throw new Error(`Telegram ${method} failed: ${json.error_code ?? res.status} ${json.description ?? ""}`);
    }
    return json.result as T;
  }

  /** Multipart upload endpoint (documents/photos), with the same retry policy. */
  private async callForm<T>(method: string, form: FormData, attempt = 0): Promise<T> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, { method: "POST", body: form });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!json.ok) {
      if (json.error_code === 429 && attempt < 3) {
        const wait = (json.parameters?.retry_after ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        return this.callForm<T>(method, form, attempt + 1);
      }
      throw new Error(`Telegram ${method} failed: ${json.error_code ?? res.status} ${json.description ?? ""}`);
    }
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
    const body = { chat_id: chatId, text, ...opts };
    return this.call<TelegramMessage>("sendMessage", body).catch(async (err) => {
      if (opts.message_thread_id && /message thread not found/i.test(String(err))) {
        const retryBody: Record<string, unknown> = { chat_id: chatId, text };
        for (const [key, value] of Object.entries(opts)) {
          if (key === "message_thread_id" || value === undefined || value === null) continue;
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
    const body = { chat_id: chatId, rich_message: { html }, ...opts };
    return this.call<TelegramMessage>("sendRichMessage", body).catch(async (err) => {
      if (opts.message_thread_id && /message thread not found/i.test(String(err))) {
        const retryBody: Record<string, unknown> = { chat_id: chatId, rich_message: { html } };
        for (const [key, value] of Object.entries(opts)) {
          if (key === "message_thread_id" || value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendRichMessage", retryBody);
      }
      throw err;
    });
  }

  sendRichMessageMarkdown(chatId: number, markdown: string, opts: Record<string, unknown> = {}): Promise<TelegramMessage> {
    const body = { chat_id: chatId, rich_message: { markdown }, ...opts };
    return this.call<TelegramMessage>("sendRichMessage", body).catch(async (err) => {
      if (opts.message_thread_id && /message thread not found/i.test(String(err))) {
        const retryBody: Record<string, unknown> = { chat_id: chatId, rich_message: { markdown } };
        for (const [key, value] of Object.entries(opts)) {
          if (key === "message_thread_id" || value === undefined || value === null) continue;
          retryBody[key] = value;
        }
        return this.call<TelegramMessage>("sendRichMessage", retryBody);
      }
      throw err;
    });
  }

  sendMessageDraft(chatId: number, draftId: number, text: string, opts: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text, ...opts });
  }

  sendRichMessageDraft(chatId: number, draftId: number, html: string, opts: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>("sendRichMessageDraft", { chat_id: chatId, draft_id: draftId, rich_message: { html }, ...opts });
  }

  sendRichMessageDraftMarkdown(chatId: number, draftId: number, markdown: string, opts: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>("sendRichMessageDraft", { chat_id: chatId, draft_id: draftId, rich_message: { markdown }, ...opts });
  }

  editMessageText(chatId: number, messageId: number, text: string, opts: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...opts });
  }

  editRichMessage(chatId: number, messageId: number, html: string, opts: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: { html }, ...opts });
  }

  editRichMessageMarkdown(chatId: number, messageId: number, markdown: string, opts: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: { markdown }, ...opts });
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }> {
    return this.call("createForumTopic", { chat_id: chatId, name });
  }

  editForumTopic(chatId: number, messageThreadId: number, name: string): Promise<boolean> {
    return this.call<boolean>("editForumTopic", { chat_id: chatId, message_thread_id: messageThreadId, name });
  }

  setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<boolean> {
    return this.call<boolean>("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] });
  }

  sendChatAction(chatId: number, action: string, messageThreadId?: number): Promise<boolean> {
    return this.call<boolean>("sendChatAction", { chat_id: chatId, action, ...(messageThreadId ? { message_thread_id: messageThreadId } : {}) });
  }

  setMyCommands(commands: Array<{ command: string; description: string }>, scope?: Record<string, unknown>): Promise<boolean> {
    return this.call<boolean>("setMyCommands", { commands, ...(scope ? { scope } : {}) });
  }

  deleteMyCommands(scope?: Record<string, unknown>): Promise<boolean> {
    return this.call<boolean>("deleteMyCommands", scope ? { scope } : {});
  }

  getFile(fileId: string): Promise<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }> {
    return this.call("getFile", { file_id: fileId });
  }
}