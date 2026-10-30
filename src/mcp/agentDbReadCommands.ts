/**
 * Issue #1697 ([AGENTIC] Slice 4, MCP read tools + dashboard
 * routes, sub-issue of #1546) — read-only MCP tools over the
 * slices 1–3 AgentDB projections.
 *
 * Exactly four tools, registered in McpToolFactory alongside
 * (never instead of, never duplicating) the goal/chain tools:
 *   - `agentdb.chain.status`  — latest chain + schedule rows
 *   - `agentdb.jobs.history`  — shard jobs for one chain
 *   - `agentdb.audit.history` — audit events for one chain
 *   - `agentdb.reports.list`  — canonical reports for the tenant
 *
 * Issue #2428 (Agent Mesh S17, G13a) adds a fifth read in this
 * family, over the slice's own projection:
 *   - `agentdb.trace.get`     — the assembled mesh trace for
 *     one W3C trace id (hop records + the job-history rows for
 *     the trace's mapped jobIds), honestly partial with named
 *     breaks when the chain is broken. Same read contract:
 *     projection only, tenant from IAAA, no tenant argument.
 *
 * Read contract (R1/R5/R7): every tool reads the PROJECTION
 * ONLY, through the slice-1/2/3 read helpers behind the ports
 * — no duplicated query logic, no new tables, no new
 * migrations, no writes of any kind. A projection read may
 * lag one transition; any consumer that cannot tolerate lag
 * reads the durable object directly and says so.
 *
 * Tenancy: the tenant comes from IAAA resolution of env —
 * the same resolution the dashboard routes use. No tool
 * accepts a tenant argument: the input schemas carry no
 * tenant field, and a forged tenant value in the arguments
 * is ignored, so a caller can only ever see their own
 * tenant's rows.
 *
 * Availability: an unbound store yields a clean unavailable
 * error, never a crash. Auth: none of these tools
 * authenticates anything. The server route (`/mcp`,
 * src/server.ts, #180) rejects callers without an app
 * session or a valid per-user `cfk_` API key before any
 * tool runs; these commands ride that path exactly like
 * every other tool in the factory.
 *
 * Explicitly out of scope: `chain.run` execution. This
 * module does not touch it, and no tool here runs, submits,
 * or projects a leg.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import type { Env } from "../types";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import { readChainStatus } from "../data/createChainSchedulePorts";
import { readJobHistory } from "../data/createShardJobPorts";
import {
  readAuditHistory,
  readReports,
} from "../data/createAuditReportPorts";
import { readTraceHops } from "../data/createMeshTracePorts";
import { assembleMeshTrace } from "../observability/meshTrace";
import type {
  ChainRow,
  ScheduleRow,
} from "../data/chainSchedulePorts";
import type { ShardJobRow } from "../data/shardJobPorts";
import type {
  AuditEventRow,
  CanonicalReportRow,
} from "../data/auditReportPorts";

/* ------------------------------------------------------------------ */
/* Result shapes (mirror the dashboard route bodies)                   */
/* ------------------------------------------------------------------ */

export interface AgentDbChainStatusResult {
  projected: boolean;
  chain: {
    chainId: string;
    status: string;
    version: number;
    goal: string;
    updatedAtMs: number;
  } | null;
  schedule: {
    scheduleId: string;
    status: string;
    version: number;
    kind: string;
    cron: string | null;
    updatedAtMs: number;
  } | null;
}

export interface AgentDbJobsHistoryResult {
  chainId: string;
  jobs: Array<{
    jobKey: string;
    status: string;
    stage: string;
    capabilityId: string;
    detail: string;
    version: number;
    updatedAtMs: number;
    /** Issue #1737: capped collation/summary JSON (see the route shape). */
    resultJson: string;
  }>;
}

export interface AgentDbAuditHistoryResult {
  chainId: string;
  events: Array<{
    eventKind: string;
    subjectType: string;
    subjectId: string;
    actor: string;
    detailJson: string;
    occurredAtMs: number;
  }>;
}

export interface AgentDbReportsListResult {
  reports: Array<{
    reportId: string;
    runId: string;
    generationId: string | null;
    title: string;
    source: string;
    summary: string;
    version: number;
    updatedAtMs: number;
  }>;
}

