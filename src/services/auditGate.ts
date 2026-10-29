/**
 * Issue #2183 — audit-gate caller helper (proposal slice).
 *
 * Money paths call checkAuditGate BEFORE a consequential action
 * once CISO+CDO sign off AND an operator enables enforcement;
 * until then this helper is available but NOT wired into money
 * paths, so no money-path behavior changes in this slice.
 *
 * Fail direction, deliberately: a missing adapter (AGENT_DB
 * unbound), a policy-load failure, or a chain-append failure is
 * loudly logged and NEVER blocks the action. Blocking on an
 * unavailable policy store before sign-off would convert an
 * operator-data outage into a payment outage with no approved
 * policy behind it. The enforcing-mode fail direction (block vs
 * allow when the store is unreachable) is an open question for
 * CISO+CDO (see issue #2183) and must be decided before any
 * enforcement wiring lands.
 *
 * This module imports port types only — never a store client,
 * never drizzle-orm (structural test pin).
 */
import {
  evaluateAuditGate,
  resolveAuditPolicy,
  type AuditChainEntryInput,
  type AuditGateDecision,
  type AuditPolicyPort,
} from "../data/auditPolicyPorts";

/**
 * Evaluate one consequential action against the operator policy.
 * `auditWriteSucceeded` is the caller's report of whether the
 * durable audit write for this action succeeded. In audit-only
 * mode a would-block decision is logged loudly (the would-block
 * event IS the audit-only record) and the action proceeds.
 * Returns the decision; the caller blocks only when
 * decision.blocked is true.
 */
export async function checkAuditGate(
  setup: () => Promise<AuditPolicyPort | null>,
  action: string,
  auditWriteSucceeded: boolean,
): Promise<AuditGateDecision> {
  try {
    const port = await setup();
    if (!port) {
      console.error(
        `[audit-gate] no audit-policy adapter (AGENT_DB unbound); action ${action} allowed, gate unevaluated.`,
      );
      return {
        action,
        mode: "audit-only",
        blockOnAuditFailure: false,
        blocked: false,
        wouldBlock: false,
        allowed: true,
      };
    }
    const policy = await resolveAuditPolicy(port);
    const decision = evaluateAuditGate(policy, action, auditWriteSucceeded);
    if (decision.wouldBlock) {
      console.error(
        `[audit-gate] AUDIT-ONLY would-block: action ${action} would have blocked on audit failure (mode audit-only, enforcement not enabled); action allowed.`,
      );
    }
    return decision;
  } catch (err) {
    console.error(
      `[audit-gate] policy load failed for action ${action} — allowed, never blocked pre-sign-off:`,
      err instanceof Error ? err.message : String(err),
    );
    return {
      action,
      mode: "audit-only",
      blockOnAuditFailure: false,
      blocked: false,
      wouldBlock: false,
      allowed: true,
    };
  }
}

/**
 * Best-effort chain append, mirroring the journal projection
 * direction: a chain-write failure is loudly logged and never
 * fails the underlying action. The DO mas_events row remains
 * the audit record; this link is its tamper evidence.
 */
export async function appendAuditChainBestEffort(
  setup: () => Promise<AuditPolicyPort | null>,
  input: AuditChainEntryInput,
): Promise<void> {
  try {
    const port = await setup();
    if (!port) {
      console.error("[audit-gate] chain append skipped (AGENT_DB unbound); audit row unaffected.");
      return;
    }
    await port.appendChainEntry(input);
  } catch (err) {
    console.error(
      "[audit-gate] chain append failed — audit row unaffected:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
