/**
 * Issue #1361 (epic #1151 slice C5) + #1257 rankers.
 *
 * OpportunityScanner's fit gate as a kernel gate-chain handler (not a
 * private gate): the handler runs the scanner's own evaluateFitGate
 * over a caller-supplied pick — the same pattern as
 * StrategyRiskFitHandler's injected screenFn. Bucket mapping: fit →
 * no cap; borderline → cap watchlist (surfaced with reasons, not
 * qualified); no_fit → cap rejected. No pick to gate passes through
 * with no cap, exactly like the panel fit handler's non-wrapped
 * pass-through.
 */
import { describe, it, expect } from "vitest";
import { OpportunityScannerFitHandler } from "../src/services/scannerFitGateHandler";
import type { KernelCandidate } from "../src/services/recommendationKernel";
import type { BestTradePick } from "../src/trading/options/recommendationAgent";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";

const GATE = { minCompositeScore: 60, minProbabilityOfProfit: 0.3, requireFresh: true, minConfidence: "MEDIUM" as const };

function kernelCandidate(): KernelCandidate {
  return {
    id: "k-1", symbol: "XYZ", structure: "bull_call_spread", label: "XYZ 200/210 bull call spread",
    legs: [], economics: null, status: "qualified", provenance: "quant", chainProvenance: "live",
    definedRisk: true, marginEstimate: null, assignmentRisk: false,
    gateReasons: [], limitations: [], rationale: [], builderId: "test",
  } as KernelCandidate;
}

function engineCandidate(over: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    id: "cand-1", rank: 1, type: "bull_call_spread", label: "XYZ 200/210 bull call spread",
    symbol: "XYZ", underlyingPrice: 200, expirationDate: "2026-11-22", dataFreshness: "FRESH",
    legs: [], netDebit: 2, estimatedFees: 2, maxProfit: null, maxProfitUnbounded: true, maxLoss: 200,
    breakevens: [203], targetPnl: 300, targetRewardRisk: 1, modelImpliedProbabilityOfProfit: 0.45,
    netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.02, vega: 0.05 },
    liquidityScore: 80, score: 70, scoreBreakdown: {} as any, payoffCurve: [], scenarios: [],
    explanations: [], warnings: [], assumptions: [],
    ...over,
  } as StrategyCandidate;
}

function pick(over: Partial<BestTradePick> = {}): BestTradePick {
  return {
    status: "recommended", riskProfile: "balanced", confidence: "HIGH",
    best: { candidate: engineCandidate(), rank: 1, compositeScore: 80, components: {} as any },
    alternatives: [], rationale: [], blockers: [],
    humanApprovalRequired: true, disclaimer: "d",
    ...over,
  } as BestTradePick;
}

describe("OpportunityScannerFitHandler", () => {
  it("fit → no cap, no reasons", () => {
    const h = new OpportunityScannerFitHandler({ pickFn: () => pick(), gate: GATE });
    expect(h.id).toBe("opportunity-scanner-fit");
    expect(h.evaluate(kernelCandidate(), {})).toEqual({ reasons: [] });
  });

  it("borderline (composite below minimum) → cap watchlist with the reason", () => {
    const p = pick();
    p.best!.compositeScore = 40;
    const h = new OpportunityScannerFitHandler({ pickFn: () => p, gate: GATE });
    const out = h.evaluate(kernelCandidate(), {});
    expect(out.cap).toBe("watchlist");
    expect(out.reasons.join(" ")).toMatch(/composite score 40/);
  });

  it("no_fit (no best) → cap rejected with the rationale as reason", () => {
    const p = pick({ best: undefined, status: "no_trade", rationale: ["No qualifying strategy"] });
    const h = new OpportunityScannerFitHandler({ pickFn: () => p, gate: GATE });
    const out = h.evaluate(kernelCandidate(), {});
    expect(out.cap).toBe("rejected");
    expect(out.reasons).toContain("No qualifying strategy");
  });

  it("no pick to gate → pass-through, no cap", () => {
    const h = new OpportunityScannerFitHandler({ pickFn: () => null, gate: GATE });
    expect(h.evaluate(kernelCandidate(), {})).toEqual({ reasons: [] });
  });
});
