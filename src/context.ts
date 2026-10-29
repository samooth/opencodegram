import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { Panels } from "./panels.js";
import type { SessionManager } from "./sessions.js";
import type { StatusManager } from "./status.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient, TelegramUser } from "./telegram.js";

export type PermissionInfo = {
  chatId: number;
  sessionId: string;
  messageId?: number;
  decided: boolean;
  label: string;
  resource: string;
};

export type SendFn = (html: string, opts?: Record<string, unknown>) => Promise<unknown>;

/** Everything the Telegram update handlers need, wired once in index.ts. */
export type BotDeps = {
  config: Config;
  tg: TelegramClient;
  oc: OpenCodeBridge;
  store: SessionStore;
  me: TelegramUser;
  topicsEnabled: boolean;
  sessions: SessionManager;
  status: StatusManager;
  panels: Panels;
  pendingPermissions: Map<string, PermissionInfo>;
  awaitingReason: Map<string, string>;
  modelListByChat: Map<string, Array<any>>;
  pendingModelByChat: Map<string, any>;
  audit: (action: string, detail: string) => void;
};
