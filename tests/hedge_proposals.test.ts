/**
 * Issue #54: hedge proposals from portfolio aggregates.
 * Pins: drafts only, deterministic sizing for both instrument forms,
 * pre/post beta-weighted Delta stated, missing-beta symbols named, and
 * no proposal when the exposure itself is unknown.
 */
import { describe, it, expect } from "vitest";
import { buildHedgeProposals, selectSpyPut, generateHedgeProposals, type SpyPutContract } from "../src/services/hedgeProposals";
import type { PortfolioRiskReport, PortfolioRiskTotals } from "../src/services/portfolioRisk";

function totals(partial: Partial<PortfolioRiskTotals>): PortfolioRiskTotals {
  return {
    deltaShares: 0, deltaDollars: 0, betaWeightedDeltaDollars: 0, betaWeightedSpyShares: 0,
    gammaSharesPerDollar: 0, thetaDollarsPerDay: 0, vegaDollarsPerVolPoint: 0, rhoDollarsPerRatePoint: 0,
    definedMaxLoss: 0, definedMaxLossPctOfNav: 0,
    betaCoverage: { covered: 1, total: 1, computedLive: 1, unavailable: 0 },
    ...partial,
  };
}

function report(t: PortfolioRiskTotals, partial: PortfolioRiskReport["partial"] = []): PortfolioRiskReport {
  return { asOf: "2026-10-15T00:00:00.000Z", nav: 200000, spyPrice: 500, totals: t, rows: [], partial, excluded: [], undefinedRiskPositions: [] } as PortfolioRiskReport;
}

const spyPut: SpyPutContract = { strike: 500, expirationDate: "2026-11-14", delta: -0.45, price: 6.5 };

describe("buildHedgeProposals", () => {
  it("sizes an exact SPY-share hedge for a long book and states pre/post delta", () => {
    const analysis = buildHedgeProposals(report(totals({ betaWeightedDeltaDollars: 50000, betaWeightedSpyShares: 100 })), null);
    expect(analysis.status).toBe("proposals");
    const shares = analysis.proposals.find((p) => p.instrument === "SPY_SHARES")!;
    expect(shares.status).toBe("DRAFT");
    expect(shares.side).toBe("SELL");
    expect(shares.quantity).toBe(100);
    expect(shares.preHedgeBetaWeightedDeltaDollars).toBe(50000);
    expect(shares.postHedgeBetaWeightedDeltaDollars).toBe(0);
    expect(shares.withinToleranceAfterHedge).toBe(true);
  });

  it("buys shares against a short (negative) book", () => {
    const analysis = buildHedgeProposals(report(totals({ betaWeightedDeltaDollars: -30000 })), null);
    const shares = analysis.proposals[0];
    expect(shares.side).toBe("BUY");
    expect(shares.quantity).toBe(60);
    expect(shares.postHedgeBetaWeightedDeltaDollars).toBe(0);
    expect(shares.estimatedCost).toBe(30000);
  });

  it("sizes the SPY-put form from the live contract delta, with defined-risk cost", () => {
    const analysis = buildHedgeProposals(report(totals({ betaWeightedDeltaDollars: 50000 })), spyPut);
    const puts = analysis.proposals.find((p) => p.instrument === "SPY_PUTS")!;
    // per-contract coverage: 0.45 * 100 * $500 = $22,500 -> round(50000/22500) = 2 contracts
    expect(puts.quantity).toBe(2);
    expect(puts.side).toBe("BUY");
    expect(puts.estimatedCost).toBe(1300);
    // residual: 50000 - 2*22500 = 5000 > tolerance ($2,000) -> stated honestly
    expect(puts.postHedgeBetaWeightedDeltaDollars).toBe(5000);
    expect(puts.withinToleranceAfterHedge).toBe(false);
  });

  it("stays silent when the book is already within tolerance", () => {
    const analysis = buildHedgeProposals(report(totals({ betaWeightedDeltaDollars: 1500 })), spyPut);
    expect(analysis.status).toBe("within-tolerance");
    expect(analysis.proposals).toEqual([]);
  });

  it("refuses to size a hedge on unknown exposure and names the missing-beta symbols", () => {
    const partial = [{ symbol: "XYZ", reason: "No beta available for this symbol; excluded from beta-weighted totals" }];
    const analysis = buildHedgeProposals(report(totals({ betaWeightedDeltaDollars: null }), partial), spyPut);
    expect(analysis.status).toBe("unavailable");
    expect(analysis.proposals).toEqual([]);
    expect(analysis.symbolsMissingBeta).toEqual(["XYZ"]);
    expect(analysis.reason).toContain("XYZ");
  });
});

