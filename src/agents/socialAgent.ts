/**
 * #1077 Phase 4 — SocialMediaAgent (drafts-only skeleton).
 *
 * Ties together social config, draft formatting, the ledger, and the NY
 * date rule into one daily build. This module PUBLISHES NOTHING:
 * - buildDailyDrafts composes and stores drafts, then stops.
 * - publishDraft refuses every attempt with not_implemented_phase5.
 *   Platform publishing (tokens, platform API clients, approval flow)
 *   is Phase 5; no platform code, SDK, token, or network call exists in
 *   this phase.
 *
 * Hard rules:
 * - Posting disabled (SOCIAL_POSTING_ENABLED off) → early return
 *   "postingDisabled"; nothing is written.
 * - No brief (missing, empty, or whitespace-only) → early return
 *   "noBrief"; nothing is written. The agent NEVER invents placeholder
 *   content: without a brief there are no drafts, full stop.
 * - One draft per enabled channel (autonomous list + approval list),
 *   written idempotently: a second build the same day returns the first
 *   draft set, never duplicates.
 * - Channel disposition follows the fail-closed resolution in
 *   social/config.ts (both lists → approval; unknown → approval).
 * - Unknown configured channels produce an error entry, never a draft,
 *   and never throw.
 */

import {
  parseSocialConfig,
  enabledChannels,
  resolveChannelDisposition,
  type SocialEnv,
} from "./social/config";
import { createDraft, type SocialDraft } from "./social/draft";
import { getOrCreateDraft, type SocialLedger } from "./social/ledger";
import { nyParts } from "./social/scheduler";

export type BuildStatus = "postingDisabled" | "noBrief" | "drafts";

export interface ChannelBuildResult {
  channel: string;
  disposition: "autonomous" | "approval";
  draft: SocialDraft | null;
  error?: string;
}

export interface DailyDraftsResult {
  status: BuildStatus;
  date: string | null;
  channels: ChannelBuildResult[];
}

export function buildDailyDrafts(input: {
  env: SocialEnv;
  brief: string;
  nowMs: number;
  store: SocialLedger;
}): DailyDraftsResult {
  const config = parseSocialConfig(input.env);
  if (!config.postingEnabled) {
    return { status: "postingDisabled", date: null, channels: [] };
  }
  if (!input.brief || input.brief.trim() === "") {
    return { status: "noBrief", date: null, channels: [] };
  }

  const date = nyParts(input.nowMs).date;
  const channels: ChannelBuildResult[] = [];
  for (const channel of enabledChannels(config)) {
    const disposition = resolveChannelDisposition(channel, config);
    const created = createDraft({
      channel,
      text: input.brief,
      date,
      createdAtMs: input.nowMs,
    });
    if (!created.ok) {
      channels.push({ channel, disposition, draft: null, error: created.error });
      continue;
    }
    const draft = getOrCreateDraft(input.store, date, channel, () => created.draft);
    channels.push({ channel, disposition, draft });
  }
  return { status: "drafts", date, channels };
}

/**
 * Phase 5 placeholder. Every publish attempt refuses with
 * not_implemented_phase5 — including for autonomous channels — because
 * no platform publisher, token, or approval flow exists yet. A draft
 * reaching this function is a wiring error, not a post.
 */
export function publishDraft(_input: {
  channel: string;
  draftId: string;
}): { ok: false; error: "not_implemented_phase5" } {
  return { ok: false, error: "not_implemented_phase5" };
}
