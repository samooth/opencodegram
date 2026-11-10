import type { ChatSession } from "./types.js";
import type { Config } from "./config.js";
import type { FileBrowser } from "./filebrowser.js";
import type { MetricsStore } from "./metrics.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { OpsServer } from "./ops.js";
import type { Panels } from "./panels.js";
import type { SessionManager } from "./sessions.js";
import type { SettingsStore } from "./settings.js";
import type { StatusManager } from "./status.js";
import type { SessionStore } from "./store.js";
import type { TelegramClient, TelegramUser } from "./telegram.js";
import type { TranscriptManager } from "./transcriptmanager.js";

export type PermissionInfo = {
  chatId: number;
  sessionId: string;
  messageId?: number;
  decided: boolean;
  label: string;
  resource: string;
};

export type FormField = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  type: string;
  options?: Array<{ value: string; label: string; description?: string }>;
};

export type FormState = {
  formId: string;
  sessionId: string;
  chatId: number;
  threadId?: number;
  title: string;
  fields: FormField[];
  answers: Record<string, string | string[]>;
  messageId?: number;
  submitted: boolean;
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
  /** Session card: one paginated message per session. */
  transcript: TranscriptManager;
  panels: Panels;
  files: FileBrowser;
  settings: SettingsStore;
  metrics: MetricsStore;
  ops?: OpsServer;
  pendingEdits: Map<number, ChatSession>;
  messageToSession: Map<string, string>;
  pendingPermissions: Map<string, PermissionInfo>;
  pendingForms: Map<number, FormState>;
  pendingFormsById: Map<string, number>;
  pendingConfirmations: Map<string, { sessionId: string; name: string; args: string; expires: number }>;
  awaitingReason: Map<string, string>;
  modelListByChat: Map<string, Array<{ id: string; providerID: string; variant?: string; name?: string; variants?: Array<{ id?: string }> }>>;
  pendingModelByChat: Map<string, { id: string; providerID: string; variant?: string } | null>;
  /** Messages waiting for the user to pick a session (groups with several). */
  pendingGroupPrompts: Map<string, { text: string; files?: Array<{ uri: string; name: string }>; at: number }>;
  audit: (action: string, detail: string) => void;
  /** Structured per-session trace for diagnosing multi-session routing. */
  sessionTrace?: (event: string, fields: Record<string, unknown>) => void;
};
