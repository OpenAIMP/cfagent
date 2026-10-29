import type { Env, SessionData } from "../types";
import { SESSION_LIMITS } from "../config/sessionLimits";
import { createStoreKv, type DoNamespaceLike } from "./durableKv";
import { type KvLike } from "./kvResilience";
import type {
  ResourceAttribution,
  ResourceUsagePort,
} from "../telemetry/resourceUsagePorts";

/**
 * All durations come from config/session-limits.json (see
 * src/config/sessionLimits.ts). These exports are aliases so callers and
 * tests keep a named constant; no value is duplicated here.
 */
export const SESSION_TTL = SESSION_LIMITS.absoluteTtlSeconds;
/** Hard cap on a session's total life, even when activity keeps renewing. */
export const SESSION_MAX_TTL = SESSION_LIMITS.maxLifetimeSeconds;
/** Renew the absolute window when this little of it remains. */
export const SESSION_RENEW_WINDOW = SESSION_LIMITS.renewWindowSeconds;
export const COOKIE_NAME = "session_id";
const STATE_MAX_AGE_MS = SESSION_LIMITS.oauthStateMaxAgeMs;
const STATE_FUTURE_SKEW_MS = SESSION_LIMITS.oauthStateFutureSkewMs;

export function getSessionId(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Shape check for a session id, applied before any session-store read (issue #329).
 *
 * `createSession` mints `crypto.randomUUID()`, so a value that is not a UUID
 * cannot name a session. Checking the shape here means a junk or
 * attacker-supplied `session_id` cookie costs a regex instead of a store `get()` —
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
  return `${COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_LIMITS.cookieMaxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Sessions live in the SessionStore Durable Object (issue #329), not KV.
 *
 * KV's free tier caps reads at 100k/day and throws once exhausted — that throw
 * was the 1101. CORRECTION (issue #1819): the DO is NOT uncapped either
 * (free-tier 5M rows read/day, 100k rows written/day); the earlier "no such
 * cap" wording was wrong, and rows-read exhaustion took sign-in down on
 * 2026-10-26. The legacy KV fallback was removed in #604: the migration
 * window has passed and SESSIONS_KV_FALLBACK=off made it dormant. Auth
 * material stays in the DO (never moves back to KV).
 */
export function sessionStore(
  env: Env,
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): KvLike {
  return createStoreKv({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "sessions",
    legacyFallback: false,
    attribution: resource?.attribution,
    resourceSink: resource?.resourceSink,
  });
}

export async function createSession(env: Env, data: SessionData): Promise<string> {
  const sessionId = crypto.randomUUID();
  await sessionStore(env).put(sessionId, JSON.stringify(data), { expirationTtl: SESSION_TTL });
  return sessionId;
}

export async function getSession(
  env: Env,
  sessionId: string,
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): Promise<SessionData | null> {
  const raw = await sessionStore(env, resource).get(sessionId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export type UpdateSessionResult =
  | { ok: true; remainingTtlSeconds: number }
  | {
      ok: false;
      code: "SESSION_INVALID_CREATED_AT" | "SESSION_ABSOLUTE_EXPIRED";
      error: string;
    };

/**
 * #945 Wiring Phase 2a — persist an updated session record under
 * the SAME session id, with TTL = remaining absolute time.
 *
 * Absolute expiry is NEVER extended: the new TTL is
 * floor((createdAt + SESSION_TTL - nowMs) / 1000), so a touch
 * cannot push a session past its original deadline. A session
 * already past absolute expiry, or with under one second of
 * absolute life left (a TTL of 0 must never be written), is
 * refused and nothing is stored. An invalid createdAt is
 * refused for the same reason: without it there is no deadline
 * to preserve.
 *
 * TTL-overshoot note for the caller: if the underlying store
 * clamps small TTLs upward (Workers KV, for example, has a 60s
 * minimum), a session in its final minute could persist in the
 * store past its absolute deadline. That cannot resurrect it:
 * getValidatedSession re-checks absolute expiry on every read.
 * The caller MUST also call invalidateSessionCache(sessionId)
 * in the same isolate after a successful update (this module
 * cannot import sessionCache.ts without a circular import), or
 * the isolate keeps serving the pre-touch copy until TTL.
 *
 * `updateSessionWithStore` takes the store so tests can use a
 * fake; `updateSession` is the production thin wrapper.
 */
export async function updateSessionWithStore(
  store: KvLike,
  sessionId: string,
  data: SessionData,
  nowMs: number
): Promise<UpdateSessionResult> {
  if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) {
    return {
      ok: false,
      code: "SESSION_INVALID_CREATED_AT",
      error: "session has no valid createdAt, so its absolute deadline cannot be preserved",
    };
  }
  const remainingMs = data.createdAt + SESSION_TTL * 1000 - nowMs;
  const remainingTtlSeconds = Math.floor(remainingMs / 1000);
  if (remainingTtlSeconds < 1) {
    return {
      ok: false,
      code: "SESSION_ABSOLUTE_EXPIRED",
      error: "session is past (or within one second of) its absolute expiry; nothing was stored",
    };
  }
  await store.put(sessionId, JSON.stringify(data), {
    expirationTtl: remainingTtlSeconds,
  });
  return { ok: true, remainingTtlSeconds };
}

/** Production wrapper: the store is the SessionStore DO. */
export async function updateSession(
  env: Env,
  sessionId: string,
  data: SessionData,
  nowMs: number = Date.now(),
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): Promise<UpdateSessionResult> {
  return updateSessionWithStore(sessionStore(env, resource), sessionId, data, nowMs);
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await sessionStore(env).delete(sessionId);
}

/**
 * True when a page navigation should slide the absolute window: the
 * session is inside its last two days and has not reached the 30-day
 * lifetime cap. Expired sessions are not renewed (the user signs in again).
 */
export function sessionRenewalDue(session: SessionData, nowMs: number): boolean {
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) return false;
  const firstCreatedAt =
    typeof session.firstCreatedAt === "number" && Number.isFinite(session.firstCreatedAt)
      ? session.firstCreatedAt
      : session.createdAt;
  if (nowMs >= firstCreatedAt + SESSION_MAX_TTL * 1000) return false;
  const remainingMs = session.createdAt + SESSION_TTL * 1000 - nowMs;
  return remainingMs > 0 && remainingMs <= SESSION_RENEW_WINDOW * 1000;
}

/**
 * Slide the absolute 7-day window on an authenticated document navigation.
 * The session id is preserved, so every other open tab keeps working; the
 * browser cookie is re-issued by the caller with a fresh Max-Age. Returns
 * false when no renewal was due (or the lifetime cap is reached).
 */
export async function renewSessionWithStore(
  store: KvLike,
  sessionId: string,
  session: SessionData,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (!sessionRenewalDue(session, nowMs)) return false;
  const firstCreatedAt =
    typeof session.firstCreatedAt === "number" && Number.isFinite(session.firstCreatedAt)
      ? session.firstCreatedAt
      : session.createdAt;
  const renewed: SessionData = {
    ...session,
    createdAt: nowMs,
    firstCreatedAt,
    lastActivityMs: nowMs,
  };
  await store.put(sessionId, JSON.stringify(renewed), {
    expirationTtl: SESSION_TTL,
  });
  return true;
}

/** Production wrapper: the store is the SessionStore DO. */
export async function renewSession(
  env: Env,
  sessionId: string,
  session: SessionData,
  nowMs: number = Date.now()
): Promise<boolean> {
  return renewSessionWithStore(sessionStore(env), sessionId, session, nowMs);
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
  if (
    isNaN(timestamp) ||
    Date.now() - timestamp > STATE_MAX_AGE_MS ||
    timestamp > Date.now() + STATE_FUTURE_SKEW_MS
  ) {
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
