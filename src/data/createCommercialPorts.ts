/**
 * Issues #2015/#2020 — composition root for the commercial store
 * port. This is the ONLY module that maps a Worker binding to a
 * port implementation: domain code imports this helper and the
 * port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state (the layer
 * is safe to merge before the binding propagates everywhere):
 * `createCommercialAdapter` returns null and callers keep their
 * fail direction — fail-closed on money paths, fail-open on ads
 * reads. A present-but-unreadable store fails at the call site,
 * where the caller decides the direction.
 */
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
  type CommercialDb,
} from "./d1CommercialAdapter";
import type { CommercialStore } from "./commercialPorts";

/** Build the commercial store adapter from Worker env, or null if unbound. */
export function createCommercialAdapter(env: { AGENT_DB?: unknown }): D1CommercialAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1CommercialAdapter(createD1CommercialDb(env.AGENT_DB as D1Database));
}

export { ensureCommercialSchema };
export type { CommercialDb, CommercialStore };
