/**
 * Issue #1123: the screener follow-up pipeline — one harmonized path by
 * which EVERY completed screener (stock or options) schedules its
 * follow-up work as tracked sub-jobs of the main job: report generation
 * (S2), channel deliveries (S3), lifecycle notifications (S4).
 *
 * This module is the pure core: the typed config, the run-outcome
 * record, the http-job adapter that recognizes screener completions, and
 * the planner that turns an outcome into sub-job specs. Execution lives
 * in the async-job executor (src/agents/orchestrator/asyncJobs.ts),
 * which owns the job store; spawn points beyond the job executor (bus
 * sources) join in S5.
 *
 * Assessment alignment (docs/Assessment.md): email recipients are
 * allowlisted (cross-channel exfiltration), generation runs on the job
 * queue (CPU-heavy work off the request path), and every transition is
 * audited by the executor into mas_events.
 */

import type { AsyncJobChannel, AsyncJobSubmission } from "../types";

export type ScreenerKind = "stock" | "options";

/** The canonical record of a finished screener run, from any source. */
export interface ScreenerRunOutcome {
  kind: ScreenerKind;
  trigger: "manual" | "scheduled";
  success: boolean;
  /** Stored report artifact keys (one per universe for sharded runs). */
  pdfKeys: string[];
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  reportUrl?: string;
  matchedCount?: number;
  totalScanned?: number;
  universe?: string;
  thesis?: string;
  summary?: string;
  /** Stable per-run delivery id (dedupe for notifications/deliveries). */
  deliveryId?: string;
  error?: string;
}

export interface ScreenerChannelConfig {
  configured: boolean;
  to?: string;
  channel?: string;
  url?: string;
}

export interface ScreenerFollowupConfig {
  enabled: boolean;
  reportEnabled: boolean;
  channels: Record<AsyncJobChannel, ScreenerChannelConfig>;
  /** Assessment rule: email may only go to allowlisted addresses. */
  emailAllowlist: string[];
}

function envFlag(env: Record<string, unknown>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "";
}

