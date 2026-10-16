/**
 * Issue #27: scan provenance + persistence. Until now an
 * OpportunityScanResult was computed, returned, and thrown away — no
 * generatedAt, no model version, no record of the template/caps that
 * produced it, and no store to retrieve or diff it from later.
 *
 * Pinned here:
 *  1. Provenance — every result carries generatedAt (from the injected
 *     clock), modelVersion, a requestSnapshot echoing exactly what was
 *     asked, a configSnapshot of the resolved scanner config, and
 *     coverage math (considered/scanned/truncated/evaluated/errors).
 *  2. Stores — InMemoryScanRunStore and SqlScanRunStore (over a fake
 *     executor implementing the store's exact statements — the repo's
 *     MockSqlStorage only supports = / LIKE in WHERE clauses, so it
 *     cannot execute the retention deletes' range/subquery semantics)
 *     round-trip a run identically: save → get returns the full result;
 *     list returns summaries newest-first with pagination.
 *  3. Retention — rows older than 365 days are pruned on save/prune;
 *     the row cap prunes oldest first.
 *  4. Diff — diffScanRuns reports new fits, dropped fits, still-fitting
 *     names, gate-bucket changes, and added/removed symbols exactly.
 *  5. Wiring — the NLQ scan path and the unified opportunities action
 *     persist when a store is supplied (returning scanRunId +
 *     persisted: true), and a store whose save throws still returns a
 *     successful scan flagged persisted: false.
 *
 * Fixtures are deterministic (fake screener / stub client patterns from
 * tests/options_scanner.test.ts). No live market data, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SCAN_SYMBOLS,
  OpportunityScanner,
  SCAN_MODEL_VERSION,
  type FitGateBucket,
  type OpportunityScanResult,
  type ScanMatrixRow,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";
import {
  InMemoryScanRunStore,
  SCAN_RUN_MAX_ROWS,
  SCAN_RUN_RETENTION_DAYS,
  SqlScanRunStore,
  diffScanRuns,
  type ScanRunStore,
  type ScanSqlExecutor,
} from "../src/trading/options/scanRunStore";
import { parseOptionsStrategyIntent, runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { Env, ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures (duplicated per repo convention from tests/options_scanner.test.ts)
// ---------------------------------------------------------------------------

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

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

const FULL_MULTS = [0.9, 0.95, 1, 1.05, 1.1];

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

type SymbolBehavior =
  | { kind: "trade"; spot: number }
  | { kind: "empty"; validationError?: string; fetchErrorReason?: string }
  | { kind: "throw"; message: string };

const trade = (spot: number): SymbolBehavior => ({ kind: "trade", spot });

function fakeScreener(behaviors: Record<string, SymbolBehavior>): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      const behavior = behaviors[symbol] ?? trade(100);
      if (behavior.kind === "throw") throw new Error(behavior.message);
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
      const contracts = makeContracts(symbol, behavior.spot);
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

/** Minimal OpportunityScanResult fabrication for store/diff tests: only
 *  the fields those layers read are meaningful (matrix gate buckets,
 *  gate counts, provenance); the rest is inert filler. */
function fabricatedResult(
  generatedAt: string,
  rows: Array<{ symbol: string; gateBucket: FitGateBucket | null }>,
): OpportunityScanResult {
  const matrix: ScanMatrixRow[] = rows.map((r) => ({
    symbol: r.symbol,
    verdict: r.gateBucket === null ? "skipped" : r.gateBucket === "no_fit" ? "no_pass" : "pass",
    targetPrice: null,
    targetSource: null,
    cells: [],
    gateBucket: r.gateBucket,
    gateReasons: [],
  }));
  const gate = { fit: 0, borderline: 0, noFit: 0 };
  for (const r of rows) {
    if (r.gateBucket === "fit") gate.fit++;
    else if (r.gateBucket === "borderline") gate.borderline++;
    else if (r.gateBucket === "no_fit") gate.noFit++;
  }
  return {
    scanned: rows.length,
    withTrades: gate.fit + gate.borderline,
    opportunities: [],
    skipped: [],
    truncatedSymbols: 0,
    assumptions: [],
    matrix,
    typeRollup: [],
    mode: "strategy_fit",
    fits: [],
    fitsTotal: gate.fit,
    gate,
    borderline: [],
    gateParams: { minCompositeScore: 55, minProbabilityOfProfit: 0.35, requireFresh: true, minConfidence: "MEDIUM" },
    profileRef: null,
    generatedAt,
    modelVersion: SCAN_MODEL_VERSION,
    requestSnapshot: {
      template: {
        thesis: "bullish",
        targetDate: "2026-11-20",
        maxPlannedLoss: 5_000,
        minRewardRisk: 0.1,
        allowedStrategies: ["long_call"],
      },
      mode: "strategy_fit",
      riskProfile: "balanced",
      profile: null,
    },
    configSnapshot: {
      maxScanSymbols: MAX_SCAN_SYMBOLS,
      targetFactors: { bullish: 1.05, bearish: 0.95, large_move: 1.1, range_bound: 1 },
    },
    coverage: {
      considered: rows.length,
      scanned: rows.length,
      truncated: 0,
      evaluated: rows.filter((r) => r.gateBucket !== null).length,
      errors: rows.filter((r) => r.gateBucket === null).length,
      withTrades: gate.fit + gate.borderline,
    },
  };
}

