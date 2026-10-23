/**
 * #1077 Phase 5a — daily social tick.
 *
 * One function the worker's scheduled() handler calls on the
 * every-30-minute tick: check whether today is due, build the draft
 * then publish what is due under the Phase 5a gating rules. Pure
 * except for the store/sink/transport it is handed — every input is
 * explicit, so tests pin exact instants and outcomes.
 *
 * Order (each step can only stop the run, never invent work):
 * 1. Posting disabled → "postingDisabled", nothing written.
 * 2. Fire check (scheduler.ts): not due → "notDue"; drafts already
 *    exist today → "alreadyExists". Both write nothing.
 * 3. Brief: briefProvider() returns string|null. Null, empty, or
 *    whitespace-only → "noBrief", nothing written (the same rule as
 *    buildDailyDrafts — the agent never invents placeholder content).
 * 4. Build drafts, then publish due drafts (publishDueDrafts):
 *    approval-list drafts only when approved, autonomous drafts when
 *    draft/approved, posted/failed never republished, per-channel
 *    failures isolated. Dry-run by default; live only behind all
 *    three gates (posting on + SOCIAL_LIVE_PUBLISHING + token).
 *
 * The briefProvider is the content-source seam: production wiring
 * passes a function returning null until the owner supplies a content
 * source, which makes the whole tick a no-op (step 3) regardless of
 * the fire check. A throwing briefProvider propagates to the caller;
 * the scheduled() handler logs tick failures rather than letting one
 * break the other jobs riding the tick.
 */

import { parseSocialConfig, type SocialEnv } from "./config";
import { buildDailyDrafts, publishDueDrafts, type DailyDraftsResult, type PublishDueResult } from "../socialAgent";
import { checkDailyFire, DEFAULT_SOCIAL_SCHEDULE, type SocialSchedule } from "./scheduler";
import type { SocialLedger } from "./ledger";
import type { PendingApprovalStore } from "./approvals";
import type { DryRunSink, SocialTransport } from "./publisher";

export type TickStatus = "postingDisabled" | "notDue" | "alreadyExists" | "noBrief" | "done";

export interface TickResult {
  status: TickStatus;
  date: string | null;
  build?: DailyDraftsResult;
  publish?: PublishDueResult;
}

export async function runSocialDailyTick(input: {
  env: SocialEnv & { SOCIAL_LIVE_PUBLISHING?: string };
  tokens: Record<string, string | undefined>;
  nowMs: number;
  store: SocialLedger;
  approvals: PendingApprovalStore;
  briefProvider: () => string | null;
  transport?: SocialTransport;
  dryRunSink: DryRunSink;
  schedule?: SocialSchedule;
}): Promise<TickResult> {
  const config = parseSocialConfig(input.env);
  if (!config.postingEnabled) {
    return { status: "postingDisabled", date: null };
  }
  const fire = checkDailyFire({
    nowMs: input.nowMs,
    schedule: input.schedule ?? DEFAULT_SOCIAL_SCHEDULE,
    ledger: input.store,
  });
  if (!fire.due) {
    return { status: "notDue", date: fire.date };
  }
  if (fire.alreadyExists) {
    return { status: "alreadyExists", date: fire.date };
  }
  const brief = input.briefProvider();
  const build = buildDailyDrafts({
    env: input.env,
    brief: brief ?? "",
    nowMs: input.nowMs,
    store: input.store,
  });
  if (build.status !== "drafts") {
    // buildDailyDrafts returns noBrief here and writes nothing; the
    // status is passed through unchanged (never postingDisabled at
    // this point — posting was checked above).
    return { status: build.status, date: fire.date, build };
  }
  const publish = await publishDueDrafts({
    env: input.env,
    tokens: input.tokens,
    store: input.store,
    approvals: input.approvals,
    date: fire.date,
    transport: input.transport,
    dryRunSink: input.dryRunSink,
    nowMs: input.nowMs,
  });
  return { status: "done", date: fire.date, build, publish };
}
