/**
 * Issue #2303 (#1976 step 1) — composition root for the
 * provider-capture port. This is the ONLY module that maps a
 * Worker binding to the port's production implementation:
 * domain code imports this helper and the port types, never a
 * store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createProviderCaptureAdapter` returns null and callers keep
 * their legacy behaviour (the DO-SQLite store behind the sync
 * surface). AGENT_DB is bound in production (wrangler.jsonc),
 * so production wiring records captures on D1 (the step-1
 * audit's residency ruling).
 */
import {
  createD1ProviderCaptureDb,
  D1ProviderCaptureAdapter,
  ensureProviderCaptureSchema,
  type ProviderCaptureDb,
} from "./d1ProviderCaptureAdapter";
import type { ProviderCaptureStore } from "./providerCapturePorts";

/** Build the provider-capture adapter from Worker env, or null if unbound. */
export function createProviderCaptureAdapter(env: {
  AGENT_DB?: unknown;
}): D1ProviderCaptureAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ProviderCaptureAdapter(
    createD1ProviderCaptureDb(env.AGENT_DB as D1Database),
  );
}

/** Idempotent schema-ensure for the provider-platform tables. */
export async function ensureProviderCaptureTables(
  adapter: D1ProviderCaptureAdapter,
): Promise<number[]> {
  return ensureProviderCaptureSchema(adapter.db);
}

export { ensureProviderCaptureSchema };
export type { ProviderCaptureDb, ProviderCaptureStore };
