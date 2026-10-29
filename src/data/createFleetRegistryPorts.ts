/**
 * Issue #2288 (#1976 step 0) — composition root for the
 * fleet-registry port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createFleetRegistryAdapter` returns null and callers keep
 * their legacy behaviour. NOTE: this root wires the READ model
 * only — the production writer that populates it is gate G-6
 * and is deliberately not built in this slice.
 */
import {
  createD1FleetRegistryDb,
  D1FleetRegistryAdapter,
  ensureFleetRegistrySchema,
  type FleetRegistryDb,
} from "./d1FleetRegistryAdapter";
import type { FleetRegistryStore } from "./fleetRegistryPorts";

/** Build the fleet-registry adapter from Worker env, or null if unbound. */
export function createFleetRegistryAdapter(env: {
  AGENT_DB?: unknown;
}): D1FleetRegistryAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1FleetRegistryAdapter(
    createD1FleetRegistryDb(env.AGENT_DB as D1Database),
  );
}

export { ensureFleetRegistrySchema };
export type { FleetRegistryDb, FleetRegistryStore };
