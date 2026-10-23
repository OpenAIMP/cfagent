/**
 * #1077 Phase 5a — approval flow (record only, no delivery).
 *
 * Approval-list drafts (Facebook, Instagram, LinkedIn by default) may
 * only publish once approved. This module records that decision:
 * - approveDraft marks a stored draft "approved" with an approval
 *   record {approver, approvedAtMs} and clears its pending entry.
 * - rejectDraft marks it "failed" and clears its pending entry. The
 *   record is NEVER deleted — the ledger is the audit trail.
 * - PendingApprovalStore holds one entry per (date, channel) for
 *   drafts awaiting approval, retrievable per date. A later wiring
 *   step (Phase 5b) will deliver these as Slack approval cards;
 *   this phase records the request and delivers NOTHING.
 *
 * Refusal rules (fail-closed, never throw):
 * - No draft for the date+channel → error.
 * - Already posted → error (a post cannot be un-posted or re-approved).
 * - Rejected (failed) → approval refused (a rejected draft needs a
 *   fresh draft, not a second decision); re-rejection is idempotent.
 * - Approving an already-approved draft refreshes the approval record.
 * Approval never blocks autonomous channels: publish gating treats an
 * approved autonomous draft as publishable, exactly like a fresh one.
 */

import type { SocialDraft } from "./draft";
import type { SocialLedger } from "./ledger";

export interface PendingApproval {
  date: string;
  channel: string;
  draftId: string;
  requestedAtMs: number;
}

export interface PendingApprovalStore {
  /**
   * Methods return T | Promise<T>, as in SocialLedger: sync
   * implementations satisfy this with plain values, async ones with
   * promises, and callers MUST await every call.
   */
  recordPending(approval: PendingApproval): void | Promise<void>;
  listPending(date: string): PendingApproval[] | Promise<PendingApproval[]>;
  clearPending(date: string, channel: string): void | Promise<void>;
}

export class MemoryPendingApprovalStore implements PendingApprovalStore {
  private readonly byKey = new Map<string, PendingApproval>();

  recordPending(approval: PendingApproval): void {
    this.byKey.set(`${approval.date}:${approval.channel}`, approval);
  }

  listPending(date: string): PendingApproval[] {
    const prefix = `${date}:`;
    const out: PendingApproval[] = [];
    for (const [key, approval] of this.byKey) {
      if (key.startsWith(prefix)) out.push(approval);
    }
    return out;
  }

  clearPending(date: string, channel: string): void {
    this.byKey.delete(`${date}:${channel}`);
  }
}

export type ApprovalResult =
  | { ok: true; draft: SocialDraft }
  | { ok: false; error: string };

export async function approveDraft(
  store: SocialLedger,
  approvals: PendingApprovalStore,
  date: string,
  channel: string,
  approver: string,
  nowMs: number,
): Promise<ApprovalResult> {
  const existing = await store.getDraft(date, channel);
  if (!existing) {
    return { ok: false, error: `no draft for ${channel} on ${date}` };
  }
  if (existing.status === "posted") {
    return { ok: false, error: `draft for ${channel} on ${date} is already posted` };
  }
  if (existing.status === "failed") {
    return { ok: false, error: `draft for ${channel} on ${date} was rejected` };
  }
  const draft: SocialDraft = {
    ...existing,
    status: "approved",
    approval: { approver, approvedAtMs: nowMs },
  };
  await store.putDraft(draft);
  await approvals.clearPending(date, channel);
  return { ok: true, draft };
}

export async function rejectDraft(
  store: SocialLedger,
  approvals: PendingApprovalStore,
  date: string,
  channel: string,
): Promise<ApprovalResult> {
  const existing = await store.getDraft(date, channel);
  if (!existing) {
    return { ok: false, error: `no draft for ${channel} on ${date}` };
  }
  if (existing.status === "posted") {
    return { ok: false, error: `draft for ${channel} on ${date} is already posted` };
  }
  const draft: SocialDraft = { ...existing, status: "failed" };
  await store.putDraft(draft);
  await approvals.clearPending(date, channel);
  return { ok: true, draft };
}
