/**
 * Issue #1737 — the screener workflow flows: the unit-testable
 * execution behind the workflow class. The class itself is a
 * thin adapter (it builds these deps from the environment and
 * delegates); every decision lives here, behind fakeable
 * interfaces, so tests drive the whole lifecycle without a
 * provider runtime.
 *
 * Two flows, one class, two roles (see the port module):
 *  - runShardFlow: one shard's screen. Executes the screen
 *    through the injected runner, stores and delivers its
 *    own full result, projects its shard row, and returns
 *    the summary + store/deliver flags as the workflow
 *    output. A screen that returns success:false is a
 *    BUSINESS outcome (the child completes with a failed
 *    output — no step retry); a runner that THROWS is an
 *    infrastructure failure (the step retries up to
 *    WORKFLOW_STEP_MAX_RETRIES, then the child errors and
 *    the parent marks the shard failed). The child owns
 *    store/deliver because it holds the full result: the
 *    parent never sees bulk data (claim-check). Store is
 *    idempotent by key (screener:<timestamp>); deliver
 *    carries a deterministic deliveryId
 *    (workflow:<jobId>:<shardId>) so re-delivery converges
 *    in the outcome sink. A store/deliver error is recorded,
 *    never fatal: the screen outcome stands.
 *  - runParentFlow: fan-out, poll, collate, project. Shards
 *    run as child workflows in batches of maxParallelShards;
 *    the parent polls child statuses on a sleep loop and
 *    enforces a per-shard deadline. A shard past its
 *    deadline is timed_out and collation proceeds with a
 *    qualified partial — never a total failure. Timed-out
 *    children are NOT terminated: they may still complete
 *    and project their own row, and the parent's collation
 *    stands as the deadline-time truth.
 *
 * Durability shape: every durable fact is a step output or a
 * projection row. The parent reads child SUMMARIES from
 * child instance outputs (status().output), never from rows
 * — rows are progress visibility (jobs/history), not the
 * result channel. The parent never stores or delivers: it
 * collates the children's stored/delivered flags into the
 * parent row's collation summary. Projection failures never
 * fail a run (R5): a failed project is recorded in the
 * result and the run continues.
 *
 * Stage honesty: a completed shard ran feed (quotes),
 * gather (technicals/enrichment), and analysis (screen)
 * inside the delegated screen, in that order — so the parent
 * records feed/gather/analysis completed for it. A failed or
 * timed-out shard records only analysis.failed: how far its
 * internal pipeline got is unobserved, so feed/gather are
 * left unrecorded rather than claimed.
 */

import {
  DEFAULT_MAX_PARALLEL_SHARDS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SHARD_TIMEOUT_MS,
  WORKFLOW_STEP_MAX_RETRIES,
  workflowIdForJob,
  type ShardOutcome,
  type StageTransition,
  type WorkflowCollation,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
  type WorkflowRunLifecycle,
} from "./workflowPorts";
import {
  projectLegOutcomes,
  SHARD_JOB_RESULT_JSON_MAX,
} from "../data/shardJobProjection";
import type { LegOutcome, ShardJobStore } from "../data/shardJobPorts";
import type { GoalDrivenScreenResult } from "../services/goalDrivenScreen";
import type { ScenarioDefinition } from "../services/goalScenarioEngine";

/** Minimal step surface the flows need (fakeable in tests). */
export interface ScreenerWorkflowStep {
  do<T>(
    name: string,
    fn: () => Promise<T>,
    opts?: { retries?: { limit: number } },
  ): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
}

/** Child-workflow operations, as the parent flow sees them. */
export interface ChildWorkflowOps {
  createChild(
    command: WorkflowJobCommand,
  ): Promise<{ workflowId: string }>;
  getChildStatus(
    workflowId: string,
  ): Promise<{
    status: WorkflowInstanceStatus;
    output?: unknown;
    error?: { message: string };
  } | null>;
}

