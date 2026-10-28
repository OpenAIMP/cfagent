/**
 * Issues #2020/#2127 — composition root for the subscription
 * store port. This is the ONLY module that maps a Worker binding
 * to a port implementation: domain code imports this helper and
 * the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createSubscriptionAdapter` returns null and callers keep
 * their fail direction — fail-closed on money paths, fail-open
 * on ads reads. A present-but-unreadable store fails at the
 * call site, where the caller decides the direction.
 */
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
  type SubscriptionDb,
} from "./d1SubscriptionAdapter";
import type { SubscriptionStore } from "./subscriptionPorts";

/** Build the subscription store adapter from Worker env, or null if unbound. */
export function createSubscriptionAdapter(env: { AGENT_DB?: unknown }): D1SubscriptionAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1SubscriptionAdapter(createD1SubscriptionDb(env.AGENT_DB as D1Database));
}

export { ensureSubscriptionSchema };
export type { SubscriptionDb, SubscriptionStore };
