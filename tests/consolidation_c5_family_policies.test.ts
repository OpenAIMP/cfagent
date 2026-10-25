/**
 * Issue #1361 (epic #1151 slice C5; #1257 family rationalization).
 *
 * RepairPolicy / HedgePolicy unification:
 * - RatioRepair (#355 position-level proposals) and CompositionRepair
 *   (composition operators, handed in as CompositionRepairInput) become
 *   RepairPolicy implementations over ONE proposal contract
 *   (RepairOption). The bundle consumes policies, not modules.
 * - hedgeProposals is re-homed as the kernel's sole HedgePolicy
 *   (SpyDeltaHedgePolicy): same behavior, same HEDGE_POLICY constants.
 *
 * All mappings moved verbatim from buildRecommendationBundle, so bundle
 * output is unchanged (guarded by tests/phase4_recommender_v2.test.ts).
 */
import { describe, it, expect } from "vitest";
import { aggregatePortfolioRisk, type ResolvedPosition } from "../src/services/portfolioRisk";
import {
  buildRepairOptions,
  CompositionRepairPolicy,
  RatioRepairPolicy,
  type CompositionRepairInput,
} from "../src/services/repairPolicies";
import {
  buildHedgeProposals,
  SPY_DELTA_HEDGE_POLICY,
} from "../src/services/hedgeProposals";
import type { RepairProposal } from "../src/services/repairProposals";

function ratioProposal(partial: Partial<RepairProposal>): RepairProposal {
  return {
    status: "DRAFT",
    symbol: "AAPL",
    units: 1,
    legLong: { strike: 180, expirationDate: "2026-12-19", premium: 5 },
    legShort: { strike: 200, expirationDate: "2026-12-19", premium: 2, quantity: 2 },
    netDebitPerUnit: 1,
    breakevenAtExpiry: 195,
    maxRecoveryPerUnit: 10,
    upsideCappedAbove: 200,
    noDownsideProtection: true,
    maxAdditionalCapitalAtRisk: 100,
    postRepairBetaWeightedDeltaDollars: null,
    rationale: "Ratio repair rationale.",
    ...partial,
  } as RepairProposal;
}

describe("RatioRepairPolicy", () => {
  it("maps #355 proposals to RepairOptions, cost-first, verbatim", () => {
    const policy = new RatioRepairPolicy();
    const options = policy.options({
      repairAnalysis: {
        asOf: "2026-10-23T00:00:00.000Z",
        status: "proposals",
        symbolsUnavailable: [],
        unavailableReasons: {},
        proposals: [
          ratioProposal({ symbol: "AAPL", units: 2, netDebitPerUnit: 1.5, breakevenAtExpiry: 195 }),
        ],
      },
      compositionRepairs: [],
    });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      kind: "ratio_repair",
      label: "AAPL 1x2 call ratio repair (breakeven → $195)",
      costDollars: 300,
      riskRemovedDollars: null,
      rankScore: -300,
      noDownsideProtection: true,
    });
    expect(options[0].rankBasis).toContain("cost-first");
  });

  it("floors a credit (negative net debit) at zero cost", () => {
    const policy = new RatioRepairPolicy();
    const options = policy.options({
      repairAnalysis: {
        asOf: "2026-10-23T00:00:00.000Z",
        status: "proposals",
        symbolsUnavailable: [],
        unavailableReasons: {},
        proposals: [ratioProposal({ netDebitPerUnit: -0.5, units: 1 })],
      },
      compositionRepairs: [],
    });
    expect(options[0].costDollars).toBe(0);
    // Verbatim builder behavior: rankScore is -cost, so a zero cost
    // yields -0 (which serializes as 0 in JSON). Do not "fix" this
    // in the policy — byte-identical output is the requirement.
    expect(options[0].rankScore).toBe(-0);
  });
});

describe("CompositionRepairPolicy", () => {
  it("ranks by risk removed minus cost when measured", () => {
    const policy = new CompositionRepairPolicy();
    const input: CompositionRepairInput = {
      label: "Vertical → Butterfly",
      costDollars: 100,
      riskRemovedDollars: 400,
      detail: "Butterfly wing added.",
    };
    const options = policy.options({ repairAnalysis: null, compositionRepairs: [input] });
    expect(options[0]).toMatchObject({
      kind: "composition",
      rankScore: 300,
      riskRemovedDollars: 400,
    });
    expect(options[0].rankBasis).toContain("risk removed minus cost");
  });

  it("ranks cost-first when risk removed is unknown", () => {
    const policy = new CompositionRepairPolicy();
    const options = policy.options({
      repairAnalysis: null,
      compositionRepairs: [{ label: "Unknown repair", costDollars: 50, detail: "d" }],
    });
    expect(options[0]).toMatchObject({ rankScore: -50, riskRemovedDollars: null });
    expect(options[0].rankBasis).toContain("cost-first");
  });
});

describe("buildRepairOptions", () => {
  it("merges both policies and sorts by rankScore desc, label asc", () => {
    const result = buildRepairOptions({
      repairAnalysis: {
        asOf: "2026-10-23T00:00:00.000Z",
        status: "proposals",
        symbolsUnavailable: [],
        unavailableReasons: {},
        proposals: [ratioProposal({ symbol: "ZZZ", netDebitPerUnit: 1, units: 1 })],
      },
      compositionRepairs: [
        { label: "AAA repair", costDollars: 10, riskRemovedDollars: 10, detail: "d" },
      ],
    });
    expect(result.status).toBe("proposals");
    // Composition: 10 - 10 = 0; ratio: -100. Order: AAA (0) then ZZZ (-100).
    expect(result.options.map((o) => o.label)).toEqual([
      "AAA repair",
      "ZZZ 1x2 call ratio repair (breakeven → $195)",
    ]);
  });

  it("reports none_supplied only when neither input is supplied", () => {
    expect(buildRepairOptions({ repairAnalysis: null, compositionRepairs: [] }).status).toBe("none_supplied");
    expect(buildRepairOptions({ repairAnalysis: undefined, compositionRepairs: undefined }).status).toBe("none_supplied");
    // Supplied-but-empty analysis still counts as supplied (verbatim
    // builder semantics: status keys on the input being present).
    expect(buildRepairOptions({
      repairAnalysis: {
        asOf: "2026-10-23T00:00:00.000Z",
        status: "not-underwater",
        symbolsUnavailable: [],
        unavailableReasons: {},
        proposals: [],
      },
      compositionRepairs: [],
    }).status).toBe("proposals");
  });
});

describe("SpyDeltaHedgePolicy", () => {
  it("delegates to buildHedgeProposals with identical output", () => {
    const resolved: ResolvedPosition[] = [{
      position: {
        symbol: "AAPL", description: "Common Stock", quantity: 50, pricePaid: 180,
        costBasis: 9_000, currentPrice: 200, marketPrice: 200, marketValue: 10_000,
        totalGain: 2_000, unrealizedGainLoss: 2_000, totalGainPercent: 11,
        unrealizedGainLossPercent: 11, daysGain: 0, daysGainPercent: 0,
        securityType: "EQ", positionType: "LONG",
      } as any,
      kind: "equity", signedQuantity: 50, referencePrice: 200,
      greeks: { delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 },
      beta: 1.2, betaSource: "computed-live", betaObservations: 252,
    }];
    const report = aggregatePortfolioRisk(resolved, { nav: 200_000, spyPrice: 500, asOf: "2026-10-23T00:00:00.000Z" });
    expect(SPY_DELTA_HEDGE_POLICY.build(report, null)).toEqual(buildHedgeProposals(report, null));
  });
});
