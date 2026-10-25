/**
 * Consolidation C3 (issue #1277, epic #1151) — stage-layered
 * scheduling, the C3 portion of #1236.
 *
 * The stage-chain read model: given a session's async-job records,
 * group the jobs that carry a chain identity (stage + chainId, the
 * additive mas_async_jobs columns) into chains and project each
 * stage's status — queued / running / completed / failed / skipped
 * / held, with the reason stated whenever the stage did not simply
 * complete. A failed stage is the chain's stop point: nothing
 * downstream was scheduled, and the view says where it stopped
 * instead of letting the run look silently incomplete (the #1209
 * invisibility failure is the anti-pattern).
 *
 * Pure projection over AsyncJobRecord — the jobs API and the panel
 * render from the same records the executor writes; this module is
 * the single definition of how a chain reads.
 */

import type { AsyncJobChannel, AsyncJobRecord, PipelineStage } from "../types";

/** Pipeline order of the five stages (feed → … → deliver). */
export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  "feed",
  "generate",
  "store",
  "serve",
  "deliver",
];

export type StageStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "held";

export interface StageStatusView {
  stage: PipelineStage;
  jobId: string;
  status: StageStatus;
  /** Why the stage did not simply complete (failure error, skip
   *  reason, hold reason) — null when it completed or has not run. */
  reason: string | null;
  channel?: AsyncJobChannel;
  notBefore?: string;
  updatedAt: string;
}

export interface StageChainView {
  chainId: string;
  /** The chain's main job (the generate stage row), when present. */
  mainJobId: string | null;
  stages: StageStatusView[];
  /** The first failed stage in pipeline order — where the chain
   *  stopped — or null while the chain is intact. */
  stoppedAt: PipelineStage | null;
}

function stageStatusOf(job: AsyncJobRecord): { status: StageStatus; reason: string | null } {
  if (job.status === "failed") {
    return { status: "failed", reason: job.error ?? "Stage failed without a recorded reason." };
  }
  if (job.status === "completed") {
    const result = (job.result ?? {}) as { status?: unknown; reason?: unknown };
    if (result.status === "skipped") {
      return {
        status: "skipped",
        reason: typeof result.reason === "string" ? result.reason : "Stage skipped without a recorded reason.",
      };
    }
    if (result.status === "held") {
      return {
        status: "held",
        reason: typeof result.reason === "string" ? result.reason : "Stage held without a recorded reason.",
      };
    }
    return { status: "completed", reason: null };
  }
  return { status: job.status, reason: null };
}

/**
 * Group job records into stage chains. Jobs without a chain identity
 * (every pre-C3 job, and every unchained run) are excluded — the
 * absence of a chain is itself the degenerate case, not an empty
 * chain. Chains are ordered by their earliest stage row; stages by
 * pipeline order, then creation time (a chain has one row per stage
 * except deliver, which has one per channel).
 */
export function buildStageChainView(jobs: AsyncJobRecord[]): StageChainView[] {
  const byChain = new Map<string, AsyncJobRecord[]>();
  for (const job of jobs) {
    if (!job.chainId || !job.stage) continue;
    const list = byChain.get(job.chainId) ?? [];
    list.push(job);
    byChain.set(job.chainId, list);
  }
  const chains: StageChainView[] = [];
  for (const [chainId, chainJobs] of byChain) {
    const sorted = [...chainJobs].sort((a, b) => {
      const byStage =
        PIPELINE_STAGE_ORDER.indexOf(a.stage!) - PIPELINE_STAGE_ORDER.indexOf(b.stage!);
      return byStage !== 0 ? byStage : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
    const stages: StageStatusView[] = sorted.map((job) => {
      const { status, reason } = stageStatusOf(job);
      return {
        stage: job.stage!,
        jobId: job.jobId,
        status,
        reason,
        channel: job.channel,
        notBefore: job.notBefore,
        updatedAt: job.updatedAt,
      };
    });
    const failed = stages.find((s) => s.status === "failed");
    chains.push({
      chainId,
      mainJobId:
        sorted.find((j) => j.stage === "generate")?.jobId ??
        sorted.find((j) => j.parentJobId)?.parentJobId ??
        null,
      stages,
      stoppedAt: failed?.stage ?? null,
    });
  }
  chains.sort((a, b) => {
    const aFirst = a.stages[0]?.updatedAt ?? "";
    const bFirst = b.stages[0]?.updatedAt ?? "";
    return aFirst < bFirst ? -1 : aFirst > bFirst ? 1 : 0;
  });
  return chains;
}