// ---------------------------------------------------------------------------
// Statement-exact fake SQL executor for SqlScanRunStore. Implements the
// store's fixed statement set against an in-memory row array with real
// semantics (range delete, NOT IN cap subquery, generated_at/id
// ordering) and throws on anything else, so the test fails loudly if the
// store's SQL ever drifts from what is implemented here.
// ---------------------------------------------------------------------------

interface FakeScanRow {
  id: string;
  generated_at: string;
  mode: string;
  model_version: string;
  summary_json: string;
  result_json: string;
}

class FakeScanSql implements ScanSqlExecutor {
  rows: FakeScanRow[] = [];

  private sorted(): FakeScanRow[] {
    return [...this.rows].sort((a, b) =>
      a.generated_at !== b.generated_at
        ? a.generated_at < b.generated_at
          ? 1
          : -1
        : a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0,
    );
  }

  exec(query: string, ...params: unknown[]): Iterable<unknown> {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) return [];
    if (q.startsWith("INSERT INTO mas_opportunity_scans")) {
      const [id, generated_at, mode, model_version, summary_json, result_json] = params as string[];
      if (!this.rows.some((r) => r.id === id)) {
        this.rows.push({ id, generated_at, mode, model_version, summary_json, result_json });
      }
      return [];
    }
    if (q.startsWith("SELECT summary_json, result_json FROM mas_opportunity_scans WHERE id = ?")) {
      return this.rows
        .filter((r) => r.id === params[0])
        .map((r) => ({ summary_json: r.summary_json, result_json: r.result_json }));
    }
    if (q.startsWith("SELECT summary_json FROM mas_opportunity_scans ORDER BY")) {
      const [limit, offset] = params as number[];
      return this.sorted()
        .slice(offset, offset + limit)
        .map((r) => ({ summary_json: r.summary_json }));
    }
    if (q.startsWith("SELECT COUNT(*)")) return [{ count: this.rows.length }];
    if (q.startsWith("DELETE FROM mas_opportunity_scans WHERE generated_at < ?")) {
      const cutoff = params[0] as string;
      this.rows = this.rows.filter((r) => !(r.generated_at < cutoff));
      return [];
    }
    if (q.startsWith("DELETE FROM mas_opportunity_scans WHERE id NOT IN")) {
      const keep = new Set(this.sorted().slice(0, params[0] as number).map((r) => r.id));
      this.rows = this.rows.filter((r) => keep.has(r.id));
      return [];
    }
    throw new Error(`FakeScanSql: unhandled statement: ${q}`);
  }
}

/** Deterministic id factory: hands out the given ids in order. */
function idQueue(...ids: string[]): () => string {
  let i = 0;
  return () => ids[i++] ?? `auto-${i}`;
}

// ---------------------------------------------------------------------------
// 1. Provenance on the scan result
// ---------------------------------------------------------------------------