/** The screen request one shard executes (structural subset of the agent's request). */
export interface ShardScreenRequest {
  trigger: "manual" | "scheduled";
  universe?: string;
  symbols?: unknown[];
  provider?: string;
  filters?: Record<string, unknown>;
  userLogin: string;
  environment?: "TEST" | "PROD";
  portfolioContext?: boolean;
  maxItems?: number;
  maxSymbols?: number;
}

/**
 * The screen result one shard returns (structural subset of
 * the agent's result, plus the child's own store/deliver
 * flags). `full` is the OPAQUE full agent result: present
 * only inside the child run, where the child's store/deliver
 * steps consume it — it is STRIPPED from the child output
 * before return, so workflow outputs and the parent
 * collation never carry bulk data (claim-check: outputs
 * carry ids + summaries + flags only).
 */
export interface ShardScreenResult {
  success: boolean;
  timestamp: string;
  universe?: string;
  totalScanned: number;
  expectedCount: number;
  matchedCount: number;
  pdfKey?: string;
  error?: string;
  full?: unknown;
  stored?: boolean;
  delivered?: boolean;
  storeError?: string;
  deliverError?: string;
}

/**
 * Issue #1996 (#1972 slice 1) — the goal-screen request one
 * shard executes. Mirrors the agent's runGoalScreen inputs;
 * the idempotency key is the RUN's key (the parent job id),
 * so a retried child step re-adopts the agent ledger record
 * instead of screening twice.
 */
export interface GoalShardRequest {
  scenario: ScenarioDefinition;
  scenarioSource: "built" | "stored";
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  userLogin: string;
  environment?: "TEST" | "PROD";
  assetClasses?: ("stocks" | "options")[];
  symbols?: string[];
  provider?: "yahoo";
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
}

/** Executes one shard's screen (the agent stub, adapted, in production). */
export interface ScreenRunner {
  runScreen(req: ShardScreenRequest): Promise<ShardScreenResult>;
  /**
   * Issue #1996 — goal-screen execution. Optional so existing
   * market runners keep compiling; a goal command reaching a
   * runner without it FAILS CLOSED (runShardFlow throws) —
   * a goal run must never silently execute as a market screen.
   */
  runGoalScreen?(req: GoalShardRequest): Promise<ShardScreenResult>;
}

/** Dependencies the flows receive (all injected; no bindings here). */
export interface ScreenerWorkflowDeps {
  screenRunner: ScreenRunner;
  /** Projection store, or null when unbound (projection skipped, run continues). */
  shardStore: ShardJobStore | null;
  /**
   * Canonical-report persist (the route's persist, via the
   * owner's door). Payload is the OPAQUE full agent result
   * (the child's `full`, falling back to the summary when a
   * runner provides none) — the flow never inspects it.
   * Keyed by screener:<timestamp>, so a retried store step
   * overwrites the same canonical row (idempotent).
   */
  storeReport: (payload: unknown, userLogin: string) => Promise<void>;
  /**
   * Tracked-pipeline delivery (the route's deliver decision,
   * via the owner's door). Same opaque payload. The door
   * stamps a deterministic deliveryId
   * (workflow:<jobId>:<shardId>) so re-delivery converges
   * in the outcome sink.
   */
  deliverOutcome: (payload: unknown, userLogin: string) => Promise<void>;
  nowMs: () => number;
}

/** Capability id carried on every workflow projection row. */
export const SCREENER_WORKFLOW_CAPABILITY = "screener-workflow";

/** Workspace id convention for workflow rows (matches the scheduled-agent caller). */
export const WORKFLOW_WORKSPACE_ID = "primary";

/** Provenance writer for workflow projection rows. */
export const WORKFLOW_PROVENANCE_WRITER = "screener-workflow:project";

/** Shard row summary: what a child's row (and the parent's collation) carries. */
export interface ShardRowSummary {
  shardId: string;
  status: "completed" | "failed" | "timed_out";
  totalScanned: number;
  expectedCount: number;
  matchedCount: number;
  pdfKey?: string;
  error?: string;
  timestamp: string;
}

