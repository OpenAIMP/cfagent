/**
 * Issue #24: the fit gate. Until now a name counted as "fitting" when
 * pickBestTrade returned ANY best candidate — research_only picks, LOW
 * confidence, stale quotes and weak scores all counted and could rank
 * #1. The gate adds configurable minima (composite score, POP, quote
 * freshness, confidence) and three reported buckets: fit / borderline /
 * no fit. In strategy_fit mode (issue #23) `fits` is now the GATED fit
 * set, replacing the #23 screen-pass definition.
 *
 * Pinned semantics:
 *  - evaluateFitGate is pure: each failed criterion contributes one
 *    human reason in a fixed order; thresholds are inclusive (a value
 *    exactly at a minimum passes); a no-trade pick is "no_fit" with the
 *    recommender's rationale; a research-only pick fails on its
 *    blockers — except the stale-quote blocker when freshness is
 *    waived, since that blocker merely restates the freshness fact.
 *  - Scanner wiring: gateBucket/gateReasons ride on opportunity rows
 *    and matrix rows; skipped matrix rows carry a null bucket (never
 *    judged, never "no_fit"); result.gate counts EVALUATED symbols
 *    only; result.borderline lists borderline matrix rows in batch
 *    order in both modes; result.gateParams echoes the resolved gate.
 *  - Defaults (probe-verified on the #30 fixtures): FRESH recommended
 *    picks at spots 40/100/250 score 78.1–78.4 composite with POP
 *    0.446–0.467 (MEDIUM confidence), the lean long-call pick scores
 *    62.05 / POP 0.359 — all clear the default gate (55 / 0.35 /
 *    FRESH / MEDIUM). The same chains STALE score 75.8–76.1 but are
 *    research_only + LOW, so they land borderline on freshness,
 *    confidence and research-only despite the high composite.
 *
 * Fixtures are deterministic (fake screener pattern from
 * tests/options_scanner.test.ts, extended with per-symbol quote
 * freshness). No live market data, no network.
 */
