/**
 * Issue #19: a target price stated in a single-name question (e.g. "target
 * $260" for NVDA) must not leak onto every symbol in an opportunity scan.
 *
 * Pinned behavior:
 *  - resolveScanTarget applies a stated target only to the symbol it was
 *    stated for; all other symbols get a thesis-derived target (spot ×
 *    factor).
 *  - A stated target with no symbol attached is applied to NO scanned name.
 *  - scan() stamps each row with its targetSource and discloses the scoping
 *    in result.assumptions.
 *  - The NLQ scan path carries the parsed symbol+target as a scoped
 *    statedTarget and surfaces the disclosure in the summary.
 */
import { describe, expect, it } from "vitest";
import {
  OpportunityScanner,
  resolveScanTarget,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";
import { parseOptionsStrategyIntent, runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function baseTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: expiryDate,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
    minDte: 14,
    maxDte: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    maxQuoteAgeSeconds: 60,
    eventPolicy: "warn",
    ...overrides,
  };
}

describe("resolveScanTarget (issue #19)", () => {
  it("applies a stated target to the symbol it was stated for", () => {
    const template = baseTemplate({ statedTarget: { price: 260, symbol: "EXP" } });
    expect(resolveScanTarget(template, "EXP", 250)).toEqual({ targetPrice: 260, source: "stated" });
  });

  it("matches the stated symbol case-insensitively", () => {
    const template = baseTemplate({ statedTarget: { price: 260, symbol: "exp" } });
    expect(resolveScanTarget(template, "EXP", 250)).toEqual({ targetPrice: 260, source: "stated" });
  });

  it("does NOT apply a stated target to a different symbol — thesis factor instead", () => {
    const template = baseTemplate({ statedTarget: { price: 260, symbol: "EXP" } });
    // The regression: the $40 name used to inherit the $260 target.
    expect(resolveScanTarget(template, "CHP", 40)).toEqual({ targetPrice: 42, source: "thesis" });
  });

  it("applies a symbol-less stated target to no symbol", () => {
    const template = baseTemplate({ statedTarget: { price: 260 } });
    expect(resolveScanTarget(template, "EXP", 250)).toEqual({ targetPrice: 262.5, source: "thesis" });
    expect(resolveScanTarget(template, "CHP", 40)).toEqual({ targetPrice: 42, source: "thesis" });
  });

  it("derives targets from the thesis factor when nothing was stated", () => {
    expect(resolveScanTarget(baseTemplate({ thesis: "bullish" }), "ANY", 200)).toEqual({ targetPrice: 210, source: "thesis" });
    expect(resolveScanTarget(baseTemplate({ thesis: "bearish" }), "ANY", 200)).toEqual({ targetPrice: 190, source: "thesis" });
    expect(resolveScanTarget(baseTemplate({ thesis: "large_move" }), "ANY", 200)).toEqual({ targetPrice: 220, source: "thesis" });
    expect(resolveScanTarget(baseTemplate({ thesis: "range_bound" }), "ANY", 200)).toEqual({ targetPrice: 200, source: "thesis" });
  });
});

// --- Scan-level regression, using the fake-screener pattern from
// --- tests/options_agents.test.ts (screenOptions returns canned contracts).

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

function makeContracts(symbol: string, spot: number): ScreenedOptionContractItem[] {
  const now = Date.now();
  return [0.9, 0.95, 1, 1.05, 1.1].flatMap((mult) => {
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

function fakeScreener(spots: Record<string, number>): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      const contracts = makeContracts(symbol, spots[symbol] ?? 100);
      return {
        contracts,
        matchedCount: contracts.length,
        totalContractsEvaluated: contracts.length,
        totalUnderlyingsScanned: 1,
        scannedAt: new Date().toISOString(),
        rejections: [],
      } as unknown as OptionScreenResult;
    },
  } as unknown as DynamicOptionsScreener;
}