/** Build a shard row summary from a screen result. */
export function shardSummaryFromResult(
  shardId: string,
  result: ShardScreenResult,
): ShardRowSummary {
  return {
    shardId,
    status: result.success ? "completed" : "failed",
    totalScanned: result.totalScanned,
    expectedCount: result.expectedCount,
    matchedCount: result.matchedCount,
    ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
    ...(result.error ? { error: result.error } : {}),
    timestamp: result.timestamp,
  };
}

/**
 * Validate a child output as a screen result (garbage output
 * → failed shard, never a crash). Picks up the child's
 * store/deliver flags; NEVER picks up `full` — bulk data
 * must not cross the child→parent boundary even if a child
 * mistakenly includes it.
 */
export function asShardScreenResult(value: unknown): ShardScreenResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.success !== "boolean" ||
    typeof v.timestamp !== "string" ||
    typeof v.totalScanned !== "number" ||
    typeof v.expectedCount !== "number" ||
    typeof v.matchedCount !== "number"
  ) {
    return null;
  }
  return {
    success: v.success,
    timestamp: v.timestamp,
    ...(typeof v.universe === "string" ? { universe: v.universe } : {}),
    totalScanned: v.totalScanned,
    expectedCount: v.expectedCount,
    matchedCount: v.matchedCount,
    ...(typeof v.pdfKey === "string" ? { pdfKey: v.pdfKey } : {}),
    ...(typeof v.error === "string" ? { error: v.error } : {}),
    ...(typeof v.stored === "boolean" ? { stored: v.stored } : {}),
    ...(typeof v.delivered === "boolean" ? { delivered: v.delivered } : {}),
    ...(typeof v.storeError === "string" ? { storeError: v.storeError } : {}),
    ...(typeof v.deliverError === "string" ? { deliverError: v.deliverError } : {}),
  };
}

/** One-line human summary for a parent row's detail (visible in jobs/history). */
export function collationDetail(collation: WorkflowCollation): string {
  const done = collation.shards.filter((s) => s.status === "completed").length;
  const total = collation.shards.length;
  const coverage =
    collation.coverage.ratio === null
      ? "no coverage"
      : `${Math.round(collation.coverage.ratio * 100)}% coverage`;
  const qualified = collation.qualified ? ", qualified partial" : "";
  return `Workflow ${collation.lifecycle}: ${done}/${total} shards, ${coverage}${qualified}.`;
}

/**
 * Pure collation: shard outcomes → the parent summary.
 * Lifecycle: Failed when no shard completed; ReportGenerated
 * when every completed shard was stored by its child;
 * Completed otherwise (qualified when any shard failed or
 * timed out). Stored/delivered sets and error maps come
 * from the child outputs' flags — the parent never stores
 * or delivers, it only collates.
 */
export function collateShards(
  jobId: string,
  workflowId: string,
  outcomes: ShardOutcome[],
  lifecycleTransitions: Array<{ lifecycle: WorkflowRunLifecycle; atMs: number }>,
  stageTransitions: StageTransition[],
): WorkflowCollation {
  const completed = outcomes.filter((o) => o.status === "completed");
  const qualified = outcomes.some((o) => o.status !== "completed");
  const evaluated = outcomes.reduce((n, o) => n + (o.totalScanned ?? 0), 0);
  const considered = outcomes.reduce((n, o) => n + (o.expectedCount ?? 0), 0);
  const storedShards = completed.filter((o) => o.stored).map((o) => o.shardId);
  const deliveredShards = completed.filter((o) => o.delivered).map((o) => o.shardId);
  const storeErrors: Record<string, string> = {};
  const deliverErrors: Record<string, string> = {};
  for (const o of outcomes) {
    if (o.storeError) storeErrors[o.shardId] = o.storeError;
    if (o.deliverError) deliverErrors[o.shardId] = o.deliverError;
  }
  const lifecycle =
    completed.length === 0
      ? "Failed"
      : completed.every((o) => o.stored)
        ? "ReportGenerated"
        : "Completed";
  const reportKeys = outcomes
    .map((o) => o.pdfKey)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  return {
    jobId,
    workflowId,
    lifecycle,
    qualified,
    coverage: {
      evaluated,
      considered,
      ratio: considered > 0 ? evaluated / considered : null,
    },
    shards: outcomes,
    lifecycleTransitions,
    stageTransitions,
    reportKeys,
    storedShards,
    deliveredShards,
    ...(Object.keys(storeErrors).length > 0 ? { storeErrors } : {}),
    ...(Object.keys(deliverErrors).length > 0 ? { deliverErrors } : {}),
    ...(lifecycle === "Failed"
      ? {
          error:
            outcomes.map((o) => o.error).find((e) => typeof e === "string") ??
            "All shards failed.",
        }
      : {}),
  };
}

