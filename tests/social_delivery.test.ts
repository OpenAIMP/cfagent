/**
 * #1077 Phase 5b slice 3: Slack approval-card delivery.
 *
 * Pinned here:
 * - the card carries date, channel, and the draft text (plain_text, so
 *   user content can never inject mrkdwn), plus Approve/Reject buttons
 *   whose value encodes date|channel|draftId — nothing more;
 * - delivery posts to exactly ONE destination (webhook first, else bot
 *   token with channel), never both, never a hardcoded channel id;
 * - delivery is idempotent per (date, channel, draftId): a second pass
 *   over an unchanged pending record sends nothing, and a rebuilt
 *   draft (new draftId) re-delivers;
 * - undeliverable (no token, no webhook) and failed posts never mark
 *   the record delivered, so the next pass retries;
 * - posted/failed/approved/missing drafts never get a card.
 */
import { describe, it, expect } from "vitest";
import {
  buildApprovalCard,
  approvalCardValue,
  parseApprovalCardValue,
  resolveSocialSlackChannel,
  deliverApprovalCard,
  deliverPendingApprovals,
  type SlackPostFn,
} from "../src/agents/social/delivery";
import { MemorySocialLedger } from "../src/agents/social/ledger";
import { MemoryPendingApprovalStore } from "../src/agents/social/approvals";
import type { SocialDraft } from "../src/agents/social/draft";

function draft(overrides: Partial<SocialDraft> = {}): SocialDraft {
  return {
    id: "draft-1",
    date: "2026-10-26",
    channel: "facebook",
    text: "Morning brief: markets up.",
    status: "draft",
    createdAtMs: 1_000,
    originalLength: 26,
    truncated: false,
    ...overrides,
  } as SocialDraft;
}

function calls() {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const post: SlackPostFn = async (url, headers, body) => {
    seen.push({ url, headers, body });
    return { status: 200, body: JSON.stringify({ ok: true }) };
  };
  return { seen, post };
}

describe("approval card construction", () => {
  it("carries date, channel, plain_text draft text, and Approve/Reject buttons", () => {
    const blocks = buildApprovalCard({
      date: "2026-10-26",
      channel: "facebook",
      draftId: "draft-1",
      text: "Hello *world*.",
    }) as any[];
    const joined = JSON.stringify(blocks);
    expect(joined).toContain("2026-10-26");
    expect(joined).toContain("facebook");
    expect(joined).toContain("Hello *world*.");
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions).toBeDefined();
    const approve = actions.elements.find((e: any) => e.action_id === "social_approve");
    const reject = actions.elements.find((e: any) => e.action_id === "social_reject");
    expect(approve).toBeDefined();
    expect(reject).toBeDefined();
    expect(approve.value).toBe("2026-10-26|facebook|draft-1");
    expect(reject.value).toBe("2026-10-26|facebook|draft-1");
    // Draft text must be plain_text: user content never renders as mrkdwn.
    const textSection = blocks.find(
      (b) => b.type === "section" && b.text?.text === "Hello *world*.",
    );
    expect(textSection.text.type).toBe("plain_text");
  });

  it("card value round-trips and rejects garbage", () => {
    expect(parseApprovalCardValue("2026-10-26|facebook|draft-1")).toEqual({
      date: "2026-10-26",
      channel: "facebook",
      draftId: "draft-1",
    });
    expect(parseApprovalCardValue("nope")).toBeNull();
    expect(parseApprovalCardValue("2026-10-26|facebook")).toBeNull();
    expect(parseApprovalCardValue("2026-13-40|facebook|d")).toBeNull();
    expect(parseApprovalCardValue("2026-10-26|myspace|d")).toBeNull();
    expect(parseApprovalCardValue(42)).toBeNull();
    expect(approvalCardValue("2026-10-26", "facebook", "draft-1")).toBe(
      "2026-10-26|facebook|draft-1",
    );
  });

  it("channel resolution prefers SOCIAL_SLACK_CHANNEL, then SLACK_CHANNEL_ID, then SLACK_CHANNEL", () => {
    expect(
      resolveSocialSlackChannel({
        SOCIAL_SLACK_CHANNEL: "C-social",
        SLACK_CHANNEL_ID: "C-id",
        SLACK_CHANNEL: "C-general",
      }),
    ).toBe("C-social");
    expect(
      resolveSocialSlackChannel({ SLACK_CHANNEL_ID: "C-id", SLACK_CHANNEL: "C-general" }),
    ).toBe("C-id");
    expect(resolveSocialSlackChannel({ SLACK_CHANNEL: "C-general" })).toBe("C-general");
    expect(resolveSocialSlackChannel({})).toBeUndefined();
  });
});

