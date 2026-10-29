/**
 * Issue #2288 (#1976 step 0) — composition root for the
 * trace-record port. This is the ONLY module that maps a Worker
 * binding to a port implementation: domain code imports this
 * helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createTraceRecordAdapter` returns null and callers keep their
 * legacy behaviour (no trace publication until the substrate is
 * bound — publication wiring is D-F2 follow-up work, not this
 * slice).
 */
import {
  createD1TraceRecordDb,
  D1TraceRecordAdapter,
  ensureTraceRecordSchema,
  type TraceRecordDb,
} from "./d1TraceRecordAdapter";
import type { TraceRecordStore } from "./traceRecordPorts";

/** Build the trace-record adapter from Worker env, or null if unbound. */
export function createTraceRecordAdapter(env: {
  AGENT_DB?: unknown;
}): D1TraceRecordAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1TraceRecordAdapter(
    createD1TraceRecordDb(env.AGENT_DB as D1Database),
  );
}

export { ensureTraceRecordSchema };
export type { TraceRecordDb, TraceRecordStore };