/** Stage transitions for one shard outcome (see the honesty note in the header). */
export function stageTransitionsForShard(
  outcome: ShardOutcome,
  atMs: number,
): StageTransition[] {
  if (outcome.status === "completed") {
    return [
      { stage: "feed", outcome: "completed", atMs },
      { stage: "gather", outcome: "completed", atMs },
      { stage: "analysis", outcome: "completed", atMs },
    ];
  }
  return [{ stage: "analysis", outcome: "failed", atMs }];
}

/** Cap a JSON summary the way the projector does (never over the row cap). */
function capSummaryJson(value: unknown): string {
  try {
    const json = JSON.stringify(value ?? null);
    return json.length <= SHARD_JOB_RESULT_JSON_MAX
      ? json
      : json.slice(0, SHARD_JOB_RESULT_JSON_MAX) + "[truncated]";
  } catch {
    return '"[unserializable]"';
  }
}

/** Project legs best-effort (a projection failure never fails the run). */
async function projectBestEffort(
  deps: ScreenerWorkflowDeps,
  tenantId: string | undefined,
  chainId: string,
  legs: LegOutcome[],
  nowMs: number,
): Promise<{ projected: boolean; error?: string }> {
  if (!deps.shardStore || !tenantId) return { projected: false };
  try {
    const result = await projectLegOutcomes({
      store: deps.shardStore,
      tenantId,
      workspaceId: WORKFLOW_WORKSPACE_ID,
      chainId,
      legs,
      nowMs,
      writer: WORKFLOW_PROVENANCE_WRITER,
      provenanceSourceDo: "ScreenerWorkflow",
    });
    return { projected: result.projected, error: result.error };
  } catch (err) {
    return {
      projected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build a shard command from a parent command + shard descriptor. */
export function shardCommandFor(
  parent: WorkflowJobCommand,
  shard: WorkflowJobCommand["shards"][number],
): WorkflowJobCommand {
  return {
    ...parent,
    role: "shard",
    parentJobId: parent.jobId,
    shard,
    shards: [shard],
    jobId: `${parent.jobId}:shard:${shard.shardId}`,
  };
}

/** Issue #1996 — the goal-screen request one shard executes. */
export function goalShardRequest(
  command: WorkflowJobCommand,
): GoalShardRequest {
  const g = command.goalScreen;
  if (!g) {
    throw new Error("goalShardRequest called for a command without a goalScreen descriptor.");
  }
  return {
    scenario: g.scenario,
    scenarioSource: g.scenarioSource,
    trigger: command.trigger,
    idempotencyKey: command.parentJobId ?? command.jobId,
    userLogin: command.userLogin,
    ...(command.environment ? { environment: command.environment } : {}),
    ...(g.assetClasses ? { assetClasses: g.assetClasses } : {}),
    ...(g.symbols ? { symbols: g.symbols } : {}),
    ...(g.provider ? { provider: g.provider } : {}),
    ...(g.providerFallback ? { providerFallback: g.providerFallback } : {}),
  };
}

/**
 * Issue #1996 — map a goal-driven screen result onto the
 * shard result shape the parent collates. Counts: a goal run
 * scans stocks + option underlyings; hits are the matches.
 * `full` is the OPAQUE envelope the child's store/deliver
 * steps consume (task id + scenario source + trigger +
 * result); it is STRIPPED from the child output before
 * return, exactly like market results. A "partial" goal run
 * is success with qualification (the #462 vocabulary), never
 * a failure; only "failed" fails the shard, loudly.
 */
export function goalResultToShardResult(input: {
  taskId: string;
  scenarioSource: "built" | "stored";
  trigger: "manual" | "scheduled";
  result: GoalDrivenScreenResult;
  /** Issue #1571: carried so the store door can stamp it when the result lacks it. */
  provider?: "yahoo";
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
}): ShardScreenResult {
  const { result } = input;
  const totalScanned =
    result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned;
  return {
    success: result.status !== "failed",
    timestamp: result.completedAt,
    totalScanned,
    expectedCount: totalScanned,
    matchedCount: result.counts.hits,
    ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
    ...(result.status === "failed"
      ? { error: `Goal screen failed (${result.goalKind}/${result.outlook}).` }
      : {}),
    full: {
      taskId: input.taskId,
      scenarioSource: input.scenarioSource,
      trigger: input.trigger,
      result,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.providerFallback ? { providerFallback: input.providerFallback } : {}),
    },
  };
}

/** The screen request one shard executes. */
export function shardScreenRequest(
  command: WorkflowJobCommand,
): ShardScreenRequest {
  const shard = command.shard;
  return {
    trigger: command.trigger,
    ...(shard?.universe ? { universe: shard.universe } : {}),
    ...(shard?.symbols ? { symbols: shard.symbols } : {}),
    ...(command.provider ? { provider: command.provider } : {}),
    ...(command.filters ? { filters: command.filters } : {}),
    userLogin: command.userLogin,
    ...(command.environment ? { environment: command.environment } : {}),
    ...(command.portfolioContext !== undefined
      ? { portfolioContext: command.portfolioContext }
      : {}),
    ...(command.maxItems !== undefined ? { maxItems: command.maxItems } : {}),
    ...(command.maxSymbols !== undefined ? { maxSymbols: command.maxSymbols } : {}),
  };
}

/**
 * Run one shard: execute, store, deliver, project, return
 * the summary. The child OWNS store and deliver of its own
 * full result — it holds the full result in hand, so the
 * parent never needs bulk data (claim-check: the child
 * output carries the summary + store/deliver flags only,
 * `full` stripped). Store/deliver run for failed screens
 * too (a canonical record of the attempt, matching the
 * sync path, which persists and publishes failures). A
 * store/deliver error is recorded on the output, never
 * fatal: the screen outcome stands.
 */
export async function runShardFlow(
  command: WorkflowJobCommand,
  step: ScreenerWorkflowStep,
  deps: ScreenerWorkflowDeps,
): Promise<ShardScreenResult> {
  const shardId = command.shard?.shardId ?? "unknown";
  // Issue #1996 — goal commands execute the goal runner, never
  // the market runner: a goal run silently executed as a market
  // screen would be a wrong-semantics success. A runner without
  // goal support throws here (step retries, then the shard
  // fails loudly) — fail closed, never fall back.
  const result = command.goalScreen
    ? await step.do(
        "execute-goal-screen",
        () => {
          const runGoalScreen = deps.screenRunner.runGoalScreen;
          if (!runGoalScreen) {
            throw new Error(
              "Goal-screen workflow command reached a runner without runGoalScreen — refusing a market-screen fallback for a goal run (issue #1996).",
            );
          }
          return runGoalScreen(goalShardRequest(command));
        },
        { retries: { limit: WORKFLOW_STEP_MAX_RETRIES } },
      )
    : await step.do(
        "execute-screen",
        () => deps.screenRunner.runScreen(shardScreenRequest(command)),
        { retries: { limit: WORKFLOW_STEP_MAX_RETRIES } },
      );
  const payload = result.full ?? result;
  let stored = false;
  let storeError: string | undefined;
  await step.do("store-shard", async () => {
    try {
      await deps.storeReport(payload, command.userLogin);
      stored = true;
    } catch (err) {
      storeError = err instanceof Error ? err.message : String(err);
    }
  });
  let delivered = false;
  let deliverError: string | undefined;
  if (command.deliver) {
    await step.do("deliver-shard", async () => {
      try {
        await deps.deliverOutcome(payload, command.userLogin);
        delivered = true;
      } catch (err) {
        deliverError = err instanceof Error ? err.message : String(err);
      }
    });
  }
  const summary = shardSummaryFromResult(shardId, result);
  const rowResult = {
    ...summary,
    stored,
    delivered,
    ...(storeError ? { storeError } : {}),
    ...(deliverError ? { deliverError } : {}),
  };
  await step.do("project-shard", async () => {
    await projectBestEffort(deps, command.tenantId, command.parentJobId ?? command.jobId, [
      {
        stepId: shardId,
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "analysis",
        status: result.success ? "completed" : "failed",
        detail: result.success
          ? `Shard ${shardId}: ${result.totalScanned}/${result.expectedCount} evaluated.`
          : `Shard ${shardId} failed: ${result.error ?? "screen failed"}`,
        result: { shardJobIds: [`shard:${shardId}`], result: rowResult },
      },
    ], deps.nowMs());
  });
  // Strip `full`: the parent collects summaries + flags only.
  const { full: _dropped, ...output } = result;
  return {
    ...output,
    stored,
    delivered,
    ...(storeError ? { storeError } : {}),
    ...(deliverError ? { deliverError } : {}),
  };
}

interface PendingShard {
  shard: WorkflowJobCommand["shards"][number];
  workflowId: string;
  deadlineMs: number;
}

/**
 * Run a parent job: fan out, poll with deadlines, collate,
 * project. Returns the final collation (children own
 * store/deliver; their flags arrive in the child outputs).
 */
export async function runParentFlow(
  command: WorkflowJobCommand,
  step: ScreenerWorkflowStep,
  deps: ScreenerWorkflowDeps,
  childOps: ChildWorkflowOps,
): Promise<WorkflowCollation> {
  const nowMs = deps.nowMs;
  const workflowId = workflowIdForJob(command.jobId);
  const maxParallel = command.maxParallelShards ?? DEFAULT_MAX_PARALLEL_SHARDS;
  const shardTimeoutMs = command.shardTimeoutMs ?? DEFAULT_SHARD_TIMEOUT_MS;
  const pollIntervalMs = command.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const lifecycleTransitions: Array<{ lifecycle: WorkflowRunLifecycle; atMs: number }> = [
    { lifecycle: "Idle", atMs: nowMs() },
    { lifecycle: "Running", atMs: nowMs() },
  ];
  const stageTransitions: StageTransition[] = [];

  // Announce: the parent row exists from the start, so
  // jobs/history shows progress while shards run. The
  // submitted leg keys on result.jobId (the projector's
  // submitted rule); the final leg keys on shardJobIds —
  // both resolve to the parent job id, so announce and
  // final are versions of ONE row, not two rows.
  await step.do("announce", async () => {
    await projectBestEffort(deps, command.tenantId, command.jobId, [
      {
        stepId: "parent",
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "feed",
        status: "submitted",
        detail: `Workflow started: ${command.shards.length} shard(s), trigger ${command.trigger}.`,
        result: { jobId: command.jobId },
      },
    ], nowMs());
  });

  // Fan out in batches of maxParallelShards.
  const pending: PendingShard[] = [];
  const outcomes = new Map<string, ShardOutcome>();
  const childResults = new Map<string, ShardScreenResult>();
  for (let i = 0; i < command.shards.length; i += maxParallel) {
    const batch = command.shards.slice(i, i + maxParallel);
    const created = await step.do(`fan-out-batch-${i / maxParallel}`, async () => {
      const out: Array<{ shard: WorkflowJobCommand["shards"][number]; workflowId: string }> = [];
      for (const shard of batch) {
        const child = await childOps.createChild(shardCommandFor(command, shard));
        out.push({ shard, workflowId: child.workflowId });
      }
      return out;
    });
    for (const c of created) {
      pending.push({
        shard: c.shard,
        workflowId: c.workflowId,
        deadlineMs: nowMs() + shardTimeoutMs,
      });
    }
    // Poll this batch to terminal-or-timeout before the next
    // batch starts: this is what bounds concurrency.
    await pollBatch(pending, outcomes, childResults, command, step, deps, childOps, pollIntervalMs, nowMs);
  }

  // Any shard still pending after its batch loop is timed out
  // (the poll loop exits only on terminal-or-deadline, so this
  // is a safety net, not a second path).
  for (const p of pending) {
    if (!outcomes.has(p.shard.shardId)) {
      outcomes.set(p.shard.shardId, {
        shardId: p.shard.shardId,
        status: "timed_out",
        timedOut: true,
        error: `Shard exceeded its ${shardTimeoutMs}ms deadline.`,
      });
    }
  }

  const outcomeList = command.shards.map(
    (s) =>
      outcomes.get(s.shardId) ?? {
        shardId: s.shardId,
        status: "failed" as const,
        error: "Shard never started.",
      },
  );
  for (const o of outcomeList) {
    stageTransitions.push(...stageTransitionsForShard(o, nowMs()));
  }
  if (outcomeList.some((o) => o.status !== "completed")) {
    lifecycleTransitions.push({ lifecycle: "BudgetConstrained", atMs: nowMs() });
  }
  const collation = collateShards(
    command.jobId,
    workflowId,
    outcomeList,
    lifecycleTransitions,
    stageTransitions,
  );
  lifecycleTransitions.push({
    lifecycle: collation.lifecycle,
    atMs: nowMs(),
  });
  collation.lifecycleTransitions = [...lifecycleTransitions];

  // Project the final parent row + one row per shard. The
  // collation already carries the final lifecycle (computed
  // from the child outputs' stored flags) and the error maps,
  // so this single write closes the run — no second
  // project-close step, no journal: the parent never stores
  // or delivers, it only collates what the children did.
  await step.do("project-final", async () => {
    const legs: LegOutcome[] = [
      {
        stepId: "parent",
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "deliver",
        status: collation.lifecycle === "Failed" ? "failed" : "completed",
        detail: collationDetail(collation),
        result: { shardJobIds: [command.jobId], result: collation },
      },
    ];
    // One row per shard. A shard the child already projected
    // replays as a no-op (same status); a shard with no row
    // (child projection failed, errored before projection,
    // or timed out) gains its record here. A timed-out shard
    // that later completes flips its row to completed
    // (version+1); the parent collation stands as the
    // deadline-time truth.
    for (const o of outcomeList) {
      if (o.status === "completed") {
        legs.push({
          stepId: o.shardId,
          capabilityId: SCREENER_WORKFLOW_CAPABILITY,
          stage: "analysis",
          status: "completed",
          detail: `Shard ${o.shardId} completed.`,
          result: {
            shardJobIds: [`shard:${o.shardId}`],
            result: {
              shardId: o.shardId,
              status: "completed",
              totalScanned: o.totalScanned ?? 0,
              expectedCount: o.expectedCount ?? 0,
              matchedCount: o.matchedCount ?? 0,
              pdfKey: o.pdfKey,
              // The child's flags, so a shard whose own row
              // is missing still carries its store/deliver
              // state in the parent's record.
              stored: o.stored ?? false,
              delivered: o.delivered ?? false,
              ...(o.storeError ? { storeError: o.storeError } : {}),
              ...(o.deliverError ? { deliverError: o.deliverError } : {}),
            },
          },
        });
        continue;
      }
      legs.push({
        stepId: o.shardId,
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "analysis",
        status: "failed",
        detail:
          o.status === "timed_out"
            ? `Shard ${o.shardId} timed out after ${shardTimeoutMs}ms.`
            : `Shard ${o.shardId} failed: ${o.error ?? "screen failed"}`,
        result: {
          shardJobIds: [`shard:${o.shardId}`],
          result: {
            shardId: o.shardId,
            status: o.status,
            ...(o.status === "timed_out" ? { timedOut: true } : {}),
            totalScanned: o.totalScanned ?? 0,
            expectedCount: o.expectedCount ?? 0,
            matchedCount: o.matchedCount ?? 0,
            error: o.error,
          },
        },
      });
    }
    await projectBestEffort(deps, command.tenantId, command.jobId, legs, nowMs());
  });

  return collation;
}

/**
 * Poll one batch's pending shards to terminal-or-deadline.
 * Each round is a sleep step + a poll step (durable). A
 * terminal child's output is validated; garbage output
 * becomes a failed shard, never a collation crash.
 */
async function pollBatch(
  pending: PendingShard[],
  outcomes: Map<string, ShardOutcome>,
  childResults: Map<string, ShardScreenResult>,
  command: WorkflowJobCommand,
  step: ScreenerWorkflowStep,
  deps: ScreenerWorkflowDeps,
  childOps: ChildWorkflowOps,
  pollIntervalMs: number,
  nowMs: () => number,
): Promise<void> {
  const shardTimeoutMs = command.shardTimeoutMs ?? DEFAULT_SHARD_TIMEOUT_MS;
  let round = 0;
  for (;;) {
    // Mark overdue shards timed_out at their own deadline
    // (not at the batch's max deadline), then poll the rest.
    const outstanding = pending.filter((p) => !outcomes.has(p.shard.shardId));
    if (outstanding.length === 0) return;
    const now = nowMs();
    const remaining = outstanding.filter((p) => {
      if (now >= p.deadlineMs) {
        outcomes.set(p.shard.shardId, {
          shardId: p.shard.shardId,
          status: "timed_out",
          timedOut: true,
          error: `Shard exceeded its ${shardTimeoutMs}ms deadline.`,
        });
        return false;
      }
      return true;
    });
    if (remaining.length === 0) return;
    await step.sleep(`poll-wait-${round}`, pollIntervalMs);
    const snapshot = await step.do(`poll-${round}`, async () => {
      const out: Array<{
        shardId: string;
        status: WorkflowInstanceStatus;
        output?: unknown;
        error?: { message: string };
      }> = [];
      for (const p of remaining) {
        const s = await childOps.getChildStatus(p.workflowId);
        out.push({
          shardId: p.shard.shardId,
          status: s?.status ?? "unknown",
          ...(s?.output !== undefined ? { output: s.output } : {}),
          ...(s?.error ? { error: s.error } : {}),
        });
      }
      return out;
    });
    for (const s of snapshot) {
      if (s.status === "complete") {
        const result = asShardScreenResult(s.output);
        if (result) {
          childResults.set(s.shardId, result);
          outcomes.set(s.shardId, {
            shardId: s.shardId,
            status: result.success ? "completed" : "failed",
            totalScanned: result.totalScanned,
            expectedCount: result.expectedCount,
            matchedCount: result.matchedCount,
            ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
            ...(result.error ? { error: result.error } : {}),
            // The child's own store/deliver flags (the parent
            // collates them; it never stores or delivers).
            ...(result.stored !== undefined ? { stored: result.stored } : {}),
            ...(result.delivered !== undefined ? { delivered: result.delivered } : {}),
            ...(result.storeError ? { storeError: result.storeError } : {}),
            ...(result.deliverError ? { deliverError: result.deliverError } : {}),
          });
        } else {
          outcomes.set(s.shardId, {
            shardId: s.shardId,
            status: "failed",
            error: "Child workflow output malformed — cannot be a screen result.",
          });
        }
      } else if (s.status === "errored" || s.status === "terminated") {
        outcomes.set(s.shardId, {
          shardId: s.shardId,
          status: "failed",
          error: s.error?.message ?? `Child workflow ${s.status}.`,
        });
      }
      // queued/running/waiting/paused/unknown: still outstanding.
    }
    round += 1;
  }
}
