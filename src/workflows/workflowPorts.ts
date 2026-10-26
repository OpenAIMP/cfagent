/**
 * Issue #1737 ([AGENTIC] Decouple screener executions onto
 * Workflows) — the workflow PORT. Provider-neutral by
 * construction: this module names no provider, no provider
 * binding type, and no provider delivery mechanics. A future
 * provider swap replaces the adapter behind this port; domain
 * code does not change.
 *
 * The port executes stage-typed job commands. A command is the
 * typed run-screen job (ADR 0003 M8 follow-up: the first job
 * command gets a typed module under the port). The command
 * carries ids and references, never bulk data (claim-check
 * discipline, same as the messaging port): the run request
 * (universe, filters, symbols), the owner's login, and the
 * trigger source. Screen bodies, quotes, and report bytes stay
 * behind the references the command and its outcomes carry.
 *
 * Stage pipeline (owner stage-architecture spec; the workflow
 * is the shape, per #1236 refined): feed (collect from
 * multiple providers) and gather (combine + enrich) are TWO
 * separate stages; analysis runs ONLY on post-gather data and
 * persists its own results, like each prior stage persists its
 * own results independently. The full stage order is feed →
 * gather → analysis → store → serve → deliver (the legacy
 * "generate" stage name is the analysis stage in this split).
 * Stage-typed events are first-class type values, reused from
 * the messaging port (stageEventType builds
 * "feed.completed" and siblings). Triggers are
 * trigger-agnostic: UX events and scheduled events produce the
 * SAME command and the same execution path; the source field
 * records the trigger source for audit and the executor never
 * branches on it.
 *
 * Job/sub-job model (slice-2 alignment, no second job model):
 * a parent job (one request — one ticker set or all tickers)
 * fans out to sub-jobs (shards, e.g. one universe each) that
 * run in parallel and collate under the parent id. The
 * projection grain is the slice-2 agent_shard_jobs row: one
 * row per (chain, job, version), terminal rails
 * completed/submitted/failed. The parent job's chain id IS
 * the job id; each shard is a leg. The collation — including
 * qualified partial results — lives on the parent row's
 * result summary, NOT as a new rail value: "partial" is a
 * result qualification (the #462 vocabulary: a qualified
 * partial report is never a complete screen and never a
 * failure), not a terminal state, so the rails stay
 * completed/submitted/failed and the projection version
 * column stays projection state, never message state. This
 * resolves the two #1739 M10 mismatches without a contract
 * change: (1) qualified partials have their home (the parent
 * row's collation summary); (2) versions are assigned on
 * write by the projector, never carried in commands.
 *
 * Lifecycle (State pattern, screener-doc §7): a workflow job
 * moves Idle → Running → [BudgetConstrained] → Completed |
 * Failed → ReportGenerated. BudgetConstrained is entered when
 * a shard fails or times out but collation still yields a
 * usable partial result — the run continues toward a
 * qualified partial, it does not fail. Completed means the
 * screen finished (qualified or not); ReportGenerated means
 * the canonical report was stored; Failed means no shard
 * produced a usable result. The ledger status
 * (queued/running/completed/failed) is coarser and stays
 * untouched: lifecycle detail rides in the collation summary.
 *
 * Parallelism and timeouts (owner spec; #1204 budgeting):
 * shards run in parallel up to maxParallelShards (a command
 * parameter, defaulted here). Each shard gets its own
 * invocation budget — fan-out across invocations IS the
 * subrequest-budget multiplier (#1785 precedent) — so the
 * bound guards provider rate limits, not the per-invocation
 * cap. Each shard has a deadline (shardTimeoutMs); a shard
 * past its deadline is marked timed_out and collation
 * proceeds with a qualified partial result, never a total
 * failure. A per-shard timeout yields partial results with
 * audit status (the collation summary + the parent row's
 * stage transitions), never a silent drop.
 *
 * Idempotency: the job id IS the idempotency key. Starting a
 * command with an existing job id returns the existing
 * handle and never starts a second run — duplicate scheduled
 * fires for one slot (the #1789 shape) resolve to the same
 * workflow instance. The workflow instance id is derived
 * deterministically from the job id (workflowIdForJob), so a
 * retried start adopts its own instance instead of failing.
 *
 * Failure and retry (blueprint ADR-0003 + NFR: 100%
 * retriable, max 3 retries per step): every workflow step
 * retries up to 3 times; step callbacks are idempotent by
 * construction (idempotent start, replay-no-op projection,
 * journal-guarded store/deliver — the parent row's summary
 * records which shards are already stored/delivered, so a
 * retried step skips them). A failed run is recorded as a
 * failed job with its error and is retryable by starting a
 * new command with a new job id — prior partial output is
 * never duplicated because shards are keyed by shard id and
 * projection replays are no-ops.
 */

