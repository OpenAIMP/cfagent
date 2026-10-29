/**
 * Issue #2303 (#1976 step 1) — composition root for the
 * provider-configuration port. This is the ONLY module that
 * maps a Worker binding to the port's production
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createProviderConfigAdapter` returns null and callers keep
 * their legacy behaviour (the DO-SQLite store behind the sync
 * surface). AGENT_DB is bound in production (wrangler.jsonc),
 * so production wiring runs provider configuration on D1.
 */
import {
  createD1ProviderConfigDb,
  D1ProviderConfigAdapter,
  ensureProviderConfigSchema,
  type ProviderConfigDb,
} from "./d1ProviderConfigAdapter";
import type { ProviderConfigStore } from "./providerConfigPorts";

/** Build the provider-config adapter from Worker env, or null if unbound. */
export function createProviderConfigAdapter(env: {
  AGENT_DB?: unknown;
}): D1ProviderConfigAdapter | null {
  if (!env.AGENT_DB) return null;
  const d1 = env.AGENT_DB as D1Database;
  return new D1ProviderConfigAdapter(createD1ProviderConfigDb(d1), d1);
}

/** Idempotent schema-ensure for the provider-platform tables. */
export async function ensureProviderConfigTables(
  adapter: D1ProviderConfigAdapter,
): Promise<number[]> {
  return ensureProviderConfigSchema(adapter.db);
}

export { ensureProviderConfigSchema };
export type { ProviderConfigDb, ProviderConfigStore };
