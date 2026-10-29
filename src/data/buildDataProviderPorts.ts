/**
 * src/data/buildDataProviderPorts.ts — #2303 (#1976 step 1):
 * the one production build for the data-provider platform
 * ports. Every host (orchestrator routes, screener agent,
 * options service, shard hosts) builds its ports through here
 * so the wiring cannot drift: adapters come from the
 * composition roots (AGENT_DB → D1 adapters; unbound → nulls
 * and the caller keeps its legacy DO-store path), and the
 * platform tables are schema-ensured exactly once per build —
 * hosts memoize the returned promise per instance.
 *
 * #CDO-mha7
 */

import {
  createProviderCaptureAdapter,
  ensureProviderCaptureTables,
} from "./createProviderCapturePorts";
import {
  createProviderConfigAdapter,
  ensureProviderConfigTables,
} from "./createProviderConfigPorts";
import type { D1ProviderCaptureAdapter } from "./d1ProviderCaptureAdapter";
import type { D1ProviderConfigAdapter } from "./d1ProviderConfigAdapter";

export interface DataProviderPorts {
  config: D1ProviderConfigAdapter | null;
  captures: D1ProviderCaptureAdapter | null;
}

export async function buildDataProviderPorts(env: {
  AGENT_DB?: unknown;
}): Promise<DataProviderPorts> {
  const config = createProviderConfigAdapter(env);
  const captures = createProviderCaptureAdapter(env);
  if (config) await ensureProviderConfigTables(config);
  if (captures) await ensureProviderCaptureTables(captures);
  return { config, captures };
}
