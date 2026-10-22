/**
 * #945 Wiring Phase 1 — GitHub login/session wiring, config-gated.
 *
 * This module is used ONLY when IAAA wiring is enabled (see providers.ts:
 * IAAA_WIRING_ENABLED = "1"/"true"). When wiring is OFF, server.ts calls
 * the legacy handleLogin/handleOAuthCallback directly and this module is
 * never invoked, so the legacy flow runs exactly as before.
 *
 * What Phase 1 does (GitHub only):
 * - After the existing GitHub profile fetch succeeds (the same
 *   exchangeGithubCode/fetchGithubProfile helpers the legacy callback
 *   uses), resolve or create a Slice 1 IdentityBinding for
 *   (issuer https://github.com, subject = GitHub numeric user id).
 *   The login is NEVER used as the subject: logins can change, user
 *   ids cannot. If the profile has no usable id, the login fails and
 *   no binding and no session are created.
 * - The profile fetch IS the proof of control for this binding
 *   (proofVerified: true): the caller has already validated the
 *   provider assertion by exchanging the code server-side and fetching
 *   the profile with the resulting token. No unproven linking happens.
 * - The session keeps every legacy field unchanged and adds only the
 *   optional Slice 1/2 fields: internalUserId, providerIssuer,
 *   providerSubject, authTimeMs (login time), sessionVersion (1).
 *   Old sessions without those fields keep working.
 * - Bindings are stored in the SessionStore DO via sessionStore(),
 *   under keys prefixed "iaaa-binding:", with NO expiry — a binding
 *   must outlive any one session. It shares the DO namespace with
 *   sessions but never collides with session keys (session keys are
 *   bare UUIDs; binding keys carry the prefix).
 *
 * What Phase 1 does NOT do (later phases, honestly stated):
 * - Idle-timeout enforcement. There is no lastActivityMs field yet,
 *   and the 60s in-isolate session cache (sessionCache.ts) means a
 *   cached read cannot enforce idle timeouts even if the field
 *   existed. getValidatedSession enforces absolute expiry
 *   (createdAt + SESSION_TTL) and existence only; idle enforcement
 *   is Phase 2, with last-activity tracking and cache invalidation.
 * - PDP, delegation, or audit wiring at routes. Those are later
 *   phases and are deliberately absent here.
 * - Any other provider. Auth0, Google, and other social logins are
 *   NOT implemented here; see providers.ts for how a future adapter
 *   registers without changing server.ts dispatch.
 *
 * Rollback: set IAAA_WIRING_ENABLED off (or remove "github" from
 * IAAA_ENABLED_PROVIDERS). No code change is needed, and sessions
 * created by the wired flow keep working afterwards because the new
 * fields are optional and the legacy fields are unchanged.
 */
import type { Env, SessionData } from "../types";
import type { KvLike } from "./kvResilience";
import {
  createMemoryIdentityBindingStore,
  resolveOrCreateBinding,
  type IdentityBinding,
  type IdentityBindingStore,
} from "./identityBinding";
import {
  createSession,
  SESSION_TTL,
  setSessionCookie,
  verifyState,
} from "./session";
import { sessionStore } from "./session";
import {
  exchangeGithubCode,
  fetchGithubProfile,
  GithubAuthError,
  type GithubUserProfile,
} from "./githubOAuth";

export const GITHUB_ISSUER = "https://github.com";
export const IAAA_BINDING_KEY_PREFIX = "iaaa-binding:";
export const IAAA_SESSION_VERSION = 1;

/** GitHub profile shape the wired callback needs (id is the subject). */
export interface GithubProfile {
  id: number;
  login: string;
  avatar_url?: string;
  name?: string | null;
}

export type GithubBindingErrorCode = "MISSING_SUBJECT_ID" | "BINDING_FAILED";

export type GithubBindingResult =
  | { ok: true; binding: IdentityBinding }
  | { ok: false; code: GithubBindingErrorCode; error: string };

/**
 * Resolve or create the Slice 1 binding for a fetched GitHub profile.
 * Subject is String(profile.id); a missing/non-finite id fails the login
 * rather than binding by login. The profile fetch is the proof.
 */
export async function resolveGithubBinding(
  store: IdentityBindingStore,
  profile: GithubProfile,
  nowMs: number
): Promise<GithubBindingResult> {
  if (
    !profile ||
    typeof profile.id !== "number" ||
    !Number.isFinite(profile.id)
  ) {
    return {
      ok: false,
      code: "MISSING_SUBJECT_ID",
      error: "GitHub profile did not include a stable user id; login cannot be bound",
    };
  }
  const result = await resolveOrCreateBinding(store, {
    providerIssuer: GITHUB_ISSUER,
    providerSubject: String(profile.id),
    proofVerified: true,
    nowMs,
  });
  if (!result.ok) {
    return { ok: false, code: "BINDING_FAILED", error: result.error };
  }
  return { ok: true, binding: result.binding };
}

/**
 * IdentityBindingStore backed by a KvLike store (in production,
 * sessionStore(env)). Two keys per binding so both lookup directions
 * work: by provider (issuer+subject) and by user+issuer. No TTL.
 */