import { describe, expect, it } from "vitest";
import {
  OpportunityScanner,
  evaluateFitGate,
  type FitGateParams,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";
import type { BestTradePick } from "../src/trading/options/recommendationAgent";
import { parseOptionsStrategyIntent, runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

const DEFAULT_GATE: FitGateParams = {
  minCompositeScore: 55,
  minProbabilityOfProfit: 0.35,
  requireFresh: true,
  minConfidence: "MEDIUM",
};

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

// --- evaluateFitGate unit fixtures

function makePick(overrides: {
  status?: BestTradePick["status"];
  confidence?: BestTradePick["confidence"];
  compositeScore?: number;
  pop?: number;
  freshness?: "FRESH" | "STALE" | "UNKNOWN";
  blockers?: string[];
  rationale?: string[];
  withBest?: boolean;
} = {}): BestTradePick {
  const withBest = overrides.withBest ?? true;
  return {
    status: overrides.status ?? "recommended",
    riskProfile: "balanced",
    confidence: overrides.confidence ?? "HIGH",
    ...(withBest
      ? {
          best: {
            candidate: {
              modelImpliedProbabilityOfProfit: overrides.pop ?? 0.5,
              dataFreshness: overrides.freshness ?? "FRESH",
            },
            rank: 1,
            compositeScore: overrides.compositeScore ?? 80,
            components: {},
          },
        }
      : {}),
    alternatives: [],
    rationale: overrides.rationale ?? [],
    blockers: overrides.blockers ?? [],
    humanApprovalRequired: true,
    disclaimer: "fixture",
  } as unknown as BestTradePick;
}

describe("evaluateFitGate (issue #24)", () => {
  it("passes a pick that clears every criterion", () => {
    expect(evaluateFitGate(makePick(), DEFAULT_GATE)).toEqual({ bucket: "fit", reasons: [] });
  });

  it("treats thresholds as inclusive: values exactly at the minima pass", () => {
    const pick = makePick({ compositeScore: 55, pop: 0.35, confidence: "MEDIUM" });
    expect(evaluateFitGate(pick, DEFAULT_GATE)).toEqual({ bucket: "fit", reasons: [] });
  });

  it("fails composite alone, with its reason", () => {
    const out = evaluateFitGate(makePick({ compositeScore: 54.2 }), DEFAULT_GATE);
    expect(out.bucket).toBe("borderline");
    expect(out.reasons).toEqual(["composite score 54.2 below minimum 55"]);
  });

  it("fails POP alone, with its reason", () => {
    const out = evaluateFitGate(makePick({ pop: 0.3 }), DEFAULT_GATE);
    expect(out.bucket).toBe("borderline");
    expect(out.reasons).toEqual(["probability of profit 30.0% below minimum 35%"]);
  });

  it("fails freshness alone when fresh quotes are required", () => {
    // Unit-isolated: a real STALE best candidate is always research_only
    // + LOW as well (see the scanner-level tests); the gate evaluates
    // each criterion independently.
    const out = evaluateFitGate(makePick({ freshness: "STALE" }), DEFAULT_GATE);
    expect(out.bucket).toBe("borderline");
    expect(out.reasons).toEqual(["quote data is STALE"]);
    expect(evaluateFitGate(makePick({ freshness: "UNKNOWN" }), DEFAULT_GATE).reasons)
      .toEqual(["quote data is UNKNOWN"]);
    // Waived: no freshness reason.
    expect(evaluateFitGate(makePick({ freshness: "STALE" }), { ...DEFAULT_GATE, requireFresh: false }))
      .toEqual({ bucket: "fit", reasons: [] });
  });

  it("fails confidence alone, in LOW < MEDIUM < HIGH order", () => {
    expect(evaluateFitGate(makePick({ confidence: "LOW" }), DEFAULT_GATE).reasons)
      .toEqual(["confidence LOW below minimum MEDIUM"]);
    expect(evaluateFitGate(makePick({ confidence: "MEDIUM" }), { ...DEFAULT_GATE, minConfidence: "HIGH" }).reasons)
      .toEqual(["confidence MEDIUM below minimum HIGH"]);
    expect(evaluateFitGate(makePick({ confidence: "LOW" }), { ...DEFAULT_GATE, minConfidence: "LOW" }))
      .toEqual({ bucket: "fit", reasons: [] });
  });

  it("fails a research-only pick on its blockers — one reason, at most two blockers listed", () => {
    const pick = makePick({
      status: "research_only",
      blockers: [
        "No positive maximum profit after fees.",
        "Model-implied probability of profit is below 20%.",
        "a third blocker that must not be listed",
      ],
    });
    const out = evaluateFitGate(pick, DEFAULT_GATE);
    expect(out.bucket).toBe("borderline");
    expect(out.reasons).toEqual([
      "pick is research-only (blockers present): No positive maximum profit after fees.; Model-implied probability of profit is below 20%.",
    ]);
  });

  it("accumulates every failed criterion in a fixed order", () => {
    const pick = makePick({
      status: "research_only",
      confidence: "LOW",
      compositeScore: 40,
      pop: 0.2,
      freshness: "STALE",
      blockers: ["Quote data is STALE; refresh quotes before considering this trade."],
    });
    expect(evaluateFitGate(pick, DEFAULT_GATE)).toEqual({
      bucket: "borderline",
      reasons: [
        "composite score 40.0 below minimum 55",
        "probability of profit 20.0% below minimum 35%",
        "quote data is STALE",
        "confidence LOW below minimum MEDIUM",
        "pick is research-only (blockers present): Quote data is STALE; refresh quotes before considering this trade.",
      ],
    });
  });

  it("maps a no-trade pick to no_fit with the recommender's rationale", () => {
    const pick = makePick({
      status: "no_trade",
      withBest: false,
      rationale: ["No XYZ strategy satisfied the bullish thesis, risk cap and reward/risk minimum."],
    });
    expect(evaluateFitGate(pick, DEFAULT_GATE)).toEqual({
      bucket: "no_fit",
      reasons: ["No XYZ strategy satisfied the bullish thesis, risk cap and reward/risk minimum."],
    });
    // No rationale at all → the standing fallback string.
    expect(evaluateFitGate(makePick({ status: "no_trade", withBest: false }), DEFAULT_GATE))
      .toEqual({ bucket: "no_fit", reasons: ["No qualifying strategy"] });
  });

  it("waiving freshness also waives the stale-quote blocker — but no other blocker", () => {
    const waived: FitGateParams = { minCompositeScore: 0, minProbabilityOfProfit: 0, requireFresh: false, minConfidence: "LOW" };
    const stalePick = makePick({
      status: "research_only",
      confidence: "LOW",
      freshness: "STALE",
      blockers: ["Quote data is STALE; refresh quotes before considering this trade."],
    });
    expect(evaluateFitGate(stalePick, waived)).toEqual({ bucket: "fit", reasons: [] });
    // A blocker no gate parameter waives still disqualifies the pick.
    const profitBlocked = makePick({
      status: "research_only",
      confidence: "LOW",
      freshness: "STALE",
      blockers: [
        "Quote data is STALE; refresh quotes before considering this trade.",
        "No positive maximum profit after fees.",
      ],
    });
    expect(evaluateFitGate(profitBlocked, waived)).toEqual({
      bucket: "borderline",
      reasons: ["pick is research-only (blockers present): No positive maximum profit after fees."],
    });
  });
});

// --- Scanner-level fixtures (fake screener with per-symbol freshness)

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

const FULL_MULTS = [0.9, 0.95, 1, 1.05, 1.1];

function makeContracts(
  symbol: string,
  spot: number,
  freshness: "FRESH" | "STALE",
): ScreenedOptionContractItem[] {
  const now = Date.now();
  return FULL_MULTS.flatMap((mult) => {
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
      quoteAgeSeconds: freshness === "FRESH" ? 0 : 7200,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: freshness,
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

type SymbolBehavior =
  | { kind: "trade"; spot: number; freshness?: "FRESH" | "STALE" }
  | { kind: "empty"; validationError?: string };

const trade = (spot: number, freshness: "FRESH" | "STALE" = "FRESH"): SymbolBehavior => ({ kind: "trade", spot, freshness });

function fakeScreener(behaviors: Record<string, SymbolBehavior>): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      const behavior = behaviors[symbol] ?? trade(100);
      if (behavior.kind === "empty") {
        return {
          contracts: [],
          matchedCount: 0,
          totalContractsEvaluated: 0,
          totalUnderlyingsScanned: 1,
          scannedAt: new Date().toISOString(),
          rejections: [],
          ...(behavior.validationError ? { validationError: behavior.validationError } : {}),
        } as unknown as OptionScreenResult;
      }
      const contracts = makeContracts(symbol, behavior.spot, behavior.freshness ?? "FRESH");
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

describe("OpportunityScanner fit gate (issue #24)", () => {
  it("G1. strategy_fit: a FRESH pick fits; a STALE pick is borderline, not a fit", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ FRESH1: trade(100), STALE1: trade(100, "STALE") }));
    const result = await scanner.scan(["FRESH1", "STALE1"], baseTemplate(), { mode: "strategy_fit" });

    // Only the gated fit is returned as a fit.
    expect(result.fitsTotal).toBe(1);
    expect(result.fits.map((f) => f.symbol)).toEqual(["FRESH1"]);
    // The stale name is reported as borderline, in batch order, with the
    // freshness + confidence + research-only reasons (its composite and
    // POP clear the bar — staleness is what disqualifies it).
    expect(result.borderline.map((b) => b.symbol)).toEqual(["STALE1"]);
    expect(result.borderline[0].gateReasons).toEqual([
      "quote data is STALE",
      "confidence LOW below minimum MEDIUM",
      "pick is research-only (blockers present): Quote data is STALE; refresh quotes before considering this trade.",
    ]);
    // Accounting + provenance.
    expect(result.gate).toEqual({ fit: 1, borderline: 1, noFit: 0 });
    expect(result.gateParams).toEqual(DEFAULT_GATE);
    // The matrix carries the buckets; the #22 screen-pass verdict is a
    // separate layer and still says "pass" for both.
    const bySymbol = new Map(result.matrix.map((m) => [m.symbol, m]));
    expect(bySymbol.get("FRESH1")).toMatchObject({ verdict: "pass", gateBucket: "fit", gateReasons: [] });
    expect(bySymbol.get("STALE1")).toMatchObject({ verdict: "pass", gateBucket: "borderline" });
    expect(result.fits[0]).toBe(bySymbol.get("FRESH1"));
  });

  it("G2. per_name_best: both picks stay in opportunities, gate info riding on each row", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ FRESH1: trade(100), STALE1: trade(100, "STALE") }));
    const result = await scanner.scan(["FRESH1", "STALE1"], baseTemplate());

    expect(result.mode).toBe("per_name_best");
    expect(result.opportunities.map((o) => o.symbol).sort()).toEqual(["FRESH1", "STALE1"]);
    const freshRow = result.opportunities.find((o) => o.symbol === "FRESH1")!;
    expect(freshRow.gateBucket).toBe("fit");
    expect(freshRow.gateReasons).toEqual([]);
    const staleRow = result.opportunities.find((o) => o.symbol === "STALE1")!;
    expect(staleRow.gateBucket).toBe("borderline");
    expect(staleRow.gateReasons).toContain("quote data is STALE");
    // fits stay a strategy_fit-mode surface, but the gate accounting and
    // the borderline list are reported in both modes.
    expect(result.fits).toEqual([]);
    expect(result.fitsTotal).toBe(0);
    expect(result.gate).toEqual({ fit: 1, borderline: 1, noFit: 0 });
    expect(result.borderline.map((b) => b.symbol)).toEqual(["STALE1"]);
  });

  it("G3. a full gate override makes the stale pick fit, and gateParams echoes it", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ STALE1: trade(100, "STALE") }));
    const override: FitGateParams = { minCompositeScore: 0, minProbabilityOfProfit: 0, requireFresh: false, minConfidence: "LOW" };
    const result = await scanner.scan(["STALE1"], baseTemplate(), { mode: "strategy_fit", fitGate: override });

    expect(result.fitsTotal).toBe(1);
    expect(result.fits.map((f) => f.symbol)).toEqual(["STALE1"]);
    expect(result.matrix[0]).toMatchObject({ gateBucket: "fit", gateReasons: [] });
    expect(result.gate).toEqual({ fit: 1, borderline: 0, noFit: 0 });
    expect(result.gateParams).toEqual(override);
  });

  it("G4. a partial override merges over the defaults and can push a fresh pick to borderline", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ FRESH1: trade(100) }));
    const result = await scanner.scan(["FRESH1"], baseTemplate(), { fitGate: { minCompositeScore: 99 } });

    const row = result.opportunities[0];
    expect(row.gateBucket).toBe("borderline");
    expect(row.gateReasons).toEqual([`composite score ${row.score.toFixed(1)} below minimum 99`]);
    // The untouched parameters fall back to the config defaults.
    expect(result.gateParams).toEqual({ ...DEFAULT_GATE, minCompositeScore: 99 });
  });

  it("G5. gate counts partition the EVALUATED symbols; skipped rows are never judged", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      FRESH1: trade(100),
      STALE1: trade(100, "STALE"),
      EMPTY1: { kind: "empty", validationError: "No chains available for EMPTY1" },
    }));
    const result = await scanner.scan(["FRESH1", "STALE1", "EMPTY1"], baseTemplate(), { mode: "strategy_fit" });

    expect(result.scanned).toBe(3);
    expect(result.gate).toEqual({ fit: 1, borderline: 1, noFit: 0 });
    // fit + borderline + noFit == evaluated == scanned − skipped.
    expect(result.gate.fit + result.gate.borderline + result.gate.noFit).toBe(2);
    const skippedRow = result.matrix.find((m) => m.symbol === "EMPTY1")!;
    expect(skippedRow.verdict).toBe("skipped");
    expect(skippedRow.gateBucket).toBeNull();
    expect(skippedRow.gateReasons).toEqual([]);
  });

  it("G6. the borderline list follows batch order, not score order", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      STB: trade(100, "STALE"),
      FRESH1: trade(100),
      STA: trade(100, "STALE"),
    }));
    const result = await scanner.scan(["STB", "FRESH1", "STA"], baseTemplate());
    expect(result.borderline.map((b) => b.symbol)).toEqual(["STB", "STA"]);
  });

  it("G7. an evaluated symbol with no pick is gate no_fit, with the rationale as its reasons", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ AAA: trade(100) }));
    // Impossible screen floor: the symbol is evaluated, nothing matches.
    const result = await scanner.scan(["AAA"], baseTemplate(), {
      mode: "strategy_fit",
      strategyFilter: { minProbabilityOfProfit: 1.01 },
    });

    expect(result.gate).toEqual({ fit: 0, borderline: 0, noFit: 1 });
    expect(result.matrix[0].gateBucket).toBe("no_fit");
    expect(result.matrix[0].gateReasons).toEqual([
      "No AAA strategy satisfied the bullish thesis, risk cap and reward/risk minimum.",
    ]);
    expect(result.fits).toEqual([]);
    expect(result.fitsTotal).toBe(0);
    expect(result.borderline).toEqual([]);
  });
});

