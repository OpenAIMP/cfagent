/**
 * #1224 — pipeline goals: ordered stages in one scheduled firing.
 *
 * A goal whose operation names a pipeline (e.g. `pipeline:social-daily`)
 * runs through this executor, not the single-operation path. Stages run
 * back-to-back in a single firing, in order, sharing one context object:
 * a stage receives the prior stage's result (date/brief context).
 *
 * Resume semantics (the pipeline-run ledger):
 * - The ledger records stage → completed/skipped/failed per run key,
 *   persisted after every stage.
 * - A re-fire after a FAILED run resumes at the first incomplete
 *   stage: stages already recorded completed are reported, not
 *   re-run. This is what makes a mid-pipeline failure safe to retry
 *   without duplicate work. Stage-produced context (the feed
 *   stage's brief) is stored in the ledger record and restored on
 *   resume, so skipped stages' outputs are not lost.
 * - A re-fire after a COMPLETED or SKIPPED run starts fresh from
 *   stage 0. This is required, not incidental: a skipped run (notably
 *   feed with no brief) must re-check its input on the next firing —
 *   a brief supplied since must let the pipeline proceed — and a
 *   completed run's stages are all idempotent on re-run (drafts are
 *   one-per-date+channel, publishes skip posted/dry-run-posted drafts,
 *   Slack delivery skips delivered cards).
 * - A stage that throws, or returns failed, halts later stages and
 *   the run records failed. A stage that returns skipped ends the
 *   run as skipped (later stages never run). Only a run whose stages
 *   all completed records completed.
 * - Intermediate records (stages persisted while the run is still in
 *   progress) carry status "failed" until the run terminates: any
 *   record that is neither completed nor skipped is resumable, so a
 *   crash mid-run resumes exactly like a stage failure.
 *
 * The executor is store-agnostic: it takes a PipelineLedger. The
 * durable SessionStore-backed ledger lives with the social pipeline
 * (src/agents/social/pipeline.ts); MemoryPipelineLedger is the
 * in-memory implementation (tests).
 *
 * Budget and tick accounting are the caller's job (ScheduledAgent
 * does one budget check per due goal before dispatch, and records
 * one tick per onCron call): the executor never budget-checks and
 * never records ticks. Stage item errors (e.g. per-channel publish
 * errors) are aggregated into result.errors for the caller to record
 * as tick errors; they do NOT fail the run — a stage fails only by
 * throwing or returning failed, mirroring how the social goal
 * executor treats publish errors as recorded-but-not-unfiring.
 */

export type PipelineStageStatus = "completed" | "skipped" | "failed";
export type PipelineRunStatus = "completed" | "skipped" | "failed";

/** Shared context threaded through stages in order. Stages mutate it (feed sets brief). */
export interface PipelineStageContext {
  /** Firing date (YYYY-MM-DD) in the goal's time zone. */
  date: string;
  /** Brief text, set by the feed stage. Absent until feed completes. */
  brief?: string;
}

export interface PipelineStageOutcome {
  status: PipelineStageStatus;
  detail?: string;
  /** Item-level errors for the caller to record (do not fail the run by themselves). */
  errors?: string[];
}

export type PipelineStageFn = (ctx: PipelineStageContext) => Promise<PipelineStageOutcome>;

export interface PipelineRunRecord {
  pipelineId: string;
  runKey: string;
  date: string;
  status: PipelineRunStatus;
  stages: Record<string, PipelineStageStatus>;
  /**
   * Stage-produced context the resume needs: a resumed run does NOT
   * re-run completed stages, so their context contributions (notably
   * the feed stage's brief) must survive in the record, or later
   * stages would see an empty context. Restored into the context on
   * resume; overwritten whenever a fresh run's feed completes.
   */
  brief?: string;
}

export interface PipelineLedger {
  getRun(runKey: string): Promise<PipelineRunRecord | null>;
  putRun(record: PipelineRunRecord): Promise<void>;
}

export class MemoryPipelineLedger implements PipelineLedger {
  private readonly runs = new Map<string, PipelineRunRecord>();

