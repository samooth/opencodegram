import { afterEach, describe, expect, test } from "bun:test";
import {
  cancelAutoRetry,
  decideRetry,
  dispatchRetry,
  isAutoRetryScheduled,
  notePromptSent,
  noteTurnCompleted,
  resetAutoRetryForTests,
} from "../src/autoretry.js";
import type { Config } from "../src/config.js";

const cfg = (overrides: Partial<Config> = {}): Config => overrides as unknown as Config;
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => resetAutoRetryForTests());

describe("auto retry", () => {
  test("does not retry prompts unknown to this process", () => {
    expect(decideRetry("ses_restart", "hola", cfg())).toEqual({ action: "none" });
  });

  test("does not retry a stale prompt for the session", () => {
    notePromptSent("ses_1", "nuevo prompt");
    expect(decideRetry("ses_1", "prompt viejo", cfg())).toEqual({ action: "none" });
  });

  test("schedules the first retry with the base backoff", () => {
    notePromptSent("ses_1", "hola");
    const decision = decideRetry("ses_1", "hola", cfg({ RETRY_BACKOFF_BASE_MS: 1000 }));
    expect(decision).toEqual({ action: "retry", attempt: 1, delay: 1000, maxAttempts: 3 });
  });

  test("does not stack retries while one is waiting", async () => {
    notePromptSent("ses_1", "hola");
    expect(decideRetry("ses_1", "hola", cfg()).action).toBe("retry");
    dispatchRetry("ses_1", 60_000, async () => {});
    expect(isAutoRetryScheduled("ses_1")).toBe(true);
    expect(decideRetry("ses_1", "hola", cfg())).toEqual({ action: "wait" });
    cancelAutoRetry("ses_1");
  });

  test("gives up after the configured number of attempts", async () => {
    notePromptSent("ses_1", "hola");
    const config = cfg({ RETRY_BACKOFF_BASE_MS: 0, AUTO_RETRY_MAX_ATTEMPTS: 2 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(decideRetry("ses_1", "hola", config)).toMatchObject({ action: "retry", attempt });
      dispatchRetry("ses_1", 0, async () => {});
      await tick();
    }
    expect(decideRetry("ses_1", "hola", config)).toEqual({ action: "exhausted", attempts: 2, maxAttempts: 2 });
  });

  test("a completed turn clears the retry state", async () => {
    let calls = 0;
    notePromptSent("ses_1", "hola");
    expect(decideRetry("ses_1", "hola", cfg()).action).toBe("retry");
    dispatchRetry("ses_1", 10, async () => { calls++; });
    noteTurnCompleted("ses_1");
    await tick(25);
    expect(calls).toBe(0);
    expect(decideRetry("ses_1", "hola", cfg())).toEqual({ action: "none" });
  });

  test("a new prompt replaces and cancels the previous retry", async () => {
    let calls = 0;
    notePromptSent("ses_1", "hola");
    expect(decideRetry("ses_1", "hola", cfg()).action).toBe("retry");
    dispatchRetry("ses_1", 10, async () => { calls++; });
    notePromptSent("ses_1", "otra cosa");
    await tick(25);
    expect(calls).toBe(0);
    expect(decideRetry("ses_1", "otra cosa", cfg())).toMatchObject({ action: "retry", attempt: 1 });
    expect(decideRetry("ses_1", "hola", cfg())).toEqual({ action: "none" });
  });

  test("expires prompts older than the max age", async () => {
    notePromptSent("ses_1", "hola");
    await tick(10);
    const decision = decideRetry("ses_1", "hola", cfg({ AUTO_RETRY_MAX_AGE_MS: 5 }));
    expect(decision).toEqual({ action: "none" });
  });
});
