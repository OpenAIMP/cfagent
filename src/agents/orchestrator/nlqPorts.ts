/**
 * Issue #992: NLQ ports (scheduling + stock-screen bindings for the NLQ executor) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * NlqPortsContext.
 */

import type { AgentContext, ScheduleOptions } from "agents";
import type { AgentScheduleItem, Env, StockScreenerFilter } from "../../types";
import type { NLQSchedulingPort, NLQSocialBriefPort, NLQStockScreenPort, NLQStockScreenRunResult } from "../nlq";
import type { ScreenerAgent, ScreenerRunRequest } from "../screener-agent";
import type { SocialBriefStore } from "../social/briefStore";
import { shardableUniverses } from "../../trading";
import { createWorkflowPorts } from "../../workflows/createWorkflowPorts";
import { workflowTenantId } from "../../workflows/screenerWorkflowRoutes";
import {
  assertWorkflowJobCommand,
  workflowStatusUrl,
  type WorkflowCollation,
  type WorkflowJobCommand,
  type WorkflowPort,
} from "../../workflows/workflowPorts";
import { readJobHistory } from "../../data/createShardJobPorts";
import type { ShardJobRow } from "../../data/shardJobPorts";
import {
  listScheduledReports,
  resolveCanonicalReportBody,
  type ScheduledReportHit,
} from "../../services/scheduledReports";

/**
 * Ports the NLQ-port constructors receive from the class. The schedule
 * functions are the Agent base class's own methods, bound by the class
 * with the `keyof this` cast the SDK signature requires (the same
 * binding routeRequest's contexts use).
 */
