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
  AsyncJobChannel,
  AsyncJobKind,
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
import {
  followupChannelLabel,
  formatHeldNotification,
  formatLifecycleNotification,
  isEmailAllowed,
  planDeliveryFollowups,
  planInitialFollowups,
  planLifecycleNotifications,
  resolveScreenerFollowupConfig,
  screenerKindForPath,
  screenerOutcomeFromHttpJob,
  type FollowupLifecycleEvent,
  type FollowupReportResult,
  type ScreenerRunOutcome,
} from "../../services/screenerFollowups";
import { resolvePipelinePolicy, shouldNotify } from "../../services/pipelinePolicy";

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
  /** Issue #1123: artifact lookups for followup.report jobs — the
   *  ScreenerAgent's stored PDFs, by kind and run key. */
  followupReportPort: () => {
    getStockPdf: (userLogin: string, key: string) => Promise<{ fileName: string } | null>;
    getOptionsPdf: (userLogin: string, key: string) => Promise<{ fileName: string } | null>;
  };
  /** Issue #1123 S3: channel deliveries for followup.deliver jobs. The
   *  port owns content + transport (Slack/email/webhook services); the
   *  executor owns policy (allowlist, skip) and job state. */
  followupDeliveryPort: () => {
    deliver: (input: {
      channel: AsyncJobChannel;
      userLogin: string;
      outcome: import("../../services/screenerFollowups").ScreenerRunOutcome;
      artifacts: Array<{ key: string; fileName: string }>;
    }) => Promise<{ ok: boolean; error?: string; detail?: string }>;
    /** Issue #1123 S4: text-only lifecycle notifications. */
    notify: (input: {
      channel: AsyncJobChannel;
      userLogin: string;
      text: string;
    }) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  };
  /** Issue #1123 S5c: the #277 report-dispatch confirmation gate.
   *  When enabled, followup.deliver jobs hold for approval instead of
   *  sending; the hold is recorded as a 'screener' confirmation in
   *  the same pending-review store (same 24h TTL). */
  reportDispatchHitlEnabled: () => boolean;
  createScreenerConfirmation: (payloadJson: string) => string;
}

const ASYNC_JOB_KINDS: readonly AsyncJobKind[] = ["main", "report", "delivery", "notification"];
const ASYNC_JOB_CHANNELS: readonly AsyncJobChannel[] = ["email", "slack", "webhook"];

/**
 * Issue #1123: additive job-graph migration for mas_async_jobs —
 * parent_job_id / job_kind / channel, probed and added when missing so
 * existing DO tables upgrade in place. Called from
 * OrchestratorAgent.ensureTables after the CREATE TABLE.
 */
export function ensureAsyncJobGraphColumns(sql: AgentContext["storage"]["sql"]): void {
  const cols = Array.from(sql.exec("PRAGMA table_info(mas_async_jobs)")) as Array<{ name?: unknown }>;
  const names = new Set(cols.map((c) => String(c?.name ?? "")));
  if (!names.has("parent_job_id")) {
    sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN parent_job_id TEXT");
  }
  if (!names.has("job_kind")) {
    sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'main'");
  }
  if (!names.has("channel")) {
    sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN channel TEXT");
  }
  sql.exec("CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_parent ON mas_async_jobs(parent_job_id)");
}

/** Issue #1123: map a row's graph columns onto record fields, tolerating
 *  legacy rows (job_kind NULL/'main', no parent/channel). */
