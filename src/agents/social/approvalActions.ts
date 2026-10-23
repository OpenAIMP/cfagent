/**
 * #1077 Phase 5b slice 3 — approve/reject actions with publish-on-approve.
 *
 * The single shared core behind BOTH approval paths (the Slack
 * interaction handler and the session-gated API route). Approving a
 * pending draft publishes it promptly through the existing
 * publishDueDrafts path — never a second publish implementation, and
 * under the same gates (posting switch, live/dry-run resolution,
 * token/account checks):
 * - Approval triggers the date's FULL publish pass, not just the one
 *   channel: any other approved or previously-failed draft for that
 *   date resolves in the same pass. That is the catch-up behavior
 *   applied on demand.
 * - A publish failure leaves the draft APPROVED (not posted) with the
 *   error in the result, so the catch-up sweep retries it — never
 *   silently dropped, never marked posted on failure. In production
 *   today there is no live transport (the Phase 5a gap: production
 *   passes no transport), so a live publish-on-approve fails honestly
 *   here exactly as the goal path does; dry-run works end to end.
 * - Posting disabled refuses approval outright: the kill switch gates
 *   publishing, not just the goal firing.
 * - Rejecting publishes nothing; the record stays "failed" as the
 *   audit trail (the Phase 5a rule, unchanged).
 */

import { approveDraft, rejectDraft, type ApprovalResult } from "./approvals";
import type { SocialDraft } from "./draft";
import type { SocialLedger } from "./ledger";
import type { PendingApprovalStore } from "./approvals";
import { publishDueDrafts, type ChannelPublishResult, type PublishDueResult } from "../socialAgent";
import { parseSocialConfig, type SocialEnv } from "./config";
import type { DryRunSink, SocialTransport } from "./publisher";

export interface ApprovePublishDeps {
  env: SocialEnv & { SOCIAL_LIVE_PUBLISHING?: string };
  tokens: Record<string, string | undefined>;
  store: SocialLedger;
  approvals: PendingApprovalStore;
  transport?: SocialTransport;
  dryRunSink: DryRunSink;
  nowMs: number;
}

export type ApprovePublishResult =
  | {
      ok: true;
      /** The draft's final stored state after the publish attempt (posted, or still approved on failure). */
      draft: SocialDraft;
      publish: PublishDueResult;
      channelResult: ChannelPublishResult | undefined;
    }
  | { ok: false; error: string };

export async function approveAndPublish(
  input: ApprovePublishDeps & { date: string; channel: string; approver: string },
): Promise<ApprovePublishResult> {
  const deps = input;
  // The kill switch gates publishing itself, not just the goal firing:
  // refusing here leaves the draft untouched for a later decision.
  if (!parseSocialConfig(deps.env).postingEnabled) {
    return { ok: false, error: "social posting is not enabled" };
  }
  const approval = await approveDraft(deps.store, deps.approvals, deps.date, deps.channel, deps.approver, deps.nowMs);
  if (!approval.ok) return { ok: false, error: approval.error };
  const publish = await publishDueDrafts({
    env: deps.env,
    tokens: deps.tokens,
    store: deps.store,
    approvals: deps.approvals,
    date: deps.date,
    transport: deps.transport,
    dryRunSink: deps.dryRunSink,
    nowMs: deps.nowMs,
  });
  // Return the final stored draft, not the approval snapshot: on
  // success it reads "posted"; on publish failure it still reads
  // "approved" (retryable), which is what callers must report.
  const finalDraft = await deps.store.getDraft(deps.date, deps.channel);
  return {
    ok: true,
    draft: finalDraft ?? approval.draft,
    publish,
    channelResult: publish.results.find((r) => r.channel === deps.channel),
  };
}

export async function rejectSocialDraft(
  input: Pick<ApprovePublishDeps, "store" | "approvals"> & { date: string; channel: string },
): Promise<ApprovalResult> {
  return rejectDraft(input.store, input.approvals, input.date, input.channel);
}
