import { describe, it, expect } from "vitest";
import {
  buildRepairProposals,
  generateRepairProposals,
  REPAIR_POLICY,
} from "../src/services/repairProposals";
import type { ETradePosition, ETradeOptionChain } from "../src/types";

/**
 * #355: portfolio repair proposals (1×2 call ratio on underwater longs).
 */

function position(overrides: Partial<ETradePosition> = {}): ETradePosition {
  return {
    symbol: "XYZ",
    description: "XYZ Corp",
    quantity: 100,
    securityType: "EQ",
    positionType: "LONG",
    pricePaid: 100,
    costBasis: 10000,
    currentPrice: 80,
    marketPrice: 80,
    marketValue: 8000,
    ...overrides,
  } as ETradePosition;
}

function callContract(strike: number, mid: number) {
  return {
    optionType: "CALL",
    strikePrice: strike,
    symbol: `XYZ${strike}C`,
    bid: mid - 0.05,
    ask: mid + 0.05,
    lastPrice: mid,
    expirationDate: "2026-11-20",
  };
}

function chain(strikes: Array<[number, number]>): { chain: ETradeOptionChain; expirationDate: string } {
  return {
    expirationDate: "2026-11-20",
    chain: {
      symbol: "XYZ",
      underlyingPrice: 80,
      pairs: strikes.map(([s, m]) => ({
        call: {
          optionType: "CALL",
          strikePrice: s,
          symbol: `XYZ${s}C`,
          bid: m - 0.05,
          ask: m + 0.05,
          lastPrice: m,
        },
      })),
    } as unknown as ETradeOptionChain,
  };
}

const GOOD_CHAIN = chain([
  [78, 6.2],
  [80, 5.0],
  [82, 3.9],
  [85, 2.9],
  [90, 2.4],
  [95, 1.8],
]);

