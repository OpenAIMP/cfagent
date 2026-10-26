/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — composition root for the telemetry ports (R1). This is
 * the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of a binding is a normal, non-error state:
 * createTelemetryAdapter returns null and callers keep their
 * unbound behavior (telemetry routes 503, the evaluateRun
 * projection hook skips silently, exactly as before).
 */
import {
  createD1TelemetryDb,
  D1TelemetryAdapter,
  ensureTelemetrySchema,
} from "./d1TelemetryAdapter";
import type { TelemetryStore } from "./telemetryPorts";

/** Build the telemetry adapter from Worker env, or null if unbound. */
export function createTelemetryAdapter(env: {
  AGENT_DB?: unknown;
}): D1TelemetryAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1TelemetryAdapter(
    createD1TelemetryDb(env.AGENT_DB as D1Database),
  );
}

/** Idempotent schema-ensure for the telemetry tables. */
export async function ensureTelemetryTables(
  adapter: D1TelemetryAdapter,
): Promise<number[]> {
  return ensureTelemetrySchema(adapter.db);
}

export type { TelemetryStore };
