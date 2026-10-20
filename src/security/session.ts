import type { Env, SessionData } from "../types";
import { createStoreKv, type DoNamespaceLike } from "./durableKv";
import { type KvLike } from "./kvResilience";

export const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days in seconds
export const COOKIE_NAME = "session_id";
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export function getSessionId(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Shape check for a session id, applied before any KV read (issue #329).
 *
 * `createSession` mints `crypto.randomUUID()`, so a value that is not a UUID
 * cannot name a session. Checking the shape here means a junk or
 * attacker-supplied `session_id` cookie costs a regex instead of a KV `get()` —
 * the negative cache alone still allowed one read per unique value per 10s.
 */
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionIdFormat(
  sessionId: string | null | undefined
): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

export function setSessionCookie(sessionId: string): string {
  return `${COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Sessions live in the SessionStore Durable Object (issue #329), not KV.
 *
 * KV's free tier caps reads at 100k/day and throws once exhausted — that throw
 * was the 1101. The DO has no such cap. The legacy KV fallback was removed in
 * #604: the migration window has passed and SESSIONS_KV_FALLBACK=off made it
 * dormant. Auth material stays in the DO (never moves back to KV).
 */
export function sessionStore(env: Env): KvLike {
  return createStoreKv({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "sessions",
    legacyFallback: false,
  });
}

export async function createSession(env: Env, data: SessionData): Promise<string> {
  const sessionId = crypto.randomUUID();
  await sessionStore(env).put(sessionId, JSON.stringify(data), { expirationTtl: SESSION_TTL });
  return sessionId;
}

export async function getSession(env: Env, sessionId: string): Promise<SessionData | null> {
  const raw = await sessionStore(env).get(sessionId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await sessionStore(env).delete(sessionId);
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Creates a cryptographically signed OAuth state parameter with a timestamp
 * for replay attack prevention.
 */
export async function createState(env: Env): Promise<string> {
  const random = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const payload = `${random}.${timestamp}`;
  const sig = await hmacSign(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

/**
 * Validates the OAuth state parameter in constant time and ensures it hasn't expired.
 */
export async function verifyState(env: Env, state: string): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [random, timestampStr, sig] = parts;
  if (!random || !timestampStr || !sig) return false;

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || Date.now() - timestamp > STATE_MAX_AGE_MS || timestamp > Date.now() + 60_000) {
    return false; // State expired or in the future
  }

  const payload = `${random}.${timestampStr}`;
  const expectedSig = await hmacSign(env.SESSION_SECRET, payload);

  // Constant-time string equality check to prevent timing side channels
  if (sig.length !== expectedSig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) {
    mismatch |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return mismatch === 0;
}
