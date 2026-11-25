/** Minimal structural types for OpenCode/Telegram API payloads used across the bot. */

type ModelVariantLike = { id?: string; name?: string };
export type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  /** Telegram native clipboard button (private chats, 1-256 characters). */
  copy_text?: { text: string };
};
export type InlineKeyboard = InlineButton[][];
