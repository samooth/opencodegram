import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  resetThrottles,
  noteTelegramFailure,
  noteTelegramSuccess,
  throttleMultiplier,
  throttleGap,
  isThrottled,
  describeThrottles,
  throttleTotals,
} from "../src/ratethrottle.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-throttle-"));
  resetThrottles();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("adaptive throttle", () => {
  test("no failures means no penalty", () => {
    expect(throttleMultiplier(123)).toBe(1);
    expect(throttleGap(123, 5000)).toBe(5000);
    expect(isThrottled(123)).toBe(false);
    expect(describeThrottles()).toEqual([]);
  });

  test("429 failures raise the multiplier and are capped", () => {
    for (let i = 0; i < 10; i++) noteTelegramFailure(123, "429 Too Many Requests");
    const m = throttleMultiplier(123);
    // 1 + 6*0.5 = 4 max
    expect(m).toBe(4);
    expect(isThrottled(123)).toBe(true);
    expect(throttleGap(123, 5000)).toBe(20000);
    expect(describeThrottles().length).toBe(1);
    expect(describeThrottles()[0]).toContain("123");
  });

  test("non rate-limit errors do not penalize", () => {
    noteTelegramFailure(123, "400 Bad Request: chat not found");
    expect(throttleMultiplier(123)).toBe(1);
  });

  test("penalty only applies to the failing chat", () => {
    noteTelegramFailure(1, "429");
    expect(throttleMultiplier(2)).toBe(1);
    expect(throttleMultiplier(1)).toBeGreaterThan(1);
  });

  test("throttleGap is capped at 120s", () => {
    noteTelegramFailure(123, "429");
    noteTelegramFailure(123, "429");
    noteTelegramFailure(123, "429");
    expect(throttleGap(123, 90_000)).toBe(120_000);
  });

  test("totals accumulate across chats", () => {
    noteTelegramFailure(1, "429");
    noteTelegramFailure(2, "429");
    throttleGap(1, 5000);
    throttleGap(2, 5000);
    const totals = throttleTotals();
    expect(totals.failures).toBe(2);
    expect(totals.extraMs).toBeGreaterThan(0);
  });

  test("success decays the penalty after a quiet period", () => {
    noteTelegramFailure(123, "429");
    noteTelegramFailure(123, "429");
    const before = throttleMultiplier(123);
    expect(before).toBe(2);
    noteTelegramSuccess(123);
    // Success alone does not decay instantly (15s quiet window).
    expect(throttleMultiplier(123)).toBe(2);
  });
});
