/**
 * Issue #1676 ([AGENTIC] Slice 2, shard jobs projection) — the
 * shard job reconcile's execution, extracted from
 * OrchestratorAgent following the #992 decomposition pattern
 * (thin delegating wrapper on the class, execution here).
 * This keeps orchestrator.ts within its standing size budget.
 *
 * This function must run on the Orchestrator instance's
 * storage: the rails list reads that instance's mas_async_jobs
 * rows (already session-filtered by listAsyncJobs), and only
 * terminal rows carrying a chain id converge into the
 * projection. Queued/running rows are not terminal and are
 * skipped; rows without a chain id cannot join a chain's
 * history and are skipped. Throws when AGENT_DB is unbound —
 * the caller surfaces the error, never a fabricated report.
 *
 * Bounded window: listAsyncJobs clamps to 100 rows, so a
 * reconcile pass covers the most recent rails jobs only.
 * That bound is honest and documented, not hidden.
 */
import { createShardJobAdapter } from "../../data/createShardJobPorts";
import { recordAuditEventBestEffort } from "../../data/createAuditReportPorts";
import { ensureShardJobSchema } from "../../data/d1ShardJobAdapter";
import {
  reconcileShardJobs,
  type RailsJobState,
  type ReconcileShardJobsReport,
} from "../../data/shardJobProjection";

export type { ReconcileShardJobsReport };

/** Structural subset of AsyncJobRecord that reconcile needs. */
export interface RailsJobInput {
  jobId: string;
  chainId?: string;
  status: string;
  stage?: string;
  capability: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShardJobReconcileContext {
  env: { AGENT_DB?: unknown };
  listRailsJobs: () => RailsJobInput[];
  tenantId: string;
  nowMs: number;
}

export async function runShardJobReconcile(
  ctx: ShardJobReconcileContext,
): Promise<ReconcileShardJobsReport> {
  const adapter = createShardJobAdapter(ctx.env);
  if (!adapter) {
    throw new Error(
      "[data-foundation] AGENT_DB is not bound; cannot reconcile shard jobs",
    );
  }
  await ensureShardJobSchema(adapter.db);
  const railsStates: RailsJobState[] = ctx
    .listRailsJobs()
    .filter(
      (job) =>
        job.chainId !== undefined &&
        (job.status === "completed" || job.status === "failed"),
    )
    .map((job) => ({
      jobKey: job.jobId,
      chainId: job.chainId as string,
      status: job.status as "completed" | "failed",
      stage: job.stage ?? "unknown",
      capabilityId: job.capability,
      detail:
        job.error ?? `Rails job ${job.jobId} ${job.status}.`,
      createdAtMs: Number.isNaN(Date.parse(job.createdAt))
        ? ctx.nowMs
        : Date.parse(job.createdAt),
      updatedAtMs: Number.isNaN(Date.parse(job.updatedAt))
        ? ctx.nowMs
        : Date.parse(job.updatedAt),
    }));
  const report = await reconcileShardJobs({
    store: adapter,
    tenantId: ctx.tenantId,
    workspaceId: "primary",
    nowMs: ctx.nowMs,
    railsStates,
  });
  // Issue #1688 (slice 3, R5): a reconcile pass writes one
  // tenant-wide audit event carrying its report counts.
  // Best-effort and never blocking: the helper never throws.
  await recordAuditEventBestEffort(ctx.env, {
    tenantId: ctx.tenantId,
    workspaceId: "primary",
    chainId: null,
    eventKind: "reconcile",
    subjectType: "job",
    subjectId: ctx.tenantId,
    actor: "system",
    detailJson: JSON.stringify(report),
    occurredAtMs: ctx.nowMs,
    provenanceWriter: "orchestrator:reconcileShardJobProjection",
    provenanceSourceDo: "Orchestrator",
    provenanceSourceVersion: "1",
  }, ctx.nowMs);
  return report;
}
