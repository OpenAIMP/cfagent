/**
 * src/data/buildMarketplacePorts.ts — #2345 (#1976 step 3a,
 * ADR 0022 D-A): the one production build for the marketplace
 * ports. AGENT_DB bound → the D1 adapters over the fleet
 * tables (migration 0021; schema-ensured + seeded once per
 * build); unbound → the DO-SQLite adapters over the caller's
 * own instance tables (the pre-move per-instance behaviour).
 *
 * Memoized per SqlStorage handle (a WeakMap keyed on the
 * instance's storage object): every host instance builds at
 * most once, so the D1 ensure runs once per instance, and
 * repeat calls from routes/tools are free — the same
 * host-memoization discipline as buildDataProviderPorts,
 * keyed on the handle every composition already holds.
 *
 * #CDO-mha7
 */
import { createMarketplacePorts } from "./createMarketplacePorts";
import {
  createD1MarketplaceDb,
  createD1MarketplacePorts,
  ensureD1Marketplace,
} from "./d1MarketplaceAdapter";
import type { MarketplacePorts } from "./marketplacePorts";
import type { SqlStorage } from "./repositoryPorts";

const cache = new WeakMap<object, Promise<MarketplacePorts>>();

/**
 * Build (or recall) the marketplace ports for one instance.
 * `env` decides the residency; `sqlFallback` is the instance's
 * DO storage handle for the unbound composition.
 */
export function buildMarketplacePorts(
  env: { AGENT_DB?: unknown },
  sqlFallback: SqlStorage,
): Promise<MarketplacePorts> {
  const key = sqlFallback as unknown as object;
  let pending = cache.get(key);
  if (!pending) {
    pending = build(env, sqlFallback);
    cache.set(key, pending);
  }
  return pending;
}

async function build(
  env: { AGENT_DB?: unknown },
  sqlFallback: SqlStorage,
): Promise<MarketplacePorts> {
  const d1 = env?.AGENT_DB as D1Database | undefined;
  if (d1) {
    const db = createD1MarketplaceDb(d1);
    await ensureD1Marketplace(db);
    return createD1MarketplacePorts(db);
  }
  return createMarketplacePorts(sqlFallback);
}
