import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Single-use codes for the private Mission Control web app.
 *
 * `/web` mints a short-lived code that is exchanged at `/app?code=…` for an
 * HttpOnly session cookie. The code is consumed on first use (so a leaked link
 * cannot be reused) and the cookie keeps the 5 s data polling working without
 * exposing a long-lived token in the URL or in browser history.
 *
 * In-memory only: a daemon restart invalidates all outstanding codes and
 * sessions, which is the desired behaviour for ephemeral access.
 */

const CODE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 5000;

type Entry = { expires: number; chatId?: number };

const codes = new Map<string, Entry>();
const sessions = new Map<string, Entry>();

function prune(map: Map<string, Entry>): void {
  const now = Date.now();
  for (const [key, value] of map) if (value.expires < now) map.delete(key);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Find a map key equal to `token` using a constant-time comparison. */
function findKey(map: Map<string, Entry>, token: string): string | undefined {
  for (const key of map.keys()) if (constantTimeEqual(key, token)) return key;
  return undefined;
}

/** Mint a single-use code. `chatId` is informational (audit only). */
export function issueWebCode(chatId?: number): { code: string; expires: number } {
  prune(codes);
  const code = randomBytes(18).toString("base64url");
  const expires = Date.now() + CODE_TTL_MS;
  codes.set(code, { expires, chatId });
  return { code, expires };
}

/**
 * Consume a code exactly once. Returns the originating chat id, or undefined
 * if the code is unknown, expired or already used.
 */
export function consumeWebCode(code: string): number | undefined {
  const key = findKey(codes, code);
  if (!key) return undefined;
  const entry = codes.get(key)!;
  codes.delete(key); // single use — delete even if expired
  if (entry.expires < Date.now()) return undefined;
  return entry.chatId;
}

/** Mint a session value for the HttpOnly cookie after a code is exchanged. */
export function issueWebSession(chatId?: number): { token: string; maxAge: number } {
  prune(sessions);
  const token = randomBytes(24).toString("base64url");
  sessions.set(token, { expires: Date.now() + SESSION_TTL_MS, chatId });
  return { token, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

export function verifyWebSession(token: string | undefined): boolean {
  if (!token) return false;
  const key = findKey(sessions, token);
  if (!key) return false;
  const entry = sessions.get(key)!;
  if (entry.expires < Date.now()) {
    sessions.delete(key);
    return false;
  }
  return true;
}

export const WEB_SESSION_COOKIE = "ocg_session";
