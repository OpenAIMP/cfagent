/**
 * #1077 Phase 5b slice 3: publish-on-approve + Slack interaction handling.
 *
 * Pinned here:
 * - approving a pending draft publishes it promptly through the existing
 *   publishDueDrafts path (same gates: posting switch, live/dry-run
 *   resolution, token checks) — never a second publish implementation;
 * - a publish failure leaves the draft APPROVED (not posted), with the
 *   error recorded, so catch-up can retry it — never silently dropped,
 *   never marked posted on failure;
 * - rejecting publishes nothing and retains the record as failed;
 * - the Slack interaction handler refuses stale cards (pending draftId
 *   mismatch), missing pending, and malformed values, and never acts
 *   on a non-social action (the caller falls through to trading);
 * - replacement blocks follow the trading convention: a header with
 *   the outcome, fields, the draft text, and a publish-outcome context.
 */
import { describe, it, expect } from "vitest";
import { MemorySocialLedger } from "../src/agents/social/ledger";
import { MemoryPendingApprovalStore } from "../src/agents/social/approvals";
import {
  approveAndPublish,
  rejectSocialDraft,
} from "../src/agents/social/approvalActions";
import {
  parseSocialAction,
  handleSocialSlackInteraction,
} from "../src/agents/social/interactions";
import {
  createMemoryDryRunSink,
  type DryRunSink,
} from "../src/agents/social/publisher";
import type { SocialDraft } from "../src/agents/social/draft";

const DATE = "2026-10-26";
const NOW = 1_769_000_000_000;

function draft(overrides: Partial<SocialDraft> = {}): SocialDraft {
  return {
    id: "draft-1",
    date: DATE,
    channel: "facebook",
    text: "Morning brief: markets up.",
    status: "draft",
    createdAtMs: 1_000,
    originalLength: 26,
    truncated: false,
    ...overrides,
  } as SocialDraft;
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  const store = new MemorySocialLedger();
  const approvals = new MemoryPendingApprovalStore();
  const sink = createMemoryDryRunSink();
  return {
    store,
    approvals,
    sink: sink as DryRunSink,
    deps: {
      env: {
        SOCIAL_POSTING_ENABLED: "1",
        SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
        SOCIAL_APPROVAL_CHANNELS: "facebook,instagram,linkedin",
      },
      tokens: {},
      store,
      approvals,
      dryRunSink: sink as DryRunSink,
      nowMs: NOW,
      ...overrides,
    },
    sink,
  };
}

async function pendingDraft() {
  const { store, approvals, sink, deps } = baseDeps();
  await store.putDraft(draft());
  await approvals.recordPending({ date: DATE, channel: "facebook", draftId: "draft-1", requestedAtMs: 1_000 });
  return { store, approvals, sink, deps };
}

