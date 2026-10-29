/**
 * Issue #2202 — composition root for the billing-policy
 * port. This is the ONLY module that maps a Worker
 * binding to a policy implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createBillingPolicyAdapter` returns null and callers
 * keep their fail direction — fail-closed on money
 * paths. A present-but-unreadable store fails at the
 * call site, where the caller decides the direction.
 */
import {
  createD1BillingPolicyDb,
  D1BillingPolicyAdapter,
  ensureBillingPolicySchema,
  type BillingPolicyDb,
} from "./d1BillingPolicyAdapter";
import type { BillingPolicyStore } from "./billingPolicyPorts";

/** Build the billing-policy adapter from Worker env, or null if unbound. */
export function createBillingPolicyAdapter(env: { AGENT_DB?: unknown }): D1BillingPolicyAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1BillingPolicyAdapter(createD1BillingPolicyDb(env.AGENT_DB as D1Database));
}

export { ensureBillingPolicySchema };
export type { BillingPolicyDb, BillingPolicyStore };
