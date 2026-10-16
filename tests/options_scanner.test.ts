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
 * Issue #22 additions (second describe block onward): the names ×
 * strategy-types fit matrix — one row per scanned symbol in batch order,
 * per-type evaluated/passed/rejected counts with rejection-reason
 * histograms, per-type best candidates, pass / no_pass / skipped verdicts —
 * plus the NLQ wiring: the full skipped list and matrix on the result
 * object and the "Fits by strategy type:" sentence in the summary.
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

describe("OpportunityScanner.scan fit matrix (issue #22)", () => {
  it("M1. returns a matrix row per symbol with per-type evaluated/passed/rejected counts", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ AAA: trade(100), BBB: trade(250) }));
    // Input order is BBB-first: the matrix follows batch (input) order,
    // unlike opportunities which are score-ordered.
    const result = await scanner.scan(["BBB", "AAA"], baseTemplate());

    expect(result.matrix.map((m) => m.symbol)).toEqual(["BBB", "AAA"]);
    const aaa = result.matrix[1];
    expect(aaa.verdict).toBe("pass");
    expect(aaa.skipReason).toBeUndefined();
    expect(aaa.targetPrice).toBe(105); // 100 × 1.05 bullish thesis factor
    expect(aaa.targetSource).toBe("thesis");

    // Fixture economics (probe-verified): the default template builds three
    // strategy types and the unfiltered screen passes every candidate.
    const byType = new Map(aaa.cells.map((c) => [c.strategyType, c]));
    expect([...byType.keys()].sort()).toEqual(["call_debit_spread", "long_call", "put_credit_spread"]);
    expect(byType.get("call_debit_spread")).toMatchObject({ evaluatedCount: 7, passedCount: 7, rejectedCount: 0, rejectionReasons: {} });
    expect(byType.get("put_credit_spread")).toMatchObject({ evaluatedCount: 7, passedCount: 7, rejectedCount: 0, rejectionReasons: {} });
    expect(byType.get("long_call")).toMatchObject({ evaluatedCount: 3, passedCount: 3, rejectedCount: 0, rejectionReasons: {} });
    for (const cell of aaa.cells) {
      expect(cell.evaluatedCount).toBe(cell.passedCount + cell.rejectedCount);
      expect(cell.best).not.toBeNull();
      expect(cell.best!.candidateId).toBeTruthy();
      expect(cell.best!.legs.length).toBeGreaterThan(0);
      expect(cell.best!.compositeScore).toBeGreaterThan(0);
    }
    // The BBB row has the same three types (counts differ with spot).
    expect(result.matrix[0].cells.map((c) => c.strategyType).sort()).toEqual(["call_debit_spread", "long_call", "put_credit_spread"]);
    expect(result.matrix[0].verdict).toBe("pass");
  });

  it("M2. cell best is the type's highest-composite candidate and agrees with the pick", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ AAA: trade(100) }));
    const result = await scanner.scan(["AAA"], baseTemplate());

    const row = result.matrix[0];
    // Cells are ordered by best compositeScore descending.
    const composites = row.cells.map((c) => c.best!.compositeScore);
    expect(composites).toEqual([...composites].sort((a, b) => b - a));
    // The top cell is the same candidate the legacy pick path chose, at the
    // same composite score — the matrix and the pick can never disagree.
    const top = row.cells[0];
    expect(top.strategyType).toBe("call_debit_spread"); // fixture economics: the winning type at spot 100
    expect(top.best!.candidateId).toBe(result.opportunities[0].pick.best!.candidate.id);
    expect(top.best!.compositeScore).toBe(result.opportunities[0].score);
    // best mirrors the candidate's own fields.
    const candidate = result.opportunities[0].pick.best!.candidate;
    expect(top.best).toMatchObject({
      label: candidate.label,
      score: candidate.score,
      expirationDate: candidate.expirationDate,
      netDebit: candidate.netDebit,
      maxLoss: candidate.maxLoss,
      maxProfit: candidate.maxProfit,
      maxProfitUnbounded: candidate.maxProfitUnbounded,
      targetRewardRisk: candidate.targetRewardRisk,
      probabilityOfProfit: candidate.modelImpliedProbabilityOfProfit,
    });
    expect(top.best!.legs).toEqual(candidate.legs);
  });

  it("M3. cell ordering is deterministic across identical scans", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ AAA: trade(100), BBB: trade(250) }));
    const project = (r: Awaited<ReturnType<OpportunityScanner["scan"]>>) =>
      r.matrix.map((m) => [
        m.symbol,
        m.verdict,
        m.cells.map((c) => [c.strategyType, c.evaluatedCount, c.passedCount, c.rejectedCount, c.best?.compositeScore ?? null]),
      ]);
    const first = await scanner.scan(["AAA", "BBB"], baseTemplate());
    const second = await scanner.scan(["AAA", "BBB"], baseTemplate());
    expect(project(second)).toEqual(project(first));
    // Best-less cells sort after cells with a best (covered structurally in
    // M4/M5); within one scan, composites never increase along the row.
    for (const row of first.matrix) {
      const withBest = row.cells.filter((c) => c.best).map((c) => c.best!.compositeScore);
      expect(withBest).toEqual([...withBest].sort((a, b) => b - a));
    }
  });

  it("M4. a symbol screened to nothing is no_pass with rejection counts and reasons", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ AAA: trade(100) }));
    // Impossible PoP floor: every built candidate is rejected by the screen.
    const result = await scanner.scan(["AAA"], baseTemplate(), {
      strategyFilter: { minProbabilityOfProfit: 1.01 },
    });

    expect(result.opportunities).toEqual([]);
    const row = result.matrix[0];
    expect(row.symbol).toBe("AAA");
    expect(row.verdict).toBe("no_pass");
    expect(row.skipReason).toBeUndefined();
    expect(row.targetPrice).toBe(105); // evaluated, so the target was resolved
    expect(row.cells.length).toBeGreaterThanOrEqual(2);
    for (const cell of row.cells) {
      expect(cell.passedCount).toBe(0);
      expect(cell.best).toBeNull();
      expect(cell.rejectedCount).toBe(cell.evaluatedCount);
      expect(cell.rejectedCount).toBeGreaterThan(0);
      // Every rejection is accounted for in the reason histogram.
      expect(Object.values(cell.rejectionReasons).reduce((a, b) => a + b, 0)).toBe(cell.rejectedCount);
      for (const reason of Object.keys(cell.rejectionReasons)) {
        expect(reason).toContain("below 101.0%");
      }
    }
  });

  it("M5. partial screening leaves passed and rejected counts side by side", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ AAA: trade(100) }));
    // Only long_call is a selected type; the other built types are all
    // rejected by the screen while long_call passes — verdict stays "pass".
    const result = await scanner.scan(["AAA"], baseTemplate(), {
      strategyFilter: { strategyTypes: ["long_call"] },
    });

    const row = result.matrix[0];
    expect(row.verdict).toBe("pass");
    const byType = new Map(row.cells.map((c) => [c.strategyType, c]));
    expect(byType.get("long_call")).toMatchObject({ evaluatedCount: 3, passedCount: 3, rejectedCount: 0 });
    expect(byType.get("long_call")!.best).not.toBeNull();
    for (const type of ["call_debit_spread", "put_credit_spread"] as const) {
      const cell = byType.get(type)!;
      expect(cell.passedCount).toBe(0);
      expect(cell.rejectedCount).toBe(cell.evaluatedCount);
      expect(cell.best).toBeNull();
      expect(Object.values(cell.rejectionReasons).reduce((a, b) => a + b, 0)).toBe(cell.rejectedCount);
      for (const reason of Object.keys(cell.rejectionReasons)) {
        expect(reason).toContain("not in selected strategy types");
      }
    }
    // Cells with a best sort before best-less cells.
    expect(row.cells[0].strategyType).toBe("long_call");
  });

  it("M6. skipped symbols appear in the matrix with their reason; every symbol appears exactly once", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      GOOD: trade(100),
      VE: { kind: "empty", validationError: "No chains available for VE" },
      ERR: { kind: "throw", message: "upstream exploded" },
    }));
    const result = await scanner.scan(["GOOD", "VE", "ERR"], baseTemplate());

    expect(result.matrix).toHaveLength(result.scanned);
    expect(result.matrix.map((m) => m.symbol)).toEqual(["GOOD", "VE", "ERR"]);
    expect(new Set(result.matrix.map((m) => m.symbol)).size).toBe(3);

    const good = result.matrix[0];
    expect(good.verdict).toBe("pass");
    expect(good.cells.length).toBeGreaterThan(0);

    const ve = result.matrix[1];
    expect(ve.verdict).toBe("skipped");
    expect(ve.skipReason).toBe("No chains available for VE");
    expect(ve.cells).toEqual([]);
    expect(ve.targetPrice).toBeNull();
    expect(ve.targetSource).toBeNull();

    const err = result.matrix[2];
    expect(err.verdict).toBe("skipped");
    expect(err.skipReason).toBe("upstream exploded");
    expect(err.cells).toEqual([]);
  });
});

