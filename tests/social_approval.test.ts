import { describe, it, expect } from "vitest";
import { MemorySocialLedger } from "../src/agents/social/ledger";
import {
  MemoryPendingApprovalStore,
  approveDraft,
  rejectDraft,
} from "../src/agents/social/approvals";
import { publishDueDrafts } from "../src/agents/socialAgent";
import { createMemoryDryRunSink } from "../src/agents/social/publisher";
import type { SocialDraft } from "../src/agents/social/draft";

const DATE = "2026-10-26";
const ENABLED = { SOCIAL_POSTING_ENABLED: "1" };

function mkDraft(channel: string, status: SocialDraft["status"]): SocialDraft {
  return {
    id: `draft-${channel}`,
    date: DATE,
    channel: channel as SocialDraft["channel"],
    text: `post for ${channel}`,
    status,
    createdAtMs: 0,
    originalLength: 10,
    truncated: false,
  };
}

function ledgerWith(...drafts: SocialDraft[]) {
  const store = new MemorySocialLedger();
  for (const d of drafts) store.putDraft(d);
  return store;
}

describe("approveDraft / rejectDraft", () => {
  it("approves a draft, records approver + time, and clears the pending entry", () => {
    const store = ledgerWith(mkDraft("facebook", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    approvals.recordPending({ date: DATE, channel: "facebook", draftId: "draft-facebook", requestedAtMs: 1 });
    const res = approveDraft(store, approvals, DATE, "facebook", "owner", 999);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.draft.status).toBe("approved");
      expect(res.draft.approval).toEqual({ approver: "owner", approvedAtMs: 999 });
    }
    expect(store.getDraft(DATE, "facebook")?.status).toBe("approved");
    expect(approvals.listPending(DATE)).toEqual([]);
  });

  it("refuses approval when no draft exists, when already posted, or when rejected", () => {
    const store = ledgerWith(mkDraft("facebook", "posted"), mkDraft("instagram", "failed"));
    const approvals = new MemoryPendingApprovalStore();
    expect(approveDraft(store, approvals, DATE, "linkedin", "owner", 1).ok).toBe(false);
    expect(approveDraft(store, approvals, DATE, "facebook", "owner", 1).ok).toBe(false);
    expect(approveDraft(store, approvals, DATE, "instagram", "owner", 1).ok).toBe(false);
  });

  it("refreshing approval on an already-approved draft updates the record", () => {
    const store = ledgerWith(mkDraft("facebook", "approved"));
    const approvals = new MemoryPendingApprovalStore();
    const res = approveDraft(store, approvals, DATE, "facebook", "second-owner", 555);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.draft.approval).toEqual({ approver: "second-owner", approvedAtMs: 555 });
  });

  it("rejects a draft: status failed, record retained, pending cleared", () => {
    const store = ledgerWith(mkDraft("facebook", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    approvals.recordPending({ date: DATE, channel: "facebook", draftId: "draft-facebook", requestedAtMs: 1 });
    const res = rejectDraft(store, approvals, DATE, "facebook");
    expect(res.ok).toBe(true);
    const kept = store.getDraft(DATE, "facebook");
    expect(kept).toBeDefined();
    expect(kept?.status).toBe("failed");
    expect(approvals.listPending(DATE)).toEqual([]);
  });

  it("refuses rejection when no draft exists or when already posted; re-reject is idempotent", () => {
    const store = ledgerWith(mkDraft("facebook", "posted"), mkDraft("instagram", "failed"));
    const approvals = new MemoryPendingApprovalStore();
    expect(rejectDraft(store, approvals, DATE, "linkedin").ok).toBe(false);
    expect(rejectDraft(store, approvals, DATE, "facebook").ok).toBe(false);
    expect(rejectDraft(store, approvals, DATE, "instagram").ok).toBe(true);
    expect(store.getDraft(DATE, "instagram")?.status).toBe("failed");
  });
});

describe("publishDueDrafts gating", () => {
  it("never publishes an unapproved approval-channel draft, and records it pending", async () => {
    const store = ledgerWith(mkDraft("facebook", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    const sink = createMemoryDryRunSink();
    const res = await publishDueDrafts({
      env: ENABLED,
      tokens: {},
      store,
      approvals,
      date: DATE,
      dryRunSink: sink,
      nowMs: 100,
    });
    expect(res.status).toBe("done");
    const entry = res.results.find((r) => r.channel === "facebook");
    expect(entry?.outcome).toBe("skipped");
    expect(entry?.reason).toMatch(/awaiting approval/i);
    expect(store.getDraft(DATE, "facebook")?.status).toBe("draft");
    expect(sink.records).toEqual([]);
    expect(approvals.listPending(DATE).map((p) => p.channel)).toEqual(["facebook"]);
  });

  it("publishes an approved approval-channel draft (dry-run by default)", async () => {
    const store = ledgerWith(mkDraft("facebook", "approved"));
    const approvals = new MemoryPendingApprovalStore();
    approvals.recordPending({ date: DATE, channel: "facebook", draftId: "draft-facebook", requestedAtMs: 1 });
    const sink = createMemoryDryRunSink();
    const res = await publishDueDrafts({
      env: ENABLED,
      tokens: {},
      store,
      approvals,
      date: DATE,
      dryRunSink: sink,
      nowMs: 100,
    });
    const entry = res.results.find((r) => r.channel === "facebook");
    expect(entry?.outcome).toBe("posted");
    expect(entry?.platformPostId).toBe("dry-run:draft-facebook");
    expect(store.getDraft(DATE, "facebook")?.status).toBe("posted");
    expect(sink.records).toHaveLength(1);
    expect(approvals.listPending(DATE)).toEqual([]);
  });

  it("publishes autonomous drafts, approved or not — approval never blocks them", async () => {
    const store = ledgerWith(mkDraft("threads", "draft"), mkDraft("x", "approved"));
    const approvals = new MemoryPendingApprovalStore();
    const sink = createMemoryDryRunSink();
    const res = await publishDueDrafts({
      env: ENABLED,
      tokens: {},
      store,
      approvals,
      date: DATE,
      dryRunSink: sink,
      nowMs: 100,
    });
    expect(res.results.filter((r) => r.outcome === "posted").map((r) => r.channel).sort()).toEqual([
      "threads",
      "x",
    ]);
    expect(sink.records).toHaveLength(2);
  });

  it("never republishes posted or failed drafts", async () => {
    const store = ledgerWith(mkDraft("threads", "posted"), mkDraft("x", "failed"));
    const approvals = new MemoryPendingApprovalStore();
    const sink = createMemoryDryRunSink();
    const res = await publishDueDrafts({
      env: ENABLED,
      tokens: {},
      store,
      approvals,
      date: DATE,
      dryRunSink: sink,
      nowMs: 100,
    });
    expect(res.results.every((r) => r.outcome === "skipped")).toBe(true);
    expect(sink.records).toEqual([]);
  });

  it("returns postingDisabled and writes nothing when posting is off", async () => {
    const store = ledgerWith(mkDraft("threads", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    const sink = createMemoryDryRunSink();
    const res = await publishDueDrafts({
      env: {},
      tokens: {},
      store,
      approvals,
      date: DATE,
      dryRunSink: sink,
      nowMs: 100,
    });
    expect(res.status).toBe("postingDisabled");
    expect(res.results).toEqual([]);
    expect(store.getDraft(DATE, "threads")?.status).toBe("draft");
    expect(sink.records).toEqual([]);
  });

  it("isolates per-channel failures: one channel erroring never blocks the others", async () => {
    const store = ledgerWith(mkDraft("threads", "draft"), mkDraft("x", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    const sink = createMemoryDryRunSink();
    const transport = {
      async post(url: string) {
        if (url.includes("twitter.com")) throw new Error("x is down");
        return { status: 200, body: { id: "threads-live-1" } };
      },
    };
    const res = await publishDueDrafts({
      env: { SOCIAL_POSTING_ENABLED: "1", SOCIAL_LIVE_PUBLISHING: "1" },
      tokens: { X_ACCESS_TOKEN: "test-token", THREADS_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      date: DATE,
      transport,
      dryRunSink: sink,
      nowMs: 100,
    });
    const byChannel = new Map(res.results.map((r) => [r.channel, r]));
    expect(byChannel.get("threads")?.outcome).toBe("posted");
    expect(byChannel.get("x")?.outcome).toBe("error");
    // The failed draft stays publishable for a later retry; it is not
    // silently marked failed.
    expect(store.getDraft(DATE, "x")?.status).toBe("draft");
    expect(store.getDraft(DATE, "threads")?.status).toBe("posted");
  });

  it("isolates live failure from dry-run success across channels", async () => {
    const store = ledgerWith(mkDraft("threads", "draft"), mkDraft("x", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    const sink = createMemoryDryRunSink();
    // Live requested, but only X has a token: threads fails closed
    // (unavailable) while X publishes live via the fake transport.
    const transport = {
      calls: 0,
      async post() {
        transport.calls += 1;
        return { status: 200, body: { data: { id: "x-live-1" } } };
      },
    };
    const res = await publishDueDrafts({
      env: { SOCIAL_POSTING_ENABLED: "1", SOCIAL_LIVE_PUBLISHING: "1" },
      tokens: { X_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      date: DATE,
      transport,
      dryRunSink: sink,
      nowMs: 100,
    });
    const byChannel = new Map(res.results.map((r) => [r.channel, r]));
    expect(byChannel.get("x")?.outcome).toBe("posted");
    expect(byChannel.get("x")?.platformPostId).toBe("x-live-1");
    expect(byChannel.get("threads")?.outcome).toBe("error");
    expect(store.getDraft(DATE, "x")?.status).toBe("posted");
    expect(store.getDraft(DATE, "threads")?.status).toBe("draft");
    expect(sink.records).toEqual([]);
  });

  it("records an error entry, never a publish, for an unknown-channel draft", async () => {
    const store = new MemorySocialLedger();
    const weird = {
      id: "draft-weird",
      date: DATE,
      channel: "tiktok",
      text: "hi",
      status: "draft",
      createdAtMs: 0,
      originalLength: 2,
      truncated: false,
    } as unknown as SocialDraft;
    store.putDraft(weird);
    const approvals = new MemoryPendingApprovalStore();
    const sink = createMemoryDryRunSink();
    const res = await publishDueDrafts({
      env: ENABLED,
      tokens: {},
      store,
      approvals,
      date: DATE,
      dryRunSink: sink,
      nowMs: 100,
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].outcome).toBe("error");
    expect(sink.records).toEqual([]);
  });
});