export interface NlqPortsContext {
  schedule: (when: Date | number | string, callback: string, payload?: unknown, options?: ScheduleOptions) => Promise<unknown>;
  scheduleEvery: (intervalSeconds: number, callback: string, payload?: unknown) => Promise<unknown>;
  cancelSchedule: (id: string) => Promise<boolean>;
  listSchedules: () => Promise<unknown[]>;
  getScreenerAgent: (userLogin?: string) => ScreenerAgent;
  getSocialBriefStore: () => SocialBriefStore | null;
  /**
   * Issue #2369: the worker env — the workflow composition
   * root, the IAAA tenant resolution and the canonical-body
   * R2 resolution all read it.
   */
  env: Env;
  /**
   * Issue #2369: the orchestrator instance's SQL storage —
   * the mas_reports read-back for workflow-run results (the
   * canonical copies live in this instance's own store).
   */
  ensureTables: () => AgentContext["storage"]["sql"];
  /**
   * Issue #2369 test seam: workflow port override (a
   * binding-seam fake). Absent → createWorkflowPorts(env)
   * per call; explicit null → the workflow path is
   * unavailable and the port keeps the legacy direct call.
   */
  workflowPort?: WorkflowPort | null;
  /**
   * Issue #2369 test seam: D1 job-history reader override.
   * Absent → readJobHistory(env, ...) (the projection read
   * behind /api/jobs/history).
   */
  readWorkflowJobHistory?: (tenantId: string, chainId: string) => Promise<ShardJobRow[] | null>;
  /** Issue #2369 test seams: await cadence/bound. Absent → the production defaults below. */
  workflowPollIntervalMs?: number;
  workflowAwaitDeadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

/**
 * Issue #109: binds this agent's Cloudflare Agents scheduling API
 * into the narrow port the NLQ executor consumes, so schedules
 * created/listed/cancelled from natural language are real SDK
 * schedules with real ids.
 *
 * Issue #108: the bindings call the typed Agent methods directly —
 * schedule/scheduleEvery/cancelSchedule/listSchedules are typed
 * members of the Agent base class, so the old `(this as any)` +
 * typeof-guard layer is gone. The port receives callback names as
 * plain strings from NLQ plan parsing; the narrow `as keyof this`
 * assertion is the one cast that remains, because the SDK signature
 * requires a method-name key. It cannot fabricate success: an
 * unknown name makes the SDK call throw, and the NLQ executor
 * converts any throw into an honest failure reply.
 */
export function nlqSchedulingPort(ctx: NlqPortsContext): NLQSchedulingPort {
  return {
    schedule: async (when, callback, payload, options) =>
      (await ctx.schedule(when, callback, payload, options)) as AgentScheduleItem,
    scheduleEvery: async (intervalSeconds, callback, payload) =>
      (await ctx.scheduleEvery(intervalSeconds, callback, payload)) as AgentScheduleItem,
    cancelSchedule: async (id) => await ctx.cancelSchedule(id),
    listSchedules: async () => (await ctx.listSchedules()) as AgentScheduleItem[],
  };
}

/**
 * Issue #982: the NLQ stock-screen port — binds the stock
 * screening service the REST /etrade/screen route delegates
 * to into the NLQ execution deps, so NLQ stock screens run
 * the same pipeline as REST screens.
 *
 * Issue #2369 (Agent Mesh S8, #2225 G2): a chat stock screen
 * now executes as a ScreenerScreenWorkflow run. The port
 * starts a parent command through the WorkflowPort (the
 * #1737 port the synchronous routes adopt opt-in and goal
 * screens submit through, #1996), awaits the outcome on the
 * workflow's own status surface (instance status + the D1
 * parent-row collation), and reads the full results back
 * from mas_reports — the canonical copies the workflow's
 * own store step wrote (survey §3.4: results travel
 * store→read-back, never through workflow outputs). The NLQ
 * contract is unchanged: the executor still receives the
 * completed run result, and its own canonical persist
 * dedupes onto the same screener:<timestamp> generation row
 * the workflow store wrote. When the workflow port is
 * unavailable (binding/projection unbound) or the start
 * fails, the port falls back to the direct ScreenerAgent
 * call below — the route precedent (tryStartScreenerWorkflow:
 * an adoption must never fail a screen the direct path can
 * serve) — with the failure logged, never silent.
 *
 * Identity is fail-closed (#1185): a missing, blank, or
 * synthetic ("default") login throws before any workflow
 * start and before the fallback — the screen never runs
 * under an identity the caller did not actually carry. The
 * login arrives threaded through the async job's payload
 * (the S5 carriage, #2341), never from a tool argument.
 *
 * Delivery: the NLQ screen request shape carries no
 * delivery request, so the command runs no deliver step and
 * no chat-side delivery path exists beside the workflow's —
 * delivery requested on other doors keeps flowing through
 * the workflow's own deliver step.
 *
 * maxItems 10: the port's consumers take up to ten standout
 * picks (the watchlist_save fallback's top-10).
 */
export function nlqStockScreenPort(ctx: NlqPortsContext): NLQStockScreenPort {
  return {
    runScreen: async ({ filters, userLogin }) => {
      const login = typeof userLogin === "string" ? userLogin.trim() : "";
      if (!login || login === "default") {
        throw new Error(
          "NLQ stock screen requires the acting user's login — refusing to run under a missing or synthetic identity (issue #1185).",
        );
      }
      const universe = typeof (filters as { universe?: unknown })?.universe === "string"
        ? ((filters as { universe?: string }).universe as ScreenerRunRequest["universe"])
        : undefined;
      const viaWorkflow = await runChatScreenViaWorkflow(ctx, { filters, userLogin: login, universe });
      if (viaWorkflow) return viaWorkflow;
      return ctx.getScreenerAgent(userLogin).runScreen({
        trigger: "manual",
        filters,
        universe,
        userLogin,
        maxItems: 10,
      });
    },
  };
}

/** Cadence for the port's own status-surface polls (the workflow's internal child polling is the command's pollIntervalMs). */
const CHAT_SCREEN_POLL_INTERVAL_MS = 2_000;
/**
 * Bound on the port's await. Generous against the workflow's
 * own per-shard deadlines (10 min per batch); on expiry the
 * port returns an honest tracked failure — the run continues
 * in the workflow and stays visible at its status URL — never
 * a fake success and never a silent second direct run.
 */
const CHAT_SCREEN_AWAIT_DEADLINE_MS = 15 * 60_000;
/** The parent workflow's child-poll cadence for chat runs (its durable sleeps; granularity only). */
const CHAT_SCREEN_PARENT_POLL_INTERVAL_MS = 5_000;

/**
 * Start one chat screen as a ScreenerScreenWorkflow run and
 * await its outcome. Returns null ONLY when no run was
 * started (port unavailable / start failed) — the caller
 * then falls back to the direct call. Once a run exists,
 * every outcome (success, stage failure, await expiry)
 * returns as a result; falling back after a start would run
 * the screen twice.
 */
async function runChatScreenViaWorkflow(
  ctx: NlqPortsContext,
  req: { filters: StockScreenerFilter; userLogin: string; universe?: string },
): Promise<NLQStockScreenRunResult | null> {
  const ports: WorkflowPort | null =
    ctx.workflowPort !== undefined ? ctx.workflowPort : createWorkflowPorts(ctx.env);
  if (!ports) return null;

  const universeId = req.universe ?? "TECH";
  const shards: WorkflowJobCommand["shards"] =
    universeId === "ALL"
      ? shardableUniverses().map((u) => ({ shardId: u, universe: u }))
      : [{ shardId: universeId, universe: universeId }];
  const nowMs = ctx.nowMs ?? (() => Date.now());
  const startedAtIso = new Date(nowMs()).toISOString();
  // Job id derived from the run (survey §3.4): the manual
  // scheme (screener:<source>:<universe>:<timestamp>) plus a
  // random suffix — two chat screens in one millisecond must
  // never adopt each other's run.
  const jobId = `screener:chat:${universeId}:${startedAtIso}:${crypto.randomUUID().slice(0, 8)}`;
  const tenantId = workflowTenantId(ctx.env);
  const command: WorkflowJobCommand = {
    jobId,
    type: "run-screen",
    source: "nlq-chat",
    trigger: "manual",
    userLogin: req.userLogin,
    role: "parent",
    tenantId,
    shards,
    filters: req.filters as unknown as Record<string, unknown>,
    maxItems: 10,
    pollIntervalMs: CHAT_SCREEN_PARENT_POLL_INTERVAL_MS,
  };

  let handle;
  try {
    handle = await ports.start(assertWorkflowJobCommand(command));
  } catch (err) {
    console.warn(
      "[nlq-stock-screen] Workflow start failed; falling back to the direct screen:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  const readHistory =
    ctx.readWorkflowJobHistory ?? ((t: string, c: string) => readJobHistory(ctx.env, t, c));
  const sleep =
    ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = ctx.workflowPollIntervalMs ?? CHAT_SCREEN_POLL_INTERVAL_MS;
  const deadline = nowMs() + (ctx.workflowAwaitDeadlineMs ?? CHAT_SCREEN_AWAIT_DEADLINE_MS);
  // A terminal instance whose collation has not projected yet
  // gets a few extra polls — projection lag is not a failure.
  let terminalPolls = 0;
  for (;;) {
    const rows = await readHistory(tenantId, jobId).catch(() => null);
    const collation = collationFromRows(rows, jobId);
    if (collation) {
      return assembleChatScreenResult(ctx, {
        shards,
        userLogin: req.userLogin,
        startedAtIso,
        collation,
        rows,
        jobId,
        terminalNote: "completed",
      });
    }
    const status = await ports.status(handle.workflowId).catch(() => null);
    const terminal =
      status !== null &&
      (status.status === "complete" || status.status === "errored" || status.status === "terminated");
    if (terminal) {
      terminalPolls += 1;
      if (terminalPolls >= 3) {
        return assembleChatScreenResult(ctx, {
          shards,
          userLogin: req.userLogin,
          startedAtIso,
          collation: null,
          rows,
          jobId,
          terminalNote: `ended with workflow status "${status.status}" before its outcome was projected`,
        });
      }
    }
    if (nowMs() >= deadline) {
      return assembleChatScreenResult(ctx, {
        shards,
        userLogin: req.userLogin,
        startedAtIso,
        collation: null,
        rows,
        jobId,
        terminalNote: "did not complete within the chat await window",
      });
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * The collation out of a chain's projection rows: the parent
 * row (keyed by the job id) carries it as its resultJson
 * once project-final lands. The announce row's {jobId,
 * detail} shape has no lifecycle — not terminal, keep
 * polling. A Failed-lifecycle final leg is projected under
 * a leg key with only its detail (the projection's failed-leg
 * shape), so a missing collation is not a missing outcome:
 * assembly falls back to the rows' details + stored bodies.
 */
function collationFromRows(rows: ShardJobRow[] | null, jobId: string): WorkflowCollation | null {
  const parent = rows?.find((r) => r.jobKey === jobId);
  if (!parent) return null;
  try {
    const parsed = JSON.parse(parent.resultJson) as WorkflowCollation;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.lifecycle === "string" &&
      Array.isArray(parsed.shards)
    ) {
      return parsed;
    }
  } catch {
    // Not a collation payload (announce row) — keep polling.
  }
  return null;
}

/** One stored canonical screener body, parsed (the read-back shape). */
interface StoredScreenBody {
  timestamp: string;
  universe?: string;
  sector?: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  filterSummary?: string;
  discoveryMessage?: string;
  error?: string;
  pdfKey?: string;
  rejections?: Array<{ symbol: string; reason: string }>;
  allStocks: NLQStockScreenRunResult["allStocks"];
  opportunities: NLQStockScreenRunResult["opportunities"];
}

function parseStoredScreenBody(text: string): StoredScreenBody | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.success !== "boolean" || typeof parsed.timestamp !== "string") return null;
    return {
      timestamp: parsed.timestamp,
      ...(typeof parsed.universe === "string" ? { universe: parsed.universe } : {}),
      ...(typeof parsed.sector === "string" ? { sector: parsed.sector } : {}),
      success: parsed.success,
      totalScanned: typeof parsed.totalScanned === "number" ? parsed.totalScanned : 0,
      matchedCount: typeof parsed.matchedCount === "number" ? parsed.matchedCount : 0,
      ...(typeof parsed.filterSummary === "string" ? { filterSummary: parsed.filterSummary } : {}),
      ...(typeof parsed.discoveryMessage === "string" ? { discoveryMessage: parsed.discoveryMessage } : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(typeof parsed.pdfKey === "string" ? { pdfKey: parsed.pdfKey } : {}),
      ...(Array.isArray(parsed.rejections)
        ? { rejections: parsed.rejections as Array<{ symbol: string; reason: string }> }
        : {}),
      allStocks: Array.isArray(parsed.allStocks)
        ? (parsed.allStocks as NLQStockScreenRunResult["allStocks"])
        : [],
      opportunities: Array.isArray(parsed.opportunities)
        ? (parsed.opportunities as NLQStockScreenRunResult["opportunities"])
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Read back the canonical screener reports stored at or
 * after the run started (the store seam keys created_at to
 * the run's own timestamp, which follows the workflow
 * start). User-scoped via listScheduledReports (#584
 * EP-003 strict filter when the login is known — it always
 * is here). Bodies stored out-of-line resolve through R2.
 */
async function readStoredScreenBodies(
  ctx: NlqPortsContext,
  userLogin: string,
  startedAtIso: string,
): Promise<StoredScreenBody[]> {
  let hits: ScheduledReportHit[];
  try {
    hits = listScheduledReports(ctx.ensureTables(), {
      userLogin,
      sourceFilter: "screener",
      limit: 100,
    });
  } catch {
    return [];
  }
  const bodies: StoredScreenBody[] = [];
  for (const hit of hits) {
    if (hit.createdAt < startedAtIso) continue;
    const text = await resolveCanonicalReportBody(ctx.env, hit);
    if (!text) continue;
    const body = parseStoredScreenBody(text);
    if (body) bodies.push(body);
  }
  return bodies;
}

function resultFromStoredBody(body: StoredScreenBody): NLQStockScreenRunResult {
  return {
    timestamp: body.timestamp,
    universe: body.universe ?? "",
    sector: body.sector ?? "",
    success: body.success,
    totalScanned: body.totalScanned,
    matchedCount: body.matchedCount,
    ...(body.filterSummary ? { filterSummary: body.filterSummary } : {}),
    discoveryMessage: body.discoveryMessage ?? "",
    ...(body.error ? { error: body.error } : {}),
    ...(body.pdfKey ? { pdfKey: body.pdfKey } : {}),
    ...(body.rejections ? { rejections: body.rejections } : {}),
    allStocks: body.allStocks,
    opportunities: body.opportunities,
  };
}

/**
 * Assemble the port result for a started run: per-shard
 * results read back from mas_reports, aggregated the way
 * the route's ALL path aggregates (success iff at least one
 * shard succeeded; counts sum; rows concatenate in shard
 * order). Stage failures surface as coded failures (#1999):
 * the error is the collation's, the shard outcome's, the
 * stored failure record's, or the projection detail's —
 * in that order — never a fabricated success.
 */
async function assembleChatScreenResult(
  ctx: NlqPortsContext,
  args: {
    shards: WorkflowJobCommand["shards"];
    userLogin: string;
    startedAtIso: string;
    collation: WorkflowCollation | null;
    rows: ShardJobRow[] | null;
    jobId: string;
    terminalNote: string;
  },
): Promise<NLQStockScreenRunResult> {
  const { shards, collation, rows, jobId } = args;
  const bodies = await readStoredScreenBodies(ctx, args.userLogin, args.startedAtIso);

  // Match bodies to shards: by the collation's pdfKey first
  // (unique per run), then by universe, then — when exactly
  // one body and one unmatched shard remain — by elimination.
  const used = new Set<number>();
  const perShard = new Map<string, StoredScreenBody>();
  for (const shard of shards) {
    const outcome = collation?.shards.find((s) => s.shardId === shard.shardId);
    if (outcome?.pdfKey) {
      const idx = bodies.findIndex((b, i) => !used.has(i) && b.pdfKey === outcome.pdfKey);
      if (idx >= 0) {
        used.add(idx);
        perShard.set(shard.shardId, bodies[idx]);
      }
    }
  }
  for (const shard of shards) {
    if (perShard.has(shard.shardId)) continue;
    const idx = bodies.findIndex(
      (b, i) => !used.has(i) && shard.universe !== undefined && b.universe === shard.universe,
    );
    if (idx >= 0) {
      used.add(idx);
      perShard.set(shard.shardId, bodies[idx]);
    }
  }
  const unmatchedShards = shards.filter((s) => !perShard.has(s.shardId));
  const unmatchedBodies = bodies.filter((_, i) => !used.has(i));
  if (unmatchedShards.length === 1 && unmatchedBodies.length === 1) {
    perShard.set(unmatchedShards[0].shardId, unmatchedBodies[0]);
  }

  const detailFor = (jobKey: string): string | undefined =>
    rows?.find((r) => r.jobKey === jobKey)?.detail || undefined;
  const shardError = (shardId: string): string | undefined =>
    collation?.shards.find((s) => s.shardId === shardId)?.error ??
    detailFor(`leg:${shardId}`);

  const matched = shards
    .map((s) => perShard.get(s.shardId))
    .filter((b): b is StoredScreenBody => b !== undefined);

  if (matched.length === 0) {
    const error =
      collation?.error ??
      detailFor("leg:parent") ??
      shards.map((s) => shardError(s.shardId)).find((e) => typeof e === "string") ??
      `Screen workflow run ${jobId} ${args.terminalNote}; it remains tracked at ${workflowStatusUrl(jobId)}.`;
    return {
      timestamp: args.startedAtIso,
      universe: shards.length === 1 ? (shards[0].universe ?? "") : "ALL",
      sector: "",
      success: false,
      totalScanned: collation?.coverage.evaluated ?? 0,
      matchedCount: collation?.shards.reduce((n, s) => n + (s.matchedCount ?? 0), 0) ?? 0,
      discoveryMessage: "",
      error,
      allStocks: [],
      opportunities: [],
    };
  }

  const results = matched.map(resultFromStoredBody);
  const success =
    collation?.lifecycle === "Failed" ? false : results.some((r) => r.success);
  const firstError =
    results.find((r) => !r.success)?.error ??
    collation?.error ??
    shards.map((s) => shardError(s.shardId)).find((e) => typeof e === "string");
  return {
    timestamp: results.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), results[0].timestamp),
    universe: shards.length === 1 ? (results[0].universe ?? "") : "ALL",
    sector:
      results.length === 1
        ? (results[0].sector ?? "")
        : results.every((r) => r.sector === results[0].sector)
          ? (results[0].sector ?? "")
          : "ALL",
    success,
    totalScanned: results.reduce((n, r) => n + r.totalScanned, 0),
    matchedCount: results.reduce((n, r) => n + r.matchedCount, 0),
    ...(results.find((r) => r.filterSummary)?.filterSummary
      ? { filterSummary: results.find((r) => r.filterSummary)!.filterSummary }
      : {}),
    discoveryMessage: results.find((r) => r.discoveryMessage)?.discoveryMessage ?? "",
    ...(!success && firstError ? { error: firstError } : {}),
    ...(results.find((r) => r.pdfKey)?.pdfKey
      ? { pdfKey: results.find((r) => r.pdfKey)!.pdfKey }
      : {}),
    ...(results.some((r) => r.rejections?.length)
      ? { rejections: results.flatMap((r) => r.rejections ?? []) }
      : {}),
    allStocks: results.flatMap((r) => r.allStocks),
    opportunities: results.flatMap((r) => r.opportunities),
  };
}

/**
 * #1077 Phase 5b slice 2: the NLQ social-brief port — binds the
 * durable brief store into the NLQ execution deps, so an explicit
 * "set social brief" request in trusted chat writes the day's brief
 * the social goal will publish. Returns null when no store is
 * available, so callers pass no port and the executor fails honestly
 * instead of writing to nowhere.
 */
export function nlqSocialBriefPort(ctx: NlqPortsContext): NLQSocialBriefPort | null {
  const store = ctx.getSocialBriefStore();
  if (!store) return null;
  return {
    setBrief: async ({ date, text }) => {
      await store.putBrief(date, text);
    },
  };
}
