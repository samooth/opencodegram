/** Minimal structural types for OpenCode/Telegram API payloads used across the bot. */

export type SessionLike = {
  id?: string;
  time?: { updated?: number; created?: number };
  title?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  location?: { directory?: string };
  directory?: string;
};

export type ModelVariantLike = { id?: string; name?: string };
export type ModelLike = {
  id?: string;
  modelID?: string;
  name?: string;
  providerID?: string;
  provider?: string;
  variants?: Array<ModelVariantLike | string>;
};

export type ProjectLike = { canonical?: string; directory?: string };

export type CustomButton = { label: string; text: string };

export type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  /** Telegram native clipboard button (private chats, 1-256 characters). */
  copy_text?: { text: string };
};
export type InlineKeyboard = InlineButton[][];