/** Map projection rows to the chain-status result shape. */
export function chainStatusToMcpResult(status: {
  chain: ChainRow | null;
  schedule: ScheduleRow | null;
}): AgentDbChainStatusResult {
  return {
    projected: status.chain !== null || status.schedule !== null,
    chain: status.chain
      ? {
          chainId: status.chain.chainId,
          status: status.chain.status,
          version: status.chain.version,
          goal: status.chain.goal,
          updatedAtMs: status.chain.updatedAtMs,
        }
      : null,
    schedule: status.schedule
      ? {
          scheduleId: status.schedule.scheduleId,
          status: status.schedule.status,
          version: status.schedule.version,
          kind: status.schedule.kind,
          cron: status.schedule.cron,
          updatedAtMs: status.schedule.updatedAtMs,
        }
      : null,
  };
}

/** Map projection rows to the job-history result shape. */
export function jobsToMcpResult(
  chainId: string,
  jobs: ShardJobRow[],
): AgentDbJobsHistoryResult {
  return {
    chainId,
    jobs: jobs.map((job) => ({
      jobKey: job.jobKey,
      status: job.status,
      stage: job.stage,
      capabilityId: job.capabilityId,
      detail: job.detail,
      version: job.version,
      updatedAtMs: job.updatedAtMs,
      resultJson: job.resultJson,
    })),
  };
}

/** Map projection rows to the audit-history result shape. */
export function auditToMcpResult(
  chainId: string,
  events: AuditEventRow[],
): AgentDbAuditHistoryResult {
  return {
    chainId,
    events: events.map((event) => ({
      eventKind: event.eventKind,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      actor: event.actor,
      detailJson: event.detailJson,
      occurredAtMs: event.occurredAtMs,
    })),
  };
}

/**
 * Map projection rows to the reports-list result shape.
 * Bodies stay out — the durable object holds the full copy.
 */
