import type { Env, SessionData } from "./types";

const SESSION_TTL = 60 * 60 * 24 * 7;
const COOKIE_NAME = "session_id";

export function getSessionId(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

export function setSessionCookie(sessionId: string): string {
  return `${COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

export async function createSession(env: Env, data: SessionData): Promise<string> {
  const sessionId = crypto.randomUUID();
  await env.SESSIONS.put(sessionId, JSON.stringify(data), { expirationTtl: SESSION_TTL });
  return sessionId;
}

export async function getSession(env: Env, sessionId: string): Promise<SessionData | null> {
  const raw = await env.SESSIONS.get(sessionId);
  if (!raw) return null;
  return JSON.parse(raw) as SessionData;
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.SESSIONS.delete(sessionId);
}

async function hmacSign(env: Env, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function createState(env: Env): Promise<string> {
  const random = crypto.randomUUID();
  const sig = await hmacSign(env, random);
  return `${random}.${sig}`;
}

export async function verifyState(env: Env, state: string): Promise<boolean> {
  const [random, sig] = state.split(".");
  if (!random || !sig) return false;
  const expected = await hmacSign(env, random);
  return sig === expected;
}