function envStr(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function resolveScreenerFollowupConfig(
  env: Record<string, unknown>,
): ScreenerFollowupConfig {
  const emailTo = envStr(env, "SCREENER_EMAIL_TO");
  const allowlistRaw = envStr(env, "SCREENER_EMAIL_ALLOWLIST");
  const emailAllowlist = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : emailTo
      ? [emailTo.toLowerCase()]
      : [];
  return {
    enabled: envStr(env, "SCREENER_FOLLOWUPS") !== "off",
    reportEnabled: envStr(env, "SCREENER_FOLLOWUP_REPORT") !== "off",
    channels: {
      email: { configured: Boolean(emailTo), to: emailTo },
      slack: {
        configured:
          envFlag(env, "SLACK_WEBHOOK_URL") ||
          envFlag(env, "SCREENER_SLACK_CHANNEL") ||
          envFlag(env, "SLACK_CHANNEL"),
        channel: envStr(env, "SCREENER_SLACK_CHANNEL") ?? envStr(env, "SLACK_CHANNEL"),
      },
      webhook: {
        configured: envFlag(env, "SCREENER_WEBHOOK_URL"),
        url: envStr(env, "SCREENER_WEBHOOK_URL"),
      },
    },
    emailAllowlist,
  };
}

/** Assessment gate: an email recipient is deliverable only if allowlisted. */
export function isEmailAllowed(config: ScreenerFollowupConfig, address: string): boolean {
  return config.emailAllowlist.includes(address.trim().toLowerCase());
}

export type FollowupReportSubmission = Extract<
  AsyncJobSubmission,
  { capability: "followup.report" }
>;

/**
 * The initial plan for a completed run: exactly one report sub-job.
 * Deliveries are planned when the report completes (S3) and lifecycle
 * notifications at their transitions (S4) — the chain keeps each step
 * dependent on the artifact it consumes instead of racing siblings.
 */
export function planInitialFollowups(
  outcome: ScreenerRunOutcome,
  config: ScreenerFollowupConfig,
  mainJobId: string,
  userLogin: string,
): FollowupReportSubmission[] {
  if (!config.enabled || !config.reportEnabled || !outcome.success) return [];
  const kindLabel = outcome.kind === "stock" ? "Stock" : "Options";
  const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
  return [
    {
      capability: "followup.report",
      payload: { outcome, userLogin },
      parentJobId: mainJobId,
      jobKind: "report",
      displayName: `Generate report — ${kindLabel} screen${scope ? ` (${scope})` : ""}`,
    },
  ];
}

/** Path recognition for screener main-jobs among http.request jobs. */
export function screenerKindForPath(pathAndQuery: string): ScreenerKind | null {
  const path = pathAndQuery.split("?")[0];
  if (path.endsWith("/etrade/screen")) return "stock";
  if (path.endsWith("/trading/options/screen")) return "options";
  return null;
}

function pdfKeyFromReportUrl(reportUrl: unknown): string | undefined {
  if (typeof reportUrl !== "string") return undefined;
  const match = reportUrl.match(/[?&]key=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Adapt a completed http.request job (path, response status, body) into
 * the canonical outcome. Returns null when the job is not a screener
 * completion or the body is unparseable — follow-ups simply don't apply.
 */
export function screenerOutcomeFromHttpJob(
  pathAndQuery: string,
  responseStatus: number | undefined,
  bodyText: string,
): ScreenerRunOutcome | null {
  const kind = screenerKindForPath(pathAndQuery);
  if (!kind) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const failed = (responseStatus !== undefined && responseStatus >= 400) || typeof body.error === "string";
  if (failed) {
    return {
      kind,
      trigger: "manual",
      success: false,
      pdfKeys: [],
      error: typeof body.error === "string" ? body.error : `screen request failed (${responseStatus})`,
    };
  }
  if (kind === "stock") {
    if (body.sharded === true && Array.isArray(body.universes)) {
      const shards = body.universes as Array<Record<string, unknown>>;
      const pdfKeys = shards
        .map((s) => (typeof s.pdfKey === "string" ? s.pdfKey : pdfKeyFromReportUrl(s.reportUrl)))
        .filter((k): k is string => Boolean(k));
      return {
        kind,
        trigger: "manual",
        success: shards.some((s) => s.success !== false),
        pdfKeys,
        pdfStatus: pdfKeys.length > 0 ? "generated" : undefined,
        matchedCount: shards.reduce((n, s) => n + (asNumber(s.matchedCount) ?? 0), 0),
        totalScanned: shards.reduce((n, s) => n + (asNumber(s.totalScanned) ?? 0), 0),
        universe: "ALL",
        reportUrl: typeof body.reportUrl === "string" ? body.reportUrl : undefined,
      };
    }
    const pdfKey = typeof body.pdfKey === "string" ? body.pdfKey : pdfKeyFromReportUrl(body.reportUrl);
    return {
      kind,
      trigger: "manual",
      success: true,
      pdfKeys: pdfKey ? [pdfKey] : [],
      pdfStatus: body.pdfStatus === "generated" || body.pdfStatus === "failed" || body.pdfStatus === "skipped"
        ? body.pdfStatus
        : pdfKey
          ? "generated"
          : undefined,
      pdfError: typeof body.pdfError === "string" ? body.pdfError : undefined,
      matchedCount: asNumber(body.matchedCount),
      totalScanned: asNumber(body.totalScanned),
      universe: typeof body.universe === "string" ? body.universe : undefined,
      reportUrl: typeof body.reportUrl === "string" ? body.reportUrl : undefined,
    };
  }
  const data = (body.data ?? {}) as Record<string, unknown>;
  const pdfKey = typeof body.pdfKey === "string" ? body.pdfKey : pdfKeyFromReportUrl(body.reportUrl);
  return {
    kind,
    trigger: "manual",
    success: true,
    pdfKeys: pdfKey ? [pdfKey] : [],
    pdfStatus: pdfKey ? "generated" : undefined,
    matchedCount: asNumber(body.matchedCount) ?? asNumber(data.matchedCount),
    totalScanned: asNumber(body.totalUnderlyingsScanned) ?? asNumber(body.totalScanned) ?? asNumber(data.totalScanned),
    thesis: typeof body.thesis === "string" ? body.thesis : undefined,
    summary: typeof body.summary === "string" ? body.summary : undefined,
    reportUrl: typeof body.reportUrl === "string" ? body.reportUrl : undefined,
  };
}
