/**
 * Issue #1676 ([AGENTIC] Slice 2) — composition root for shard
 * job ports (mirrors src/data/createChainSchedulePorts.ts).
 *
 * This is the ONLY module besides the adapters that may
 * touch the AGENT_DB binding, and it never lets a missing
 * binding throw: an unbound environment yields a null
 * adapter, a skipped projection, and a null history read.
 * Callers decide what null means (the job-history route
 * answers 503; the run path treats it as a no-op).
 */
import { createD1ShardJobDb, D1ShardJobAdapter, ensureShardJobSchema } from "./d1ShardJobAdapter";
import { recordAuditEventBestEffort } from "./createAuditReportPorts";
import type { LegOutcome, ShardJobRow } from "./shardJobPorts";
import {
  projectLegOutcomes,
  type ProjectLegOutcomesResult,
} from "./shardJobProjection";

type EnvWithAgentDb = { AGENT_DB?: unknown };

/** Null when AGENT_DB is not bound; never throws. */
export function createShardJobAdapter(
  env: EnvWithAgentDb,
): D1ShardJobAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ShardJobAdapter(createD1ShardJobDb(env.AGENT_DB));
}

export interface ProjectRunLegsInput {
  tenantId: string;
  workspaceId: string;
  chainId: string;
  legs: LegOutcome[];
  nowMs: number;
  writer: string;
}

export type ProjectRunLegsResult = ProjectLegOutcomesResult & {
  /** True when the projection was skipped because no store is bound. */
  skipped?: boolean;
};

/**
 * Project a run's legs into AgentDB. Best-effort by design:
 * an unbound store is a no-op and a store failure is
 * reported, never thrown, so a projection failure can never
 * fail the run that produced the outcomes.
 */
export async function projectRunLegs(
  env: EnvWithAgentDb,
  input: ProjectRunLegsInput,
): Promise<ProjectRunLegsResult> {
  const adapter = createShardJobAdapter(env);
  if (!adapter) {
    return { projected: false, projectedJobs: 0, skippedJobs: 0, skipped: true };
  }
  try {
    await ensureShardJobSchema(adapter.db);
    const result = await projectLegOutcomes({ store: adapter, ...input });
    // Issue #1688 (slice 3, R5): a run that projected jobs
    // also writes one audit event for the projection, keyed
    // by chain, carrying the job counts. Best-effort and
    // never blocking: the audit helper never throws.
    if (result.projectedJobs > 0) {
      await recordAuditEventBestEffort(env, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        chainId: input.chainId,
        eventKind: "project",
        subjectType: "job",
        subjectId: input.chainId,
        actor: "system",
        detailJson: JSON.stringify({
          projectedJobs: result.projectedJobs,
          skippedJobs: result.skippedJobs,
          writer: input.writer,
        }),
        occurredAtMs: input.nowMs,
        provenanceWriter: "scheduled-agent:projectRunLegs",
        provenanceSourceDo: "ScheduledAgent",
        provenanceSourceVersion: "1",
      }, input.nowMs);
    }
    return result;
  } catch (err) {
    return {
      projected: false,
      projectedJobs: 0,
      skippedJobs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Tenant-scoped job history for one chain, latest row per
 * job, newest first. Null when AGENT_DB is not bound.
 */
export async function readJobHistory(
  env: EnvWithAgentDb,
  tenantId: string,
  chainId: string,
): Promise<ShardJobRow[] | null> {
  const adapter = createShardJobAdapter(env);
  if (!adapter) return null;
  await ensureShardJobSchema(adapter.db);
  return adapter.listJobsForChain(tenantId, chainId);
}
