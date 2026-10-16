/**
 * Issue #30: direct unit tests for OpportunityScanner.scan — the component
 * that answers "which names fit my strategy?". Until now only NLQ routing
 * tests existed (with the pipeline stubbed), so scanner semantics were
 * unpinned and could regress silently.
 *
 * Pinned semantics (numbered as in the issue/SSOT enumeration):
 *  1. Best-per-name reduction — at most one row per symbol; the row's score
 *     is that symbol's best pick compositeScore.
 *  2. Ranking order — score descending; ties broken by symbol ascending.
 *  3. MAX_SCAN_SYMBOLS truncation + coverage reporting — symbols past the
 *     cap are counted in truncatedSymbols and never evaluated.
 *  4. Coverage counts — withTrades counts qualifying symbols BEFORE the
 *     top-N slice.
 *  5. Top-N limit semantics — default limit 10; explicit limit respected.
 *  6. Symbol normalization — case/whitespace/duplicate variants collapse.
 *  7. Skip reasons — no contracts (validation error / fetch error / bare),
 *     no qualifying strategy, and load failure each surface their reason.
 *  8. Empty input — a scan of nothing is a well-formed empty result.
 *
 * Stated-target scoping is NOT re-tested here; it is pinned by
 * tests/options_scanner_targets.test.ts (issue #19).
 *
 * Fixtures are deterministic: a fake screener (pattern from
 * tests/options_agents.test.ts) serves canned chains keyed by symbol, with
 * per-symbol behaviors — trade at a spot, empty screen (with optional
 * validation/fetch error), or throw. No live market data, no network.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SCAN_SYMBOLS,
  OpportunityScanner,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

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

/** Leaner template for the many-symbol tests: one strategy type keeps the
 *  candidate build cheap while still producing a qualifying pick. */
function leanTemplate(): ScanRequestTemplate {
  return baseTemplate({ allowedStrategies: ["long_call"] });
}

// --- Fake chain builder (same economics as tests/options_scanner_targets.test.ts)

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

const FULL_MULTS = [0.9, 0.95, 1, 1.05, 1.1];
const LEAN_MULTS = [0.95, 1, 1.05];