export function createKvBindingStore(kv: KvLike): IdentityBindingStore {
  const byProviderKey = (issuer: string, subject: string) =>
    `${IAAA_BINDING_KEY_PREFIX}${issuer}\0${subject}`;
  const byUserKey = (userId: string, issuer: string) =>
    `${IAAA_BINDING_KEY_PREFIX}user:${userId}\0${issuer}`;

  async function read(key: string): Promise<IdentityBinding | null> {
    const raw = await kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdentityBinding;
    } catch {
      return null;
    }
  }

  return {
    async getByProvider(providerIssuer, providerSubject) {
      return read(byProviderKey(providerIssuer, providerSubject));
    },
    async getByUserAndIssuer(internalUserId, providerIssuer) {
      return read(byUserKey(internalUserId, providerIssuer));
    },
    async put(binding) {
      const value = JSON.stringify(binding);
      await kv.put(byProviderKey(binding.providerIssuer, binding.providerSubject), value);
      await kv.put(byUserKey(binding.internalUserId, binding.providerIssuer), value);
    },
  };
}

/** Test seam: the binding store used by the wired callback. Defaults to Kv-backed. */
export function createWiredBindingStore(env: Env): IdentityBindingStore {
  return createKvBindingStore(sessionStore(env));
}

/** Test seam: in-memory binding store (tests only). */
export function createTestBindingStore(): IdentityBindingStore {
  return createMemoryIdentityBindingStore();
}

/**
 * Build the extended session for a wired login: every legacy field
 * unchanged, plus the new optional fields. Never mutates `base`.
 */
export function buildExtendedSessionData(
  base: SessionData,
  binding: Pick<IdentityBinding, "internalUserId" | "providerIssuer" | "providerSubject">,
  nowMs: number
): SessionData {
  return {
    ...base,
    internalUserId: binding.internalUserId,
    providerIssuer: binding.providerIssuer,
    providerSubject: binding.providerSubject,
    authTimeMs: nowMs,
    sessionVersion: IAAA_SESSION_VERSION,
  };
}

export type ValidatedSessionResult =
  | { ok: true; session: SessionData }
  | { ok: false; code: "SESSION_MISSING" | "SESSION_INVALID" | "SESSION_EXPIRED"; error: string };

/**
 * Phase 1 session validation: existence + absolute expiry only
 * (createdAt + SESSION_TTL, expiry exclusive). Idle expiry is NOT
 * enforced here — see the module header (Phase 2).
 */
export function getValidatedSession(
  session: SessionData | null,
  nowMs: number
): ValidatedSessionResult {
  if (!session) {
    return { ok: false, code: "SESSION_MISSING", error: "no session exists for this id" };
  }
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) {
    return { ok: false, code: "SESSION_INVALID", error: "session has no valid createdAt" };
  }
  if (session.createdAt + SESSION_TTL * 1000 <= nowMs) {
    return { ok: false, code: "SESSION_EXPIRED", error: "session passed its absolute expiry" };
  }
  return { ok: true, session };
}

/**
 * Wired GitHub callback: the same upstream calls as the legacy callback
 * (state check, code exchange, profile fetch via the shared helpers),
 * then binding + extended session. On any failure before the session
 * is created, no binding is created for a missing-id profile and no
 * session is created at all.
 *
 * `bindingStore` and `nowMs` are test seams; production callers omit
 * them and get the Kv-backed store and Date.now().
 */
export async function handleGithubCallbackWired(
  env: Env,
  request: Request,
  options?: { bindingStore?: IdentityBindingStore; nowMs?: number }
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return errorPage(`GitHub authentication was cancelled or failed: ${error}`, 400);
  if (!code || !state) return errorPage("Missing required authorization code or state parameter", 400);

  const isValidState = await verifyState(env, state);
  if (!isValidState) {
    return errorPage("Invalid or expired OAuth state session. Please try signing in again.", 403);
  }

  try {
    const accessToken = await exchangeGithubCode(env, code);
    const user: GithubUserProfile = await fetchGithubProfile(accessToken);

    const store = options?.bindingStore ?? createWiredBindingStore(env);
    const nowMs = options?.nowMs ?? Date.now();
    const bindingResult = await resolveGithubBinding(
      store,
      { id: user.id, login: user.login, avatar_url: user.avatar_url, name: user.name },
      nowMs
    );
    if (!bindingResult.ok) {
      return errorPage(bindingResult.error, 400);
    }

    const sessionData = buildExtendedSessionData(
      {
        githubLogin: user.login,
        githubAvatar: user.avatar_url,
        githubName: user.name || user.login,
        createdAt: nowMs,
      },
      bindingResult.binding,
      nowMs
    );

    const sessionId = await createSession(env, sessionData);
    return new Response(null, {
      status: 302,
      headers: { Location: "/", "Set-Cookie": setSessionCookie(sessionId) },
    });
  } catch (err) {
    if (err instanceof GithubAuthError) return errorPage(err.message, err.status);
    const message = err instanceof Error ? err.message : "Unexpected OAuth authentication error";
    return errorPage(message, 500);
  }
}

/** Local error page (same shape as the legacy callback's error page). */
function errorPage(message: string, status = 400): Response {
  return new Response(
    `<!DOCTYPE html><html><head><title>Authentication Error</title></head>` +
      `<body><h1>Authentication Error</h1><p>${escapeHtml(message)}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
