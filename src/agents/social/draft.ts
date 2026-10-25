/**
 * #1077 Phase 4 — social draft records and per-channel formatting.
 *
 * A draft is a post that has been composed and stored but NOT published.
 * Phase 4 creates drafts only; publishing is Phase 5 and must refuse
 * (see publishDraft in src/agents/socialAgent.ts).
 *
 * Formatting limits are conservative, documented here, and chosen below
 * each platform's commonly published maximum so a draft never needs a
 * platform-side rejection to be valid:
 * - X: 280, Threads: 500, Facebook: 2000, Instagram: 2200, LinkedIn: 3000.
 *
 * Truncation never silently cuts mid-word where avoidable: over-limit
 * text is cut at the last word boundary within the limit and an ellipsis
 * marker ("…") is appended; the pre-truncation length is recorded on the
 * result and on the draft. A single unbroken word longer than the limit
 * cannot be cut at a boundary and is hard-cut (documented, tested).
 *
 * Unknown channels fail closed: formatting returns an error and no
 * postable draft is ever produced for them.
 */

import type { SocialChannel } from "./config";

export const CHANNEL_LIMITS: Record<SocialChannel, number> = {
  x: 280,
  threads: 500,
  facebook: 2000,
  instagram: 2200,
  linkedin: 3000,
};

/**
 * Draft lifecycle statuses. "posted" means REALLY posted: a live
 * publish reached a platform and recorded its post id (see
 * platformPostId below). A dry-run publish never sets "posted" — it
 * sets "dry-run-posted", so flipping SOCIAL_LIVE_PUBLISHING on
 * mid-day still live-publishes that day's drafts instead of
 * skipping them as already-posted (issue #1171).
 */
export type SocialDraftStatus = "draft" | "approved" | "posted" | "failed" | "dry-run-posted";

export interface SocialApprovalRecord {
  approver: string;
  approvedAtMs: number;
}

export interface SocialDraft {
  id: string;
  /** YYYY-MM-DD in America/New_York (the posting day the draft belongs to). */
  date: string;
  channel: SocialChannel;
  text: string;
  status: SocialDraftStatus;
  /** Present only once an approval-list draft has been approved (Phase 5). */
  approval?: SocialApprovalRecord;
  /**
   * The platform's post id, recorded ONLY by a live publish (#1171).
   * A dry-run publish never sets this: the synthetic dry-run id
   * travels in the publish result and the sink record only. A draft
   * with status "posted" always carries this id; a draft without it
   * was never live-posted, whatever its status says.
   */
  platformPostId?: string;
  createdAtMs: number;
  /** Pre-truncation length; equals text.length when not truncated. */
  originalLength: number;
  truncated: boolean;
}

export type FormatResult =
  | { ok: true; text: string; truncated: boolean; originalLength: number }
  | { ok: false; error: string };

export type CreateDraftResult =
  | { ok: true; draft: SocialDraft }
  | { ok: false; error: string };

function isKnownChannel(id: string): id is SocialChannel {
  // Own-property check, NOT `id in CHANNEL_LIMITS`: `in` also matches
  // inherited Object.prototype names ("constructor", "toString",
  // "__proto__"), which would otherwise slip past the unknown-channel
  // fail-closed rule and mint a garbage draft.
  return Object.prototype.hasOwnProperty.call(CHANNEL_LIMITS, id);
}

function truncateAtWordBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Reserve one char for the ellipsis marker.
  const candidate = text.slice(0, limit - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  if (lastSpace > 0) return candidate.slice(0, lastSpace) + "…";
  return candidate + "…";
}

export function formatDraftText(channel: string, text: string): FormatResult {
  const id = channel.trim().toLowerCase();
  if (!isKnownChannel(id)) {
    return { ok: false, error: `unknown social channel: ${channel}` };
  }
  const limit = CHANNEL_LIMITS[id];
  if (text.length <= limit) {
    return { ok: true, text, truncated: false, originalLength: text.length };
  }
  return {
    ok: true,
    text: truncateAtWordBoundary(text, limit),
    truncated: true,
    originalLength: text.length,
  };
}

export function createDraft(input: {
  channel: string;
  text: string;
  date: string;
  createdAtMs: number;
}): CreateDraftResult {
  const formatted = formatDraftText(input.channel, input.text);
  if (!formatted.ok) return formatted;
  const channel = input.channel.trim().toLowerCase() as SocialChannel;
  return {
    ok: true,
    draft: {
      id: crypto.randomUUID(),
      date: input.date,
      channel,
      text: formatted.text,
      status: "draft",
      createdAtMs: input.createdAtMs,
      originalLength: formatted.originalLength,
      truncated: formatted.truncated,
    },
  };
}
