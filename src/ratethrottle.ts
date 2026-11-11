/**
 * Adaptive per-chat throttle for Telegram edits.
 *
 * Telegram limits message edits per chat. Fixed gaps keep working until the
 * limit is hit; after that they make it worse. This module tracks 429/rate
 * limit failures per chat and scales the edit gap exponentially while the
 * chat is penalized, decaying back to the base gap after a quiet period.
 */

type ChatThrottle = {
  /** Consecutive/rolling rate-limit failures. */
  failures: number;
  lastFailureAt: number;
  lastSuccessAt: number;
};

const state = new Map<number, ChatThrottle>();

/** Global counters for /ops and metrics. */
let totalFailures = 0;
let totalThrottledMs = 0;

/** Failure is a rate limit if Telegram says so. */
function isRateLimit(message: string): boolean {
  return /429|Too Many Requests|retry after/i.test(message);
}

/** Record a rate-limit failure for a chat. */
export function noteTelegramFailure(chatId: number, message: string): void {
  if (!Number.isFinite(chatId) || chatId === 0) return;
  if (!isRateLimit(message)) return;
  totalFailures++;
  const now = Date.now();
  const entry = state.get(chatId) ?? { failures: 0, lastFailureAt: 0, lastSuccessAt: now };
  // Rolling window: failures older than 2 minutes no longer count cumulatively.
  if (now - entry.lastFailureAt > 120_000) entry.failures = 0;
  entry.failures = Math.min(entry.failures + 1, 6);
  entry.lastFailureAt = now;
  state.set(chatId, entry);
}

/** Record a successful call for a chat: allows the penalty to decay. */
export function noteTelegramSuccess(chatId: number): void {
  if (!Number.isFinite(chatId) || chatId === 0) return;
  const entry = state.get(chatId);
  if (!entry) return;
  entry.lastSuccessAt = Date.now();
  // One success halves the penalty so the gap recovers gradually.
  if (entry.failures > 0 && Date.now() - entry.lastFailureAt > 15_000) {
    entry.failures = Math.max(0, entry.failures - 1);
  }
}

/**
 * Multiplier (1..4) applied to the base edit gap for a chat. The penalty
 * resets completely after 5 quiet minutes.
 */
export function throttleMultiplier(chatId: number): number {
  const entry = state.get(chatId);
  if (!entry || entry.failures === 0) return 1;
  const now = Date.now();
  if (now - entry.lastFailureAt > 300_000) {
    entry.failures = 0;
    state.delete(chatId);
    return 1;
  }
  return 1 + Math.min(entry.failures, 6) * 0.5;
}

/** Base gap scaled by the chat's current penalty, capped at 2 minutes. */
export function throttleGap(chatId: number, baseMs: number): number {
  const gap = Math.round(baseMs * throttleMultiplier(chatId));
  const capped = Math.min(gap, 120_000);
  totalThrottledMs += Math.max(0, capped - baseMs);
  return capped;
}

/** Whether a chat is currently penalized (gap above base). */
export function isThrottled(chatId: number): boolean {
  return throttleMultiplier(chatId) > 1;
}

/** One line per penalized chat, for /ops. */
export function describeThrottles(): string[] {
  const lines: string[] = [];
  for (const [chatId, entry] of state) {
    if (entry.failures === 0) continue;
    const secs = Math.max(1, Math.round((Date.now() - entry.lastFailureAt) / 1000));
    lines.push(`<code>${chatId}</code> ×${throttleMultiplier(chatId).toFixed(1)} · ${entry.failures} fallos · hace ${secs}s`);
  }
  return lines;
}

export function throttleTotals(): { failures: number; extraMs: number } {
  return { failures: totalFailures, extraMs: totalThrottledMs };
}

/** Test helper: forget all state. */
export function resetThrottles(): void {
  state.clear();
  totalFailures = 0;
  totalThrottledMs = 0;
}