  async getRun(runKey: string): Promise<PipelineRunRecord | null> {
    const record = this.runs.get(runKey);
    return record ? { ...record, stages: { ...record.stages } } : null;
  }

  async putRun(record: PipelineRunRecord): Promise<void> {
    this.runs.set(record.runKey, { ...record, stages: { ...record.stages } });
  }
}

export interface PipelineStageResult {
  name: string;
  status: PipelineStageStatus;
  detail?: string;
}

export interface PipelineRunResult {
  status: PipelineRunStatus;
  date: string;
  stages: PipelineStageResult[];
  /** Aggregated item errors from all stages (plus stage-failure messages). */
  errors: string[];
}

export async function executePipeline(input: {
  pipelineId: string;
  runKey: string;
  date: string;
  stages: string[];
  stageFns: Record<string, PipelineStageFn>;
  ledger: PipelineLedger;
  context: PipelineStageContext;
}): Promise<PipelineRunResult> {
  const prior = await input.ledger.getRun(input.runKey);
  // Resume only a failed (incomplete) run; completed/skipped runs start fresh.
  const resumable = prior !== null && prior.status === "failed";
  // A resumed run does not re-run completed stages, so restore their
  // context contribution (the feed stage's brief) from the record —
  // otherwise later stages would see an empty context and the resume
  // would wrongly end as skipped.
  if (resumable && prior.brief !== undefined) input.context.brief = prior.brief;
  const recorded: Record<string, PipelineStageStatus> = resumable ? { ...prior.stages } : {};
  const startIndex = resumable
    ? input.stages.findIndex((name) => recorded[name] !== "completed")
    : 0;
  const results: PipelineStageResult[] = input.stages.map((name, i) =>
    i < startIndex
      ? { name, status: recorded[name] ?? "completed", detail: "previously completed (resumed)" }
      : { name, status: "completed" },
  );
  const errors: string[] = [];

  // Only stages actually reached in this run (plus resumed ones) are recorded.
  const persist = async (status: PipelineRunStatus) => {
    const reached: Record<string, PipelineStageStatus> = {};
    for (let i = 0; i <= lastRunIndex; i++) reached[results[i].name] = results[i].status;
    await input.ledger.putRun({
      pipelineId: input.pipelineId,
      runKey: input.runKey,
      date: input.date,
      status,
      stages: reached,
      ...(input.context.brief !== undefined ? { brief: input.context.brief } : {}),
    });
  };
  let lastRunIndex = startIndex - 1;

  for (let i = startIndex; i < input.stages.length; i++) {
    const name = input.stages[i];
    const fn = input.stageFns[name];
    if (!fn) {
      results[i] = { name, status: "failed", detail: `unknown stage: ${name}` };
      errors.push(`stage ${name} failed: unknown stage`);
      lastRunIndex = i;
      await persist("failed");
      return { status: "failed", date: input.date, stages: results.slice(0, i + 1), errors };
    }
    let outcome: PipelineStageOutcome;
    try {
      outcome = await fn(input.context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results[i] = { name, status: "failed", detail: message };
      errors.push(`stage ${name} failed: ${message}`);
      lastRunIndex = i;
      await persist("failed");
      return { status: "failed", date: input.date, stages: results.slice(0, i + 1), errors };
    }
    results[i] = { name, status: outcome.status, detail: outcome.detail };
    if (outcome.errors) errors.push(...outcome.errors);
    lastRunIndex = i;
    if (outcome.status === "failed") {
      await persist("failed");
      return { status: "failed", date: input.date, stages: results.slice(0, i + 1), errors };
    }
    if (outcome.status === "skipped") {
      await persist("skipped");
      return { status: "skipped", date: input.date, stages: results.slice(0, i + 1), errors };
    }
    // Completed: persist the intermediate record (status "failed" =
    // incomplete/resumable until the run terminates) so a crash
    // mid-run still resumes instead of redoing work.
    await persist("failed");
  }
  await persist("completed");
  return { status: "completed", date: input.date, stages: results, errors };
}
