/**
 * Issue #1257 (challenger re-point): the evaluation-spec mapping and
 * verdict reasons are pure functions — pinned here so the route
 * handlers cannot silently drift from the documented mapping:
 * champion = current state; challenger differs only in what its
 * kind changes.
 */
import { describe, it, expect } from "vitest";
import {
  buildEvaluationSpecs,
  verdictReasons,
} from "../src/services/proposalChallengerBridge";
import type { Challenger } from "../src/services/championChallenger";

const CURRENT = {
  weightsForRegime: { iron_condor: 1.2 },
  activeSet: ["iron_condor"],
};

function challenger(overrides: Partial<Challenger>): Challenger {
  return {
    id: "chl-1",
    userLogin: "alice",
    kind: "active_set",
    title: "t",
    regime: "chop",
    spec: {},
    criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
    evalSetVersion: "v2",
    sourceProposalId: null,
    createdBy: "strategy-bank-reselection",
    status: "proposed",
    evaluation: null,
    createdAt: "2026-10-24T12:00:00.000Z",
    ...overrides,
  } as Challenger;
}

describe("buildEvaluationSpecs", () => {
  it("weights challengers change weights only; the active set stays the champion's", () => {
    const { championSpec, challengerSpec } = buildEvaluationSpecs(
      challenger({ kind: "weights", spec: { weights: { iron_condor: 1.4 } } }),
      CURRENT
    );
    expect(championSpec).toEqual({ weights: { iron_condor: 1.2 }, activeStrategies: ["iron_condor"] });
    expect(challengerSpec).toEqual({ weights: { iron_condor: 1.4 }, activeStrategies: ["iron_condor"] });
  });

  it("active-set challengers change the active set only; weights stay the champion's", () => {
    const { championSpec, challengerSpec } = buildEvaluationSpecs(
      challenger({ kind: "active_set", spec: { activeStrategies: ["long_strangle"] } }),
      CURRENT
    );
    expect(championSpec).toEqual({ weights: { iron_condor: 1.2 }, activeStrategies: ["iron_condor"] });
    expect(challengerSpec).toEqual({ weights: { iron_condor: 1.2 }, activeStrategies: ["long_strangle"] });
  });

  it("ranking challengers score the ranking order against current weights", () => {
    const { challengerSpec } = buildEvaluationSpecs(
      challenger({ kind: "ranking", spec: { ranking: ["bull_put_spread", "iron_condor"] } }),
      CURRENT
    );
    expect(challengerSpec).toEqual({
      weights: { iron_condor: 1.2 },
      activeStrategies: ["bull_put_spread", "iron_condor"],
    });
  });

  it("no recorded active set means no strategy filter (null), not an empty set", () => {
    const { championSpec, challengerSpec } = buildEvaluationSpecs(
      challenger({ kind: "active_set", spec: { activeStrategies: ["long_strangle"] } }),
      { weightsForRegime: {}, activeSet: null }
    );
    expect(championSpec.activeStrategies).toBeNull();
    expect(challengerSpec.activeStrategies).toEqual(["long_strangle"]);
  });
});

describe("verdictReasons", () => {
  it("a pass names both satisfied bars", () => {
    const reasons = verdictReasons({
      holdout: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
      criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
      verdict: "pass",
    });
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toMatch(/edge 0\.1000 >= minimum/);
    expect(reasons[1]).toMatch(/evaluated 2 >= minimum/);
  });

  it("a fail names exactly the missed bar", () => {
    const reasons = verdictReasons({
      holdout: { championScore: 0.2, challengerScore: 0.1, evaluated: 2 },
      criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
      verdict: "fail",
    });
    expect(reasons[0]).toMatch(/below minimum/);
    expect(reasons[1]).toMatch(/>= minimum/);
  });

  it("null holdout scores are reported as unavailable, never invented", () => {
    const reasons = verdictReasons({
      holdout: { championScore: null, challengerScore: null, evaluated: 0 },
      criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
      verdict: "fail",
    });
    expect(reasons[0]).toMatch(/unavailable/);
    expect(reasons[1]).toMatch(/below minimum/);
  });
});
