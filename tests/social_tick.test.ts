import { describe, it, expect } from "vitest";
import { MemorySocialLedger } from "../src/agents/social/ledger";
import { MemoryPendingApprovalStore } from "../src/agents/social/approvals";
import { runSocialDailyTick } from "../src/agents/social/tick";
import { publishDueDrafts } from "../src/agents/socialAgent";
import { createMemoryDryRunSink } from "../src/agents/social/publisher";

// 2026-10-26 is a Monday; 13:00Z = 09:00 EDT (due). 2026-10-24 is Saturday.
const MON_0900 = Date.parse("2026-10-26T13:00:00Z");
const MON_0830 = Date.parse("2026-10-26T12:30:00Z");
const SAT_1000 = Date.parse("2026-10-24T14:00:00Z");
const ENABLED = { SOCIAL_POSTING_ENABLED: "1" };

function tickInput(overrides: Record<string, unknown> = {}) {
  return {
    env: ENABLED,
    tokens: {},
    nowMs: MON_0900,
    store: new MemorySocialLedger(),
    approvals: new MemoryPendingApprovalStore(),
    briefProvider: () => "Morning brief.",
    dryRunSink: createMemoryDryRunSink(),
    ...overrides,
  } as Parameters<typeof runSocialDailyTick>[0];
}

describe("runSocialDailyTick fire rules", () => {
  it("returns notDue and writes nothing before the posting time or on weekends", async () => {
    for (const nowMs of [MON_0830, SAT_1000]) {
      const input = tickInput({ nowMs });
      const res = await runSocialDailyTick(input);
      expect(res.status).toBe("notDue");
      expect(input.store.listDrafts("2026-10-26")).toEqual([]);
      expect(input.store.listDrafts("2026-10-24")).toEqual([]);
    }
  });

  it("returns postingDisabled and writes nothing when posting is off", async () => {
    const input = tickInput({ env: {} });
    const res = await runSocialDailyTick(input);
    expect(res.status).toBe("postingDisabled");
    expect(input.store.listDrafts("2026-10-26")).toEqual([]);
  });

  it("returns alreadyExists and builds nothing when drafts already exist today", async () => {
    const input = tickInput();
    const first = await runSocialDailyTick(input);
    expect(first.status).toBe("done");
    const second = await runSocialDailyTick(input);
    expect(second.status).toBe("alreadyExists");
    expect(input.store.listDrafts("2026-10-26")).toHaveLength(5);
  });

  it("returns noBrief and writes nothing for null, empty, or whitespace briefs", async () => {
    for (const briefProvider of [() => null, () => "", () => "   "]) {
      const input = tickInput({ briefProvider });
      const res = await runSocialDailyTick(input);
      expect(res.status).toBe("noBrief");
      expect(input.store.listDrafts("2026-10-26")).toEqual([]);
    }
  });
});

describe("runSocialDailyTick happy path (dry-run default)", () => {
  it("builds drafts and dry-run publishes autonomous ones; approval ones wait", async () => {
    const sink = createMemoryDryRunSink();
    const input = tickInput({ dryRunSink: sink });
    const res = await runSocialDailyTick(input);
    expect(res.status).toBe("done");
    expect(res.date).toBe("2026-10-26");
    expect(res.build?.status).toBe("drafts");
    expect(input.store.listDrafts("2026-10-26")).toHaveLength(5);
    // Autonomous channels posted via dry-run; approval channels await approval.
    expect(input.store.getDraft("2026-10-26", "threads")?.status).toBe("posted");
    expect(input.store.getDraft("2026-10-26", "x")?.status).toBe("posted");
    expect(input.store.getDraft("2026-10-26", "facebook")?.status).toBe("draft");
    expect(sink.records.map((r) => r.channel).sort()).toEqual(["threads", "x"]);
    const publish = res.publish!;
    expect(publish.results.find((r) => r.channel === "facebook")?.outcome).toBe("skipped");
    expect(publish.results.find((r) => r.channel === "threads")?.outcome).toBe("posted");
  });

  it("publishes an approved draft on a later tick once approved", async () => {
    const sink = createMemoryDryRunSink();
    const input = tickInput({ dryRunSink: sink });
    await runSocialDailyTick(input);
    // Approve the facebook draft directly in the ledger (approval flow).
    const fb = input.store.getDraft("2026-10-26", "facebook")!;
    input.store.putDraft({ ...fb, status: "approved", approval: { approver: "owner", approvedAtMs: 1 } });
    // A second tick is alreadyExists-guarded, so publish due drafts directly.
    const res = await publishDueDrafts({
      env: ENABLED,
      tokens: {},
      store: input.store,
      approvals: input.approvals,
      date: "2026-10-26",
      dryRunSink: sink,
      nowMs: MON_0900,
    });
    expect(res.results.find((r) => r.channel === "facebook")?.outcome).toBe("posted");
    expect(input.store.getDraft("2026-10-26", "facebook")?.status).toBe("posted");
  });

  it("fails live publishing closed when live is on but no tokens exist — no dry-run fallback", async () => {
    const sink = createMemoryDryRunSink();
    const transportCalls: string[] = [];
    const input = tickInput({
      env: { SOCIAL_POSTING_ENABLED: "1", SOCIAL_LIVE_PUBLISHING: "1" },
      dryRunSink: sink,
      transport: {
        async post(url: string) {
          transportCalls.push(url);
          return { status: 200, body: { data: { id: "x-1" } } };
        },
      },
    });
    const res = await runSocialDailyTick(input);
    expect(res.status).toBe("done");
    expect(sink.records).toEqual([]);
    expect(transportCalls).toEqual([]);
    const outcomes = new Map(res.publish!.results.map((r) => [r.channel, r.outcome]));
    expect(outcomes.get("threads")).toBe("error");
    expect(outcomes.get("x")).toBe("error");
    // Drafts were still built (build never fails on publish gating).
    expect(input.store.listDrafts("2026-10-26")).toHaveLength(5);
  });
});
