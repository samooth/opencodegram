export const STATUS_EDIT_INTERVAL_MS = 5000;
export const STATUS_MIN_UPDATE_GAP_MS = 5000;
/**
 * Cadence used while a session runs in the background (its route was taken
 * over by another session). Slower updates avoid Telegram rate limits when
 * several sessions work at the same time in a group.
 */
export const STATUS_BACKGROUND_GAP_MS = 20000;
export const POLL_BACKOFF_MS = 3000;
export const MAX_READ_BYTES = 160 * 1024;
export const MAX_DOCUMENT_BYTES = 45 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ARTIFACTS = 5;
export const PREVIEW_LINES_DEFAULT = 160;
export const SESSION_LIST_CACHE_TTL_MS = 10_000;
export const COMMAND_LIST_CACHE_TTL_MS = 60_000;
export const STATUS_MESSAGE_CLEANUP_DELAY_MS = 0;