describe("scan provenance (issue #27)", () => {
  it("stamps generatedAt from the injected clock, the model version, and faithful request/config snapshots", async () => {
    const now = new Date("2026-10-16T14:30:00.000Z");
    const scanner = new OpportunityScanner(fakeScreener({ NVDA: trade(250), AMD: trade(40) }));
    const template = baseTemplate({
      statedTarget: { price: 260, symbol: "NVDA" },
      perSymbol: { AMD: { statedTarget: { percent: 8 } } },
    });
    const result = await scanner.scan(["NVDA", "AMD"], template, {
      now,
      mode: "strategy_fit",
      riskProfile: "aggressive",
    });

    expect(result.generatedAt).toBe("2026-10-16T14:30:00.000Z");
    expect(result.modelVersion).toBe("1.1.2");
    expect(result.modelVersion).toBe(SCAN_MODEL_VERSION);

    // The snapshot echoes exactly what was asked (not what the gate or
    // the scorer later decided): scoped stated target and the per-name
    // override travel verbatim, the shared filters by reference.
    expect(result.requestSnapshot.mode).toBe("strategy_fit");
    expect(result.requestSnapshot.riskProfile).toBe("aggressive");
    expect(result.requestSnapshot.strategyFilter).toBeUndefined();
    expect(result.requestSnapshot.template).toEqual({
      thesis: "bullish",
      targetDate: expiryDate,
      minDte: 14,
      maxDte: 60,
      maxPlannedLoss: 5_000,
      minRewardRisk: 0.1,
      allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
      statedTarget: { price: 260, symbol: "NVDA" },
      perSymbol: { AMD: { statedTarget: { percent: 8 } } },
    });

    // The resolved scanner config, not caller input.
    expect(result.configSnapshot.maxScanSymbols).toBe(MAX_SCAN_SYMBOLS);
    expect(result.configSnapshot.targetFactors.bullish).toBe(1.05);
    expect(result.configSnapshot.targetFactors.bearish).toBe(0.95);
    expect(result.configSnapshot.targetFactors.large_move).toBe(1.1);
    expect(result.configSnapshot.targetFactors.range_bound).toBe(1);
  });

  it("coverage math on a mixed batch: trades + validation skip + screener error + truncation", async () => {
    const tradingNames = Array.from({ length: 18 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`);
    const behaviors: Record<string, SymbolBehavior> = {};
    for (const name of tradingNames) behaviors[name] = trade(100);
    behaviors["ERR"] = { kind: "empty", validationError: "bad request" };
    behaviors["THR"] = { kind: "throw", message: "upstream chain fetch failed" };
    behaviors["X21"] = trade(100); // 21st unique name — beyond the batch cap

    const scanner = new OpportunityScanner(fakeScreener(behaviors));
    const requested = [...tradingNames, "ERR", "THR", "X21"];
    const result = await scanner.scan(requested, baseTemplate(), {
      now: new Date("2026-10-16T14:30:00.000Z"),
      mode: "strategy_fit",
    });

    // considered counts the unique request (21), scanned the capped
    // batch (20), truncated the overflow (1); the two skipped rows are
    // errors, the 18 trading rows were evaluated, and every evaluated
    // row had a trade (withTrades is the pre-slice count).
    expect(result.coverage).toEqual({
      considered: 21,
      scanned: 20,
      truncated: 1,
      evaluated: 18,
      errors: 2,
      withTrades: 18,
    });
    // And the coverage fields agree with the matrix they summarize.
    expect(result.matrix).toHaveLength(20);
    expect(result.matrix.filter((r) => r.verdict === "skipped")).toHaveLength(2);
  });

  it("coverage for a screened-but-rejected symbol: evaluated, zero trades, no error", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ NP1: trade(100) }));
    const result = await scanner.scan(["NP1"], baseTemplate(), {
      strategyFilter: { minProbabilityOfProfit: 1.01 }, // rejects every candidate
    });
    expect(result.coverage).toEqual({
      considered: 1,
      scanned: 1,
      truncated: 0,
      evaluated: 1,
      errors: 0,
      withTrades: 0,
    });
    expect(result.matrix[0]).toMatchObject({ symbol: "NP1", verdict: "no_pass", gateBucket: "no_fit" });
  });
});

// ---------------------------------------------------------------------------
// 2. Store round-trips (both implementations, identical semantics)
// ---------------------------------------------------------------------------

describe("scan run stores (issue #27)", () => {
  it("retention constants match the settled decisions", () => {
    expect(SCAN_RUN_RETENTION_DAYS).toBe(365);
    expect(SCAN_RUN_MAX_ROWS).toBe(1000);
  });

  async function saveTwoRuns(store: ScanRunStore): Promise<{ first: OpportunityScanResult; second: OpportunityScanResult }> {
    const first = fabricatedResult("2026-10-15T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" },
      { symbol: "BBB", gateBucket: "no_fit" },
      { symbol: "CCC", gateBucket: null },
    ]);
    const second = fabricatedResult("2026-10-16T14:30:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]);
    await store.save(first);
    await store.save(second);
    return { first, second };
  }

  /** The same round-trip contract, run against both stores. */
  async function expectRoundTrip(store: ScanRunStore): Promise<void> {
    const { first, second } = await saveTwoRuns(store);

    const gotFirst = await store.get("run-1");
    expect(gotFirst).not.toBeNull();
    expect(gotFirst!.id).toBe("run-1");
    expect(gotFirst!.generatedAt).toBe(first.generatedAt);
    expect(gotFirst!.mode).toBe("strategy_fit");
    expect(gotFirst!.modelVersion).toBe(SCAN_MODEL_VERSION);
    expect(gotFirst!.gate).toEqual({ fit: 1, borderline: 0, noFit: 1 });
    expect(gotFirst!.coverage).toEqual(first.coverage);
    // The full result round-trips byte-for-byte (JSON) — matrix,
    // snapshots, gateParams and all.
    expect(gotFirst!.result).toEqual(first);
    expect((await store.get("run-2"))!.result).toEqual(second);
    expect(await store.get("missing")).toBeNull();

    // Listings are summaries (no full result), newest first.
    const all = await store.list();
    expect(all.map((s) => s.id)).toEqual(["run-2", "run-1"]);
    expect(all[0]).not.toHaveProperty("result");
    expect(all[1].gate).toEqual({ fit: 1, borderline: 0, noFit: 1 });

    // Pagination: limit + offset walk the newest-first listing.
    expect((await store.list({ limit: 1, offset: 0 })).map((s) => s.id)).toEqual(["run-2"]);
    expect((await store.list({ limit: 1, offset: 1 })).map((s) => s.id)).toEqual(["run-1"]);
    expect(await store.list({ limit: 1, offset: 2 })).toEqual([]);
  }

  it("InMemoryScanRunStore round-trips a run", async () => {
    await expectRoundTrip(new InMemoryScanRunStore({ idFactory: idQueue("run-1", "run-2") }));
  });

  it("SqlScanRunStore round-trips a run over its exact statements", async () => {
    const fake = new FakeScanSql();
    const store = new SqlScanRunStore(fake, { idFactory: idQueue("run-1", "run-2") });
    await expectRoundTrip(store);
    // Two rows landed in the table, with the summary and result JSON
    // stored as separate columns.
    expect(fake.rows).toHaveLength(2);
    expect(JSON.parse(fake.rows[0].summary_json).id).toBe("run-1");
    expect(JSON.parse(fake.rows[0].result_json).generatedAt).toBe("2026-10-15T14:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 3. Retention
// ---------------------------------------------------------------------------

describe("scan run retention (issue #27)", () => {
  it("prunes rows older than 365 days on save (in-memory)", async () => {
    const store = new InMemoryScanRunStore({ idFactory: idQueue("old", "fresh") });
    await store.save(fabricatedResult("2025-10-01T00:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]));
    // Saving the fresh run prunes against the fresh run's own clock:
    // 2025-10-01 is more than 365 days before 2026-10-16.
    await store.save(fabricatedResult("2026-10-16T00:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]));
    expect(await store.get("old")).toBeNull();
    expect(await store.get("fresh")).not.toBeNull();
    expect((await store.list()).map((s) => s.id)).toEqual(["fresh"]);
  });

  it("prune(now) deletes expired rows and reports the count; rows inside the window survive", async () => {
    const store = new InMemoryScanRunStore({ idFactory: idQueue("a", "b") });
    await store.save(fabricatedResult("2026-01-10T00:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]));
    await store.save(fabricatedResult("2026-01-11T00:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]));
    // Pruning "now" in mid-2026: both rows are inside 365 days.
    expect(await store.prune(new Date("2026-06-01T00:00:00.000Z"))).toBe(0);
    expect(await store.list()).toHaveLength(2);
    // Pruning "now" in mid-2027: both rows are beyond 365 days.
    expect(await store.prune(new Date("2027-06-01T00:00:00.000Z"))).toBe(2);
    expect(await store.list()).toEqual([]);
  });

  it("prunes rows older than 365 days on save (SQL store)", async () => {
    const fake = new FakeScanSql();
    const store = new SqlScanRunStore(fake, { idFactory: idQueue("old", "fresh") });
    await store.save(fabricatedResult("2025-10-01T00:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]));
    await store.save(fabricatedResult("2026-10-16T00:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]));
    expect(await store.get("old")).toBeNull();
    expect(await store.get("fresh")).not.toBeNull();
    expect(fake.rows.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("enforces the row cap oldest-first (in-memory)", async () => {
    const store = new InMemoryScanRunStore({ idFactory: idQueue("r1", "r2", "r3", "r4", "r5"), maxRows: 3 });
    for (let day = 1; day <= 5; day++) {
      await store.save(fabricatedResult(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, [
        { symbol: "AAA", gateBucket: "fit" },
      ]));
    }
    expect((await store.list()).map((s) => s.id)).toEqual(["r5", "r4", "r3"]);
    expect(await store.get("r1")).toBeNull();
    expect(await store.get("r2")).toBeNull();
  });

  it("enforces the row cap oldest-first (SQL store)", async () => {
    const fake = new FakeScanSql();
    const store = new SqlScanRunStore(fake, { idFactory: idQueue("r1", "r2", "r3", "r4", "r5"), maxRows: 3 });
    for (let day = 1; day <= 5; day++) {
      await store.save(fabricatedResult(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, [
        { symbol: "AAA", gateBucket: "fit" },
      ]));
    }
    expect((await store.list()).map((s) => s.id)).toEqual(["r5", "r4", "r3"]);
    expect(fake.rows).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Run-over-run diff
// ---------------------------------------------------------------------------

describe("diffScanRuns (issue #27)", () => {
  it("reports new fits, a dropped fit, still-fitting names, bucket changes, and added/removed symbols exactly", () => {
    const older = fabricatedResult("2026-10-15T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" }, // → borderline in the newer run
      { symbol: "BBB", gateBucket: "fit" }, // → still fit
      { symbol: "CCC", gateBucket: "borderline" }, // → fit (new fit)
      { symbol: "FFF", gateBucket: "no_fit" }, // → skipped in the newer run: never judged, no bucket change
      { symbol: "GGG", gateBucket: null }, // only in the older run
    ]);
    const newer = fabricatedResult("2026-10-16T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "borderline" },
      { symbol: "BBB", gateBucket: "fit" },
      { symbol: "CCC", gateBucket: "fit" },
      { symbol: "DDD", gateBucket: "fit" }, // only in the newer run, and fit
      { symbol: "FFF", gateBucket: null },
    ]);

    expect(diffScanRuns(older, newer)).toEqual({
      newFits: ["CCC", "DDD"],
      droppedFits: ["AAA"],
      stillFitting: ["BBB"],
      bucketChanges: [
        { symbol: "AAA", from: "fit", to: "borderline" },
        { symbol: "CCC", from: "borderline", to: "fit" },
      ],
      addedSymbols: ["DDD"],
      removedSymbols: ["GGG"],
    });
  });

  it("diffing a run against itself is empty", () => {
    const run = fabricatedResult("2026-10-16T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" },
      { symbol: "BBB", gateBucket: null },
    ]);
    const diff = diffScanRuns(run, run);
    expect(diff.newFits).toEqual([]);
    expect(diff.droppedFits).toEqual([]);
    expect(diff.stillFitting).toEqual(["AAA"]);
    expect(diff.bucketChanges).toEqual([]);
    expect(diff.addedSymbols).toEqual([]);
    expect(diff.removedSymbols).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Wiring: persistence rides the scan paths, and never fails a scan
// ---------------------------------------------------------------------------

/** E*TRADE chain fixture for the stub client (copied exactly from
 *  tests/options_scanner.test.ts: legs carry timeStamp/adjustedFlag/
 *  impliedVolatility, the chain carries underlyingPrice +
 *  selectedExpiry, and the client methods take args objects). */
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

const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

describe("scan persistence wiring (issue #27)", () => {
  const intent = parseOptionsStrategyIntent("Best bullish option trades for NVDA and AMD max loss $5000");
  const spots: Record<string, number> = { NVDA: 250, AMD: 40 };
  const client = {
    getOptionExpireDates: async () => [expiryObj],
    getOptionChains: async (args: { symbol: string }) =>
      spots[args.symbol] !== undefined ? chainFor(args.symbol, spots[args.symbol], expiryObj) : null,
  };
  const etrade = { client, environment: { kind: "sandbox" as const } };

  it("NLQ opportunities scan persists with a store and returns scanRunId", async () => {
    const store = new InMemoryScanRunStore({ idFactory: idQueue("nlq-run-1") });
    const result = await runOptionsStrategyAction(etrade as never, intent.action, intent.filters, { scanRunStore: store });

    expect(result.status).toBe("ranked_opportunities");
    expect(result.persisted).toBe(true);
    expect(result.scanRunId).toBe("nlq-run-1");

    // The stored run is the scan that was just returned — full matrix,
    // provenance and all — retrievable afterwards (acceptance: a scan
    // from yesterday can be fetched and diffed against today's).
    const stored = await store.get("nlq-run-1");
    expect(stored).not.toBeNull();
    expect(stored!.mode).toBe("per_name_best");
    expect(stored!.modelVersion).toBe(SCAN_MODEL_VERSION);
    expect(stored!.result.matrix).toHaveLength(2);
    expect(stored!.result.generatedAt).toBe(stored!.generatedAt);
    expect(stored!.result.requestSnapshot.template.thesis).toBe("bullish");
    expect(stored!.result.gateParams.minCompositeScore).toBe(55);
    expect(stored!.result.coverage).toMatchObject({ considered: 2, scanned: 2, errors: 0 });
  });

  it("a store whose save throws still returns a successful scan, flagged persisted: false", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const broken: ScanRunStore = {
        save: async () => {
          throw new Error("storage unavailable");
        },
        list: async () => [],
        get: async () => null,
        prune: async () => 0,
      };
      const result = await runOptionsStrategyAction(etrade as never, intent.action, intent.filters, {
        scanRunStore: broken,
      });
      expect(result.status).toBe("ranked_opportunities");
      expect(result.persisted).toBe(false);
      expect(result.scanRunId).toBeUndefined();
      expect(result.rows).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("without a store the NLQ scan behaves exactly as before (no persistence fields)", async () => {
    const result = await runOptionsStrategyAction(etrade as never, intent.action, intent.filters);
    expect(result.status).toBe("ranked_opportunities");
    expect(result.persisted).toBeUndefined();
    expect(result.scanRunId).toBeUndefined();
  });
});

describe("unified opportunities persistence (issue #27)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("persists the scan and stamps executionData with scanRunId when a store is injected", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: chainFor("NVDA", 250, expiryObj),
      AMD: chainFor("AMD", 40, expiryObj),
    });
    const store = new InMemoryScanRunStore({ idFactory: idQueue("unified-run-1") });
    const service = new UnifiedOptionsService(
      { ETRADE_ENVIRONMENT: "sandbox" } as Env,
      "default_trader",
      undefined,
      undefined,
      store,
    );
    const result = await service.execute({ action: "opportunities", symbols: ["NVDA", "AMD"], targetDate: expiryDate });

    expect(result.success).toBe(true);
    const data = result.data as unknown as OpportunityScanResult & { scanRunId?: string; persisted?: boolean };
    expect(data.scanRunId).toBe("unified-run-1");
    expect(data.persisted).toBe(true);

    const stored = await store.get("unified-run-1");
    expect(stored).not.toBeNull();
    expect(stored!.result.generatedAt).toBe(data.generatedAt);
    expect(stored!.result.matrix).toHaveLength(2);
    expect(stored!.result.requestSnapshot.template.thesis).toBe("bullish");
  });

  it("without a store the unified scan carries no persistence fields", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ MSFT: chainFor("MSFT", 500, expiryObj) });
    const service = new UnifiedOptionsService({ ETRADE_ENVIRONMENT: "sandbox" } as Env);
    const result = await service.execute({ action: "opportunities", symbols: ["MSFT"], targetDate: expiryDate });
    expect(result.success).toBe(true);
    const data = result.data as unknown as { scanRunId?: string; persisted?: boolean };
    expect(data.scanRunId).toBeUndefined();
    expect(data.persisted).toBeUndefined();
  });
});
