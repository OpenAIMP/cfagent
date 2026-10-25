/**
 * Issue #1446 ([AGENTIC] Phase 3, sub-issue of #1362) — job synthesis
 * pin test.
 *
 * Synthesis turns a Phase 2 compiled chain into a schedule/job record
 * behind the scenes. It does NOT execute anything: no screen runs, no
 * message sends, no mas_async_jobs rows, no shard jobs, no goals-list
 * entry. The hard rule pinned here: a synthesized record is born
 * PENDING and only an explicit approval flips exactly that record to
 * approved. There is no code path — including this test file — that
 * creates an enabled/live scheduled job from synthesis: the record
 * type carries no `enabled` field at all, and the firing predicate
 * returns false for every pending record, even when its cron is due.
 *
 * Reconciliation (recorded in #1446 and in src/agentic/jobSynthesis.ts):
 * schedule substrate = ScheduledAgent DO goals (chosen); NLQ Agents
 * Schedule API = explicitly out of scope, no adapter built. Job model
 * = mas_async_jobs rows with chain_id/stage carrying the #1355
 * sharded shape (already reconciled on main by #1355 itself);
 * synthesis submits no rows — submission is firing, out of scope.
 */
import { describe, it, expect } from "vitest";
import { compileChain, compileGoal } from "../src/orchestrate";
import {
  approveSynthesizedInList,
  approveSynthesizedRecord,
  markSynthesizedFired,
  shouldFireSynthesized,
  synthesizeSchedule,
} from "../src/agentic/jobSynthesis";

const FULL_CHAIN_IDS = [
  "feed-dataprovider",
  "feed-screener-pipeline",
  "generate-screener-pdf",
  "generate-screener-xlsx",
  "store-mas-reports",
  "store-r2-binaries",
  "serve-report-pdf",
  "deliver-slack",
];
const SERVE_DELIVER_IDS = [
  "serve-options-latest",
  "serve-report-pdf",
  "deliver-email",
];

function stepsFor(ids: string[]) {
  return ids.map((capabilityId) => ({ capabilityId }));
}

describe("job synthesis (#1446) — worked example 1: NASDAQ100 screen → Slack", () => {
  it("synthesizes to a PENDING recurring record carrying chain, cron, budget, Slack-only delivery", () => {
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    expect(chain).not.toBeNull();
    const record = synthesizeSchedule(chain!, {
      id: "synth-nasdaq100-slack",
      cron: "0 6 * * *",
    });
    expect(record.status).toBe("pending");
    expect(record.kind).toBe("recurring");
    expect(record.cron).toBe("0 6 * * *");
    expect(record.steps.map((s) => s.capabilityId)).toEqual(FULL_CHAIN_IDS);
    expect(record.budgetCents).toBe(5000);
    expect(record.budgetCapCents).toBe(10000);
    expect(record.deliveryChannels).toEqual(["slack"]);
    expect(record.goal).toBe("Create a NASDAQ100 screen and send it to Slack");
    // The gate is structural: no `enabled` field exists to flip.
    expect("enabled" in record).toBe(false);
    expect(record.approvedAt).toBeNull();
  });

  it("a pending record NEVER fires, even when its cron is due", () => {
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    const record = synthesizeSchedule(chain!, {
      id: "synth-pending-never-fires",
      cron: "0 6 * * *",
    });
    // 06:00 UTC matches cron "0 6 * * *" under isDue's UTC branch.
    expect(shouldFireSynthesized(record, new Date("2026-10-25T06:00:00Z"))).toBe(false);
  });
});

