import type { Config } from "./config.js";

/**
 * State for automatic retries after a rate-limit failure.
 *
 * A retry is only allowed for a prompt that this process actually sent
 * (`notePromptSent`). This prevents replaying prompts restored from disk after
 * a restart, which used to resend old user messages.
 *
 * Every prompt gets at most `AUTO_RETRY_MAX_ATTEMPTS` retries and a retry is
 * abandoned once the prompt is older than `AUTO_RETRY_MAX_AGE_MS`.
 */
export type RetryState = {
  prompt: string;
  attempts: number;
  lastActivityAt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** True while a retry prompt has been dispatched and its outcome is unknown. */
  dispatched: boolean;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_AGE_MS = 30 * 60_000;

const states = new Map<string, RetryState>();

/** Record that this process sent `prompt`; resets any previous retry. */
export function notePromptSent(sessionId: string, prompt: string): void {
  const previous = states.get(sessionId);
  if (previous?.timer) clearTimeout(previous.timer);
  states.set(sessionId, {
    prompt,
    attempts: 0,
    lastActivityAt: Date.now(),
    dispatched: false,
  });
}

/** The turn produced a final answer: stop tracking retries for it. */
export function noteTurnCompleted(sessionId: string): void {
  const state = states.get(sessionId);
  if (state?.timer) clearTimeout(state.timer);
  states.delete(sessionId);
}

/** Cancel a scheduled retry (new prompt, stop, delete, ...). */
export function cancelAutoRetry(sessionId: string): void {
  noteTurnCompleted(sessionId);
}

export function isAutoRetryScheduled(sessionId: string): boolean {
  return states.get(sessionId)?.timer !== undefined;
}

export type RetryDecision =
  | { action: "none" }
  | { action: "wait" }
  | { action: "retry"; attempt: number; delay: number; maxAttempts: number }
  | { action: "exhausted"; attempts: number; maxAttempts: number };

/**
 * Decide what to do after a rate-limit failure.
 *
 * `none` also covers stale or unknown prompts (for example, prompts restored
 * from disk after a restart), which must never be retried.
 */
export function decideRetry(sessionId: string, prompt: string, config?: Config): RetryDecision {
  const state = states.get(sessionId);
  if (!state || state.prompt !== prompt) return { action: "none" };

  const maxAge = config?.AUTO_RETRY_MAX_AGE_MS ?? DEFAULT_MAX_AGE_MS;
  if (Date.now() - state.lastActivityAt > maxAge) {
    cancelAutoRetry(sessionId);
    return { action: "none" };
  }

  const maxAttempts = config?.AUTO_RETRY_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS;

  // A retry is already waiting for its backoff window: ignore duplicate
  // failure events for the same turn instead of stacking timers.
  if (state.timer) return { action: "wait" };

  // The dispatched retry prompt failed; the next attempt is allowed.
  if (state.dispatched) state.dispatched = false;

  if (state.attempts >= maxAttempts) {
    return { action: "exhausted", attempts: state.attempts, maxAttempts };
  }

  const base = config?.RETRY_BACKOFF_BASE_MS ?? 60_000;
  const max = config?.RETRY_BACKOFF_MAX_MS ?? 900_000;
  const factor = config?.RETRY_BACKOFF_FACTOR ?? 2;
  const attempt = state.attempts + 1;
  const delay = Math.min(base * Math.pow(factor, state.attempts), max);

  state.attempts = attempt;
  state.lastActivityAt = Date.now();

  return { action: "retry", attempt, delay, maxAttempts };
}

/**
 * Schedule `run` after `delay`. The runner should only dispatch the prompt
 * (not await the whole turn); completion is detected by `noteTurnCompleted`.
 */
export function dispatchRetry(sessionId: string, delay: number, run: () => Promise<void>): void {
  const state = states.get(sessionId);
  if (!state) return;
  state.timer = setTimeout(async () => {
    state.timer = undefined;
    state.dispatched = true;
    state.lastActivityAt = Date.now();
    try {
      await run();
    } catch (err) {
      state.dispatched = false;
      console.error("[autoretry] prompt dispatch failed", sessionId, err);
    }
  }, delay);
}

/** Test helper: forget all retry state. */
export function resetAutoRetryForTests(): void {
  for (const state of states.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  states.clear();
}
