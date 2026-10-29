/**
 * #945 Wiring Phase 2a — idle enforcement helpers, activity touch, step-up wrapper.
 *
 * Pure helpers only. Phase 2b-part1 wires two call sites, and no
 * others: server.ts `requireAuth` validates wired sessions via
 * iaaaEnforcement.ts (fresh read, idle expiry, touch), and POST
 * /api/api-keys mints only when `sessionRequiresStepUp` (via the
 * iaaaGates.ts pilot predicate) is false. No other route calls
 * these helpers; route PDP enforcement is still a later phase.
 *
 * sessionCache interaction — read before wiring enforcement anywhere:
 * - `getSessionCached` serves a copy up to 60s stale per isolate.
 *   Enforcing idle expiry against a CACHED copy is wrong in both
 *   directions: a session touched in another isolate within the
 *   last 60s can be falsely rejected from a stale copy, and a
 *   session idle past the deadline can still validate for up to
 *   60s from a copy cached just before the deadline. Any future
 *   enforcement point MUST read fresh (`getSession`, not
 *   `getSessionCached`), or accept that ±60s error window
 *   explicitly. This is the same reason Phase 1's header said the
 *   cache cannot enforce idle timeouts.
 * - After `updateSession`, the caller MUST call
 *   `invalidateSessionCache(sessionId)` in the same isolate, or
 *   that isolate keeps serving the pre-touch copy until TTL.
 *   `updateSession` cannot do this itself: session.ts must not
 *   import sessionCache.ts (sessionCache imports session.ts).
 *
 * Touch precision: `touchSession` only writes when at least 60s
 * elapsed since the last recorded activity, so lastActivityMs is
 * accurate only to ±60s. The idle deadline therefore has the same
 * ±60s slack: a session can be up to 60s past its true idle
 * deadline before a touch would have recorded newer activity.
 * This slack is deliberate (it bounds store writes on polling
 * traffic); it must not be presented as exact idle enforcement.
 *
 * Step-up: `sessionRequiresStepUp` wraps Slice 2 `requiresStepUp`,
 * which reads ONLY authTimeMs and the freshness window. The other
 * SessionState fields it requires are filled from the session
 * where available and are never treated as identity here. A
 * session without authTimeMs (every legacy session) is stale, never
 * fresh — fail closed. The 15-minute default is the Slice 2
 * documented default, NOT a settled CISO threshold (spec §8).
 */

import { SESSION_LIMITS } from "../config/sessionLimits";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_POLICY,
  DEFAULT_STEP_UP_FRESHNESS_MS,
  requiresStepUp,
} from "./sessionPolicy";
import type { SessionData } from "../types";

/** Minimum elapsed activity before a touch writes (60s; see header). */
export const IAAA_TOUCH_MIN_INTERVAL_MS = SESSION_LIMITS.touchIntervalMs;

export interface TouchResult {
  touched: boolean;
  /** The updated session when touched; the original object when not. Never mutated. */
  session: SessionData;
}

/**
 * Return the session with lastActivityMs advanced to `nowMs`, but
 * only when at least IAAA_TOUCH_MIN_INTERVAL_MS elapsed since the
 * last recorded activity. A session with no recorded activity is
 * touched (first touch initialises the field). A session whose
 * last activity is in the future (clock skew) is NOT touched: a
 * future timestamp must not be overwritten by an older "now".
 * Pure: the input is never mutated.
 */
export function touchSession(session: SessionData, nowMs: number): TouchResult {
  const last = session.lastActivityMs;
  if (typeof last === "number" && Number.isFinite(last)) {
    if (nowMs - last < IAAA_TOUCH_MIN_INTERVAL_MS) {
      return { touched: false, session };
    }
  }
  return { touched: true, session: { ...session, lastActivityMs: nowMs } };
}

/**
 * Step-up check for a live SessionData record: true when the
 * session's authentication is not fresh enough for a sensitive
 * action. `freshnessMs` overrides the default window; an invalid
 * (non-finite, zero, or negative) override falls back to the
 * default rather than silently disabling step-up. This answers
 * freshness only — callers must check session usability
 * (revocation, absolute and idle expiry) separately, and this
 * function is wired into NO route in this phase.
 */
export function sessionRequiresStepUp(
  session: SessionData,
  nowMs: number,
  freshnessMs?: number
): boolean {
  const freshness =
    typeof freshnessMs === "number" &&
    Number.isFinite(freshnessMs) &&
    freshnessMs > 0
      ? freshnessMs
      : DEFAULT_STEP_UP_FRESHNESS_MS;
  // requiresStepUp consults only authTimeMs and the policy window;
  // the remaining SessionState fields are structural only here.
  // A missing/non-finite authTimeMs becomes NaN, which
  // requiresStepUp treats as stale (fail closed).
  return requiresStepUp(
    {
      sessionId: "",
      internalUserId: session.internalUserId ?? "",
      createdAtMs: session.createdAt,
      lastActivityMs: session.lastActivityMs ?? session.createdAt,
      authTimeMs:
        typeof session.authTimeMs === "number" ? session.authTimeMs : Number.NaN,
    },
    { ...DEFAULT_SESSION_POLICY, stepUpFreshnessMs: freshness },
    nowMs
  );
}

/** Re-exported so callers need not import sessionPolicy for the default. */
export { DEFAULT_IDLE_TIMEOUT_MS };