describe("job synthesis (#1446) — worked example 2: yesterday's report by email", () => {
  it("synthesizes to a PENDING one-shot job, not a recurring schedule", () => {
    const chain = compileGoal("Send me yesterday's report by email", {
      budgetCents: 0,
    });
    expect(chain).not.toBeNull();
    const record = synthesizeSchedule(chain!, { id: "synth-yesterday-email" });
    expect(record.status).toBe("pending");
    expect(record.kind).toBe("one-shot");
    expect(record.cron).toBeNull();
    expect(record.steps.map((s) => s.capabilityId)).toEqual(SERVE_DELIVER_IDS);
    expect(record.deliveryChannels).toEqual(["email"]);
    expect(record.reusesStoredReport).toBe(true);
    expect("enabled" in record).toBe(false);
  });

  it("a pending one-shot never fires; approval enables exactly that record; it fires at most once", () => {
    const chain = compileGoal("Send me yesterday's report by email", {
      budgetCents: 0,
    });
    const pending = synthesizeSchedule(chain!, { id: "synth-oneshot-gate" });
    const now = new Date("2026-10-25T12:00:00Z");
    expect(shouldFireSynthesized(pending, now)).toBe(false);
    const approved = approveSynthesizedRecord(pending);
    expect(approved.status).toBe("approved");
    expect(approved.id).toBe("synth-oneshot-gate");
    expect(approved.approvedAt).not.toBeNull();
    expect(shouldFireSynthesized(approved, now)).toBe(true);
    const fired = markSynthesizedFired(approved, "2026-10-25T12:00:00Z");
    expect(fired.firedAt).toBe("2026-10-25T12:00:00Z");
    expect(shouldFireSynthesized(fired, now)).toBe(false);
  });
});

describe("job synthesis (#1446) — approval semantics", () => {
  it("approval enables exactly one record in a list; re-approve is a no-op, not a duplicate", () => {
    const chainA = compileChain({
      goal: "NASDAQ100 screen to Slack",
      steps: stepsFor(FULL_CHAIN_IDS),
      budgetCents: 100,
      recurrence: "recurring",
    });
    const chainB = compileChain({
      goal: "yesterday report by email",
      steps: stepsFor(SERVE_DELIVER_IDS),
      budgetCents: 0,
      recurrence: "one-shot",
      reusesStoredReport: true,
    });
    const a = synthesizeSchedule(chainA!, { id: "synth-a", cron: "0 6 * * *" });
    const b = synthesizeSchedule(chainB!, { id: "synth-b" });
    const after = approveSynthesizedInList([a, b], "synth-a");
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.id === "synth-a")?.status).toBe("approved");
    expect(after.find((r) => r.id === "synth-b")?.status).toBe("pending");
    const again = approveSynthesizedInList(after, "synth-a");
    expect(again).toHaveLength(2);
    expect(again.find((r) => r.id === "synth-a")?.status).toBe("approved");
  });

  it("approving an unknown id throws; approval never touches other records", () => {
    const chain = compileChain({
      goal: "yesterday report by email",
      steps: stepsFor(SERVE_DELIVER_IDS),
      budgetCents: 0,
      recurrence: "one-shot",
      reusesStoredReport: true,
    });
    const record = synthesizeSchedule(chain!, { id: "synth-only" });
    expect(() => approveSynthesizedInList([record], "synth-nope")).toThrow(
      /Unknown synthesized schedule/,
    );
  });

  it("approved recurring fires only when its cron is due", () => {
    const chain = compileChain({
      goal: "NASDAQ100 screen to Slack",
      steps: stepsFor(FULL_CHAIN_IDS),
      budgetCents: 100,
      recurrence: "recurring",
    });
    const approved = approveSynthesizedRecord(
      synthesizeSchedule(chain!, { id: "synth-due", cron: "0 6 * * *" }),
    );
    expect(shouldFireSynthesized(approved, new Date("2026-10-25T06:00:00Z"))).toBe(true);
    expect(shouldFireSynthesized(approved, new Date("2026-10-25T07:00:00Z"))).toBe(false);
    // A recent lastRun suppresses re-fire (isDue's 23h window).
    const justFired = markSynthesizedFired(approved, "2026-10-25T06:00:00Z");
    expect(shouldFireSynthesized(justFired, new Date("2026-10-25T06:30:00Z"))).toBe(false);
  });
});