export function reportsToMcpResult(
  reports: CanonicalReportRow[],
): AgentDbReportsListResult {
  return {
    reports: reports.map((report) => ({
      reportId: report.reportId,
      runId: report.runId,
      generationId: report.generationId,
      title: report.title,
      source: report.source,
      summary: report.summary,
      version: report.version,
      updatedAtMs: report.updatedAtMs,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Projection reads (tenant from env, never from caller input)         */
/* ------------------------------------------------------------------ */

function requireChainId(tool: string, chainId: unknown): string {
  if (typeof chainId !== "string" || chainId.trim().length === 0) {
    throw new Error(`${tool}: chainId is required.`);
  }
  return chainId;
}

export async function chainStatusForMcp(
  env: Partial<Env>,
  chainId: string,
): Promise<AgentDbChainStatusResult> {
  const tenantId = resolveIaaaTenant(env);
  const status = await readChainStatus(env, tenantId, chainId);
  if (status === null) {
    throw new Error(
      "agentdb.chain.status unavailable: AgentDB is not bound.",
    );
  }
  return chainStatusToMcpResult(status);
}

export async function jobsHistoryForMcp(
  env: Partial<Env>,
  chainId: string,
): Promise<AgentDbJobsHistoryResult> {
  const tenantId = resolveIaaaTenant(env);
  const jobs = await readJobHistory(env, tenantId, chainId);
  if (jobs === null) {
    throw new Error(
      "agentdb.jobs.history unavailable: AgentDB is not bound.",
    );
  }
  return jobsToMcpResult(chainId, jobs);
}

export async function auditHistoryForMcp(
  env: Partial<Env>,
  chainId: string,
): Promise<AgentDbAuditHistoryResult> {
  const tenantId = resolveIaaaTenant(env);
  const events = await readAuditHistory(env, tenantId, chainId);
  if (events === null) {
    throw new Error(
      "agentdb.audit.history unavailable: AgentDB is not bound.",
    );
  }
  return auditToMcpResult(chainId, events);
}

export async function reportsListForMcp(
  env: Partial<Env>,
  reportId?: string | null,
): Promise<AgentDbReportsListResult> {
  const tenantId = resolveIaaaTenant(env);
  const reports = await readReports(env, tenantId, reportId ?? null);
  if (reports === null) {
    throw new Error(
      "agentdb.reports.list unavailable: AgentDB is not bound.",
    );
  }
  return reportsToMcpResult(reports);
}

/* ------------------------------------------------------------------ */
/* agentdb.chain.status                                                */
/* ------------------------------------------------------------------ */

export class AgentDbChainStatusCommand implements IMcpToolCommand<{
  chainId: string;
}> {
  readonly name = "agentdb.chain.status";
  readonly description =
    "Read a chain's projected status from AgentDB (latest chain + schedule rows, projection only — never durable-object state). Read-only: it writes nothing. The tenant is resolved from the caller's environment, never from arguments. Projection reads may lag one transition.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      chainId: {
        type: "string",
        description: "The persisted chain identity (the synthesized record id).",
      },
    },
    required: ["chainId"],
  };
  readonly zodSchema = z.object({
    chainId: z.string().min(1).describe("The persisted chain identity"),
  });

  async execute(
    input: { chainId: string },
    context: McpToolContext,
  ): Promise<AgentDbChainStatusResult> {
    const chainId = requireChainId(this.name, input.chainId);
    const result = await chainStatusForMcp(context.env, chainId);
    context.audit("agentdb.chain.status", "mcp", {
      chainId,
      projected: result.projected,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* agentdb.jobs.history                                                */
/* ------------------------------------------------------------------ */

export class AgentDbJobsHistoryCommand implements IMcpToolCommand<{
  chainId: string;
}> {
  readonly name = "agentdb.jobs.history";
  readonly description =
    "List a chain's projected shard jobs from AgentDB (latest row per job, newest first, projection only — never durable-object state). Read-only: it writes nothing. The tenant is resolved from the caller's environment, never from arguments. Projection reads may lag one transition.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      chainId: {
        type: "string",
        description: "The chain the jobs ran (or were submitted) for.",
      },
    },
    required: ["chainId"],
  };
  readonly zodSchema = z.object({
    chainId: z.string().min(1).describe("The chain the jobs ran for"),
  });

  async execute(
    input: { chainId: string },
    context: McpToolContext,
  ): Promise<AgentDbJobsHistoryResult> {
    const chainId = requireChainId(this.name, input.chainId);
    const result = await jobsHistoryForMcp(context.env, chainId);
    context.audit("agentdb.jobs.history", "mcp", {
      chainId,
      jobs: result.jobs.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* agentdb.audit.history                                               */
/* ------------------------------------------------------------------ */

export class AgentDbAuditHistoryCommand implements IMcpToolCommand<{
  chainId: string;
}> {
  readonly name = "agentdb.audit.history";
  readonly description =
    "List a chain's projected audit events from AgentDB (one row per lifecycle event, newest first, projection only — never durable-object state). Read-only: it writes nothing. The tenant is resolved from the caller's environment, never from arguments. Projection reads may lag one transition.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      chainId: {
        type: "string",
        description: "The chain the audit events belong to.",
      },
    },
    required: ["chainId"],
  };
  readonly zodSchema = z.object({
    chainId: z.string().min(1).describe("The chain the audit events belong to"),
  });

  async execute(
    input: { chainId: string },
    context: McpToolContext,
  ): Promise<AgentDbAuditHistoryResult> {
    const chainId = requireChainId(this.name, input.chainId);
    const result = await auditHistoryForMcp(context.env, chainId);
    context.audit("agentdb.audit.history", "mcp", {
      chainId,
      events: result.events.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* agentdb.reports.list                                                */
/* ------------------------------------------------------------------ */

export class AgentDbReportsListCommand implements IMcpToolCommand<{
  reportId?: string | null;
}> {
  readonly name = "agentdb.reports.list";
  readonly description =
    "List canonical reports from AgentDB (latest row per report, newest first; with reportId, that one report — projection only, never durable-object state). Read-only: it writes nothing, and report bodies are never included (the durable object holds the full copy). The tenant is resolved from the caller's environment, never from arguments. Projection reads may lag one transition.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      reportId: {
        type: "string",
        description:
          "Optional canonical report id; when absent, all reports for the tenant are listed.",
      },
    },
  };
  readonly zodSchema = z.object({
    reportId: z
      .string()
      .min(1)
      .optional()
      .describe("Optional canonical report id"),
  });

  async execute(
    input: { reportId?: string | null },
    context: McpToolContext,
  ): Promise<AgentDbReportsListResult> {
    const reportId =
      typeof input.reportId === "string" && input.reportId.trim() !== ""
        ? input.reportId
        : null;
    const result = await reportsListForMcp(context.env, reportId);
    context.audit("agentdb.reports.list", "mcp", {
      reportId,
      reports: result.reports.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* agentdb.trace.get (#2428, Agent Mesh S17 — unified traces)          */
/* ------------------------------------------------------------------ */

export interface AgentDbTraceGetResult {
  traceId: string;
  /** True only when every hop this trace's shape requires is present. */
  complete: boolean;
  hops: Array<{
    kind: string;
    operation: string;
    timestampMs: number;
    caller?: string;
    agent?: string;
    jobId?: string;
  }>;
  /** Named breaks: each expected-but-missing hop, stated plainly. */
  breaks: string[];
  /** The existing run identities the trace maps to (workflow jobIds). */
  jobIds: string[];
}

/** Reader seams for traceForMcp (the production defaults read env; tests inject). */
export interface TraceForMcpDeps {
  /** Tenant override (tests); absent → resolveIaaaTenant(env), the sibling commands' resolution. */
  tenantId?: string;
  readHops?: (traceId: string) => Promise<import("../data/meshTracePorts").MeshTraceHop[]>;
  readJobs?: (tenantId: string, chainId: string) => Promise<ShardJobRow[] | null>;
}

const TRACE_ID_SHAPE = /^[0-9a-f]{32}$/;

/**
 * Assemble one mesh trace for the read surface. Tenancy (R7):
 * the tenant is resolved from env exactly like the sibling
 * commands; hops recorded under a DIFFERENT tenant are
 * excluded before assembly (a hop whose tenant is null — an
 * ingress boundary with no scope — stays visible: it carries
 * no tenant material). The trace id itself is an unguessable
 * 128-bit identifier; malformed ids are refused, never
 * normalized into a lookup.
 */
export async function traceForMcp(
  env: Partial<Env>,
  traceId: string,
  deps: TraceForMcpDeps = {},
): Promise<AgentDbTraceGetResult> {
  if (typeof traceId !== "string" || !TRACE_ID_SHAPE.test(traceId)) {
    throw new Error("agentdb.trace.get: traceId must be a W3C trace id (32 lowercase hex).");
  }
  const tenantId = deps.tenantId ?? resolveIaaaTenant(env as Env);
  const readHops = deps.readHops ?? ((id: string) => readTraceHops(env, id));
  const readJobs = deps.readJobs ?? ((t: string, c: string) => readJobHistory(env, t, c));

  const allHops = await readHops(traceId);
  const hops = allHops.filter(
    (hop) => hop.tenantId === undefined || hop.tenantId === null || hop.tenantId === tenantId,
  );
  const jobIds = [
    ...new Set(
      hops
        .map((hop) => hop.jobId)
        .filter((j): j is string => typeof j === "string" && j.length > 0),
    ),
  ];
  const rows: ShardJobRow[] = [];
  for (const jobId of jobIds) {
    const jobRows = await readJobs(tenantId, jobId).catch(() => null);
    if (jobRows) rows.push(...jobRows);
  }
  const assembly = assembleMeshTrace(traceId, hops, rows);
  return {
    traceId: assembly.traceId,
    complete: assembly.complete,
    hops: assembly.hops.map((hop) => ({
      kind: hop.kind,
      operation: hop.operation,
      timestampMs: hop.timestampMs,
      ...(hop.caller ? { caller: hop.caller } : {}),
      ...(hop.agent ? { agent: hop.agent } : {}),
      ...(hop.jobId ? { jobId: hop.jobId } : {}),
    })),
    breaks: assembly.breaks,
    jobIds: assembly.jobIds,
  };
}

export class AgentDbTraceGetCommand implements IMcpToolCommand<{
  traceId: string;
}> {
  readonly name = "agentdb.trace.get";
  readonly description =
    "Assemble one mesh trace from AgentDB by its W3C trace id: the ordered hops a request left across the chat turn, mesh doors, async jobs, workflow starts/steps, projections, and A2A calls, with named breaks when the chain is incomplete. Read-only: it writes nothing. The tenant is resolved from the caller's environment, never from arguments; hops recorded under another tenant are excluded.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      traceId: {
        type: "string",
        description: "The W3C trace id (32 lowercase hex) minted at the request's ingress.",
      },
    },
    required: ["traceId"],
  };
  readonly zodSchema = z.object({
    traceId: z.string().min(1).describe("The W3C trace id (32 lowercase hex)"),
  });

  async execute(
    input: { traceId: string },
    context: McpToolContext,
  ): Promise<AgentDbTraceGetResult> {
    const result = await traceForMcp(context.env, input.traceId);
    context.audit("agentdb.trace.get", "mcp", {
      traceId: result.traceId,
      complete: result.complete,
      hops: result.hops.length,
      breaks: result.breaks.length,
    });
    return result;
  }
}
