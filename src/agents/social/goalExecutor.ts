/**
 * #1077 Phase 5b slice 1 — the social goal executor.
 *
 * The single path by which a ScheduledAgent "social.publish" goal turns
 * into drafts and posts. It deliberately contains NO fire check of its
 * own: the goal's cron + isDue (src/schedule.ts) decides WHEN, and the
 * executor decides only WHAT happens when the goal fires. The bespoke
 * fire check in social/scheduler.ts and the parallel tick in
 * social/tick.ts were retired with this module — keeping both would
 * mean two schedulers that could disagree.
 *
 * Flow: buildDailyDrafts (idempotent per date+channel) then
 * publishDueDrafts under the existing gating — posting switch,
 * SOCIAL_LIVE_PUBLISHING, per-channel tokens, approval flow, dry-run
 * default. Content is never invented: a null, empty, or whitespace
 * brief produces no drafts and the goal is reported as not fired, so
 * the caller leaves lastRun untouched and the goal stays due for the
 * next tick (slice 2 wires NLQ/human content into the brief).
 *
 * Firing rule: the goal counts as run when the day produced drafts OR
 * catch-up published something (slice 3). postingDisabled, noBrief
 * with nothing caught up, and noDrafts with nothing caught up all
 * report not-fired. Publish failures do NOT unfire a run — the drafts
 * exist, per-channel errors are in the publish results for the caller
 * to record, and the catch-up sweep retries them at the next firing.
 *
 * Catch-up (slice 3): every firing also sweeps the 7 prior dates for
 * approved-but-unposted drafts and previously-failed publishes,
 * through the same publishDueDrafts path. This is what fixes the two
 * slice-1 limitations: a same-day approval arriving after the firing
 * is published by the next firing even without publish-on-approve,
 * and a failed publish is retried instead of dropped. Only dates with
 * at least one posted or error result are reported; skipped-only
 * dates are omitted. Dates older than the lookback are never
 * auto-published — staleness beyond a week is a human decision, not
 * something the scheduler should take on its own.
 */

import {
  buildDailyDrafts,
  publishDueDrafts,
  type ChannelPublishResult,
  type DailyDraftsResult,
  type PublishDueResult,
} from "../socialAgent";
import { zonedDateParts } from "../../schedule";
import type { SocialLedger } from "./ledger";
import type { PendingApprovalStore } from "./approvals";
import type { SocialEnv } from "./config";
import type { DryRunSink, SocialTransport } from "./publisher";

export interface SocialGoalDeps {
  env: SocialEnv & { SOCIAL_LIVE_PUBLISHING?: string };
  /** Token/account values keyed by env var name (e.g. X_ACCESS_TOKEN). */
  tokens: Record<string, string | undefined>;
  store: SocialLedger;
  approvals: PendingApprovalStore;
  /** Slice 2: production reads the firing date's brief from the durable brief store (see scheduled-agent.ts onCron); tests pass an override. */
  briefProvider: () => string | null;
  nowMs: number;
  /** IANA zone for the draft date; defaults to America/New_York. */
  timeZone?: string;
  transport?: SocialTransport;
  dryRunSink: DryRunSink;
}

export type SocialGoalResult =
  | {
      fired: true;
      date: string;
      build: DailyDraftsResult;
      publish: PublishDueResult;
      /** Catch-up entries for prior dates with at least one posted/error result. */
      catchUp: CatchUpEntry[];
    }
  | { fired: false; reason: "postingDisabled" | "noBrief" | "noDrafts" };

export interface CatchUpEntry {
  date: string;
  results: ChannelPublishResult[];
}

/** How far back the catch-up sweep looks, in days. Older approved drafts are never auto-published. */
export const SOCIAL_CATCH_UP_LOOKBACK_DAYS = 7;

/** Prior dates for a firing date, newest first, as YYYY-MM-DD strings. Pure. */
export function priorDates(firingDate: string, days = SOCIAL_CATCH_UP_LOOKBACK_DAYS): string[] {
  const [year, month, day] = firingDate.split("-").map(Number);
  const base = Date.UTC(year, month - 1, day);
  const out: string[] = [];
  for (let i = 1; i <= days; i++) {
    out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

export async function executeSocialGoal(deps: SocialGoalDeps): Promise<SocialGoalResult> {
  const build = await buildDailyDrafts({
    env: deps.env,
    brief: deps.briefProvider() ?? "",
    nowMs: deps.nowMs,
    store: deps.store,
    timeZone: deps.timeZone,
  });
  // The kill switch gates everything, including catch-up: a disabled
  // system publishes nothing, not even its backlog.
  if (build.status === "postingDisabled") return { fired: false, reason: "postingDisabled" };
  const firingDate =
    build.date ?? zonedDateParts(deps.nowMs, deps.timeZone ?? "America/New_York").date;
  let publish: PublishDueResult | null = null;
  if (build.date && build.channels.some((c) => c.draft !== null)) {
    publish = await publishDueDrafts({
      env: deps.env,
      tokens: deps.tokens,
      store: deps.store,
      approvals: deps.approvals,
      date: build.date,
      transport: deps.transport,
      dryRunSink: deps.dryRunSink,
      nowMs: deps.nowMs,
    });
  }
  // Slice 3 catch-up: prior dates through the same publish path.
  // publishDueDrafts already enforces every gate (approval status,
  // posted/failed skips, live/dry-run resolution), so the sweep can
  // only publish what a firing would have published: approved drafts
  // and retries of previously-failed publishes. Unapproved drafts are
  // re-recorded pending and skipped, never published.
  const catchUp: CatchUpEntry[] = [];
  for (const date of priorDates(firingDate)) {
    const swept = await publishDueDrafts({
      env: deps.env,
      tokens: deps.tokens,
      store: deps.store,
      approvals: deps.approvals,
      date,
      transport: deps.transport,
      dryRunSink: deps.dryRunSink,
      nowMs: deps.nowMs,
    });
    if (swept.status === "done" && swept.results.some((r) => r.outcome === "posted" || r.outcome === "error")) {
      catchUp.push({ date, results: swept.results });
    }
  }
  const dayProduced = publish !== null;
  const catchUpPublished = catchUp.some((e) => e.results.some((r) => r.outcome === "posted"));
  if (!dayProduced && !catchUpPublished) {
    return { fired: false, reason: build.status === "noBrief" ? "noBrief" : "noDrafts" };
  }
  return {
    fired: true,
    date: firingDate,
    build,
    publish: publish ?? { date: firingDate, status: "done", results: [] },
    catchUp,
  };
}
