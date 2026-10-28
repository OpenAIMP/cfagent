/**
 * Workflow Runs read surface — `GET /workflow-runs` (internally; the
 * Worker forwards `/api/workflow-runs` here).
 *
 * Answers one question the other panels answer only in fragments:
 * "what did the workflow engine actually do?" The response is a list
 * of runs — a run per job chain (or standalone job) plus a run per
 * outcome with no job twin — each carrying its ordered stages, the
 * normalized inputs/outputs of every stage, its failures and their
 * reasons, the trigger and how it was evidenced, artifacts, and
 * delivery states.
 *
 * Reads are scoped to this Durable Object (one per signed-in user):
 * jobs by session id, outcomes by the object's own store, stage
 * transitions by the verified login. Each source is read defensively:
 * one broken store never hides the others — its error is named in
 * `storeErrors` and the rest of the ledger still renders.
 *
 * Only summaries leave this module: raw job payloads/results are
 * normalized by src/services/workflowRuns.ts (secret-shaped keys
 * redacted, long values clipped) and the raw rows are never returned.
 */
import { listJobOutcomes } from "../../services/jobOutcomes";
import { listScreeningActivity } from "../../services/screeningActivity";
import type { SqlStorage } from "../../orm";
import {
  buildWorkflowRuns,
  summarizeWorkflowRuns,
  type WorkflowRunJobRow,
  type WorkflowRunOutcomeRow,
  type WorkflowRunStageTransition,
} from "../../services/workflowRuns";

export interface WorkflowRunsSql {
  exec: (query: string, ...args: unknown[]) => Iterable<unknown>;
}

export interface WorkflowRunsRouteContext {
  ensureTables: () => SqlStorage;
  /** The verified login (src/server.ts sets x-user-login from the session). */
  userLogin: string;
  env?: unknown;
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

function clampLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(parsed, MAX_LIMIT));
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read the job tree with payloads — the only read that needs them. */
export function readWorkflowRunJobs(sql: WorkflowRunsSql, sessionId: string, limit: number): WorkflowRunJobRow[] {
  const rows = Array.from(
    sql.exec(
      "SELECT job_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id FROM mas_async_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
      sessionId,
      Math.max(1, Math.min(limit, 500)),
    ),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    job_id: String(row.job_id ?? ""),
    capability: String(row.capability ?? ""),
    display_name: String(row.display_name ?? ""),
    status: String(row.status ?? "unknown"),
    payload_json: str(row.payload_json),
    result_json: str(row.result_json),
    error: str(row.error),
    created_at: String(row.created_at ?? ""),
    updated_at: str(row.updated_at),
    started_at: str(row.started_at),
    completed_at: str(row.completed_at),
    parent_job_id: str(row.parent_job_id),
    job_kind: str(row.job_kind),
    channel: str(row.channel),
    not_before: str(row.not_before),
    stage: str(row.stage),
    chain_id: str(row.chain_id),
  }));
}

/** Flatten the stage-kind activity rows this surface joins on. */
export function readWorkflowRunTransitions(sql: WorkflowRunsSql, userLogin: string, limit: number): WorkflowRunStageTransition[] {
  return listScreeningActivity(sql, userLogin, limit)
    .filter((entry) => entry.kind === "stage")
    .map((entry) => {
      const detail =
        entry.detail && typeof entry.detail === "object" ? (entry.detail as Record<string, unknown>) : {};
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        summary: entry.summary,
        chainId: str(detail.chainId),
        jobId: str(detail.jobId) ?? entry.refId,
        stage: str(detail.stage),
        status: String(detail.status ?? ""),
        reason: str(detail.reason),
      };
    });
}

function outcomeRow(row: ReturnType<typeof listJobOutcomes>[number]): WorkflowRunOutcomeRow {
  return {
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    status: row.status,
    scanned: num(row.scanned),
    matched: num(row.matched),
    codedError: row.codedError,
    reportUrl: row.reportUrl,
    pdfKey: row.pdfKey,
    xlsxKey: row.xlsxKey,
    csvKey: row.csvKey,
    deliveryStates: row.deliveryStates,
    origin: row.origin,
    createdAt: row.createdAt,
  };
}

export async function handleWorkflowRunsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: WorkflowRunsRouteContext,
): Promise<Response | null> {
  const isList = path === "/workflow-runs" || path === "/api/workflow-runs";
  if (!isList) return null;
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const limit = clampLimit(url.searchParams.get("limit"));
  // Jobs are grouped into runs, so read more rows than runs requested —
  // a 5-stage chain must not displace five single-job runs.
  const jobLimit = Math.min(MAX_LIMIT * 10, Math.max(120, limit * 8));
  const storeErrors: Record<string, string> = {};

  let jobs: WorkflowRunJobRow[] = [];
  let outcomes: WorkflowRunOutcomeRow[] = [];
  let transitions: WorkflowRunStageTransition[] = [];

  try {
    const sql = ctx.ensureTables();
    jobs = readWorkflowRunJobs(sql, sessionId, jobLimit);
  } catch (err) {
    storeErrors.jobs = err instanceof Error ? err.message : String(err);
  }
  try {
    outcomes = listJobOutcomes(ctx.ensureTables(), Math.min(MAX_LIMIT * 2, Math.max(50, limit * 2))).map(outcomeRow);
  } catch (err) {
    storeErrors.outcomes = err instanceof Error ? err.message : String(err);
  }
  if (ctx.userLogin) {
    try {
      transitions = readWorkflowRunTransitions(ctx.ensureTables(), ctx.userLogin, 400);
    } catch (err) {
      storeErrors.stages = err instanceof Error ? err.message : String(err);
    }
  } else {
    storeErrors.stages = "skipped: no authenticated user identity available to scope the stage records";
  }

  const runs = buildWorkflowRuns({ jobs, outcomes, transitions, limit });
  return Response.json({
    count: runs.length,
    runs,
    summary: summarizeWorkflowRuns(runs),
    ...(Object.keys(storeErrors).length > 0 ? { storeErrors } : {}),
    generatedAt: new Date().toISOString(),
  });
}
