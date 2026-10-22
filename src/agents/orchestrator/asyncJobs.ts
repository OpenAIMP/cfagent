/**
 * Issue #992: Async jobs (submit / recover / read / execute the mas_async_jobs queue) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * AsyncJobsContext.
 */

import type { AgentContext, ScheduleOptions } from "agents";
import type { DatabaseORM } from "../../orm";
import type {
  AgentName,
  AsyncJobPayload,
  AsyncJobRecord,
  AsyncJobStatus,
  AsyncJobSubmission,
  Env,
} from "../../types";
import type { NLQSchedulingPort, NLQStockScreenPort } from "../nlq";
import { executeMCPTool } from "../../mcp";
import { executeNaturalLanguageQuery } from "../nlq";
import { getUserDid } from "../did";
import { SqlScanRunStore, SqlStrategyProfileStore } from "../../trading";
import { createDiscoveryService } from "../../services/discoveryService";

/**
 * Ports the async-job functions receive from the class. Table/state
 * ownership stays in OrchestratorAgent (ensureTables/getOrm are the
 * class's own); executeAsyncJob re-enters the class's routeRequest for
 * queued HTTP jobs exactly as before.
 */
export interface AsyncJobsContext {
  env: Env;
  agentCtx: AgentContext;
  ensureTables: () => AgentContext["storage"]["sql"];
  sessionKey: () => string;
  schedule: (when: Date | number | string, callback: string, payload?: unknown, options?: ScheduleOptions) => Promise<unknown>;
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
  getOrm: () => DatabaseORM;
  routeRequest: (request: Request) => Promise<Response>;
  nlqSchedulingPort: () => NLQSchedulingPort;
  nlqStockScreenPort: () => NLQStockScreenPort;
}

export async function submitAsyncJob(ctx: AsyncJobsContext, 
  job: AsyncJobSubmission,
): Promise<{ jobId: string; status: "queued"; statusUrl: string }> {
  const sql = ctx.ensureTables();
  const payloadJson = JSON.stringify(job.payload);
  if (new TextEncoder().encode(payloadJson).byteLength > 17_000_000) {
    throw new Error("Async job payload exceeds the 17 MB serialized storage limit.");
  }
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  sql.exec(
    "DELETE FROM mas_async_jobs WHERE session_id = ? AND status IN ('completed', 'failed') AND created_at < ?",
    ctx.sessionKey(),
    cutoff,
  );
  sql.exec(
    `DELETE FROM mas_async_jobs WHERE job_id IN (
      SELECT job_id FROM mas_async_jobs WHERE session_id = ?
      AND status IN ('completed', 'failed') ORDER BY created_at DESC LIMIT -1 OFFSET 500
    )`,
    ctx.sessionKey(),
  );
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const displayName = job.capability === "http.request"
    ? `${job.payload.method} ${job.payload.pathAndQuery.split("?")[0]}`
    : job.capability === "mcp.tool"
      ? `MCP: ${job.payload.toolName}`
      : job.capability === "nlq.execute"
        ? `NLQ: ${job.payload.query.slice(0, 100)}`
        : `Task: ${job.payload.title}`;
  sql.exec(
    `INSERT INTO mas_async_jobs
      (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    jobId,
    ctx.sessionKey(),
    job.capability,
    displayName,
    payloadJson,
    now,
    now,
  );

  try {
    await ctx.schedule(0, "executeAsyncJob", { jobId } satisfies AsyncJobPayload, {
      idempotent: true,
      retry: { maxAttempts: 1 },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sql.exec(
      "UPDATE mas_async_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'queued'",
      `Could not schedule async work: ${message}`,
      new Date().toISOString(),
      new Date().toISOString(),
      jobId,
    );
    throw error;
  }

  ctx.audit("async_job.queued", "orchestrator", { jobId, capability: job.capability });
  return { jobId, status: "queued", statusUrl: `/api/jobs/${jobId}` };
}

export async function recoverQueuedAsyncJobs(ctx: AsyncJobsContext): Promise<void> {
  const pending = Array.from(ctx.ensureTables().exec(
    "SELECT job_id FROM mas_async_jobs WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 100",
    ctx.sessionKey(),
  )) as Array<{ job_id: string }>;
  for (const { job_id: jobId } of pending) {
    try {
      await ctx.schedule(0, "executeAsyncJob", { jobId } satisfies AsyncJobPayload, {
        idempotent: true,
        retry: { maxAttempts: 1 },
      });
    } catch (error) {
      console.error(`[OrchestratorAgent] Could not reschedule queued async job ${jobId}:`, error);
    }
  }
}

export function getAsyncJob(ctx: AsyncJobsContext, jobId: string): AsyncJobRecord | undefined {
  const sql = ctx.ensureTables();
  const rows = Array.from(sql.exec(
    `SELECT job_id, session_id, capability, display_name, status, result_json, response_status,
            error, created_at, updated_at, started_at, completed_at
     FROM mas_async_jobs WHERE job_id = ? AND session_id = ?`,
    jobId,
    ctx.sessionKey(),
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return undefined;
  if (row.status === "running" && typeof row.started_at === "string" &&
    Date.now() - Date.parse(row.started_at) > 2 * 60 * 60 * 1000) {
    const completedAt = new Date().toISOString();
    sql.exec(
      `UPDATE mas_async_jobs SET status = 'failed',
       error = 'Execution stopped before a result was recorded; the outcome may be unknown. Verify external side effects before submitting again.',
       updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'running'`,
      completedAt,
      completedAt,
      jobId,
    );
    return getAsyncJob(ctx, jobId);
  }
  let result: unknown;
  if (typeof row.result_json === "string") {
    try {
      result = JSON.parse(row.result_json);
    } catch (error) {
      throw new Error(`Stored result for async job ${jobId} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    jobId: String(row.job_id),
    sessionId: String(row.session_id),
    capability: String(row.capability),
    label: String(row.display_name),
    status: row.status as AsyncJobStatus,
    result,
    responseStatus: typeof row.response_status === "number" ? row.response_status : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
  };
}

