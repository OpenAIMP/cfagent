/**
 * #1077 Phase 5b slice 3: catch-up sweep inside the social goal executor.
 *
 * Pinned here:
 * - a firing publishes previously-approved-but-unposted drafts from
 *   prior dates (bounded 7-day lookback), through the existing
 *   publishDueDrafts path — never a second publish implementation;
 * - failed autonomous publishes from a prior date are retried on the
 *   next firing (the draft stays in its pre-publish status, so the
 *   sweep picks it up);
 * - unapproved approval drafts are NEVER published by catch-up (they
 *   are re-recorded pending and skipped, exactly like the day pass);
 * - posted/failed drafts are skipped; dates older than the lookback
 *   are never auto-published;
 * - posting disabled short-circuits everything, including catch-up;
 * - fired semantics: a firing counts when the day produced drafts OR
 *   catch-up published something; a firing with nothing to do stays
 *   not-fired (noBrief / noDrafts), so the goal stays due.
 */
import { describe, it, expect } from "vitest";
import { MemorySocialLedger } from "../src/agents/social/ledger";
import { MemoryPendingApprovalStore } from "../src/agents/social/approvals";
import {
  executeSocialGoal,
  priorDates,
  SOCIAL_CATCH_UP_LOOKBACK_DAYS,
} from "../src/agents/social/goalExecutor";
import { createMemoryDryRunSink } from "../src/agents/social/publisher";
import type { SocialDraft } from "../src/agents/social/draft";

const DAY = "2026-10-26"; // Monday
const DAY_MS = Date.parse("2026-10-26T13:00:00Z"); // 09:00 EDT
const ENV = {
  SOCIAL_POSTING_ENABLED: "1",
  SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
  SOCIAL_APPROVAL_CHANNELS: "facebook,instagram,linkedin",
};

function draft(overrides: Partial<SocialDraft> = {}): SocialDraft {
  return {
    id: "d-1",
    date: DAY,
    channel: "facebook",
    text: "Brief text.",
    status: "draft",
    createdAtMs: 1_000,
    originalLength: 11,
    truncated: false,
    ...overrides,
  } as SocialDraft;
}

function deps(overrides: Record<string, unknown> = {}) {
  const store = new MemorySocialLedger();
  const approvals = new MemoryPendingApprovalStore();
  const sink = createMemoryDryRunSink();
  return {
    store,
    approvals,
    sink,
    base: {
      env: ENV,
      tokens: {},
      store,
      approvals,
      briefProvider: () => "Brief text.",
      nowMs: DAY_MS,
      timeZone: "America/New_York",
      dryRunSink: sink,
      ...overrides,
    },
  };
}

describe("priorDates", () => {
  it("lists the 7 prior days, newest first, across a month boundary", () => {
    expect(priorDates("2026-11-02")).toEqual([
      "2026-11-01",
      "2026-10-31",
      "2026-10-30",
      "2026-10-29",
      "2026-10-28",
      "2026-10-27",
      "2026-10-26",
    ]);
    expect(SOCIAL_CATCH_UP_LOOKBACK_DAYS).toBe(7);
  });
});