describe("OpportunityScanner stated-target scoping (issue #19)", () => {
  it("scopes a stated target to its symbol and discloses it in assumptions", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ EXP: 250, CHP: 40 }));
    const result = await scanner.scan(["EXP", "CHP"], baseTemplate({ statedTarget: { price: 260, symbol: "EXP" } }));

    expect(result.scanned).toBe(2);
    expect(result.skipped).toEqual([]);
    const exp = result.opportunities.find((o) => o.symbol === "EXP");
    const chp = result.opportunities.find((o) => o.symbol === "CHP");
    expect(exp).toBeDefined();
    expect(chp).toBeDefined();
    expect(exp!.targetPrice).toBe(260);
    expect(exp!.targetSource).toBe("stated");
    // Regression assertion: the cheap name must NOT inherit the $260 target.
    expect(chp!.targetPrice).toBe(42); // 40 × 1.05 bullish factor
    expect(chp!.targetSource).toBe("thesis");
    expect(result.assumptions).toHaveLength(1);
    expect(result.assumptions[0]).toContain("Stated target $260.00 applied to EXP only");
    expect(result.assumptions[0]).toContain("thesis-derived target");
  });

  it("discloses and ignores a stated target that names no symbol", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ EXP: 250, CHP: 40 }));
    const result = await scanner.scan(["EXP", "CHP"], baseTemplate({ statedTarget: { price: 260 } }));

    const exp = result.opportunities.find((o) => o.symbol === "EXP");
    expect(exp).toBeDefined();
    expect(exp!.targetPrice).toBe(262.5); // 250 × 1.05 — the stated 260 was NOT applied
    expect(exp!.targetSource).toBe("thesis");
    expect(result.assumptions).toHaveLength(1);
    expect(result.assumptions[0]).toContain("was stated without a symbol, so it was not applied to any scanned name");
  });

  it("reports no assumptions when no target was stated", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ EXP: 250, CHP: 40 }));
    const result = await scanner.scan(["EXP", "CHP"], baseTemplate());
    expect(result.assumptions).toEqual([]);
    for (const row of result.opportunities) expect(row.targetSource).toBe("thesis");
  });
});

// --- NLQ-level: the parsed symbol+target reach the scan scoped, and the
// --- disclosure lands in the user-facing summary. The scan runs through the
// --- real DynamicOptionsScreener over a stub E*TRADE client (the pattern
// --- from tests/options_scanner_watchlists.test.ts).

function chainFor(symbol: string, spot: number, expiry: { year: number; month: number; day: number }): ETradeOptionChain {
  const quoteTimestamp = Date.now();
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(spot, strike, type);
    const deltaMag = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      optionType: type,
      strikePrice: strike,
      symbol: `${symbol}${strike}${type === "CALL" ? "C" : "P"}`,
      bid: Math.max(0.05, mid - 0.1),
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? deltaMag : -deltaMag,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiry,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

describe("NLQ opportunity scan stated-target wiring (issue #19)", () => {
  it("scopes the parsed target to the named symbol and discloses it in the summary", async () => {
    const intent = parseOptionsStrategyIntent("Best bullish option trades for NVDA and AMD target $260 max loss $5000");
    expect(intent?.action).toBe("options_opportunities");
    expect(intent?.filters.request).toMatchObject({ symbol: "NVDA", targetPrice: 260 });

    const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
    const expiry = { year: expiryDateObj.getUTCFullYear(), month: expiryDateObj.getUTCMonth() + 1, day: expiryDateObj.getUTCDate() };
    const spots: Record<string, number> = { NVDA: 250, AMD: 40 };
    const client = {
      getOptionExpireDates: async () => [expiry],
      getOptionChains: async (args: { symbol: string }) => chainFor(args.symbol, spots[args.symbol] ?? 100, expiry),
    };
    const etrade = {
      client: client as never,
      fetchQuoteRemote: async () => ({ lastPrice: 0 }),
      getWatchlists: async () => [],
      screenMarketsAsync: async () => ({ stocks: [] }),
    };

    const out = await runOptionsStrategyAction(etrade as never, intent!.action, intent!.filters);
    expect(out.status).toBe("ranked_opportunities");
    expect(out.count).toBeGreaterThan(0);
    expect(out.summary).toContain("Stated target $260.00 applied to NVDA only");
    expect(out.summary).toContain("thesis-derived target (spot × 1.05 for bullish)");
  });
});
