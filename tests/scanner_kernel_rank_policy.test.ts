/**
 * #1257 rankers-as-policies: OpportunityScanner's per-symbol rank routes
 * through the kernel RiskProfileComposite ranking policy instead of calling
 * the recommender directly. The ranker itself is unchanged (the policy wraps
 * RecommendationAgent.rank, the same function the panel path uses), so the
 * order is identical — what changes is who owns the order.
 *
 * Pinned here:
 *  1. The policy owns the order: with a ranker whose return order disagrees
 *     with its composite scores, the adapter returns composite-descending
 *     (policy) order, not the ranker's return order.
 *  2. Guard-fail fallback: when the policy cannot invoke the ranker (a
 *     candidate without a numeric targetRewardRisk), the adapter falls back
 *     to the direct ranker — today's path, unchanged — and still invokes
 *     the policy first.
 *  3. Production equivalence: with the real recommender, adapter order and
 *     composite scores equal the direct ranker, including the id-ascending
 *     tiebreak.
 *  4. Scan-level routing: OpportunityScanner.scan invokes the policy's rank.
 *
 * The cross-symbol row sort (score desc, symbol asc) is NOT candidate
 * ranking — it orders scan result rows across symbols — and stays where it
 * is. Discovery name ranking already flows through ScenarioGridRank via
 * #1411; discovery strategy ranking rides with the blocked #1256 strategy
 * rewire and is not forced here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecommendationAgent, type RankedStrategy, type RiskProfile } from "../src/trading/options/recommendationAgent";
import type { StrategyCandidate, StrategyRequest } from "../src/trading/options/strategyEngine";
import { RiskProfileComposite } from "../src/services/recommendationKernel";
import { OpportunityScanner, rankScannerCandidates, type ScanRequestTemplate } from "../src/trading/options/opportunityScanner";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

type RankFn = (
  candidates: StrategyCandidate[],
  request: Pick<StrategyRequest, "maxPlannedLoss" | "minRewardRisk">,
  profile: RiskProfile,
) => RankedStrategy[];

const request = { maxPlannedLoss: 5_000, minRewardRisk: 0.1 };
const profile: RiskProfile = "balanced";

function candidate(
  id: string,
  overrides: Partial<StrategyCandidate> = {},
): StrategyCandidate {
  return {
    id,
    type: "long_call",
    label: `Long call ${id}`,
    symbol: "AAA",
    legs: [],
    netDebit: 100,
    maxLoss: 1_000,
    score: 80,
    targetRewardRisk: 2.0,
    modelImpliedProbabilityOfProfit: 0.5,
    liquidityScore: 80,
    ...overrides,
  } as unknown as StrategyCandidate;
}

function ranked(
  c: StrategyCandidate,
  compositeScore: number,
): RankedStrategy {
  return {
    candidate: c,
    components: {
      engineScore: c.score,
      probability: 50,
      rewardRisk: 50,
      capitalSafety: 50,
      liquidity: 50,
    },
    compositeScore,
    rank: 0,
  } as unknown as RankedStrategy;
}

describe("rankScannerCandidates routes through the kernel policy", () => {
  it("1. the policy owns the order, not the ranker's return order", () => {
    const a = candidate("a");
    const b = candidate("b");
    // Return order disagrees with composite scores on purpose.
    const rankFn: RankFn = vi.fn(() => [ranked(b, 10), ranked(a, 20)]);
    const out = rankScannerCandidates(rankFn, [a, b], request, profile);
    expect(out.map((o) => o.candidate.id)).toEqual(["a", "b"]);
    expect(out.map((o) => o.compositeScore)).toEqual([20, 10]);
    expect(rankFn).toHaveBeenCalledTimes(1);
  });

  it("2. guard-fail falls back to the direct ranker, policy still invoked", () => {
    const a = candidate("a");
    const broken = candidate("broken", { targetRewardRisk: undefined as unknown as number });
    const rankFn: RankFn = vi.fn((cands) => cands.map((c) => ranked(c, 10)));
    const policySpy = vi.spyOn(RiskProfileComposite.prototype, "rank");
    const out = rankScannerCandidates(rankFn, [a, broken], request, profile);
    expect(policySpy).toHaveBeenCalled();
    // Fallback = the ranker's own return order, unchanged from today.
    expect(out.map((o) => o.candidate.id)).toEqual(["a", "broken"]);
    expect(rankFn).toHaveBeenCalledTimes(1);
  });

  it("3. production ranker equivalence, including the id tiebreak", () => {
    const recommender = new RecommendationAgent();
    const direct: RankFn = (c, r, p) => recommender.rank(c, r, p);
    const cands = [
      candidate("c1", { score: 80, modelImpliedProbabilityOfProfit: 0.5, targetRewardRisk: 2.0, maxLoss: 1_000, liquidityScore: 80 }),
      candidate("c2", { score: 70, modelImpliedProbabilityOfProfit: 0.6, targetRewardRisk: 1.5, maxLoss: 500, liquidityScore: 90 }),
      candidate("c3", { score: 90, modelImpliedProbabilityOfProfit: 0.4, targetRewardRisk: 3.0, maxLoss: 2_000, liquidityScore: 70 }),
      candidate("twin-b", { score: 60, modelImpliedProbabilityOfProfit: 0.5, targetRewardRisk: 2.0, maxLoss: 1_000, liquidityScore: 80 }),
      candidate("twin-a", { score: 60, modelImpliedProbabilityOfProfit: 0.5, targetRewardRisk: 2.0, maxLoss: 1_000, liquidityScore: 80 }),
    ];
    const viaPolicy = rankScannerCandidates(direct, cands, request, profile);
    const viaDirect = direct(cands, request, profile);
    expect(viaPolicy.map((o) => o.candidate.id)).toEqual(viaDirect.map((r) => r.candidate.id));
    expect(viaPolicy.map((o) => o.compositeScore)).toEqual(viaDirect.map((r) => r.compositeScore));
    const twins = viaPolicy.map((o) => o.candidate.id).filter((id) => id.startsWith("twin-"));
    expect(twins).toEqual(["twin-a", "twin-b"]);
  });
});

// --- Minimal scan fixture (pattern from tests/options_scanner.test.ts) ---

const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

function makeContracts(symbol: string, spot: number): ScreenedOptionContractItem[] {
  const now = Date.now();
  return [0.95, 1, 1.05].flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const callMid = legMid(spot, strike, "CALL");
    const putMid = legMid(spot, strike, "PUT");
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: "FRESH" as const,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
    };
    return [
      { ...base, optionType: "CALL" as const, symbol: `${symbol}${strike}C`, osiKey: `${symbol}-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `${symbol}${strike}P`, osiKey: `${symbol}-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

function fakeScreener(spot: number): DynamicOptionsScreener {
  const contracts = makeContracts("AAA", spot);
  return {
    screenOptions: async () =>
      ({
        contracts,
        matchedCount: contracts.length,
        totalContractsEvaluated: contracts.length,
        totalUnderlyingsScanned: 1,
        scannedAt: new Date().toISOString(),
        rejections: [],
      }) as unknown as OptionScreenResult,
  } as unknown as DynamicOptionsScreener;
}

describe("OpportunityScanner.scan routes through the kernel policy", () => {
  it("4. scan invokes RiskProfileComposite.rank", async () => {
    const policySpy = vi.spyOn(RiskProfileComposite.prototype, "rank");
    const template: ScanRequestTemplate = {
      thesis: "bullish",
      targetDate: expiryDate,
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 5_000,
      minRewardRisk: 0.1,
      allowedStrategies: ["long_call"],
      minDte: 14,
      maxDte: 60,
      contractLimit: 500,
      candidateLimit: 10,
      maxStrikesPerSide: 12,
      maxIronCondors: 100,
      maxQuoteAgeSeconds: 60,
      eventPolicy: "warn",
    };
    const scanner = new OpportunityScanner(fakeScreener(100));
    const result = await scanner.scan(["AAA"], template);
    expect(policySpy).toHaveBeenCalled();
    expect(result.withTrades).toBe(1);
  });
});
