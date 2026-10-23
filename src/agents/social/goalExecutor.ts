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
 * Firing rule: the goal counts as run ONLY when at least one draft
 * was actually produced. postingDisabled, noBrief, and noDrafts all
 * report not-fired. Publish failures do NOT unfire a run — the drafts
 * exist, per-channel errors are in the publish results for the caller
 * to record, and the next day's goal builds fresh drafts.
 */

import {
  buildDailyDrafts,
  publishDueDrafts,
  type DailyDraftsResult,
  type PublishDueResult,
} from "../socialAgent";
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
  | { fired: true; date: string; build: DailyDraftsResult; publish: PublishDueResult }
  | { fired: false; reason: "postingDisabled" | "noBrief" | "noDrafts" };

export async function executeSocialGoal(deps: SocialGoalDeps): Promise<SocialGoalResult> {
  const build = await buildDailyDrafts({
    env: deps.env,
    brief: deps.briefProvider() ?? "",
    nowMs: deps.nowMs,
    store: deps.store,
    timeZone: deps.timeZone,
  });
  if (build.status === "postingDisabled") return { fired: false, reason: "postingDisabled" };
  if (build.status === "noBrief") return { fired: false, reason: "noBrief" };
  if (!build.date || !build.channels.some((c) => c.draft !== null)) {
    return { fired: false, reason: "noDrafts" };
  }
  const publish = await publishDueDrafts({
    env: deps.env,
    tokens: deps.tokens,
    store: deps.store,
    approvals: deps.approvals,
    date: build.date,
    transport: deps.transport,
    dryRunSink: deps.dryRunSink,
    nowMs: deps.nowMs,
  });
  return { fired: true, date: build.date, build, publish };
}