// --- NLQ level (issue #22): the scan result object carries the FULL skipped
// --- list and the matrix, and the summary gains per-type fit counts. The
// --- scan runs through the real DynamicOptionsScreener over a stub E*TRADE
// --- client (harness pattern from tests/options_scanner_targets.test.ts).

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

describe("NLQ opportunity scan fit matrix wiring (issue #22)", () => {
  it("returns the full skipped list and matrix in the result object and fit counts in the summary", async () => {
    const intent = parseOptionsStrategyIntent(
      "Best bullish option trades for NVDA, AMD, ZZZA, ZZZB, ZZZC, ZZZD max loss $5000",
    );
    expect(intent?.action).toBe("options_opportunities");
    expect(intent?.filters.scope).toEqual({
      kind: "symbols",
      symbols: ["NVDA", "AMD", "ZZZA", "ZZZB", "ZZZC", "ZZZD"],
    });

    const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
    const expiry = { year: expiryDateObj.getUTCFullYear(), month: expiryDateObj.getUTCMonth() + 1, day: expiryDateObj.getUTCDate() };
    const spots: Record<string, number> = { NVDA: 250, AMD: 40 };
    const client = {
      getOptionExpireDates: async () => [expiry],
      // Symbols outside the spots map have no chain at all: the screener
      // records a fetch error and the scanner skips them.
      getOptionChains: async (args: { symbol: string }) =>
        spots[args.symbol] !== undefined ? chainFor(args.symbol, spots[args.symbol], expiry) : null,
    };
    const etrade = {
      client: client as never,
      fetchQuoteRemote: async () => ({ lastPrice: 0 }),
      getWatchlists: async () => [],
      screenMarketsAsync: async () => ({ stocks: [] }),
    };

    const out = await runOptionsStrategyAction(etrade as never, intent!.action, intent!.filters);
    expect(out.status).toBe("ranked_opportunities");

    // The FULL skipped list is in the result object — all four chain-less
    // names — even though the summary text only shows 3 examples + "…".
    expect(out.summary).toContain("4 skipped (");
    expect(out.summary).toContain("; ...)");
    expect(out.skipped).toBeDefined();
    expect(out.skipped!.map((s) => s.symbol).sort()).toEqual(["ZZZA", "ZZZB", "ZZZC", "ZZZD"]);
    for (const s of out.skipped!) expect(s.reason).toContain("returned no data");

    // The matrix is in the result object: one row per scanned symbol, in
    // scope order, with the chain-less names as "skipped" rows.
    expect(out.matrix).toBeDefined();
    expect(out.matrix!.map((m) => m.symbol)).toEqual(["NVDA", "AMD", "ZZZA", "ZZZB", "ZZZC", "ZZZD"]);
    expect(out.matrix!.map((m) => m.verdict)).toEqual(["pass", "pass", "skipped", "skipped", "skipped", "skipped"]);
    for (const row of out.matrix!.slice(2)) {
      expect(row.skipReason).toContain("returned no data");
      expect(row.cells).toEqual([]);
    }

    // Per-type fit counts in the summary — exact sentence for these fixture
    // economics, and consistent with counts rebuilt from the matrix object.
    expect(out.summary).toContain(
      "Fits by strategy type: call_debit_spread 2, protective_collar 2, put_credit_spread 2, bear_call_ladder 1, call_backspread 1, long_call 1, protective_put 1, strap 1.",
    );
    const fitCounts = new Map<string, number>();
    for (const row of out.matrix!) {
      for (const cell of row.cells) {
        if (cell.passedCount > 0 && cell.best != null) {
          fitCounts.set(cell.strategyType, (fitCounts.get(cell.strategyType) ?? 0) + 1);
        }
      }
    }
    const expectedSentence = `Fits by strategy type: ${[...fitCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, count]) => `${type} ${count}`)
      .join(", ")}.`;
    expect(out.summary).toContain(expectedSentence);
  });
});
