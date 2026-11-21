import { describe, expect, test } from "bun:test";
import { consumeWebCode, issueWebCode, issueWebSession, verifyWebSession, WEB_SESSION_COOKIE } from "../src/webauth.js";

describe("single-use web codes", () => {
  test("a code is consumed exactly once", () => {
    const { code } = issueWebCode(123);
    expect(consumeWebCode(code)).toBe(123);
    expect(consumeWebCode(code)).toBeUndefined();
  });

  test("unknown codes are rejected", () => {
    expect(consumeWebCode("not-a-real-code")).toBeUndefined();
  });

  test("codes carry the requesting chat id (or undefined)", () => {
    const { code } = issueWebCode();
    expect(consumeWebCode(code)).toBeUndefined();
  });
});

describe("web sessions", () => {
  test("issued sessions verify, unknown ones do not", () => {
    const { token, maxAge } = issueWebSession(123);
    expect(maxAge).toBeGreaterThan(0);
    expect(verifyWebSession(token)).toBe(true);
    expect(verifyWebSession("bogus")).toBe(false);
    expect(verifyWebSession(undefined)).toBe(false);
  });

  test("cookie name is stable", () => {
    expect(WEB_SESSION_COOKIE).toBe("ocg_session");
  });
});