function makeContracts(symbol: string, spot: number, mults: number[] = FULL_MULTS): ScreenedOptionContractItem[] {
  const now = Date.now();
  return mults.flatMap((mult) => {
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

// --- Behavior-driven fake screener

type SymbolBehavior =
  | { kind: "trade"; spot: number }
  | { kind: "empty"; validationError?: string; fetchErrorReason?: string }
  | { kind: "throw"; message: string }
  | { kind: "throwRaw"; value: unknown };

const trade = (spot: number): SymbolBehavior => ({ kind: "trade", spot });

function fakeScreener(
  behaviors: Record<string, SymbolBehavior>,
  opts: { mults?: number[]; calls?: string[] } = {},
): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      opts.calls?.push(symbol);
      const behavior = behaviors[symbol] ?? trade(100);
      if (behavior.kind === "throw") throw new Error(behavior.message);
      if (behavior.kind === "throwRaw") throw behavior.value;
      if (behavior.kind === "empty") {
        return {
          contracts: [],
          matchedCount: 0,
          totalContractsEvaluated: 0,
          totalUnderlyingsScanned: 1,
          scannedAt: new Date().toISOString(),
          rejections: [],
          ...(behavior.validationError ? { validationError: behavior.validationError } : {}),
          ...(behavior.fetchErrorReason ? { fetchErrors: [{ symbol, reason: behavior.fetchErrorReason }] } : {}),
        } as unknown as OptionScreenResult;
      }
      const contracts = makeContracts(symbol, behavior.spot, opts.mults);
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

const padded = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, "0")}`;

describe("OpportunityScanner.scan (issue #30)", () => {
  it("1. reduces each symbol to its single best pick", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ AAA: trade(100), BBB: trade(250), CCC: trade(40) }));
    const result = await scanner.scan(["AAA", "BBB", "CCC"], baseTemplate());

    expect(result.withTrades).toBe(3);
    // At most one row per symbol.
    expect(result.opportunities).toHaveLength(3);
    expect(new Set(result.opportunities.map((o) => o.symbol)).size).toBe(3);
    for (const row of result.opportunities) {
      // The pipeline ranked several strategies per symbol (best + alternatives);
      // the row carries only the #1 pick and its composite score.
      expect(row.pick.best).toBeDefined();
      expect(row.pick.best!.rank).toBe(1);
      expect(row.pick.alternatives.length).toBeGreaterThan(0);
      expect(row.score).toBe(row.pick.best!.compositeScore);
      for (const alt of row.pick.alternatives) {
        expect(row.score).toBeGreaterThanOrEqual(alt.compositeScore);
      }
    }
  });

  it("2a. ranks rows by score descending", async () => {
    // Fixture economics: at these spots the best-pick scores separate
    // strictly (spot 100 > spot 250 > spot 40). Input is worst-first so the
    // asserted order can only come from the scanner's sort.
    const scanner = new OpportunityScanner(fakeScreener({ S40: trade(40), S250: trade(250), S100: trade(100) }));
    const result = await scanner.scan(["S40", "S250", "S100"], baseTemplate());

    expect(result.opportunities.map((o) => o.symbol)).toEqual(["S100", "S250", "S40"]);
    const scores = result.opportunities.map((o) => o.score);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it("2b. breaks score ties by symbol ascending", async () => {
    // Identical fixtures at an identical spot produce identical scores;
    // input order is shuffled so only the tie-break can order the rows.
    const scanner = new OpportunityScanner(fakeScreener({ ZZA: trade(100), ZZB: trade(100), ZZC: trade(100) }));
    const result = await scanner.scan(["ZZB", "ZZC", "ZZA"], baseTemplate());

    expect(result.opportunities.map((o) => o.symbol)).toEqual(["ZZA", "ZZB", "ZZC"]);
    const scores = result.opportunities.map((o) => o.score);
    expect(scores[0]).toBe(scores[1]);
    expect(scores[1]).toBe(scores[2]);
  });

  it("3. truncates at MAX_SCAN_SYMBOLS and never evaluates the excess", async () => {
    const total = MAX_SCAN_SYMBOLS + 3;
    const symbols = Array.from({ length: total }, (_, i) => padded("N", i + 1));
    const behaviors: Record<string, SymbolBehavior> = {};
    for (const s of symbols) behaviors[s] = trade(100);
    const calls: string[] = [];
    const scanner = new OpportunityScanner(fakeScreener(behaviors, { mults: LEAN_MULTS, calls }));

    const result = await scanner.scan(symbols, leanTemplate());

    expect(result.scanned).toBe(MAX_SCAN_SYMBOLS);
    expect(result.truncatedSymbols).toBe(3);
    // The screener saw exactly the first MAX_SCAN_SYMBOLS symbols, once each.
    expect(calls).toHaveLength(MAX_SCAN_SYMBOLS);
    expect([...calls].sort()).toEqual(symbols.slice(0, MAX_SCAN_SYMBOLS).sort());
    // Truncated symbols surface nowhere in the result.
    const excess = symbols.slice(MAX_SCAN_SYMBOLS);
    for (const s of excess) {
      expect(calls).not.toContain(s);
      expect(result.opportunities.map((o) => o.symbol)).not.toContain(s);
      expect(result.skipped.map((k) => k.symbol)).not.toContain(s);
    }
  });

  it("4. counts withTrades before the top-N slice", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ AAA: trade(250), BBB: trade(40) }));
    const result = await scanner.scan(["AAA", "BBB"], baseTemplate(), { limit: 1 });

    expect(result.scanned).toBe(2);
    expect(result.withTrades).toBe(2); // both qualified, even though only one row survives
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0].symbol).toBe("AAA"); // the higher-scored of the two
  });

  it("5a. applies the default limit of 10", async () => {
    const symbols = Array.from({ length: 12 }, (_, i) => padded("T", i + 1));
    const behaviors: Record<string, SymbolBehavior> = {};
    for (const s of symbols) behaviors[s] = trade(100);
    const scanner = new OpportunityScanner(fakeScreener(behaviors, { mults: LEAN_MULTS }));

    // Reversed input: with identical scores the surviving rows are decided
    // by the symbol tie-break, not by input order.
    const result = await scanner.scan([...symbols].reverse(), leanTemplate());

    expect(result.withTrades).toBe(12);
    expect(result.opportunities).toHaveLength(10);
    expect(result.opportunities.map((o) => o.symbol)).toEqual(symbols.slice(0, 10));
  });

  it("5b. respects an explicit limit", async () => {
    const symbols = Array.from({ length: 5 }, (_, i) => padded("L", i + 1));
    const behaviors: Record<string, SymbolBehavior> = {};
    for (const s of symbols) behaviors[s] = trade(100);
    const scanner = new OpportunityScanner(fakeScreener(behaviors, { mults: LEAN_MULTS }));

    const result = await scanner.scan(symbols, leanTemplate(), { limit: 3 });

    expect(result.withTrades).toBe(5);
    expect(result.opportunities).toHaveLength(3);
    expect(result.opportunities.map((o) => o.symbol)).toEqual(symbols.slice(0, 3));
  });

  it("6. collapses duplicate and case/whitespace variants into one symbol", async () => {
    const calls: string[] = [];
    const scanner = new OpportunityScanner(fakeScreener({ CL1: trade(100), CL2: trade(100) }, { calls }));
    const result = await scanner.scan(["cl1", " CL1 ", "CL1", "cl2", "CL2 "], baseTemplate());

    expect(result.scanned).toBe(2);
    expect(result.truncatedSymbols).toBe(0);
    expect([...calls].sort()).toEqual(["CL1", "CL2"]); // normalized before evaluation
    expect(result.opportunities.map((o) => o.symbol)).toEqual(["CL1", "CL2"]);
  });

  it("7a. reports the screen's reason for symbols with no eligible contracts", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      GOOD: trade(100),
      VE: { kind: "empty", validationError: "No chains available for VE" },
      FE: { kind: "empty", fetchErrorReason: "broker timeout" },
      BARE: { kind: "empty" },
      ERR: { kind: "throw", message: "upstream exploded" },
    }));
    const result = await scanner.scan(["GOOD", "VE", "FE", "BARE", "ERR"], baseTemplate());

    expect(result.scanned).toBe(5);
    expect(result.withTrades).toBe(1);
    expect(result.opportunities.map((o) => o.symbol)).toEqual(["GOOD"]);
    // skipped order follows completion order under concurrency — compare as a map.
    const reasons = new Map(result.skipped.map((k) => [k.symbol, k.reason]));
    expect(reasons).toEqual(new Map([
      ["VE", "No chains available for VE"], // snapshot validationError
      ["FE", "broker timeout"], // screen fetchErrors[0].reason
      ["BARE", "No eligible option contracts"], // bare fallback
      ["ERR", "upstream exploded"], // load failure surfaces the error message
    ]));
    // Rows and skips partition the scanned batch.
    expect(result.withTrades + result.skipped.length).toBe(result.scanned);
  });

  it("7b. prefers the validation error over a fetch error when both are present", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      BOTH: { kind: "empty", validationError: "validation reason", fetchErrorReason: "fetch reason" },
    }));
    const result = await scanner.scan(["BOTH"], baseTemplate());

    expect(result.skipped).toEqual([{ symbol: "BOTH", reason: "validation reason" }]);
  });

  it("7c. skips symbols whose contracts yield no qualifying strategy, with the pick rationale", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ GOOD: trade(100) }));
    // A screen filter no candidate can satisfy empties the matched set, so
    // the recommender's no-trade rationale becomes the skip reason.
    const result = await scanner.scan(["GOOD"], baseTemplate(), {
      strategyFilter: { minProbabilityOfProfit: 1.01 },
    });

    expect(result.withTrades).toBe(0);
    expect(result.opportunities).toEqual([]);
    expect(result.skipped).toEqual([
      { symbol: "GOOD", reason: "No GOOD strategy satisfied the bullish thesis, risk cap and reward/risk minimum." },
    ]);
  });

  it("7d. falls back to a generic reason when a load failure is not an Error", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      RAW: { kind: "throwRaw", value: "plain string failure" },
    }));
    const result = await scanner.scan(["RAW"], baseTemplate());

    expect(result.skipped).toEqual([{ symbol: "RAW", reason: "Scan failed" }]);
  });

  it("8. returns a well-formed empty result for empty or all-blank input", async () => {
    const calls: string[] = [];
    const scanner = new OpportunityScanner(fakeScreener({}, { calls }));

    for (const input of [[], ["", "   "]]) {
      const result = await scanner.scan(input, baseTemplate());
      expect(result.scanned).toBe(0);
      expect(result.withTrades).toBe(0);
      expect(result.opportunities).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.truncatedSymbols).toBe(0);
    }
    expect(calls).toEqual([]); // nothing was evaluated
  });
});