describe("approveAndPublish", () => {
  it("approves and publishes (dry-run) through the existing path, clearing pending", async () => {
    const { approvals, sink, deps } = await pendingDraft();
    const res = await approveAndPublish({ ...deps, date: DATE, channel: "facebook", approver: "slack:U1" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.draft.status).toBe("posted");
    expect(res.draft.approval).toEqual({ approver: "slack:U1", approvedAtMs: NOW });
    expect(res.channelResult?.outcome).toBe("posted");
    expect(res.channelResult?.platformPostId).toBe("dry-run:draft-1");
    expect(sink.records).toHaveLength(1);
    expect(await approvals.listPending(DATE)).toHaveLength(0);
  });

  it("a live-gate failure leaves the draft APPROVED with the error recorded (retryable)", async () => {
    const { store, deps } = await pendingDraft();
    const live = {
      ...deps,
      env: { ...deps.env, SOCIAL_LIVE_PUBLISHING: "1" },
      tokens: {}, // no token: live gate must fail, never fall back to dry-run
    };
    const res = await approveAndPublish({ ...live, date: DATE, channel: "facebook", approver: "slack:U1" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.draft.status).toBe("approved");
    expect(res.channelResult?.outcome).toBe("error");
    expect(res.channelResult?.reason).toContain("missing token");
    const stored = await store.getDraft(DATE, "facebook");
    expect(stored?.status).toBe("approved");
  });

  it("approving with posting disabled refuses without touching the draft", async () => {
    const { store, deps } = await pendingDraft();
    const off = { ...deps, env: { ...deps.env, SOCIAL_POSTING_ENABLED: "0" } };
    const res = await approveAndPublish({ ...off, date: DATE, channel: "facebook", approver: "slack:U1" });
    expect(res.ok).toBe(false);
    expect((await store.getDraft(DATE, "facebook"))?.status).toBe("draft");
  });

  it("approving a missing draft or an already-posted draft refuses honestly", async () => {
    const { deps } = baseDeps();
    const missing = await approveAndPublish({ ...deps, date: DATE, channel: "facebook", approver: "slack:U1" });
    expect(missing.ok).toBe(false);
    const { store, deps: deps2 } = baseDeps();
    await store.putDraft(draft({ status: "posted" }));
    const posted = await approveAndPublish({ ...deps2, date: DATE, channel: "facebook", approver: "slack:U1" });
    expect(posted.ok).toBe(false);
  });

  it("reject publishes nothing and retains the record as failed", async () => {
    const { store, approvals, sink, deps } = await pendingDraft();
    const res = await rejectSocialDraft({ store, approvals, date: DATE, channel: "facebook" });
    expect(res.ok).toBe(true);
    expect((await store.getDraft(DATE, "facebook"))?.status).toBe("failed");
    expect(sink.records).toHaveLength(0);
    expect(await approvals.listPending(DATE)).toHaveLength(0);
  });
});

function payload(actionId: string, value: string, userId = "U1") {
  return {
    type: "block_actions",
    user: { id: userId, username: "approver" },
    channel: { id: "C-general" },
    actions: [{ action_id: actionId, value }],
  };
}

describe("parseSocialAction", () => {
  it("parses approve/reject with date|channel|draftId and the Slack user", () => {
    expect(parseSocialAction(payload("social_approve", "2026-10-26|facebook|draft-1"))).toEqual({
      kind: "social",
      action: "approve",
      date: "2026-10-26",
      channel: "facebook",
      draftId: "draft-1",
      userId: "U1",
    });
    const rej = parseSocialAction(payload("social_reject", "2026-10-26|linkedin|d-9", "U2"));
    expect(rej).toMatchObject({ kind: "social", action: "reject", userId: "U2" });
  });

  it("non-social actions are 'other' (caller falls through to trading); garbage is an error", () => {
    expect(parseSocialAction(payload("etrade_approve_order", "ORD_1"))).toEqual({ kind: "other" });
    expect(parseSocialAction({ actions: [] })).toMatchObject({ kind: "error" });
    expect(parseSocialAction(payload("social_approve", "garbage"))).toMatchObject({ kind: "error" });
    expect(parseSocialAction(payload("social_approve", "2026-10-26|myspace|d"))).toMatchObject({
      kind: "error",
    });
  });
});

describe("handleSocialSlackInteraction", () => {
  it("approve publishes (dry-run) and returns replacement blocks with the outcome", async () => {
    const { deps } = await pendingDraft();
    const res = await handleSocialSlackInteraction({
      ...deps,
      payload: payload("social_approve", "2026-10-26|facebook|draft-1"),
    });
    expect(res.handled).toBe(true);
    expect(res.message).toContain("APPROVED");
    expect(res.message).toContain("posted");
    const joined = JSON.stringify(res.blocks);
    expect(joined).toContain("facebook");
    expect(joined).toContain("2026-10-26");
    expect(joined).toContain("<@U1>");
    expect(joined).toContain("Morning brief: markets up.");
    const stored = await deps.store.getDraft(DATE, "facebook");
    expect(stored?.status).toBe("posted");
  });

  it("reject returns rejection blocks and publishes nothing", async () => {
    const { deps, sink } = await pendingDraft();
    const res = await handleSocialSlackInteraction({
      ...deps,
      payload: payload("social_reject", "2026-10-26|facebook|draft-1"),
    });
    expect(res.handled).toBe(true);
    expect(res.message).toContain("REJECTED");
    expect(sink.records).toHaveLength(0);
    expect((await deps.store.getDraft(DATE, "facebook"))?.status).toBe("failed");
  });

  it("a stale card (pending draftId mismatch) is refused and changes nothing", async () => {
    const { store, approvals, deps } = await pendingDraft();
    await store.putDraft(draft({ id: "draft-2" }));
    await approvals.recordPending({ date: DATE, channel: "facebook", draftId: "draft-2", requestedAtMs: 2_000 });
    const res = await handleSocialSlackInteraction({
      ...deps,
      payload: payload("social_approve", "2026-10-26|facebook|draft-1"),
    });
    expect(res.handled).toBe(true);
    expect(res.message.toLowerCase()).toContain("stale");
    expect((await store.getDraft(DATE, "facebook"))?.status).toBe("draft");
  });

  it("no pending approval is refused without touching the draft", async () => {
    const { store, deps } = baseDeps();
    await store.putDraft(draft());
    const res = await handleSocialSlackInteraction({
      ...deps,
      payload: payload("social_approve", "2026-10-26|facebook|draft-1"),
    });
    expect(res.handled).toBe(true);
    expect(res.message.toLowerCase()).toContain("no pending");
    expect((await store.getDraft(DATE, "facebook"))?.status).toBe("draft");
  });

  it("non-social actions are not handled here", async () => {
    const { deps } = baseDeps();
    const res = await handleSocialSlackInteraction({
      ...deps,
      payload: payload("etrade_approve_order", "ORD_1"),
    });
    expect(res.handled).toBe(false);
  });
});