// --- NLQ level: the summary's accounting sentence and Gate segment
// --- carry the gated bucket counts end to end. Same stub-client harness
// --- as tests/options_scanner.test.ts, with a stale-timestamp chain for
// --- the borderline name (the real screener derives STALE from the
// --- quote timestamp).

function chainFor(symbol: string, spot: number, expiry: { year: number; month: number; day: number }, tsOffsetMs: number): ETradeOptionChain {
  const quoteTimestamp = Date.now() + tsOffsetMs;
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

describe("NLQ fit gate wiring (issue #24)", () => {
  it("reports the gated buckets in the fit-mode summary and rows only the fits", async () => {
    const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
    const expiry = { year: expiryDateObj.getUTCFullYear(), month: expiryDateObj.getUTCMonth() + 1, day: expiryDateObj.getUTCDate() };
    const chains: Record<string, ETradeOptionChain> = {
      FRESH1: chainFor("FRESH1", 100, expiry, 0),
      STALE1: chainFor("STALE1", 100, expiry, -2 * 3_600_000),
    };
    const client = {
      getOptionExpireDates: async () => [expiry],
      getOptionChains: async (args: { symbol: string }) => chains[args.symbol] ?? null,
    };
    const etrade = {
      client: client as never,
      fetchQuoteRemote: async () => ({ lastPrice: 0 }),
      getWatchlists: async () => [{ name: "Semis", symbols: ["FRESH1", "STALE1"] }],
      screenMarketsAsync: async () => ({ stocks: [] }),
    };
    const intent = parseOptionsStrategyIntent("Which names in my Semis watchlist fit a bullish strategy? max loss $5000");
    expect(intent?.filters.mode).toBe("strategy_fit");

    const out = await runOptionsStrategyAction(etrade as never, intent!.action, intent!.filters);

    expect(out.summary).toContain("2 names accounted — 1 fit, 1 borderline, 0 no fit, 0 skipped.");
    expect(out.summary).toContain("Gate: 1 fit, 1 borderline, 0 no fit (min score 55, min POP 35%, fresh quotes required).");
    // Rows cover the fits only — the borderline name is accounted in the
    // summary and the matrix, not presented as a fit row.
    expect(out.rows.map((r) => r.symbol)).toEqual(["FRESH1"]);
    const staleRow = out.matrix!.find((m) => m.symbol === "STALE1")!;
    expect(staleRow.gateBucket).toBe("borderline");
    expect(staleRow.gateReasons[0]).toBe("quote data is STALE");
  });
});
