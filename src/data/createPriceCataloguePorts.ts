/**
 * Issue #2185 (sub-issue of #2012) — composition root for the
 * price catalogue port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state (the layer
 * is safe to merge before the binding propagates everywhere):
 * `createPriceCatalogueAdapter` returns null and callers keep
 * their fail direction — fail-closed on money paths. A
 * present-but-unreadable store fails at the call site, where the
 * caller decides the direction.
 */
import {
  createD1PriceCatalogueDb,
  D1PriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
  type PriceCatalogueDb,
} from "./d1PriceCatalogueAdapter";
import type { PriceCatalogue } from "./priceCataloguePorts";

/** Build the price catalogue adapter from Worker env, or null if unbound. */
export function createPriceCatalogueAdapter(env: { AGENT_DB?: unknown }): D1PriceCatalogueAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1PriceCatalogueAdapter(createD1PriceCatalogueDb(env.AGENT_DB as D1Database));
}

export { ensurePriceCatalogueSchema };
export type { PriceCatalogue, PriceCatalogueDb };
