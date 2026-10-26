/**
 * Issue #1701 ([AGENTIC] Slice 6) — composition root for
 * retention purge (mirrors src/data/createShardJobPorts.ts).
 *
 * This is the ONLY module besides the adapters that may
 * touch the AGENT_DB binding, and it never lets a missing
 * binding throw: an unbound environment yields a null
 * adapter and a null purge report. Callers decide what null
 * means (the purge route answers 503).
 *
 * The purge needs no durable-object hop: it touches only
 * the AgentDB projection, so the server calls it directly
 * instead of routing through the shared Orchestrator
 * instance (unlike reconciliation, which reads DO state).
 */
import {
  createD1ShardJobDb,
  D1ShardJobAdapter,
  ensureShardJobSchema,
} from "./d1ShardJobAdapter";
import { runRetentionPurge } from "./retentionPurge";
import type {
  RetentionPurgeOptions,
  RetentionPurgeReport,
} from "./retentionPorts";

type EnvWithAgentDb = { AGENT_DB?: unknown };

/** Null when AGENT_DB is not bound; never throws. */
export function createRetentionPurgeStore(
  env: EnvWithAgentDb,
): D1ShardJobAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ShardJobAdapter(createD1ShardJobDb(env.AGENT_DB));
}

/**
 * Purge expired shard-job rows for one tenant. Null when
 * AGENT_DB is not bound. Throws on store failure — the route
 * maps that to 500.
 */
export async function runRetentionPurgeForTenant(
  env: EnvWithAgentDb,
  tenantId: string,
  options: RetentionPurgeOptions = {},
): Promise<RetentionPurgeReport | null> {
  const adapter = createRetentionPurgeStore(env);
  if (!adapter) return null;
  await ensureShardJobSchema(adapter.db);
  return runRetentionPurge(adapter, tenantId, options);
}