describe("deliverApprovalCard", () => {
  it("posts blocks to the webhook when one is configured (exactly one call)", async () => {
    const { seen, post } = calls();
    const res = await deliverApprovalCard({
      post,
      env: { SLACK_WEBHOOK_URL: "https://hooks.slack.test/xxx", SLACK_BOT_TOKEN: "xoxb-1" },
      card: { date: "2026-10-26", channel: "facebook", draftId: "draft-1", text: "Hi." },
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("webhook");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://hooks.slack.test/xxx");
    const body = JSON.parse(seen[0].body);
    expect(body.blocks).toBeDefined();
    expect(body.blocks.some((b: any) => b.type === "actions")).toBe(true);
  });

  it("falls back to bot chat.postMessage with the resolved channel when no webhook", async () => {
    const { seen, post } = calls();
    const res = await deliverApprovalCard({
      post,
      env: { SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL: "C-general" },
      card: { date: "2026-10-26", channel: "linkedin", draftId: "draft-9", text: "Hi." },
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("bot");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://slack.com/api/chat.postMessage");
    const body = JSON.parse(seen[0].body);
    expect(body.channel).toBe("C-general");
    expect(body.blocks).toBeDefined();
  });

  it("bot token without a channel is not deliverable (no call, honest error)", async () => {
    const { seen, post } = calls();
    const res = await deliverApprovalCard({
      post,
      env: { SLACK_BOT_TOKEN: "xoxb-1" },
      card: { date: "2026-10-26", channel: "facebook", draftId: "draft-1", text: "Hi." },
    });
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("no token and no webhook is not deliverable (no call, honest error)", async () => {
    const { seen, post } = calls();
    const res = await deliverApprovalCard({
      post,
      env: {},
      card: { date: "2026-10-26", channel: "facebook", draftId: "draft-1", text: "Hi." },
    });
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("webhook failure falls back to bot; both failing is an error, not a silent drop", async () => {
    const seen: { url: string }[] = [];
    const post: SlackPostFn = async (url) => {
      seen.push({ url });
      return { status: 500, body: "" };
    };
    const res = await deliverApprovalCard({
      post,
      env: {
        SLACK_WEBHOOK_URL: "https://hooks.slack.test/xxx",
        SLACK_BOT_TOKEN: "xoxb-1",
        SLACK_CHANNEL: "C-general",
      },
      card: { date: "2026-10-26", channel: "facebook", draftId: "draft-1", text: "Hi." },
    });
    expect(res.ok).toBe(false);
    expect(seen.map((s) => s.url)).toEqual([
      "https://hooks.slack.test/xxx",
      "https://slack.com/api/chat.postMessage",
    ]);
  });

  it("bot chat.postMessage returning ok:false is a failure even on HTTP 200", async () => {
    const post: SlackPostFn = async () => ({
      status: 200,
      body: JSON.stringify({ ok: false, error: "channel_not_found" }),
    });
    const res = await deliverApprovalCard({
      post,
      env: { SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL: "C-general" },
      card: { date: "2026-10-26", channel: "facebook", draftId: "draft-1", text: "Hi." },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("channel_not_found");
  });
});

describe("deliverPendingApprovals idempotency", () => {
  async function setup() {
    const store = new MemorySocialLedger();
    const approvals = new MemoryPendingApprovalStore();
    await store.putDraft(draft());
    await approvals.recordPending({
      date: "2026-10-26",
      channel: "facebook",
      draftId: "draft-1",
      requestedAtMs: 1_000,
    });
    return { store, approvals };
  }

  it("delivers once, then skips the unchanged record on the next pass", async () => {
    const { store, approvals } = await setup();
    const { seen, post } = calls();
    const env = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL: "C-general" };
    const first = await deliverPendingApprovals({
      store,
      approvals,
      dates: ["2026-10-26"],
      post,
      env,
    });
    expect(first).toHaveLength(1);
    expect(first[0].delivered).toBe(true);
    expect(seen).toHaveLength(1);
    const second = await deliverPendingApprovals({
      store,
      approvals,
      dates: ["2026-10-26"],
      post,
      env,
    });
    expect(second[0].delivered).toBe(false);
    expect(second[0].skipped).toBe("already delivered");
    expect(seen).toHaveLength(1);
  });

  it("a rebuilt draft (new draftId) re-delivers", async () => {
    const { store, approvals } = await setup();
    const { seen, post } = calls();
    const env = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL: "C-general" };
    await deliverPendingApprovals({ store, approvals, dates: ["2026-10-26"], post, env });
    await store.putDraft(draft({ id: "draft-2" }));
    await approvals.recordPending({
      date: "2026-10-26",
      channel: "facebook",
      draftId: "draft-2",
      requestedAtMs: 2_000,
    });
    const res = await deliverPendingApprovals({
      store,
      approvals,
      dates: ["2026-10-26"],
      post,
      env,
    });
    expect(res[0].delivered).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("a failed delivery never marks the record delivered, so the next pass retries", async () => {
    const { store, approvals } = await setup();
    let callsMade = 0;
    const post: SlackPostFn = async () => {
      callsMade++;
      return { status: 500, body: "" };
    };
    const env = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL: "C-general" };
    const first = await deliverPendingApprovals({
      store,
      approvals,
      dates: ["2026-10-26"],
      post,
      env,
    });
    expect(first[0].delivered).toBe(false);
    expect(first[0].error).toBeDefined();
    const second = await deliverPendingApprovals({
      store,
      approvals,
      dates: ["2026-10-26"],
      post,
      env,
    });
    expect(second[0].delivered).toBe(false);
    expect(callsMade).toBe(2);
  });

  it("posted, failed, approved, and missing drafts never get a card", async () => {
    const store = new MemorySocialLedger();
    const approvals = new MemoryPendingApprovalStore();
    for (const [channel, status] of [
      ["facebook", "posted"],
      ["instagram", "failed"],
      ["linkedin", "approved"],
    ] as const) {
      await store.putDraft(draft({ channel, status, id: `d-${channel}` }));
      await approvals.recordPending({
        date: "2026-10-26",
        channel,
        draftId: `d-${channel}`,
        requestedAtMs: 1_000,
      });
    }
    await approvals.recordPending({
      date: "2026-10-26",
      channel: "x",
      draftId: "d-ghost",
      requestedAtMs: 1_000,
    });
    const { seen, post } = calls();
    const res = await deliverPendingApprovals({
      store,
      approvals,
      dates: ["2026-10-26"],
      post,
      env: { SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL: "C-general" },
    });
    expect(res.every((r) => !r.delivered)).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("never throws on a store failure: the error is a result entry", async () => {
    const store = new MemorySocialLedger();
    const approvals = new MemoryPendingApprovalStore();
    await approvals.recordPending({
      date: "2026-10-26",
      channel: "facebook",
      draftId: "draft-1",
      requestedAtMs: 1_000,
    });
    const throwingStore = {
      ...store,
      getDraft: async () => {
        throw new Error("store down");
      },
    } as any;
    const { post } = calls();
    const res = await deliverPendingApprovals({
      store: throwingStore,
      approvals,
      dates: ["2026-10-26"],
      post,
      env: { SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL: "C-general" },
    });
    expect(res[0].delivered).toBe(false);
    expect(res[0].error).toContain("store down");
  });
});
