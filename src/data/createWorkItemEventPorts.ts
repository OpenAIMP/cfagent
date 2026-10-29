/**
 * Issue #2288 (#1976 step 0) — composition root for the
 * work-item event port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createWorkItemEventAdapter` returns null and callers keep
 * their legacy behaviour. The production projector that feeds
 * this family from GitHub is the Sentinel programme's S-1
 * specifying work (#2279); this slice builds the store + port.
 */
import {
  createD1WorkItemEventDb,
  D1WorkItemEventAdapter,
  ensureWorkItemEventSchema,
  type WorkItemEventDb,
} from "./d1WorkItemEventAdapter";
import type { WorkItemEventStore } from "./workItemEventPorts";

/** Build the work-item event adapter from Worker env, or null if unbound. */
export function createWorkItemEventAdapter(env: {
  AGENT_DB?: unknown;
}): D1WorkItemEventAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1WorkItemEventAdapter(
    createD1WorkItemEventDb(env.AGENT_DB as D1Database),
  );
}

export { ensureWorkItemEventSchema };
export type { WorkItemEventDb, WorkItemEventStore };
