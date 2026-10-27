/**
 * ResourceUsagePort composition root (issue #1819).
 *
 * Precedence is durability-first, and it returns null — never a sink that
 * silently drops data — when no durable sink is bound:
 *   1. OBSERVABILITY bound → #1743's Analytics Engine stream (production).
 *   2. AGENT_DB bound → D1 `resource_sql_ops` table (also bound in
 *      production wrangler config; the fallback when AE is unavailable).
 *   3. Neither bound → null. Callers then rely on the store_op v2 log lines
 *      alone (Workers Logs), which carry rows by ns/op even with no sink.
 *
 * Deliberately NOT in this root: the in-memory adapter. A per-isolate array
 * is a test double, not a measurement store; constructing one per request
 * would look like instrumentation while measuring nothing.
 */
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import {
  D1ResourceUsageAdapter,
  type ResourceD1Db,
} from "./d1ResourceUsageAdapter";
import { ObservabilityResourceUsageAdapter } from "./resourceUsageObservabilityAdapter";
import type { ResourceUsagePort } from "./resourceUsagePorts";

export function createResourceUsagePort(env: {
  OBSERVABILITY?: unknown;
  AGENT_DB?: ResourceD1Db | null;
}): ResourceUsagePort | null {
  if (env.OBSERVABILITY) {
    return new ObservabilityResourceUsageAdapter(createObservabilitySink(env));
  }
  if (env.AGENT_DB) {
    return new D1ResourceUsageAdapter(env.AGENT_DB);
  }
  return null;
}
