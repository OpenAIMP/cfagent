/**
 * src/data/dataProviderPortsProvider.ts — #2303 (#1976 step 1):
 * the registered ports builder.
 *
 * Why this exists: several modules that need the data-provider
 * ports at runtime (ETradeService, ETradeTradingPlatform) are
 * reachable from the CLIENT bundle through the trading barrel,
 * and the builder's module graph (D1 adapters → transaction
 * aspect → node:async_hooks) is server-only — a static OR
 * dynamic import from those modules breaks the client build.
 * So the builder is registered once by the worker entry
 * (src/server.ts, the server composition root) and consumers
 * resolve it through here. Unregistered contexts (tests, the
 * client bundle) resolve to null ports, and every consumer
 * keeps its legacy DO-store path — the same absence discipline
 * as the composition roots themselves.
 *
 * This module imports TYPES only and is client-safe.
 *
 * #CDO-mha7
 */

import type { DataProviderPorts } from "./buildDataProviderPorts";

export type DataProviderPortsBuilder = (env: {
  AGENT_DB?: unknown;
}) => Promise<DataProviderPorts>;

let registeredBuilder: DataProviderPortsBuilder | null = null;

/** Register the production ports builder (server entry only). */
export function registerDataProviderPortsBuilder(
  builder: DataProviderPortsBuilder
): void {
  registeredBuilder = builder;
}

/**
 * Build the ports through the registered builder, or resolve
 * to null ports when none is registered (legacy behaviour).
 */
export function buildRegisteredDataProviderPorts(env: {
  AGENT_DB?: unknown;
}): Promise<DataProviderPorts> {
  if (!registeredBuilder) {
    return Promise.resolve({ config: null, captures: null });
  }
  return registeredBuilder(env);
}