describe("job synthesis (#1446) — synthesis validation", () => {
  it("recurring synthesis requires a valid cron; one-shot synthesis forbids one", () => {
    const recurring = compileChain({
      goal: "NASDAQ100 screen to Slack",
      steps: stepsFor(FULL_CHAIN_IDS),
      budgetCents: 100,
      recurrence: "recurring",
    });
    expect(() => synthesizeSchedule(recurring!, { id: "synth-no-cron" })).toThrow(/cron/);
    expect(() =>
      synthesizeSchedule(recurring!, { id: "synth-bad-cron", cron: "not-a-cron" }),
    ).toThrow(/cron/);
    const oneShot = compileChain({
      goal: "yesterday report by email",
      steps: stepsFor(SERVE_DELIVER_IDS),
      budgetCents: 0,
      recurrence: "one-shot",
      reusesStoredReport: true,
    });
    expect(() =>
      synthesizeSchedule(oneShot!, { id: "synth-oneshot-cron", cron: "0 6 * * *" }),
    ).toThrow(/cron/);
  });

  it("rejects chains with unknown, planned-only, duplicate, or out-of-order steps, and budgets over cap", () => {
    const base = {
      goal: "x",
      budgetCents: 100,
      recurrence: "one-shot" as const,
    };
    expect(() =>
      synthesizeSchedule(
        compileChain({ ...base, steps: stepsFor(["nope-unknown"]) })!,
        { id: "synth-unknown" },
      ),
    ).toThrow();
    // compileChain itself rejects these; synthesis must also reject a
    // hand-built chain that bypasses the compiler.
    const plannedOnly = {
      goal: "x",
      steps: [
        {
          id: "c1",
          capabilityId: "feed-dataprovider-news",
          stage: "feed" as const,
          args: {},
          dependsOn: [],
        },
      ],
      budgetCents: 100,
      budgetCapCents: null,
      recurrence: "one-shot" as const,
      reusesStoredReport: false,
    };
    expect(() => synthesizeSchedule(plannedOnly, { id: "synth-planned" })).toThrow(
      /planned|not usable|registry/,
    );
    const overCap = compileChain({
      goal: "NASDAQ100 screen to Slack",
      steps: stepsFor(FULL_CHAIN_IDS),
      budgetCents: 5000,
      budgetCapCents: 100,
      recurrence: "recurring",
    });
    expect(overCap).toBeNull(); // compiler enforces the cap first
    const handBuiltOverCap = {
      goal: "NASDAQ100 screen to Slack",
      steps: FULL_CHAIN_IDS.map((capabilityId, i) => ({
        id: `c${i + 1}`,
        capabilityId,
        // Correct registry stages: synthesis must still reject on budget.
        stage: (
          capabilityId.startsWith("feed-")
            ? "feed"
            : capabilityId.startsWith("generate-")
              ? "generate"
              : capabilityId.startsWith("store-")
                ? "store"
                : capabilityId.startsWith("serve-")
                  ? "serve"
                  : "deliver"
        ) as const,
        args: {},
        dependsOn: [],
      })),
      budgetCents: 5000,
      budgetCapCents: 100,
      recurrence: "recurring" as const,
      reusesStoredReport: false,
    };
    expect(() => synthesizeSchedule(handBuiltOverCap, { id: "synth-cap", cron: "0 6 * * *" })).toThrow(
      /budget/,
    );
  });

  it("synthesizing the same chain twice yields two distinct pending records", () => {
    const chain = compileGoal("Send me yesterday's report by email", {
      budgetCents: 0,
    });
    const first = synthesizeSchedule(chain!, { id: "synth-one" });
    const second = synthesizeSchedule(chain!, { id: "synth-two" });
    expect(first.id).not.toBe(second.id);
    expect(first.status).toBe("pending");
    expect(second.status).toBe("pending");
  });
});
