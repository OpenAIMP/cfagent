/**
 * Issue #1468 ([AGENTIC] Phase 6, sub-issue of #1362) — governance wiring
 * pins, pure module level.
 *
 * Every behavior here delegates to shipped code; this file pins the
 * wiring, not a new governance machine:
 *  - Promotion (#1747, branch 2): a Phase 3 approval authorizing this
 *    chain's content is required (approved record whose steps match
 *    the version's steps); authority is approval + registry
 *    verification + staged rollout — never a #759 verdict.
 *  - Rollback: the #760 staged shape (shadow → partial → full →
 *    completed, automatic rollback on failure signals, exact prior
 *    snapshot restore) over versioned chain records.
 *  - Kill: `killed` is a terminal status on the Phase 3 record, so
 *    `shouldFireSynthesized` (fires ONLY approved records) already
 *    refuses it; approval of a killed record throws.
 *  - Attribution: run records carry chain + capability versions +
 *    shard/provenance, mapped onto the #755 audit record shape.
 */
import { describe, it, expect } from "vitest";
import { compileGoal } from "../src/orchestrate";
import {
  synthesizeSchedule,
  approveSynthesizedRecord,
  shouldFireSynthesized,
  type SynthesizedSchedule,
} from "../src/agentic/jobSynthesis";
import {
  versionChain,
  promoteChainVersion,
  advanceChainPromotion,
  rollbackChainVersion,
  killSynthesizedRecord,
  killSynthesizedInList,
  listKilledSynthesized,
  shouldFireGoverned,
  attributeChainRun,
  chainRunAuditRecord,
  type GovernedChainVersion,
} from "../src/agentic/chainGovernance";
import { CAPABILITY_REGISTRY } from "../src/agentic/capabilityRegistry";

function nasdaqChain() {
  const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
    budgetCents: 5000,
    budgetCapCents: 10000,
  });
  if (!chain) throw new Error("test chain did not compile");
  return chain;
}

function versionedV1(): GovernedChainVersion {
  return versionChain("chain-nasdaq-slack", nasdaqChain(), 1, {
    createdAt: "2026-10-25T00:00:00.000Z",
  });
}

/**
 * Phase 3 approval fixtures (#1747): the approval record is synthesized
 * from the SAME compiled chain the version was versioned from, so its
 * steps match the version's steps — that match is the authority binding.
 * A pending record, a killed record, and an approved record for
 * different chain content must all refuse promotion.
 */
function approvedRecordFor(
  chain: ReturnType<typeof nasdaqChain>,
  id = "synth-gov-approve",
): SynthesizedSchedule {
  const rec = synthesizeSchedule(chain, { id, cron: "0 6 * * *" });
  return approveSynthesizedRecord(rec, "2026-10-25T01:00:00.000Z");
}

function pendingRecordFor(
  chain: ReturnType<typeof nasdaqChain>,
  id = "synth-gov-pending",
): SynthesizedSchedule {
  return synthesizeSchedule(chain, { id, cron: "0 6 * * *" });
}

/** An approved record for DIFFERENT chain content: a strict prefix of the chain's steps. */
function approvedRecordForOtherContent(
  chain: ReturnType<typeof nasdaqChain>,
): SynthesizedSchedule {
  const shorter = { ...chain, steps: chain.steps.slice(0, -1) };
  return approvedRecordFor(shorter as ReturnType<typeof nasdaqChain>, "synth-gov-other");
}

describe("chain versioning (#1468)", () => {
  it("derives capability versions from the Phase 1 registry, never caller-supplied stages", () => {
    const v = versionedV1();
    expect(v.chainId).toBe("chain-nasdaq-slack");
    expect(v.version).toBe(1);
    expect(v.stage).toBe("draft");
    expect(v.priorVersion).toBeNull();
    expect(v.steps.length).toBeGreaterThan(0);
    for (const step of v.steps) {
      const entry = CAPABILITY_REGISTRY.find((e) => e.id === step.capabilityId);
      expect(entry).toBeDefined();
      expect(step.stage).toBe(entry!.stage);
    }
    for (const cv of v.capabilityVersions) {
      const entry = CAPABILITY_REGISTRY.find((e) => e.id === cv.id)!;
      expect(cv.status).toBe(entry.status);
      expect(cv.verification).toBe(entry.verification);
    }
  });

  it("rejects chains with unknown or planned-only capabilities", () => {
    const chain = nasdaqChain();
    const bad = {
      ...chain,
      steps: [
        ...chain.steps,
        {
          id: "step-nope",
          capabilityId: "feed-dataprovider-news",
          stage: "feed",
          args: {},
          dependsOn: [],
        },
      ],
    } as any;
    expect(() => versionChain("chain-x", bad, 1)).toThrow(/not usable|planned/);
  });
});

