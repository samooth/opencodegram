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

  private async call<T>(method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!json.ok) {
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
    return this.call<TelegramMessage>("sendMessage", { chat_id: chatId, text, ...opts });
  }

  sendRichMessage(chatId: number, html: string, opts: Record<string, unknown> = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendRichMessage", { chat_id: chatId, rich_message: { html }, ...opts });
  }

  sendRichMessageMarkdown(chatId: number, markdown: string, opts: Record<string, unknown> = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendRichMessage", { chat_id: chatId, rich_message: { markdown }, ...opts });
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

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }> {
    return this.call("createForumTopic", { chat_id: chatId, name });
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return this.call<boolean>("setMyCommands", { commands });
  }

  getFile(fileId: string): Promise<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }> {
    return this.call("getFile", { file_id: fileId });
  }
}