/**
 * #945 Wiring Phase 2a — auth audit event builders + best-effort recording.
 *
 * Builds Slice 5 IaaaAuditEvent inputs for authentication events and
 * records them through a caller-supplied AuditStore seam. This module
 * creates NO production store: the existing audit route and the
 * mas_events store are untouched. The builders take tenantId as an
 * explicit caller parameter and invent no default themselves. (The
 * GitHub end-to-end slice resolved the two open questions at the
 * call sites: the Kv-backed store in iaaaAuditStore.ts is the
 * backend, and server.ts resolves the tenant as IAAA_TENANT_ID else
 * the documented default "primary" — see iaaaGithubEndToEnd.ts.
 * Inventing any other tenant value would fabricate attribution.)
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
 * context exists). Logout IS hooked since Phase 2b-part1: the
 * hook lives in githubOAuth.ts handleLogout (reached from
 * server.ts /auth/logout) and records BEFORE deleteSession when
 * wiring is ON and the session has an internalUserId. Login
 * events are hooked since the GitHub end-to-end slice: server.ts
 * dispatch supplies the Kv audit store and the resolved tenant
 * (IAAA_TENANT_ID else "primary") to the wired callback, so login
 * success/failure events are recorded in production, best-effort.
 * Whether a failed audit write should BLOCK a wired login (the
 * Slice 5 consequential-action rule) is still an open CISO
 * decision — this slice does not block on audit failure.
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