describe("#355 repair proposals", () => {
  it("proposes a 1x2 ratio on an underwater 100-share position", () => {
    const analysis = buildRepairProposals([position()], { XYZ: GOOD_CHAIN }, null as any);
    expect(analysis.status).toBe("proposals");
    expect(analysis.proposals).toHaveLength(1);
    const p = analysis.proposals[0];
    expect(p.status).toBe("DRAFT");
    expect(p.symbol).toBe("XYZ");
    expect(p.units).toBe(1);
    // K1 = nearest strike to spot 80; K2 satisfies the half-gap rule:
    // K2 >= 80 + (100 - 80) / 2 = 90.
    expect(p.legLong.strike).toBe(80);
    expect(p.legShort.strike).toBeGreaterThanOrEqual(90);
    expect(p.legShort.quantity).toBe(2);
    // Zero-cost target: |netDebit| <= 0.5% of spot.
    expect(Math.abs(p.netDebitPerUnit)).toBeLessThanOrEqual(
      (REPAIR_POLICY.repairCostTolerancePctOfSpot / 100) * 80
    );
    // Honest reporting: no downside protection is explicit.
    expect(p.noDownsideProtection).toBe(true);
    expect(p.upsideCappedAbove).toBe(p.legShort.strike);
  });

  it("marks at-or-above-cost positions not-underwater", () => {
    const analysis = buildRepairProposals(
      [position({ currentPrice: 105, marketPrice: 105 })],
      { XYZ: GOOD_CHAIN },
      null as any
    );
    expect(analysis.status).toBe("not-underwater");
    expect(analysis.proposals).toHaveLength(0);
  });

  it("rejects when no strike satisfies the half-gap rule", () => {
    const shortChain = chain([
      [78, 6.2],
      [80, 5.0],
      [82, 3.9],
    ]);
    const analysis = buildRepairProposals([position()], { XYZ: shortChain }, null as any);
    expect(analysis.status).toBe("unavailable");
    expect(analysis.reason).toContain("half-gap");
    expect(analysis.symbolsUnavailable).toContain("XYZ");
  });

  it("rejects when net debit exceeds tolerance (never rounds into it)", () => {
    // Expensive long call, cheap shorts -> debit beyond 0.5% of spot.
    const pricey = chain([
      [80, 12.0],
      [90, 2.4],
      [95, 1.8],
    ]);
    const analysis = buildRepairProposals([position()], { XYZ: pricey }, null as any);
    expect(analysis.status).toBe("unavailable");
    expect(analysis.reason).toContain("tolerance");
  });

  it("names positions under 100 shares as unavailable", () => {
    const analysis = buildRepairProposals(
      [position({ quantity: 50 })],
      { XYZ: GOOD_CHAIN },
      null as any
    );
    expect(analysis.status).toBe("unavailable");
    expect(analysis.symbolsUnavailable).toContain("XYZ");
    expect(analysis.reason).toContain("100");
  });

  it("names option positions as unavailable (v1 is equity-only)", () => {
    const analysis = buildRepairProposals(
      [position({ securityType: "OPTN", optionType: "CALL", strikePrice: 80 })],
      { XYZ: GOOD_CHAIN },
      null as any
    );
    expect(analysis.status).toBe("unavailable");
    expect(analysis.symbolsUnavailable).toContain("XYZ");
  });

  it("names symbols with no chain as unavailable (never fabricated)", () => {
    const analysis = buildRepairProposals([position()], {}, null as any);
    expect(analysis.status).toBe("unavailable");
    expect(analysis.symbolsUnavailable).toContain("XYZ");
    expect(analysis.reason).toContain("chain");
  });

  it("scales units by 100-share blocks", () => {
    const analysis = buildRepairProposals(
      [position({ quantity: 250 })],
      { XYZ: GOOD_CHAIN },
      null as any
    );
    expect(analysis.status).toBe("proposals");
    expect(analysis.proposals[0].units).toBe(2);
  });

  it("attaches fully-specified executableOrder with unit-ratio legs to repair proposal", () => {
    const analysis = buildRepairProposals(
      [position({ quantity: 200 })],
      { XYZ: GOOD_CHAIN },
      null as any
    );
    expect(analysis.status).toBe("proposals");
    const p = analysis.proposals[0];
    expect(p.executableOrder).toBeDefined();
    expect(p.executableOrder?.isExecutable).toBe(true);
    expect(p.executableOrder?.assetClass).toBe("options");
    expect(p.executableOrder?.symbol).toBe("XYZ");
    expect(p.executableOrder?.action).toBe("BUY");
    expect(p.executableOrder?.quantity).toBe(2);
    expect(p.executableOrder?.limitPrice).toBeGreaterThanOrEqual(0.01);
    expect(p.executableOrder?.legs).toHaveLength(2);
    expect(p.executableOrder?.legs[0]).toEqual({
      underlyingSymbol: "XYZ",
      securityType: "OPTN",
      side: "BUY",
      quantity: 1,
      optionType: "CALL",
      strike: 80,
      expirationDate: "2026-11-20",
    });
    expect(p.executableOrder?.legs[1]).toEqual({
      underlyingSymbol: "XYZ",
      securityType: "OPTN",
      side: "SELL",
      quantity: 2,
      optionType: "CALL",
      strike: 90,
      expirationDate: "2026-11-20",
    });
  });

  it("discovers viable repair options across listed expiration dates in generateRepairProposals", async () => {
    const now = new Date();
    const exp1 = new Date(now.getTime() + 25 * 24 * 3600 * 1000);
    const exp2 = new Date(now.getTime() + 35 * 24 * 3600 * 1000);
    const mockDates = [
      { year: exp1.getUTCFullYear(), month: exp1.getUTCMonth() + 1, day: exp1.getUTCDate() },
      { year: exp2.getUTCFullYear(), month: exp2.getUTCMonth() + 1, day: exp2.getUTCDate() },
    ];

    const mockEtrade = {
      getPositions: () => ({
        positions: [position({ symbol: "XYZ", quantity: 100, pricePaid: 100, currentPrice: 80, marketPrice: 80 })],
      }),
      getOptionExpireDates: async () => mockDates,
      getOptionChains: async (params: any) => {
        // Return valid chain for the second expiration
        if (params.expiryDay === exp2.getUTCDate()) {
          return GOOD_CHAIN.chain;
        }
        return null;
      },
      fetchPortfolioRemote: async () => ({ account: { netAccountValue: 10000 }, positions: [] }),
    } as any;

    const analysis = await generateRepairProposals(mockEtrade);
    expect(analysis.status).toBe("proposals");
    expect(analysis.proposals).toHaveLength(1);
    expect(analysis.proposals[0].symbol).toBe("XYZ");
    expect(analysis.proposals[0].executableOrder?.isExecutable).toBe(true);
  });
});
