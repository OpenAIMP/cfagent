/**
 * #1750 (parent #1717, IAAA-2): numeric revocation-propagation targets,
 * one per trigger.
 *
 * Before this slice, authz.md §9 stated revocation propagation as an
 * observed property only ("wired sessions re-validate on fresh reads,
 * bounded by a 60-second isolate cache") with NO numeric target. This
 * module is the single source of truth for the replacement targets,
 * and authz.md §9 is their human-readable record; the two must agree,
 * and the proving tests (tests/iaaa_revocation_targets_1750.test.ts,
 * tests/iaaa_revocation_session_cache_1750.test.ts) pin both the
 * numbers and the gate behavior behind them.
 *
 * How to read a target (measurement definition, applies to all five):
 * the clock starts when the revoking write COMPLETES (the store
 * put/delete returns), and ends at the first gate check at or after
 * that moment. `boundMs` is the worst case: a gate check later than
 * `boundMs` after the write MUST deny. A bound of 0 means the very
 * next gate check denies, with no grace window at all. For
 * token-expiry there is no revoking write: the clock starts at the
 * deadline itself, and a gate check at or after the deadline MUST
 * deny (0 ms past the deadline).
 *
 * What these targets deliberately are NOT:
 * - Not configuration. No env var, session value, run value, or user
 *   value can widen, narrow, or disable them — there is no lookup
 *   of any kind in this module, on purpose. A caller-extendable
 *   revocation grace would let a caller disable their own
 *   enforcement, which the program's security guard forbids. The
 *   table is frozen at module load for the same reason.
 * - Not invented thresholds. Every number below reuses a value the
 *   system already enforces: 0 ms is what a fresh store read
 *   already gives (no cache layer sits between these gates and
 *   their stores); 60,000 ms IS the isolate-cache positive TTL
 *   (SESSION_CACHE_POSITIVE_TTL_MS in sessionCache.ts — the
 *   proving tests assert equality, so a TTL change fails loudly
 *   until this target and authz.md §9 are updated with it);
 *   7 days IS SESSION_TTL; 30 minutes IS the enforced idle
 *   default. Where a reused value is itself a settled CISO value
 *   (idle, step-up — settled by #1757, values unchanged), this
 *   module says so instead of presenting it as unsettled.
 *
 * Scope limits (full list in authz.md §9; summarized here so no
 * reader mistakes a target for universal coverage):
 * - The membership/admin targets bind PDP-enforced gates only.
 *   Legacy sessions inside the §8 bound are PDP-exempt, and
 *   session-gated-only routes never consult memberships — neither
 *   population is covered by the 0 ms targets, and neither is
 *   folded into them.
 * - The session target's 60 s tier is the cross-isolate cached
 *   path only. A wired session is denied immediately on its fresh
 *   read even when a cached copy exists; the 60 s tier never
 *   applies to it.
 * - Admin removal denies admin gates; it does NOT terminate the
 *   removed admin's session. Session-gated routes keep serving
 *   that session until session revocation or expiry.
 * - API keys have no expiry: a key lives until deleted. Deletion
 *   is immediate (0 ms); there is no expiry bound to state.
 * - Idle expiry is enforced against the last RECORDED activity,
 *   which lags true activity by up to 60 s (touch precision, see
 *   iaaaSessionActivity.ts). The idle target is therefore exact
 *   against the recorded deadline, with that recording slack
 *   stated — not hidden inside a looser gate bound.
 */

export type RevocationTrigger =
  | "membership-revocation"
  | "session-revocation"
  | "api-key-deletion"
  | "admin-removal"
  | "token-expiry";

export interface RevocationTarget {
  trigger: RevocationTrigger;
  /**
   * Worst-case milliseconds from the revoking write's completion
   * (or, for token-expiry, from the deadline) to denial at the
   * gate. 0 means the very next gate check denies.
   */
  boundMs: number;
  /** The gate the bound is measured at. */
  gate: string;
  /** How the bound is measured, and what enforces it. */
  measuredAt: string;
}

/** Same-isolate session revocation: the revoking isolate's own next read. */
export const SESSION_REVOCATION_SAME_ISOLATE_BOUND_MS = 0;

/**
 * Cross-isolate session revocation: an isolate that never hears
 * about the delete serves its stale cached copy until the TTL
 * lapses. MUST equal SESSION_CACHE_POSITIVE_TTL_MS (sessionCache.ts);
 * the proving tests assert equality so the two cannot drift apart.
 */