export function listAsyncJobs(ctx: AsyncJobsContext, limit = 50): AsyncJobRecord[] {
  const rows = Array.from(ctx.ensureTables().exec(
    `SELECT job_id, session_id, capability, display_name, status, error, created_at, updated_at, started_at, completed_at
     FROM mas_async_jobs WHERE session_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    ctx.sessionKey(),
    Math.max(1, Math.min(100, Math.floor(limit))),
  )) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    if (row.status === "running") {
      const updated = getAsyncJob(ctx, String(row.job_id));
      if (updated?.status === "failed") return updated;
    }
    return {
      jobId: String(row.job_id),
      sessionId: String(row.session_id),
      capability: String(row.capability),
      label: String(row.display_name),
      status: row.status as AsyncJobStatus,
      error: typeof row.error === "string" ? row.error : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
      completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
    };
  });
}

export async function executeAsyncJob(ctx: AsyncJobsContext, { jobId }: AsyncJobPayload): Promise<void> {
  const sql = ctx.ensureTables();
  const now = new Date().toISOString();
  const claimed = sql.exec(
    `UPDATE mas_async_jobs SET status = 'running', started_at = ?, updated_at = ?
     WHERE job_id = ? AND session_id = ? AND status = 'queued'`,
    now,
    now,
    jobId,
    ctx.sessionKey(),
  );
  if (claimed.rowsWritten !== 1) return;

  const rows = Array.from(sql.exec(
    "SELECT capability, payload_json FROM mas_async_jobs WHERE job_id = ? AND session_id = ?",
    jobId,
    ctx.sessionKey(),
  )) as Array<{ capability: string; payload_json: string }>;
  const job = rows[0];
  if (!job) throw new Error(`Async job ${jobId} disappeared after it was claimed.`);

  try {
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    let result: unknown;
    let responseStatus: number | undefined;

    if (job.capability === "http.request") {
      const pathAndQuery = String(payload.pathAndQuery || "");
      const method = String(payload.method || "GET");
      const headers = new Headers(payload.headers as HeadersInit);
      const body = typeof payload.body === "string" ? payload.body : undefined;
      const response = await ctx.routeRequest(new Request(new URL(pathAndQuery, "https://agent.internal"), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
      }));
      const responseBody = await response.text();
      if (new TextEncoder().encode(responseBody).byteLength > 5_000_000) {
        throw new Error("Async API response exceeds the 5 MB job-result limit.");
      }
      responseStatus = response.status;
      result = {
        body: responseBody,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } else if (job.capability === "mcp.tool") {
      const toolName = String(payload.toolName || "");
      const args = (payload.arguments || {}) as Record<string, unknown>;
      result = await executeMCPTool(toolName, args, {
        env: ctx.env,
        orm: ctx.getOrm(),
        sessionId: ctx.sessionKey(),
        audit: (type, agent, detail) => ctx.audit(type, agent, detail),
      });
    } else if (job.capability === "task.draft") {
      result = {
        taskId: `task_${crypto.randomUUID().slice(0, 8)}`,
        status: "draft",
        requiresConfirmation: true,
        ...payload,
        message: "Task draft created. Awaiting human confirmation.",
      };
    } else if (job.capability === "nlq.execute") {
      const query = String(payload.query || "").trim();
      if (!query) throw new Error("NLQ job requires a non-empty query.");
      result = await executeNaturalLanguageQuery(
        ctx.getOrm(),
        ctx.sessionKey(),
        query,
        ctx.env,
        typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey(),
        getUserDid(ctx.sessionKey()),
        { scanRunStore: new SqlScanRunStore(ctx.agentCtx.storage.sql), profileStore: new SqlStrategyProfileStore(ctx.agentCtx.storage.sql), schedulingPort: ctx.nlqSchedulingPort(), stockScreenPort: ctx.nlqStockScreenPort(), discoveryRunner: createDiscoveryService({ env: ctx.env, userLogin: typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey(), orm: ctx.getOrm(), sql: ctx.agentCtx.storage.sql }) },
      );
    } else {
      throw new Error(`Unsupported async capability: ${job.capability}`);
    }

    const serializedResult = JSON.stringify(result);
    if (new TextEncoder().encode(serializedResult).byteLength > 12_000_000) {
      throw new Error("Async job result exceeds the 12 MB serialized result limit.");
    }
    const completedAt = new Date().toISOString();
    sql.exec(
      `UPDATE mas_async_jobs SET status = 'completed', result_json = ?, response_status = ?,
       updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'running'`,
      serializedResult,
      responseStatus ?? null,
      completedAt,
      completedAt,
      jobId,
    );
    ctx.audit("async_job.completed", "orchestrator", { jobId, capability: job.capability });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = new Date().toISOString();
    sql.exec(
      `UPDATE mas_async_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
       WHERE job_id = ? AND status = 'running'`,
      message,
      completedAt,
      completedAt,
      jobId,
    );
    ctx.audit("async_job.failed", "orchestrator", { jobId, capability: job.capability, error: message });
    console.error(`[OrchestratorAgent] Async job ${jobId} failed:`, error);
  }
}
