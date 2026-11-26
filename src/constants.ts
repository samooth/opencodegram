/**
 * Telegram rich messages (Bot API 10.x) allow 32768 characters, 500 blocks,
 * 16 nesting levels. Leave headroom for numbers/buttons/entities added later.
 */
export const RICH_MESSAGE_LIMIT = 32000;
/** Plain-text fallback (Telegram limit 4096) keeps a safety margin. */
export const PLAIN_MESSAGE_LIMIT = 3900;
/** Coalesce streamed text deltas into one card edit every 3s (readability). */
export const STREAM_FLUSH_MS = 3000;
export const STATUS_EDIT_INTERVAL_MS = 5000;
export const STATUS_MIN_UPDATE_GAP_MS = 1200;
/**
 * Cadence used while a session runs in the background (its route was taken
 * over by another session). Slower updates avoid Telegram rate limits when
 * several sessions work at the same time in a group.
 */
export const STATUS_BACKGROUND_GAP_MS = 20000;
export const POLL_BACKOFF_MS = 3000;
export const SESSION_LIST_CACHE_TTL_MS = 10_000;
export const COMMAND_LIST_CACHE_TTL_MS = 60_000;