function jobGraphFields(row: Record<string, unknown>): {
  parentJobId?: string;
  jobKind: AsyncJobKind;
  channel?: AsyncJobChannel;
} {
  const kind = ASYNC_JOB_KINDS.find((k) => k === row.job_kind);
  const channel = ASYNC_JOB_CHANNELS.find((c) => c === row.channel);
  return {
    parentJobId: typeof row.parent_job_id === "string" && row.parent_job_id ? row.parent_job_id : undefined,
    jobKind: kind ?? "main",
    channel,
  };
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
  const displayName = job.displayName ?? (job.capability === "http.request"
    ? `${job.payload.method} ${job.payload.pathAndQuery.split("?")[0]}`
    : job.capability === "mcp.tool"
      ? `MCP: ${job.payload.toolName}`
      : job.capability === "nlq.execute"
        ? `NLQ: ${job.payload.query.slice(0, 100)}`
        : job.capability === "followup.report"
          ? "Generate report"
          : job.capability === "followup.deliver"
            ? "Deliver report"
            : job.capability === "followup.notify"
              ? "Notify"
              : `Task: ${job.payload.title}`);
  // Single-line column list: the shared MockSqlStorage INSERT parser does
  // not span newlines inside the column list (tests would silently drop
  // the row) — keep this statement on one line.
  sql.exec(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, parent_job_id, job_kind, channel) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
    jobId,
    ctx.sessionKey(),
    job.capability,
    displayName,
    payloadJson,
    now,
    now,
    job.parentJobId ?? null,
    job.jobKind ?? "main",
    job.channel ?? null,
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
            error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel
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
    ...jobGraphFields(row),
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
    `SELECT job_id, session_id, capability, display_name, status, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel
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
      ...jobGraphFields(row),
      error: typeof row.error === "string" ? row.error : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
      completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
    };
  });
}

/** Issue #1123 S4: plan + submit the lifecycle notifications for one
 *  transition. Callers wrap this so notification scheduling can never
 *  fail the job that triggered it. */
async function submitLifecycleNotifications(
  ctx: AsyncJobsContext,
  event: FollowupLifecycleEvent,
  outcome: ScreenerRunOutcome,
  mainJobId: string,
  userLogin: string,
  detail?: string,
): Promise<void> {
  const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
  for (const spec of planLifecycleNotifications(event, outcome, config, mainJobId, userLogin, detail)) {
    await submitAsyncJob(ctx, spec);
  }
}

/**
 * Issue #1123 S5a: the bridge for screener runs that did NOT execute
 * as async jobs (synchronous route executions, scheduled runs).
 * Records the run as a completed main-job row (capability
 * 'screener.run', visible in the jobs panel like any other job) and
 * submits the standard chain — report sub-job + completion/failure
 * notifications — so every completion source produces the same tree.
 * 'started' notifications are not emitted retroactively.
 */
export async function recordScreenerRunMainJob(
  ctx: AsyncJobsContext,
  outcome: ScreenerRunOutcome,
  userLogin: string,
  options?: { chainReport?: boolean },
): Promise<string> {
  const sql = ctx.ensureTables();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const kindLabel = outcome.kind === "stock" ? "Stock" : "Options";
  const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
  const displayName = `${kindLabel} screen${scope ? ` — ${scope}` : ""}`;
  // Single-line INSERT per the MockSqlStorage lesson (multi-line
  // column lists silently no-op in the shared mock).
  sql.exec(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, completed_at, job_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    jobId,
    ctx.sessionKey(),
    "screener.run",
    displayName,
    outcome.success ? "completed" : "failed",
    JSON.stringify({ outcome, userLogin }),
    JSON.stringify({
      status: outcome.success ? "completed" : "failed",
      kind: outcome.kind,
      trigger: outcome.trigger,
      matchedCount: outcome.matchedCount,
      totalScanned: outcome.totalScanned,
      reportUrl: outcome.reportUrl,
      bridged: true,
    }),
    outcome.success ? null : outcome.error ?? null,
    now,
    now,
    now,
    "main",
  );
  ctx.audit("screener.run_bridged", "orchestrator", { jobId, kind: outcome.kind, success: outcome.success });
  const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
  // chainReport=false covers sources whose report delivery lives on
  // another sanctioned path (scheduled options, #223): the run is
  // recorded + notified, never double-delivered.
  if (options?.chainReport !== false) {
    for (const spec of planInitialFollowups(outcome, config, jobId, userLogin)) {
      await submitAsyncJob(ctx, spec);
    }
  }
  await submitLifecycleNotifications(ctx, outcome.success ? "completed" : "failed", outcome, jobId, userLogin);
  return jobId;
}

/** Route/scheduler-facing alias: bridge one finished run end-to-end.
 *  chainReport=false records + notifies without the report chain
 *  (sources whose delivery lives on another sanctioned path). */
export async function scheduleScreenerFollowups(
  ctx: AsyncJobsContext,
  outcome: ScreenerRunOutcome,
  userLogin: string,
  chainReport?: boolean,
): Promise<void> {
  await recordScreenerRunMainJob(ctx, outcome, userLogin, { chainReport: chainReport !== false });
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

    // Issue #1123 S4: a screener main job announces its start on Slack
    // + email as tracked notification sub-jobs. Planned exactly once —
    // only the executor that won the claim reaches this point.
    if (job.capability === "http.request") {
      const kind = screenerKindForPath(typeof payload.pathAndQuery === "string" ? payload.pathAndQuery : "");
      if (kind) {
        try {
          const startHeaders = (payload.headers ?? {}) as Record<string, unknown>;
          const startUserLogin = typeof startHeaders["x-user-login"] === "string" ? startHeaders["x-user-login"] : ctx.sessionKey();
          await submitLifecycleNotifications(
            ctx,
            "started",
            { kind, trigger: "manual", success: true, pdfKeys: [] },
            jobId,
            startUserLogin,
          );
        } catch (notifyError) {
          console.error(`[OrchestratorAgent] Start notification scheduling failed for job ${jobId}:`, notifyError);
        }
      }
    }

    if (job.capability === "http.request") {
      const pathAndQuery = String(payload.pathAndQuery || "");
      const method = String(payload.method || "GET");
      const headers = new Headers(payload.headers as HeadersInit);
      // Issue #1123: the harmonization seam — a route executed as a job
      // can see its main-job id and defer follow-ups (report, delivery,
      // notifications) to the tracked pipeline instead of firing its
      // own untracked publishers.
      headers.set("x-async-job-id", jobId);
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
    } else if (job.capability === "followup.report") {
      // Issue #1123 S2: secure the run's report artifact for the
      // pipeline. The run generates the PDF once (inside the screening
      // pipeline); this sub-job verifies and adopts the stored artifact
      // so S3's deliveries all share the same bytes. A failed run
      // generation completes as 'skipped' with the reason — never a
      // stale-PDF fallback (the #822 honesty rule).
      const outcome = payload.outcome as import("../../services/screenerFollowups").ScreenerRunOutcome;
      const userLogin = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
      if (!outcome || typeof outcome !== "object") throw new Error("followup.report job requires an outcome payload.");
      if (outcome.pdfStatus === "failed") {
        result = { status: "skipped", reason: outcome.pdfError || "Report generation failed during the run." };
      } else if (!outcome.pdfKeys || outcome.pdfKeys.length === 0) {
        result = { status: "skipped", reason: "The run produced no report artifact key." };
      } else {
        const port = ctx.followupReportPort();
        const artifacts: Array<{ key: string; fileName: string; kind?: "pdf" | "xlsx" }> = [];
        const missing: string[] = [];
        for (const key of outcome.pdfKeys) {
          const pdf = outcome.kind === "stock"
            ? await port.getStockPdf(userLogin, key)
            : await port.getOptionsPdf(userLogin, key);
          if (pdf) artifacts.push({ key, fileName: pdf.fileName, kind: "pdf" });
          else missing.push(key);
        }
        if (artifacts.length === 0) {
          throw new Error(`Report artifact(s) referenced by the run are missing from storage: ${missing.join(", ")}`);
        }
        // Issue #1191 (#1173 R3): adopt the run's XLSX alongside the
        // PDF so deliveries carry text + PDF + XLSX. persistRun only
        // stamps the key after a successful store, so the outcome's
        // word is the adoption evidence (the delivery port's byte
        // fetch is the verification — a missing XLSX is reported in
        // the delivery detail, never fabricated). A failed XLSX
        // generation is recorded on the result, not silent.
        let xlsxNote: string | undefined;
        if (outcome.kind === "stock" && outcome.xlsxKey && outcome.xlsxStatus !== "failed") {
          artifacts.push({ key: outcome.xlsxKey, fileName: "screener-report.xlsx", kind: "xlsx" });
        } else if (outcome.kind === "stock" && outcome.xlsxStatus === "failed") {
          xlsxNote = outcome.xlsxError || "XLSX generation failed during the run.";
        }
        result = { status: "ready", artifacts, missingKeys: missing, ...(xlsxNote ? { xlsxNote } : {}) };
      }
    } else if (job.capability === "followup.deliver") {
      // Issue #1123 S3: deliver the shared report artifact on one
      // channel. Policy lives here (skip passthrough, the Assessment's
      // email allowlist); transport lives behind the delivery port.
      const channel = payload.channel as AsyncJobChannel;
      const outcome = payload.outcome as import("../../services/screenerFollowups").ScreenerRunOutcome;
      const artifacts = (payload.artifacts ?? []) as Array<{ key: string; fileName: string; kind?: "pdf" | "xlsx" }>;
      const userLogin = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
      // Issue #1191 (#1173 R3): the pipeline policy gates deliveries
      // per channel + event — an operator's explicit off switch
      // completes the job as 'skipped' with the reason recorded,
      // instead of the pre-R3 behavior where coverage depended on
      // incidental config.
      const pipelinePolicy = resolvePipelinePolicy(ctx.env as unknown as Record<string, unknown>);
      if (typeof payload.skipReason === "string" && payload.skipReason) {
        result = { status: "skipped", reason: payload.skipReason, channel };
      } else if (!shouldNotify(pipelinePolicy, "completed", channel)) {
        result = { status: "skipped", reason: `Pipeline policy disables completed-run deliveries on ${channel}.`, channel };
      } else if (typeof payload.approvedConfirmationId !== "string" && ctx.reportDispatchHitlEnabled()) {
        // Issue #1123 S5c / #277: with the confirmation gate on, the
        // delivery HOLDS — it is recorded as a pending 'screener'
        // confirmation carrying the full delivery spec, and approval
        // in the pending-review surface resubmits it with the
        // approval marker. Nothing unapproved is ever sent.
        const self = getAsyncJob(ctx, jobId);
        const confirmationId = ctx.createScreenerConfirmation(JSON.stringify({
          delivery: {
            outcome,
            userLogin,
            channel,
            artifacts,
            parentJobId: self?.parentJobId,
            displayName: self?.label,
          },
        }));
        result = {
          status: "held",
          channel,
          confirmationId,
          reason: "Report-dispatch confirmation (#277) is enabled; delivery held for approval.",
        };
        // Issue #1191 (#1173 R3): a held delivery announces itself —
        // before R3 the hold was silent, which is how completed runs
        // produced no message of any kind. Best-effort: announcement
        // failure never changes the hold outcome. (Webhook is a
        // delivery channel, not a notification channel — slack/email
        // only, and only when the policy allows held notices.)
        if (channel !== "webhook" && shouldNotify(pipelinePolicy, "held", channel)) {
          try {
            await ctx.followupDeliveryPort().notify({
              channel,
              userLogin,
              text: formatHeldNotification(outcome),
              ...(channel === "email" && outcome.emailTo ? { emailTo: outcome.emailTo } : {}),
              ...(channel === "slack" && outcome.slackChannel ? { slackChannel: outcome.slackChannel } : {}),
            });
          } catch (announceError) {
            console.warn("[asyncJobs] held-delivery announcement failed:", announceError instanceof Error ? announceError.message : String(announceError));
          }
        }
      } else {
        if (channel === "email") {
          const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
          // Per-task override wins over the env recipient (S5b); the
          // allowlist applies to the effective recipient either way.
          const to = outcome.emailTo ?? config.channels.email.to;
          if (!to) throw new Error("Email delivery is not configured (SCREENER_EMAIL_TO is unset).");
          if (!isEmailAllowed(config, to, outcome)) {
            throw new Error(`Email recipient ${to} is not in the screener email allowlist; delivery refused.`);
          }
        }
        const delivery = await ctx.followupDeliveryPort().deliver({ channel, userLogin, outcome, artifacts });
        if (!delivery.ok) throw new Error(delivery.error || `Delivery via ${channel} failed.`);
        result = { status: "sent", channel, detail: delivery.detail };
      }
    } else if (job.capability === "followup.notify") {
      // Issue #1123 S4: one lifecycle notification on one channel.
      // Text-only; the email allowlist applies exactly as for
      // deliveries (Assessment cross-channel rule).
      const channel = payload.channel as AsyncJobChannel;
      const event = payload.event as FollowupLifecycleEvent;
      const outcome = payload.outcome as ScreenerRunOutcome;
      const userLogin = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
      // Issue #1191 (#1173 R3): pipeline policy gate, mirroring the
      // deliver branch — a policy-off event/channel completes as
      // 'skipped' with the reason on the job, never a silent drop.
      const notifyPolicy = resolvePipelinePolicy(ctx.env as unknown as Record<string, unknown>);
      if (!shouldNotify(notifyPolicy, event, channel)) {
        result = { status: "skipped", reason: `Pipeline policy disables ${event} notifications on ${channel}.`, channel, event };
      } else {
      if (channel === "email") {
        const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
        // Issue #1191: per-task recipient wins (mirrors deliveries);
        // the allowlist applies to the effective recipient.
        const to = outcome.emailTo ?? config.channels.email.to;
        if (!to) throw new Error("Email notification is not configured (SCREENER_EMAIL_TO is unset).");
        if (!isEmailAllowed(config, to, outcome)) {
          throw new Error(`Email recipient ${to} is not in the screener email allowlist; notification refused.`);
        }
      }
      const text = formatLifecycleNotification(
        event,
        outcome,
        typeof payload.detail === "string" ? payload.detail : undefined,
      );
      const sent = await ctx.followupDeliveryPort().notify({
        channel,
        userLogin,
        text,
        ...(channel === "email" && outcome.emailTo ? { emailTo: outcome.emailTo } : {}),
        ...(channel === "slack" && outcome.slackChannel ? { slackChannel: outcome.slackChannel } : {}),
      });
      if (!sent.ok) throw new Error(sent.error || `Notification via ${channel} failed.`);
      result = { status: "notified", channel, event };
      }
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

    // Issue #1123 S2: a completed screener main-job schedules its
    // follow-ups (report first; deliveries/notifications chain from
    // there in S3/S4). Scheduling must never fail the main job.
    if (job.capability === "http.request") {
      try {
        const httpResult = result as { body?: string } | undefined;
        const outcome = screenerOutcomeFromHttpJob(
          String(payload.pathAndQuery || ""),
          responseStatus,
          typeof httpResult?.body === "string" ? httpResult.body : "",
        );
        if (outcome) {
          const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
          const headers = (payload.headers || {}) as Record<string, string>;
          const userLogin = typeof headers["x-user-login"] === "string" ? headers["x-user-login"] : ctx.sessionKey();
          for (const spec of planInitialFollowups(outcome, config, jobId, userLogin)) {
            await submitAsyncJob(ctx, spec);
          }
          // S4: completion (or run-level failure) notifications ride
          // the same completion point — Slack + email, tracked.
          await submitLifecycleNotifications(
            ctx,
            outcome.success ? "completed" : "failed",
            outcome,
            jobId,
            userLogin,
          );
        }
      } catch (followupError) {
        ctx.audit("followup.schedule_failed", "orchestrator", {
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
        console.error(`[OrchestratorAgent] Follow-up scheduling failed for job ${jobId}:`, followupError);
      }
    }

    // Issue #1123 S3: a completed report sub-job chains the deliveries
    // (parented to the MAIN job, not the report). Same never-fail rule.
    if (job.capability === "followup.report") {
      try {
        const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
        const outcome = (payload as { outcome?: import("../../services/screenerFollowups").ScreenerRunOutcome }).outcome;
        const userLogin = typeof (payload as { userLogin?: unknown }).userLogin === "string"
          ? (payload as { userLogin: string }).userLogin
          : ctx.sessionKey();
        if (outcome) {
          const mainJobId = getAsyncJob(ctx, jobId)?.parentJobId ?? jobId;
          const specs = planDeliveryFollowups(
            outcome,
            config,
            (result ?? {}) as FollowupReportResult,
            mainJobId,
            userLogin,
          );
          for (const spec of specs) {
            await submitAsyncJob(ctx, spec);
          }
        }
      } catch (followupError) {
        ctx.audit("followup.schedule_failed", "orchestrator", {
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
        console.error(`[OrchestratorAgent] Delivery scheduling failed for job ${jobId}:`, followupError);
      }
    }

    // Issue #1123 S4: a delivery that actually sent announces itself —
    // 'delivered' notifications parented to the MAIN job.
    if (job.capability === "followup.deliver" && (result as { status?: string } | undefined)?.status === "sent") {
      try {
        const outcome = (payload as { outcome?: ScreenerRunOutcome }).outcome;
        const channel = payload.channel as AsyncJobChannel;
        const userLogin = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
        if (outcome) {
          const mainJobId = getAsyncJob(ctx, jobId)?.parentJobId ?? jobId;
          await submitLifecycleNotifications(
            ctx,
            "delivered",
            outcome,
            mainJobId,
            userLogin,
            `via ${followupChannelLabel(channel)}`,
          );
        }
      } catch (followupError) {
        ctx.audit("followup.schedule_failed", "orchestrator", {
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
        console.error(`[OrchestratorAgent] Delivered-notification scheduling failed for job ${jobId}:`, followupError);
      }
    }
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
    // Issue #1123 S4: a screener main job that fails hard (the route
    // threw before any response) still emits its failed notifications
    // — the run-level failures that DO produce a response are covered
    // by the completion hook above.
    if (job.capability === "http.request") {
      let failurePayload: Record<string, unknown> = {};
      try {
        failurePayload = JSON.parse(job.payload_json) as Record<string, unknown>;
      } catch {
        failurePayload = {};
      }
      const kind = screenerKindForPath(typeof failurePayload.pathAndQuery === "string" ? failurePayload.pathAndQuery : "");
      if (kind) {
        try {
          const headers = (failurePayload.headers ?? {}) as Record<string, unknown>;
          const userLogin = typeof headers["x-user-login"] === "string" ? headers["x-user-login"] : ctx.sessionKey();
          await submitLifecycleNotifications(
            ctx,
            "failed",
            { kind, trigger: "manual", success: false, pdfKeys: [], error: message },
            jobId,
            userLogin,
          );
        } catch (notifyError) {
          console.error(`[OrchestratorAgent] Failure notification scheduling failed for job ${jobId}:`, notifyError);
        }
      }
    }
  }
}
