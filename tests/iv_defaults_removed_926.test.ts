/**
 * Issue #926 (S8) — IV defaults removed: chain IV required.
 *
 * Red pin (written BEFORE the fix): a leg without chain IV must be
 * excluded from IV-dependent math and counted, and IV-dependent outputs
 * must be marked unavailable — never computed with an assumed constant
 * (client 0.35, server 0.4).
 */
import { describe, it, expect } from "vitest";
import { RISK_MATH } from "../src/shared/riskMath";
import {
  computeRiskProfile,
  type RiskSubject,
} from "../src/client/options/riskManagementEngine";
import { blackScholes } from "../src/client/options/blackScholes";
import {
  buildStructure,
  missingIvForStructure,
  type ChainSnapshot,
} from "../src/services/researchPipeline";
import {
  valueAtHorizon,
  buildScenarioRows,
  type StructureEconomics,
} from "../src/services/researchEconomics";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";
import { discoverNamesForStrategy } from "../src/services/researchDiscovery";
import type { ResearchDataProvider } from "../src/services/researchPipeline";

const NOW = Date.now();

function straddleChain(callIv: number | null): ChainSnapshot {
  const mk = (
    optionType: "call" | "put",
    strike: number,
    bid: number,
    ask: number,
    iv: number | null,
  ) => ({ optionType, strike, expiry: "2026-12-18", dte: 35, bid, ask, iv, volume: 100, openInterest: 500 });
  return {
    symbol: "AAA",
    underlyingPrice: 100,
    asOf: NOW - 60_000,
    provenance: "live",
    expiries: [
      {
        expiry: "2026-12-18",
        dte: 35,
        legs: [
          mk("call", 95, 10.0, 10.4, 0.4),
          mk("call", 100, 4.8, 5.0, callIv),
          mk("call", 105, 2.4, 2.6, 0.4),
          mk("put", 100, 4.9, 5.1, 0.4),
        ],
      },
    ],
  } as unknown as ChainSnapshot;
}

function pmccChain(longIv: number | null): ChainSnapshot {
  const mk = (
    optionType: "call" | "put",
    strike: number,
    bid: number,
    ask: number,
    iv: number | null,
    dte: number,
  ) => ({ optionType, strike, expiry: "2027-06-18", dte, bid, ask, iv, volume: 100, openInterest: 500 });
  return {
    symbol: "AAA",
    underlyingPrice: 100,
    asOf: NOW - 60_000,
    provenance: "live",
    expiries: [
      { expiry: "2027-06-18", dte: 200, legs: [mk("call", 85, 20.0, 20.4, longIv, 200)] },
      { expiry: "2026-12-18", dte: 35, legs: [mk("call", 105, 2.4, 2.6, 0.4, 35)] },
    ],
  } as unknown as ChainSnapshot;
}

