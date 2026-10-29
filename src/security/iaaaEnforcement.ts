/**
 * #945 Wiring Phase 2b-part1 — live enforcement call sites (pure
 * decision + orchestration helpers for server.ts).
 *
 * This module is the ONLY place that decides whether a request uses
 * the wired validation path. server.ts requireAuth calls it only
 * when IAAA wiring is ON, and only for sessions that already carry
 * an internalUserId (a wired session). Everything else keeps the
 * exact legacy cached path, byte for byte:
 *
 * - Wiring OFF: this module is never called. requireAuth is the
 *   original single line (`getSessionCached`), unchanged.
 * - Wiring ON, session without internalUserId (legacy / Phase 1):
 *   validateAndTouchWiredSession returns { wired: false } having
 *   performed NO fresh read, NO persist, and NO invalidation, and
 *   requireAuth returns the cached session exactly as before.
 *   Such sessions stay idle-exempt, per the Phase 2a contract.
 * - Wiring ON, wired session: the cached copy only decides THAT
 *   the session is wired (internalUserId never changes after
 *   creation, so a <=60s-stale copy cannot misclassify it). The
 *   enforcement decision itself always uses a FRESH read
 *   (getSession, never getSessionCached): the 60s isolate cache
 *   cannot enforce idle timeouts in either direction — it can
 *   falsely reject a session touched in another isolate within
 *   the last 60s, or accept a session up to 60s past its idle
 *   deadline. After a touch persist, the caller MUST invalidate
 *   the isolate cache (done here, in the same isolate); updateSession
 *   cannot do it itself without a circular import.
 *
 * Performance note (wiring ON only): wired sessions cost one
 * fresh store read per request on top of the cached read, plus
 * one store write per >=60s of activity (touch precision). That
 * is the deliberate price of idle enforcement; wiring OFF costs
 * nothing extra, and non-wired sessions under wiring ON cost
 * nothing extra either (no fresh read happens for them).
 *
 * Limitations, stated plainly:
 * - A wired session whose store record vanished (deleted in
 *   another isolate) is denied here, because the cached copy
 *   proves it was wired. But a session with NO cached copy in
 *   this isolate and NO store record cannot be proven wired, so
 *   it falls back to the legacy path — which returns null for
 *   it anyway (negative cache or store miss). Cross-isolate
 *   cache staleness after a delete is bounded by the 60s TTL,
 *   exactly as before wiring; this module does not change it.
 * - Touch persistence is best-effort: if the persist fails, the
 *   validated session is still returned and the cache is kept,
 *   so the next request retries the touch. Authentication is
 *   never failed merely because an activity write failed.
 * - Step-up here means freshness enforcement only: there is no
 *   separate step-up challenge flow yet. A stale session mints
 *   nothing; the user re-authenticates (a fresh login refreshes
 *   authTimeMs) and retries. The 15-minute default is the Slice 2
 *   documented default, NOT a settled CISO threshold.
 */

import { getValidatedSession } from "./iaaaLogin";
import { touchSession } from "./iaaaSessionActivity";
import type { SessionData } from "../types";

/** Store operations the wired validation path needs, injectable for tests. */
export interface WiredSessionStoreDeps {
  /** Authoritative read; must be getSession, never getSessionCached. */
  freshRead(sessionId: string): Promise<SessionData | null>;
  /** Persist a touched session under the same id, preserving absolute expiry. */
  persist(
    sessionId: string,
    data: SessionData,
    nowMs: number,
  ): Promise<{ ok: boolean }>;
  /** Drop the session from this isolate's cache. */
  invalidate(sessionId: string): void;
}

export type WiredSessionValidation =
  | { wired: true; session: SessionData }
  | { wired: true; session: null }
  | { wired: false };

/**
 * Validate a cached session through the wired path.
 *
 * `cached` is the session requireAuth already read (cached path).
 * Only its internalUserId is consulted, and only to decide whether
 * this session is wired at all. All enforcement uses the fresh read.
 */
export interface WiredSessionValidationOptions {
  /** Owner override for the idle window (default 30 minutes). */
  idleTimeoutMs?: number;
}

export async function validateAndTouchWiredSession(
  deps: WiredSessionStoreDeps,
  cached: SessionData | null,
  sessionId: string,
  nowMs: number,
  options?: WiredSessionValidationOptions,
): Promise<WiredSessionValidation> {
  if (!cached?.internalUserId) {
    return { wired: false };
  }
  const fresh = await deps.freshRead(sessionId);
  if (!fresh) {
    // The store record is gone but the cached copy proves this was a
    // wired session: deny, do not resurrect it from cache.
    deps.invalidate(sessionId);
    return { wired: true, session: null };
  }
  if (!fresh.internalUserId) {
    // Defensive branch, unreachable in practice: internalUserId
    // never changes after creation. The authoritative record wins
    // and is returned under legacy semantics.
    return { wired: true, session: fresh };
  }
  const validated = getValidatedSession(fresh, nowMs, options);
  if (!validated.ok) {
    deps.invalidate(sessionId);
    return { wired: true, session: null };
  }
  const touched = touchSession(validated.session, nowMs);
  if (touched.touched) {
    const persisted = await deps.persist(sessionId, touched.session, nowMs);
    if (persisted.ok) {
      deps.invalidate(sessionId);
    }
    return { wired: true, session: touched.session };
  }
  return { wired: true, session: validated.session };
}

/**
 * The two small gating predicates (logout-audit tenant, step-up
 * for minting) live in iaaaGates.ts, not here: this module imports
 * iaaaLogin.ts, which imports githubOAuth.ts, so defining the
 * predicates here would make them unimportable from
 * githubOAuth.ts without a cycle. See iaaaGates.ts.
 */
