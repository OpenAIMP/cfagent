/**
 * Issue #2183 — composition root for the audit-policy port. This
 * is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createAuditPolicyAdapter` returns null and callers keep their
 * fail direction — the gate helper in src/services/auditGate.ts
 * treats a null adapter as "no policy available" and allows the
 * action with a loud log, never blocking on a missing store.
 * What the gate should do in enforcing mode when the store is
 * unreachable is undecided (an open question for CISO+CDO in
 * issue #2183) and must be decided before any enforcement
 * wiring lands. A present-but-unreadable store fails at the
 * call site, where the caller decides the direction.
 */
import {
  createD1AuditPolicyDb,
  D1AuditPolicyAdapter,
  ensureAuditPolicySchema,
  type AuditPolicyDb,
} from "./d1AuditPolicyAdapter";
import type { AuditPolicyPort } from "./auditPolicyPorts";

/** Build the audit-policy adapter from Worker env, or null if unbound. */
export function createAuditPolicyAdapter(env: {
  AGENT_DB?: unknown;
}): D1AuditPolicyAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1AuditPolicyAdapter(createD1AuditPolicyDb(env.AGENT_DB as D1Database));
}

export { ensureAuditPolicySchema };
export type { AuditPolicyDb, AuditPolicyPort };