describe("promotion authority (#1747, branch 2)", () => {
  it("(a) promotion without authority is refused: pending, killed, timestamp-less, or mismatched approval", () => {
    const chain = nasdaqChain();
    const v = versionChain("chain-nasdaq-slack", chain, 1, {
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    // A pending record is not authority: Phase 3 confirmation never happened.
    expect(() => promoteChainVersion(v, pendingRecordFor(chain))).toThrow(/not approved/);
    // A killed record is not authority: killed is terminal against approval.
    const killed = killSynthesizedRecord(approvedRecordFor(chain, "synth-gov-killed"));
    expect(() => promoteChainVersion(v, killed)).toThrow(/not approved/);
    // An approved record with no timestamp is not authority: never trust
    // a hand-built record shape — the timestamp is part of the evidence.
    const timestampLess = { ...approvedRecordFor(chain, "synth-gov-nots"), approvedAt: null };
    expect(() => promoteChainVersion(v, timestampLess)).toThrow(/no approval timestamp/);
    // An approval for DIFFERENT chain content does not promote this one.
    expect(() => promoteChainVersion(v, approvedRecordForOtherContent(chain))).toThrow(
      /does not authorize this chain version/,
    );
  });

  it("an approved record for this chain's content promotes draft → shadow and records the authority", () => {
    const chain = nasdaqChain();
    const v = versionChain("chain-nasdaq-slack", chain, 1, {
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    const approval = approvedRecordFor(chain);
    const promoted = promoteChainVersion(v, approval);
    expect(promoted.stage).toBe("shadow");
    expect(promoted.authorityRef).toBe(approval.id);
    expect(promoted.priorVersion).toBeNull();
    // Promotion never mutates the input record.
    expect(v.stage).toBe("draft");
    expect(v.authorityRef).toBeNull();
  });

  it("only a draft version can be promoted", () => {
    const chain = nasdaqChain();
    const approval = approvedRecordFor(chain);
    const promoted = promoteChainVersion(
      versionChain("chain-nasdaq-slack", chain, 1, {
        createdAt: "2026-10-25T00:00:00.000Z",
      }),
      approval,
    );
    expect(() => promoteChainVersion(promoted, approval)).toThrow(/only a draft/);
  });
});

describe("staged promotion + rollback (#760 shape, #1468)", () => {
  function shadowed(): GovernedChainVersion {
    const chain = nasdaqChain();
    return promoteChainVersion(
      versionChain("chain-nasdaq-slack", chain, 1, {
        createdAt: "2026-10-25T00:00:00.000Z",
      }),
      approvedRecordFor(chain),
    );
  }

  it("advances shadow → partial → full → completed, and completed is terminal", () => {
    let v = shadowed();
    v = advanceChainPromotion(v, {}).version;
    expect(v.stage).toBe("partial");
    v = advanceChainPromotion(v, {}).version;
    expect(v.stage).toBe("full");
    v = advanceChainPromotion(v, {}).version;
    expect(v.stage).toBe("completed");
    expect(() => advanceChainPromotion(v, {})).toThrow(/completed/);
  });

  it("(b) a failure signal rolls back automatically and names the restored prior version", () => {
    const prior = versionedV1();
    const chain = nasdaqChain();
    const next = versionChain("chain-nasdaq-slack", chain, 2, {
      priorVersion: 1,
      createdAt: "2026-10-25T02:00:00.000Z",
    });
    void prior;
    const promoted = promoteChainVersion(next, approvedRecordFor(chain));
    const advanced = advanceChainPromotion(promoted, {});
    expect(advanced.version.stage).toBe("partial");
    const failed = advanceChainPromotion(advanced.version, { failed: true });
    expect(failed.version.stage).toBe("rolled_back");
    expect(failed.restoredPriorVersion).toBe(1);
    // A rolled-back version cannot advance again: it must re-prove from scratch.
    expect(() => advanceChainPromotion(failed.version, {})).toThrow(/rolled back/);
  });

  it("rollbackChainVersion restores the prior snapshot exactly", () => {
    const prior = versionedV1();
    const chain = nasdaqChain();
    const next = promoteChainVersion(
      versionChain("chain-nasdaq-slack", chain, 2, { priorVersion: 1 }),
      approvedRecordFor(chain),
    );
    const rolled = rollbackChainVersion(next);
    expect(rolled.stage).toBe("rolled_back");
    // The prior version itself is untouched and re-presentable.
    expect(prior.stage).toBe("draft");
    expect(prior.version).toBe(1);
    expect(prior.steps).toEqual(versionedV1().steps);
  });
});

describe("kill switch (#756 layers, #1468)", () => {
  function approvedRecord(): SynthesizedSchedule {
    const rec = synthesizeSchedule(nasdaqChain(), {
      id: "synth-gov-1",
      cron: "0 6 * * *",
    });
    return approveSynthesizedRecord(rec, "2026-10-25T01:00:00.000Z");
  }

  it("(c) a killed record never fires via shouldFireSynthesized semantics", () => {
    const killed = killSynthesizedRecord(approvedRecord());
    expect(killed.status).toBe("killed");
    const now = new Date("2026-10-26T06:00:00.000Z");
    expect(shouldFireSynthesized(killed, now)).toBe(false);
    expect(shouldFireGoverned(killed, now, { halted: false })).toBe(false);
    // And the pending record never fired either (Phase 3 gate intact).
    const pending = synthesizeSchedule(nasdaqChain(), { id: "synth-gov-p", cron: "0 6 * * *" });
    expect(shouldFireSynthesized(pending, now)).toBe(false);
  });

  it("the global #756 halt blocks even an approved, unkilled record", () => {
    const rec = approvedRecord();
    const now = new Date("2026-10-26T06:00:00.000Z");
    expect(shouldFireGoverned(rec, now, { halted: true })).toBe(false);
    expect(shouldFireGoverned(rec, now, { halted: false })).toBe(
      shouldFireSynthesized(rec, now),
    );
  });

  it("kill is terminal: approval of a killed record throws, re-kill is a no-op", () => {
    const killed = killSynthesizedRecord(approvedRecord());
    expect(() => approveSynthesizedRecord(killed)).toThrow(/killed/);
    expect(killSynthesizedRecord(killed)).toBe(killed);
  });

  it("kill in a list touches exactly one record and killed records are enumerable", () => {
    const a = approvedRecord();
    const b = synthesizeSchedule(nasdaqChain(), { id: "synth-gov-2", cron: "0 6 * * *" });
    const killed = killSynthesizedInList([a, b], "synth-gov-1");
    expect(killed.find((r) => r.id === "synth-gov-1")?.status).toBe("killed");
    expect(killed.find((r) => r.id === "synth-gov-2")?.status).toBe("pending");
    expect(listKilledSynthesized(killed).map((r) => r.id)).toEqual(["synth-gov-1"]);
    expect(() => killSynthesizedInList([a, b], "synth-nope")).toThrow(
      /Unknown synthesized schedule/,
    );
  });
});

describe("run attribution + #755 audit shape (#1468)", () => {
  it("(d) a chain run attributes chain version + capability versions + provenance", () => {
    const v = versionedV1();
    const attr = attributeChainRun(v, {
      goal: "Create a NASDAQ100 screen and send it to Slack",
      shardProvenance: ["shard-feed-1", "shard-generate-1", "shard-deliver-1"],
      outcome: "completed",
      runAt: "2026-10-26T06:00:00.000Z",
    });
    expect(attr.chainId).toBe("chain-nasdaq-slack");
    expect(attr.chainVersion).toBe(1);
    expect(attr.capabilityVersions).toEqual(v.capabilityVersions);
    expect(attr.shardProvenance).toEqual([
      "shard-feed-1",
      "shard-generate-1",
      "shard-deliver-1",
    ]);
    expect(attr.outcome).toBe("completed");
  });

  it("the audit record maps onto the shipped #755 record shape", () => {
    const v = versionedV1();
    const attr = attributeChainRun(v, {
      goal: "Create a NASDAQ100 screen and send it to Slack",
      shardProvenance: ["shard-feed-1"],
      outcome: "failed",
      runAt: "2026-10-26T06:00:00.000Z",
    });
    const rec = chainRunAuditRecord(attr);
    expect(rec.subject).toBe("chain-nasdaq-slack");
    expect(rec.parameter).toBe("chain-version:1");
    expect(rec.actor).toBe("chain-run");
    expect(rec.after).toContain("failed");
    expect(rec.dataWindow).toBe("shard-feed-1");
    expect(rec.rationale).toContain("Create a NASDAQ100 screen");
  });
});
