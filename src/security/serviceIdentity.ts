/**
 * #1185 / #1066 — the explicit service identity for unattended work.
 *
 * Background execution (worker `scheduled()` / `queue()`, session-less
 * entry points) used to run under a hardcoded synthetic login with a
 * process-wide static E*TRADE token as its fallback. That identity is
 * removed: unattended work now runs under an explicit service identity —
 * a non-secret login id the owner configures via `SERVICE_USER_LOGIN`
 * and authorizes once through the same 3-legged E*TRADE linking flow any
 * user completes, so its token is a stored per-identity token in the
 * SessionStore (`etrade:token:<ENV>:<serviceId>`) with the same expiry,
 * renewal, and revocation lifecycle as a user token.
 *
 * Fail-closed contract: when the id is unset, blank, or not login-shaped,
 * there is NO unattended identity. Callers must skip (and log) rather
 * than substitute any other identity.
 */
import { resolveEnvironmentConfig } from "../config/environment";
import type { Env } from "../types";

/** Login shape the Orchestrator accepts on the `x-user-login` header. */
const LOGIN_SHAPE = /^[A-Za-z0-9._-]{1,80}$/;

/** True when `value` is a string shaped like a login this system forwards. */
export function isLoginShaped(value: unknown): value is string {
  return typeof value === "string" && LOGIN_SHAPE.test(value);
}

/**
 * The configured service identity, or null when none is configured.
 * Null is a hard stop for unattended dispatch — never a fallback.
 */
export function getServiceUserLogin(env: Env): string | null {
  const resolved = resolveEnvironmentConfig(env).serviceUserLogin;
  return isLoginShaped(resolved) ? resolved : null;
}

/**
 * The address — NOT an identity — of the shared Orchestrator instance the
 * session-less entry points forward to.
 *
 * Durable Object instance names are addresses, not principals. This
 * value is the legacy instance name: the live state behind it (armed
 * schedules, stored execution context) belongs to that address, and
 * renaming an address orphans the state, so the name is retained until
 * a state migration renames it. It must never be used as a login, a
 * token key, an audit actor, or a payer — identity for those purposes
 * comes from `getServiceUserLogin` or from an authenticated session.
 */
export const SHARED_ORCHESTRATOR_INSTANCE = "default_trader";