describe("catch-up sweep", () => {
  it("publishes a prior date's approved draft and reports it in catchUp", async () => {
    const { store, approvals, base } = deps();
    await store.putDraft(draft({ date: "2026-10-23", status: "approved", id: "d-old" }));
    const res = await executeSocialGoal(base);
    expect(res.fired).toBe(true);
    if (!res.fired) throw new Error("expected fired");
    expect(res.catchUp.map((c) => c.date)).toContain("2026-10-23");
    const entry = res.catchUp.find((c) => c.date === "2026-10-23")!;
    expect(entry.results.some((r) => r.channel === "facebook" && r.outcome === "posted")).toBe(true);
    expect((await store.getDraft("2026-10-23", "facebook"))?.status).toBe("dry-run-posted");
    expect(await approvals.listPending("2026-10-23")).toHaveLength(0);
  });

  it("retries a prior date's failed autonomous publish", async () => {
    const { store, base } = deps();
    // Autonomous channel (x) draft left in pre-publish status by an
    // earlier failed publish: the sweep must attempt it again.
    await store.putDraft(draft({ date: "2026-10-23", channel: "x", status: "draft", id: "d-x" }));
    const res = await executeSocialGoal(base);
    expect(res.fired).toBe(true);
    if (!res.fired) throw new Error("expected fired");
    expect((await store.getDraft("2026-10-23", "x"))?.status).toBe("dry-run-posted");
  });

  it("never publishes unapproved approval drafts, posted drafts, or failed drafts", async () => {
    const { store, base } = deps({ briefProvider: () => null });
    await store.putDraft(draft({ date: "2026-10-23", status: "draft", id: "d-unapproved" }));
    await store.putDraft(draft({ date: "2026-10-22", status: "posted", id: "d-posted" }));
    await store.putDraft(draft({ date: "2026-10-21", status: "failed", id: "d-failed" }));
    const res = await executeSocialGoal(base);
    expect(res.fired).toBe(false);
    if (res.fired) throw new Error("expected not fired");
    expect((await store.getDraft("2026-10-23", "facebook"))?.status).toBe("draft");
    expect((await store.getDraft("2026-10-22", "facebook"))?.status).toBe("posted");
    expect((await store.getDraft("2026-10-21", "facebook"))?.status).toBe("failed");
  });

  it("never auto-publishes drafts older than the lookback", async () => {
    const { store, base } = deps({ briefProvider: () => null });
    await store.putDraft(draft({ date: "2026-10-18", status: "approved", id: "d-ancient" }));
    const res = await executeSocialGoal(base);
    expect(res.fired).toBe(false);
    expect((await store.getDraft("2026-10-18", "facebook"))?.status).toBe("approved");
  });

  it("posting disabled short-circuits catch-up too", async () => {
    const { store, base } = deps({
      briefProvider: () => null,
      env: { ...ENV, SOCIAL_POSTING_ENABLED: "0" },
    });
    await store.putDraft(draft({ date: "2026-10-23", status: "approved", id: "d-old" }));
    const res = await executeSocialGoal(base);
    expect(res).toEqual({ fired: false, reason: "postingDisabled" });
    expect((await store.getDraft("2026-10-23", "facebook"))?.status).toBe("approved");
  });

  it("a catch-up-only firing counts (no brief today, backlog published)", async () => {
    const { store, base } = deps({ briefProvider: () => null });
    await store.putDraft(draft({ date: "2026-10-23", status: "approved", id: "d-old" }));
    const res = await executeSocialGoal(base);
    expect(res.fired).toBe(true);
    if (!res.fired) throw new Error("expected fired");
    expect(res.date).toBe(DAY);
    expect(res.catchUp).toHaveLength(1);
  });

  it("a firing with nothing to do stays not-fired (noBrief, goal stays due)", async () => {
    const { base } = deps({ briefProvider: () => null });
    const res = await executeSocialGoal(base);
    expect(res).toEqual({ fired: false, reason: "noBrief" });
  });

  it("a day-build firing still counts even when catch-up finds nothing", async () => {
    const { base } = deps();
    const res = await executeSocialGoal(base);
    expect(res.fired).toBe(true);
    if (!res.fired) throw new Error("expected fired");
    expect(res.catchUp).toHaveLength(0);
  });

  it("catch-up errors are reported per date, not thrown", async () => {
    const { store, base } = deps({ briefProvider: () => null });
    await store.putDraft(draft({ date: "2026-10-23", status: "approved", id: "d-old" }));
    // Live requested with no token: the catch-up publish errors per channel.
    const live = {
      ...base,
      env: { ...ENV, SOCIAL_LIVE_PUBLISHING: "1" },
    };
    const res = await executeSocialGoal(live);
    expect(res.fired).toBe(false);
    expect((await store.getDraft("2026-10-23", "facebook"))?.status).toBe("approved");
  });
});