export const SESSION_REVOCATION_CROSS_ISOLATE_BOUND_MS = 60_000;

const membershipRevocation: RevocationTarget = Object.freeze({
  trigger: "membership-revocation" as const,
  boundMs: 0,
  gate: "PDP check (checkRoutePermission / authorize) on PDP-enforced routes",
  measuredAt:
    "First PDP check after the revokeMembership write completes denies. " +
    "The PDP reads the membership store fresh on every check; no " +
    "membership cache sits between store and PDP, so there is no " +
    "grace window. Binding expiry is exact the same way: a binding " +
    "denies at the first check at or after its expiresAtMs.",
});

const sessionRevocation: RevocationTarget = Object.freeze({
  trigger: "session-revocation" as const,
  boundMs: SESSION_REVOCATION_CROSS_ISOLATE_BOUND_MS,
  gate: "Session gate (requireAuth), every isolate",
  measuredAt:
    "Worst case 60,000 ms (the isolate-cache TTL): an isolate that " +
    "never hears about the delete serves its stale copy until the " +
    "TTL lapses, then re-reads the store and denies. Same-isolate " +
    "bound is 0 ms: the logout path invalidates the isolate cache " +
    "before deleting the record, so its next read denies. A wired " +
    "session is denied immediately on every isolate: the wired " +
    "validation path fresh-reads and denies on a missing record " +
    "even when a cached copy exists, so the 60 s tier never applies " +
    "to it.",
});

const apiKeyDeletion: RevocationTarget = Object.freeze({
  trigger: "api-key-deletion" as const,
  boundMs: 0,
  gate: "API-key verification (verifyApiKey) at the MCP transport",
  measuredAt:
    "First verification after the revokeApiKey delete completes " +
    "denies: verification reads the key store fresh (hash lookup, " +
    "then record read) with no cache layer, so a deleted key's " +
    "hash index is already gone. API keys carry no expiry; " +
    "deletion is the only key-revocation trigger.",
});

const adminRemoval: RevocationTarget = Object.freeze({
  trigger: "admin-removal" as const,
  boundMs: 0,
  gate:
    "Admin gates (GET /api/iaaa/overview gate, PDP, grant gate) — all fresh membership reads",
  measuredAt:
    "First admin-gate check after the admin membership's " +
    "revokeMembership write completes denies. Admin removal IS " +
    "membership revocation applied to an admin binding, so it " +
    "shares the membership mechanism and its 0 ms bound. It does " +
    "NOT terminate the removed admin's session: session-gated " +
    "routes keep serving that session until session revocation " +
    "or expiry (see authz.md §9 residual gaps).",
});

const tokenExpiry: RevocationTarget = Object.freeze({
  trigger: "token-expiry" as const,
  boundMs: 0,
  gate: "Session gate (wired validation) and OIDC claim validation",
  measuredAt:
    "0 ms past the deadline at the gate. Absolute session expiry: " +
    "first wired gate check at or after createdAt + SESSION_TTL " +
    "(7 days) denies. Idle expiry: first wired gate check at or " +
    "after recorded last-activity + the enforced idle default " +
    "(30 minutes) denies; recorded activity lags true activity " +
    "by up to 60 s (touch precision), so the bound is exact " +
    "against the recorded deadline, not wall-clock inactivity. " +
    "OIDC claims: a claim with exp at or before now denies on " +
    "presentation. The idle and step-up windows are settled CISO " +
    "values (#1757); this target reuses the enforced defaults. " +
    "Legacy sessions " +
    "without recorded activity are idle-exempt (absolute deadline " +
    "only) — a pinned residual, not part of this target.",
});

/** All five targets, frozen. */
export const REVOCATION_TARGETS: readonly RevocationTarget[] = Object.freeze([
  membershipRevocation,
  sessionRevocation,
  apiKeyDeletion,
  adminRemoval,
  tokenExpiry,
]);

/** Lookup by trigger; same frozen objects as REVOCATION_TARGETS. */
export const REVOCATION_TARGET_BY_TRIGGER: Readonly<
  Record<RevocationTrigger, RevocationTarget>
> = Object.freeze({
  "membership-revocation": membershipRevocation,
  "session-revocation": sessionRevocation,
  "api-key-deletion": apiKeyDeletion,
  "admin-removal": adminRemoval,
  "token-expiry": tokenExpiry,
});
