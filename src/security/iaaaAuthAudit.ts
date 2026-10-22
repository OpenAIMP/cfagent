/**
 * #945 Wiring Phase 2a — auth audit event builders + best-effort recording.
 *
 * Builds Slice 5 IaaaAuditEvent inputs for authentication events and
 * records them through a caller-supplied AuditStore seam. This module
 * creates NO production store: the existing audit route and the
 * mas_events store are untouched, and no production call site passes
 * a store yet, so in production nothing is recorded by this module.
 * A future phase must decide two things before switching production
 * recording on: (1) a real audit store backend for IAAA events, and
 * (2) a tenant for login events — login in Phase 1 has no tenant
 * concept, so the builders take tenantId as an explicit caller
 * parameter and there is deliberately NO default tenant. Inventing
 * one (e.g. "default") would fabricate tenant attribution.
 *
 * Actor attribution: the actor is the Slice 1 internal user id when
 * known. When it is not known — a login that failed before any
 * binding existed — the actor is the literal string "unknown",
 * which states the absence of attribution rather than attributing
 * the event to a login, an email, or a guessed identity. A login
 * is never attributed by display login: logins can change, and
 * Slice 5 forbids login/email as identity.
 *
 * Best-effort recording, deliberately: `recordWiredAuthAudit`
 * never throws and its result never changes a login outcome in
 * this phase. Whether a failed audit write should BLOCK a wired
 * login (the Slice 5 consequential-action rule) is a CISO
 * decision still open, and blocking logins on a store that does
 * not exist in production yet would be the wrong default. The
 * caller that eventually wires a production store must decide
 * this explicitly and document it; until then, a failed write
 * is reported in the result, not enforced.
 *
 * Not yet audited here (Phase 2b): token-exchange / profile-fetch
 * failures in the wired callback (they fail before any binding
 * context exists), and logout — the logout builder exists, but
 * the logout hook lives in githubOAuth.ts handleLogout (reached
 * from server.ts /auth/logout), not in iaaaLogin.ts, so wiring
 * it is a parent step, not a change made here. See the hook note
 * at the bottom of this header: record the logout event BEFORE
 * deleteSession, using the session's internalUserId when present.
 */

import {
  IAAA_AUDIT_POLICY_VERSION,
  recordAuditEvent,
  type AuditResult,
  type AuditStore,
  type CreateIaaaAuditEventInput,
} from "./iaaaAudit";

/** Explicit marker for unattributed actors; never a real principal. */
export const IAAA_UNKNOWN_ACTOR = "unknown";

export type WiredLoginFailureCode = "MISSING_SUBJECT_ID" | "BINDING_FAILED";

export interface WiredAuthAuditInput {
  tenantId: string;
  timestamp: number;
  correlationId: string;
}

/**
 * Login success: actor = initiating principal = internal user id.
 * Correlation id is the session id created for this login, so the
 * event correlates to exactly one session.
 */
export function buildLoginSuccessAuditEventInput(input: {
  internalUserId: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "auth.login",
    actorPrincipalId: input.internalUserId,
    actorType: "human",
    initiatingPrincipalId: input.internalUserId,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "auth.login",
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * Login failure (missing subject id, or binding failure): the
 * login is denied and failed, and the actor is explicitly
 * "unknown" — no binding existed to attribute it to.
 */
export function buildLoginFailureAuditEventInput(input: {
  code: WiredLoginFailureCode;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "auth.login",
    actorPrincipalId: IAAA_UNKNOWN_ACTOR,
    actorType: "human",
    initiatingPrincipalId: IAAA_UNKNOWN_ACTOR,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "auth.login",
    decision: "deny",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "failed",
    errorCode: input.code,
  };
}

/**
 * Logout: actor = internal user id when the session carried one;
 * "unknown" for legacy sessions without it. The caller (the future
 * logout hook) records this BEFORE the session is deleted.
 */
export function buildLogoutAuditEventInput(input: {
  internalUserId?: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  const actor = input.internalUserId ?? IAAA_UNKNOWN_ACTOR;
  return {
    timestamp: input.timestamp,
    type: "auth.logout",
    actorPrincipalId: actor,
    actorType: "human",
    initiatingPrincipalId: actor,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "auth.logout",
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * Best-effort record: returns the Slice 5 result, and converts a
 * throwing store into an ok:false AUDIT_WRITE_FAILED result
 * instead of propagating. Never throws. Never changes a login
 * outcome by itself — the caller decides what a failure means.
 */
export async function recordWiredAuthAudit(
  store: AuditStore,
  input: CreateIaaaAuditEventInput
): Promise<AuditResult> {
  try {
    return await recordAuditEvent(store, input);
  } catch (err) {
    return {
      ok: false,
      code: "AUDIT_WRITE_FAILED",
      error:
        err instanceof Error
          ? `audit event could not be recorded: ${err.message}`
          : "audit event could not be recorded",
    };
  }
}