import type { StageName } from "../messaging/messagingPorts";

/** Re-exported for workflow callers (single import surface). */
export type { StageName };

/** State-pattern lifecycle states for a workflow job. */
export type WorkflowRunLifecycle =
  | "Idle"
  | "Running"
  | "BudgetConstrained"
  | "Completed"
  | "Failed"
  | "ReportGenerated";

/** Liveness of a workflow instance (coarse; detail lives in the projection). */
export type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting"
  | "waitingForPause"
  | "complete"
  | "errored"
  | "terminated"
  | "unknown";

/** Default cap on concurrently executing shards (provider rate-limit guard). */
export const DEFAULT_MAX_PARALLEL_SHARDS = 4;

/** Default per-shard deadline (ms): generous vs a typical screen, bounded vs infinite. */
export const DEFAULT_SHARD_TIMEOUT_MS = 10 * 60 * 1000;

/** Default poll interval (ms) for the parent's shard-status loop. */
export const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;

/** Max retries per workflow step (blueprint ADR-0003 NFR). */
export const WORKFLOW_STEP_MAX_RETRIES = 3;

/** Max explicit symbols on one command (claim-check: the request, not bulk data). */
export const MAX_COMMAND_SYMBOLS = 200;

/** One shard of a parent job: a universe screen, or an explicit symbol set. */
export interface WorkflowShard {
  /** Shard identity within the parent job (a universe id, or "symbols"). */
  shardId: string;
  /** Universe this shard screens (absent for an explicit-symbol shard). */
  universe?: string;
  /**
   * Explicit symbols this shard screens (premium path;
   * bounded by MAX_COMMAND_SYMBOLS). Listing objects, not
   * bare strings: the route already resolved membership
   * (symbol + company + sector) and the adapter passes it
   * through to the agent request — re-resolving in the
   * adapter could diverge from what the payer asked for.
   */
  symbols?: unknown[];
}

/**
 * The typed run-screen job command. This IS the workflow
 * input: the workflow class receives exactly this object as
 * its params (plus role). No bulk data: filters are criteria,
 * symbols are membership, everything else is a reference.
 */