describe("#926 IV defaults removed", () => {
  it("has no IV fallback constant in the shared risk math", () => {
    expect(
      (RISK_MATH as Record<string, unknown>).defaultIvWhenMissing,
    ).toBeUndefined();
  });

  it("client: a leg without IV contributes no Greeks and is counted", () => {
    const subject: RiskSubject = {
      title: "Long Call",
      underlyingSymbol: "AAA",
      underlyingPrice: 100,
      dte: 30,
      legs: [{ side: "BUY", optionType: "CALL", strike: 100, quantity: 1 }],
    };
    const profile = computeRiskProfile(subject);
    expect(profile.anatomy.netDelta).toBe(0);
    expect(profile.anatomy.missingIvLegs).toBe(1);
    expect(profile.anatomy.greeksSource).toBe("legs");
  });

  it("client: an IV-bearing leg still models, an IV-less leg is excluded", () => {
    const subject: RiskSubject = {
      title: "Two legs",
      underlyingSymbol: "AAA",
      underlyingPrice: 100,
      dte: 30,
      legs: [
        { side: "BUY", optionType: "CALL", strike: 100, quantity: 1, iv: 0.4 },
        { side: "BUY", optionType: "CALL", strike: 105, quantity: 1 },
      ],
    };
    const profile = computeRiskProfile(subject);
    const expected = blackScholes(100, 100, 30 / 365, 0.4, 0.04, 0, "CALL");
    expect(profile.anatomy.netDelta).toBe(Number(expected.delta.toFixed(3)));
    expect(profile.anatomy.missingIvLegs).toBe(1);
  });

  it("client: POP is unavailable (not a substitute number) when no leg has IV", () => {
    const subject: RiskSubject = {
      title: "Long Call",
      underlyingSymbol: "AAA",
      underlyingPrice: 100,
      dte: 30,
      breakevens: [105],
      legs: [{ side: "BUY", optionType: "CALL", strike: 100, quantity: 1, entryPrice: 5 }],
    };
    const profile = computeRiskProfile(subject);
    expect(profile.anatomy.probabilityOfProfit).toBeNull();
    expect(profile.anatomy.popSource).toBe("unavailable");
    expect(profile.anatomy.probabilityOfTouch).toBeNull();
  });

  it("server: a straddle whose call lacks chain IV is not built", () => {
    expect(buildStructure("long_straddle", straddleChain(null), 100, RESEARCH_CONFIG_DEFAULTS)).toBeNull();
    expect(missingIvForStructure("long_straddle", straddleChain(null), 100, RESEARCH_CONFIG_DEFAULTS)).toBe(true);
    const built = buildStructure("long_straddle", straddleChain(0.4), 100, RESEARCH_CONFIG_DEFAULTS);
    expect(built).not.toBeNull();
    expect(missingIvForStructure("long_straddle", straddleChain(0.4), 100, RESEARCH_CONFIG_DEFAULTS)).toBe(false);
  });

  it("server: a PMCC whose long leg lacks chain IV is not built", () => {
    expect(buildStructure("pmcc", pmccChain(null), 100, RESEARCH_CONFIG_DEFAULTS)).toBeNull();
    expect(buildStructure("pmcc", pmccChain(0.4), 100, RESEARCH_CONFIG_DEFAULTS)).not.toBeNull();
  });

  it("server: scenario rows are empty when any leg lacks IV; valueAtHorizon does not reprice a missing-IV leg", () => {
    const ivLessLeg = {
      optionType: "call", strike: 100, expiry: "2026-12-18", dte: 35,
      bid: 4.8, ask: 5.0, quantity: 1, mid: 4.9,
    } as unknown as StructureEconomics["legs"][number];
    const econ: StructureEconomics = {
      structure: "long_straddle", legs: [ivLessLeg], netDebit: 0, netCredit: 0,
      maxLoss: 4.9, maxGain: null, breakevens: [], derivationNotes: [],
    };
    expect(buildScenarioRows(econ, 100, 0.4, 15, 0.05, 0, { feePerContract: 0, slippagePerContract: 0, contracts: 1 })).toEqual([]);
    // No BS reprice without IV: the leg contributes its market mid, not a 0.4-IV price.
    expect(valueAtHorizon([ivLessLeg], 0, 0, 100, 0, 30 / 365, 0.05, 0)).toBe(4.9);
  });

  it("server discovery: an IV-less chain yields no fabricated ivFit; an IV-bearing chain scores it", async () => {
    // A spread builds from mids (no IV needed to construct it), so the
    // fit code runs in both cases — the only difference is chain IV.
    const mkChain = (iv: number | null): ChainSnapshot => ({
      symbol: "AAA",
      underlyingPrice: 100,
      asOf: NOW - 60_000,
      provenance: "live",
      expiries: [{
        expiry: "2026-12-18",
        dte: 35,
        legs: [
          { optionType: "call", strike: 100, expiry: "2026-12-18", dte: 35, bid: 4.8, ask: 5.0, iv, volume: 200, openInterest: 1000 },
          { optionType: "call", strike: 105, expiry: "2026-12-18", dte: 35, bid: 2.4, ask: 2.6, iv, volume: 200, openInterest: 1000 },
        ],
      }],
    }) as unknown as ChainSnapshot;
    const mkProvider = (chain: ChainSnapshot): ResearchDataProvider => ({
      getUniverseSymbols: async () => ["AAA"],
      getQuote: async () => ({ symbol: "AAA", price: 100, timestamp: NOW, quoteStatus: "live", source: "fixture:quote" }),
      getChain: async () => chain,
      getTechnicals: async () => null,
      getCatalysts: async () => null,
      getRegime: async () => ({}) ,
    }) as unknown as ResearchDataProvider;
    const noIv = await discoverNamesForStrategy(
      { provider: mkProvider(mkChain(null)) },
      RESEARCH_CONFIG_DEFAULTS,
      { symbol: "AAA", outlook: "bullish", structure: "bull_call_spread", symbols: ["AAA"] },
    );
    expect(noIv.ranked.length).toBeGreaterThan(0);
    for (const entry of noIv.ranked) {
      expect(entry.components.ivFit).toBeNull();
      expect(entry.missingComponents).toContain("ivFit");
    }
    const withIv = await discoverNamesForStrategy(
      { provider: mkProvider(mkChain(0.4)) },
      RESEARCH_CONFIG_DEFAULTS,
      { symbol: "AAA", outlook: "bullish", structure: "bull_call_spread", symbols: ["AAA"] },
    );
    expect(withIv.ranked.length).toBeGreaterThan(0);
    for (const entry of withIv.ranked) {
      expect(entry.components.ivFit).not.toBeNull();
    }
  });
});
