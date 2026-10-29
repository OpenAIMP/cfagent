/**
 * Issue #2208 — composition root for the lifecycle port. This is
 * the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createLifecycleAdapter` returns null and callers keep their
 * fail direction — lifecycle routes fail closed (503) when the
 * store is unbound, and the welcome send is best-effort (a null
 * store is a loud log, never a thrown error).
 */
import {
  createD1LifecycleDb,
  D1LifecycleAdapter,
  ensureLifecycleSchema,
  type LifecycleDb,
} from "./d1LifecycleAdapter";
import type { LifecycleStore } from "./lifecyclePorts";

/** Build the lifecycle store adapter from Worker env, or null if unbound. */
export function createLifecycleAdapter(env: { AGENT_DB?: unknown }): D1LifecycleAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1LifecycleAdapter(createD1LifecycleDb(env.AGENT_DB as D1Database));
}

export { ensureLifecycleSchema };
export type { LifecycleDb, LifecycleStore };