describe("selectSpyPut", () => {
  it("picks the put nearest the money with a usable price and delta", () => {
    const chain = {
      symbol: "SPY",
      underlyingPrice: 500,
      pairs: [
        { put: { optionType: "PUT" as const, strikePrice: 480, symbol: "SPY", bid: 2, ask: 2.2, lastPrice: 2.1, delta: -0.2 } },
        { put: { optionType: "PUT" as const, strikePrice: 500, symbol: "SPY", bid: 6.4, ask: 6.6, lastPrice: 6.5, delta: -0.45 } },
        { put: { optionType: "PUT" as const, strikePrice: 520, symbol: "SPY", bid: 12, ask: 12.4, lastPrice: 12.2, delta: -0.7 } },
      ],
    } as any;
    const selected = selectSpyPut(chain, "2026-11-14");
    expect(selected?.strike).toBe(500);
    expect(selected?.delta).toBe(-0.45);
    expect(selected?.price).toBe(6.5);
  });
});

describe("executableOrder on hedge proposals", () => {
  it("attaches a fully-specified executable order to SPY shares hedge", () => {
    const analysis = buildHedgeProposals(report(totals({ betaWeightedDeltaDollars: 50000 })), null);
    const shares = analysis.proposals.find((p) => p.instrument === "SPY_SHARES")!;
    expect(shares.executableOrder).toBeDefined();
    expect(shares.executableOrder?.isExecutable).toBe(true);
    expect(shares.executableOrder?.assetClass).toBe("equity");
    expect(shares.executableOrder?.symbol).toBe("SPY");
    expect(shares.executableOrder?.action).toBe("SELL");
    expect(shares.executableOrder?.quantity).toBe(100);
    expect(shares.executableOrder?.limitPrice).toBe(500);
    expect(shares.executableOrder?.legs).toHaveLength(1);
    expect(shares.executableOrder?.legs[0]).toEqual({
      underlyingSymbol: "SPY",
      securityType: "EQ",
      side: "SELL",
      quantity: 100,
    });
  });

  it("attaches a fully-specified executable order to SPY puts hedge", () => {
    const analysis = buildHedgeProposals(report(totals({ betaWeightedDeltaDollars: 50000 })), spyPut);
    const puts = analysis.proposals.find((p) => p.instrument === "SPY_PUTS")!;
    expect(puts.executableOrder).toBeDefined();
    expect(puts.executableOrder?.isExecutable).toBe(true);
    expect(puts.executableOrder?.assetClass).toBe("options");
    expect(puts.executableOrder?.symbol).toBe("SPY");
    expect(puts.executableOrder?.action).toBe("BUY");
    expect(puts.executableOrder?.quantity).toBe(2);
    expect(puts.executableOrder?.limitPrice).toBe(6.5);
    expect(puts.executableOrder?.strategyNetDebit).toBe(650);
    expect(puts.executableOrder?.legs[0]).toEqual({
      underlyingSymbol: "SPY",
      securityType: "OPTN",
      side: "BUY",
      quantity: 1,
      optionType: "PUT",
      strike: 500,
      expirationDate: "2026-11-14",
    });
  });
});

describe("generateHedgeProposals listed expiration discovery", () => {
  it("queries getOptionExpireDates and selects the listed expiration closest to 30 DTE", async () => {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 28 * 24 * 3600 * 1000);
    const mockExpireDates = [
      { year: futureDate.getUTCFullYear(), month: futureDate.getUTCMonth() + 1, day: futureDate.getUTCDate() },
    ];
    let capturedChainParams: any = null;
    const mockEtrade = {
      fetchPortfolioRemote: async () => ({
        account: { netAccountValue: 200000 },
        positions: [],
      }),
      getPositions: () => ({ positions: [] }),
      getQuotes: async () => [{ symbol: "SPY", lastPrice: 500 }],
      getOptionExpireDates: async (symbol: string) => mockExpireDates,
      getOptionChains: async (params: any) => {
        capturedChainParams = params;
        return {
          symbol: "SPY",
          underlyingPrice: 500,
          pairs: [
            { put: { optionType: "PUT", strikePrice: 500, symbol: "SPY", bid: 6.4, ask: 6.6, lastPrice: 6.5, delta: -0.45 } },
          ],
        };
      },
    } as any;

    const analysis = await generateHedgeProposals(mockEtrade);
    expect(capturedChainParams).toBeDefined();
    expect(capturedChainParams.symbol).toBe("SPY");
    expect(capturedChainParams.expiryYear).toBe(futureDate.getUTCFullYear());
    expect(capturedChainParams.expiryMonth).toBe(futureDate.getUTCMonth() + 1);
    expect(capturedChainParams.expiryDay).toBe(futureDate.getUTCDate());
  });
});