export interface WorkflowJobCommand {
  /** Idempotency key: slot key for scheduled, timestamp key for manual. */
  jobId: string;
  /** Command type. Only run-screen exists in this slice. */
  type: "run-screen";
  /** Trigger source for audit (never branched on): e.g. "scheduled-tasks" or "manual". */
  source: string;
  trigger: "manual" | "scheduled";
  /** Owner login. Required — fail closed without an identity (#1185). */
  userLogin: string;
  /** Shards to run in parallel (computed by the starter from the request). */
  shards: WorkflowShard[];
  /** Role: "parent" fans out; "shard" executes one shard. Routes start parents. */
  role: "parent" | "shard";
  /** Parent job id (shard commands only). */
  parentJobId?: string;
  /** This shard's descriptor (shard commands only). */
  shard?: WorkflowShard;
  /** Tenant id resolved by the starter (absent → projection best-effort skipped). */
  tenantId?: string;
  /**
   * Issue #1743 — W3C traceparent for the run: the ingress
   * trace continued into the workflow. Steps emit under it
   * when they gain sink access (follow-up); the contract and
   * the adapter passthrough land here, not a fake producer —
   * service-layer call sites carry no request context today.
   */
  traceparent?: string;
  /** Sector filter (recorded on the job; the screen applies it). */
  sector?: string;
  /** Data provider ("etrade" | "yahoo"; the screen defaults it when absent). */
  provider?: string;
  /** Screen criteria (filters object, as the route parsed it). */
  filters?: Record<string, unknown>;
  maxItems?: number;
  maxSymbols?: number;
  environment?: "TEST" | "PROD";
  portfolioContext?: boolean;
  /** Whether the deliver step runs (etrade routes: true; foss/premium: false). */
  deliver?: boolean;
  /** Parallelism bound (default DEFAULT_MAX_PARALLEL_SHARDS). */
  maxParallelShards?: number;
  /** Per-shard deadline in ms (default DEFAULT_SHARD_TIMEOUT_MS). */
  shardTimeoutMs?: number;
  /** Poll interval in ms for the parent's shard-status loop (default DEFAULT_POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
}

/** A started (or already-existing) workflow instance. */
export interface WorkflowHandle {
  workflowId: string;
  jobId: string;
  /** Instance liveness at start time. */
  status: WorkflowInstanceStatus;
  /** True when start adopted an already-running instance (duplicate start). */
  existing: boolean;
  /** Existing job-history path for this job (no new status route). */
  statusUrl: string;
}

/** Liveness read for one workflow instance. */
export interface WorkflowStatus {
  workflowId: string;
  /** Job id when the adapter knows it (the in-memory adapter does; the binding adapter does not — instance status carries no params). */
  jobId?: string;
  status: WorkflowInstanceStatus;
}

/** Provider-neutral workflow execution port. */
export interface WorkflowPort {
  /** Start a command, or adopt the existing instance for its job id. Never starts twice. */
  start(command: WorkflowJobCommand): Promise<WorkflowHandle>;
  /** Liveness for one instance (detail lives in the jobs-history projection). */
  status(workflowId: string): Promise<WorkflowStatus | null>;
}

/** Neutral error codes. Provider error shapes never escape an adapter. */
export type WorkflowErrorCode = "invalid_command" | "start_failed" | "unavailable";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

/**
 * Derive a deterministic instance id from a job id. Instance
 * ids accept at most 100 chars of [A-Za-z0-9_-] (first char
 * not '-'). Job ids in this codebase are slot/timestamp keys
 * over a fixed grammar (dates use '-', times use ':', never
 * interchangeable at one position), so sanitizing
 * non-alphanumerics to '-' is injective for them; the length
 * guard fails fast rather than truncating into a collision.
 */
export function workflowIdForJob(jobId: string): string {
  const id = `screen-${jobId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  if (id.length > 100) {
    throw new WorkflowError(
      "invalid_command",
      `Job id derives an instance id over 100 chars (${id.length}); refusing rather than truncating into a collision.`,
    );
  }
  return id;
}

/** Validate a run-screen command (fail fast, before any start). Throws WorkflowError. */
export function assertWorkflowJobCommand(
  command: WorkflowJobCommand,
): WorkflowJobCommand {
  if (!command || typeof command !== "object") {
    throw new WorkflowError("invalid_command", "Workflow command must be an object.");
  }
  if (command.type !== "run-screen") {
    throw new WorkflowError(
      "invalid_command",
      `Unknown workflow command type "${String((command as { type?: unknown }).type)}" (only "run-screen" exists).`,
    );
  }
  if (!command.jobId || typeof command.jobId !== "string") {
    throw new WorkflowError("invalid_command", "Workflow command requires a jobId (idempotency key).");
  }
  if (!command.userLogin || typeof command.userLogin !== "string") {
    throw new WorkflowError(
      "invalid_command",
      "Workflow command requires a userLogin — no default identity (#1185).",
    );
  }
  if (!command.source || typeof command.source !== "string") {
    throw new WorkflowError("invalid_command", "Workflow command requires a source (trigger source for audit).");
  }
  if (command.trigger !== "manual" && command.trigger !== "scheduled") {
    throw new WorkflowError("invalid_command", 'Workflow command trigger must be "manual" or "scheduled".');
  }
  if (!Array.isArray(command.shards) || command.shards.length === 0) {
    throw new WorkflowError("invalid_command", "Workflow command requires at least one shard.");
  }
  for (const shard of command.shards) {
    if (!shard || typeof shard.shardId !== "string" || shard.shardId.length === 0) {
      throw new WorkflowError("invalid_command", "Every workflow shard requires a shardId.");
    }
    if (shard.symbols && shard.symbols.length > MAX_COMMAND_SYMBOLS) {
      throw new WorkflowError(
        "invalid_command",
        `Workflow shard carries ${shard.symbols.length} symbols over the ${MAX_COMMAND_SYMBOLS} cap (claim-check: membership, not bulk data).`,
      );
    }
  }
  if (command.role === "shard" && (!command.parentJobId || !command.shard)) {
    throw new WorkflowError("invalid_command", "A shard command requires parentJobId and shard.");
  }
  if (
    command.maxParallelShards !== undefined &&
    (!Number.isInteger(command.maxParallelShards) || command.maxParallelShards < 1)
  ) {
    throw new WorkflowError("invalid_command", "maxParallelShards must be a positive integer.");
  }
  if (
    command.shardTimeoutMs !== undefined &&
    (!Number.isInteger(command.shardTimeoutMs) || command.shardTimeoutMs < 1)
  ) {
    throw new WorkflowError("invalid_command", "shardTimeoutMs must be a positive integer.");
  }
  return command;
}

/** One shard's outcome, as the parent collates it. References only, never bodies. */
export interface ShardOutcome {
  shardId: string;
  status: "completed" | "failed" | "timed_out";
  /** True when the shard exceeded its deadline (a timeout is a qualification, not a crash). */
  timedOut?: boolean;
  /** Symbols the shard was asked to consider (coverage denominator). */
  expectedCount?: number;
  /** Symbols the shard actually evaluated (coverage numerator). */
  totalScanned?: number;
  matchedCount?: number;
  /** Canonical report reference for this shard (pdfKey), when one was stored. */
  pdfKey?: string;
  /** Failure detail (never a spec payload, never auth material). */
  error?: string;
  /**
   * Issue #1737: set by the CHILD workflow, which owns store
   * and deliver of its own full result. The parent never
   * stores or delivers — it only collates these flags.
   */
  stored?: boolean;
  delivered?: boolean;
  storeError?: string;
  deliverError?: string;
}

/** One lifecycle transition on the job's journal. */
export interface LifecycleTransition {
  lifecycle: WorkflowRunLifecycle;
  atMs: number;
}

/** One stage transition on the job's journal (stage-typed, via stageEventType vocabulary). */
export interface StageTransition {
  stage: StageName;
  outcome: "completed" | "failed";
  atMs: number;
}

/**
 * The parent row's collation summary (rides the parent
 * agent_shard_jobs row's result summary, capped by the
 * projector). This is the home for qualified partial
 * results: status stays on the terminal rails, qualification
 * lives here.
 */
export interface WorkflowCollation {
  jobId: string;
  workflowId: string;
  /**
   * Final lifecycle: Completed (qualified or not), Failed (no
   * usable shard), or ReportGenerated (every completed shard
   * stored by its child — computed at collation time from the
   * child outputs' stored flags, not by a later parent step).
   */
  lifecycle: "Completed" | "Failed" | "ReportGenerated";
  /** True when any shard failed or timed out but a partial result stands (#462 vocabulary). */
  qualified: boolean;
  /** Coverage across shards: evaluated / considered (null ratio when nothing was considered). */
  coverage: { evaluated: number; considered: number; ratio: number | null };
  shards: ShardOutcome[];
  lifecycleTransitions: LifecycleTransition[];
  stageTransitions: StageTransition[];
  /** Canonical report references stored for this job (pdfKeys). */
  reportKeys: string[];
  /** Shards whose child stored a canonical report (from child outputs, not a parent step). */
  storedShards: string[];
  /** Shards whose child delivered an outcome through the tracked pipeline. */
  deliveredShards: string[];
  /** Per-shard store errors (recorded, not fatal: the screen itself succeeded). */
  storeErrors?: Record<string, string>;
  /** Per-shard deliver errors (recorded, not fatal). */
  deliverErrors?: Record<string, string>;
  /** Top-level error when lifecycle is Failed. */
  error?: string;
}

/** Status URL for a job (existing jobs-history path; no new status route). */
export function workflowStatusUrl(jobId: string): string {
  return `/api/jobs/history?chainId=${encodeURIComponent(jobId)}`;
}
