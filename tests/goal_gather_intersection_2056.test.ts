/**
 * Issue #2056 (refined): with a live real-time source present,
 * Yahoo has NO row effect — rows come from the live source alone,
 * Yahoo complements COLUMNS on those rows (live wins on shared
 * columns). A live-only symbol still stores; a Yahoo-only symbol
 * is never stored.
 */
import { describe, expect, it, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { createGoalGatherEnrichment } from "../src/services/goalGather";
import { listCapturesByRun } from "../src/trading";
import type { ETradeQuote } from "../src/types";

function mapBlobStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    storage: {
      get: async <T,>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
    },
  };
}

function listing(symbol: string): ETradeQuote {
  return { symbol, companyName: `${symbol} Corp`, lastPrice: 100 } as ETradeQuote;
}

function row(symbol: string, fields: Partial<ETradeQuote> = {}): ETradeQuote {
  return { ...listing(symbol), lastPrice: 150, source: "LIVE", quoteStatus: "LIVE", ...fields } as ETradeQuote;
}

function depsFor(rows: Record<string, ETradeQuote>) {
  return {
    fetchQuotes: vi.fn(async (symbols: string[]) =>
      symbols.map((s) => rows[s.toUpperCase()]).filter(Boolean)
    ),
    fetchQuote: vi.fn(async (symbol: string) => {
      const found = rows[symbol.toUpperCase()];
      if (!found) throw new Error(`unserved ${symbol}`);
      return found;
    }),
  } as any;
}

const ROUTES = [
  {
    capability: "quotes",
    primaryProviderId: "etrade",
    gapFillProviderId: "yahoo",
    minTier: "freemium",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    capability: "historicalBars",
    primaryProviderId: "yahoo",
    gapFillProviderId: null,
    minTier: "freemium",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
] as any;

function historyDeps() {
  return {
    fetchBars: async () => [{ date: "2026-09-01", open: 99, high: 101, low: 98, close: 100, volume: 1_000_000 }],
  } as any;
}

function buildEnrich(sql: any, storage: any, live: any, yahoo: any, extra: any = {}) {
  return createGoalGatherEnrichment({
    sql,
    blobStorage: storage,
    blobEnv: {},
    tenantId: "default",
    runId: "goal-run-2056",
    liveQuoteDeps: live,
    ...(yahoo ? { yahooQuoteDeps: yahoo } : {}),
    historyDeps: historyDeps(),
    routes: ROUTES,
    ...extra,
  });
}

describe("goal gather live rows, Yahoo complements columns (#2056)", () => {
  it("stores live rows only; Yahoo never adds rows (Yahoo-only E drops)", async () => {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    // Live serves A, B, C, D; Yahoo serves C, D, E → stored = A, B, C, D.
    // E is Yahoo-only: never a row. A, B are live-only: stored with live columns.
    const live = depsFor({ A: row("A"), B: row("B"), C: row("C"), D: row("D") });
    const yahoo = depsFor({ C: row("C"), D: row("D"), E: row("E") });
    const enrich = buildEnrich(sql as never, storage as never, live, yahoo);
    const out = await enrich.enrich([
      listing("A"), listing("B"), listing("C"), listing("D"), listing("E"),
    ]);
    expect(out.enrichedQuotes.map((q) => q.symbol).sort()).toEqual(["A", "B", "C", "D"]);
    expect(out.missingSymbols).toEqual(["E"]);
    expect(out.missingFields.E).toEqual(["quote:live"]);
    // No gap-filled members, ever.
    expect(out.gapFilledCount).toBe(0);
    const rows = listCapturesByRun(sql as never, "default", "goal-run-2056");
    expect(rows.map((r) => (r.requestParams as any).symbol).sort()).toEqual(["A", "B", "C", "D"]);
    expect(rows.every((r) => r.providerId === "etrade")).toBe(true);
    expect(rows.every((r) => (r.requestParams as any).gapFilled === false)).toBe(true);
    // Per-row Yahoo presence: A, B live-only → false; C, D complemented → true.
    const bySymbol = new Map(rows.map((r) => [(r.requestParams as any).symbol, r.requestParams as any]));
    expect(bySymbol.get("A").yahooPresent).toBe(false);
    expect(bySymbol.get("B").yahooPresent).toBe(false);
    expect(bySymbol.get("C").yahooPresent).toBe(true);
    expect(bySymbol.get("D").yahooPresent).toBe(true);
  });

  it("unions columns with live winning on shared columns", async () => {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    // Live lacks averageVolume; Yahoo has it → stored row takes Yahoo's.
    // Both carry week52High; live's 200 wins over Yahoo's 999.
    const live = depsFor({
      A: row("A", { week52High: 200, week52Low: 100 }),
    });
    const yahoo = depsFor({
      A: row("A", { week52High: 999, week52Low: 50, averageVolume: 50_000_000 }),
    });
    const enrich = buildEnrich(sql as never, storage as never, live, yahoo);
    const out = await enrich.enrich([listing("A")]);
    expect(out.enrichedQuotes.map((q) => q.symbol)).toEqual(["A"]);
    const a = out.enrichedQuotes[0];
    expect(a.week52High).toBe(200);
    expect(a.averageVolume).toBe(50_000_000);
  });

  it("Yahoo side absent → live rows still stored, Yahoo columns missing", async () => {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    const live = depsFor({ A: row("A", { week52High: 200, averageVolume: 10 }), B: row("B", { week52High: 210, averageVolume: 20 }) });
    const enrich = buildEnrich(sql as never, storage as never, live, null);
    const out = await enrich.enrich([listing("A"), listing("B")]);
    expect(out.enrichedQuotes.map((q) => q.symbol).sort()).toEqual(["A", "B"]);
    expect(out.missingSymbols).toEqual([]);
    const rows = listCapturesByRun(sql as never, "default", "goal-run-2056");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.requestParams as any).yahooPresent === false)).toBe(true);
  });

  it("Yahoo batch failure → live rows still stored", async () => {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    const live = depsFor({ A: row("A", { week52High: 200, averageVolume: 10 }) });
    const yahoo = {
      fetchQuotes: async () => { throw new Error("yahoo down"); },
      fetchQuote: async () => { throw new Error("yahoo down"); },
    } as any;
    const enrich = buildEnrich(sql as never, storage as never, live, yahoo);
    const out = await enrich.enrich([listing("A")]);
    expect(out.enrichedQuotes.map((q) => q.symbol)).toEqual(["A"]);
    expect(out.missingSymbols).toEqual([]);
  });

  it("live batch failure → fail-closed, every symbol missing", async () => {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    const live = {
      fetchQuotes: async () => { throw new Error("live down"); },
      fetchQuote: async () => { throw new Error("live down"); },
    } as any;
    const yahoo = depsFor({ A: row("A") });
    const enrich = buildEnrich(sql as never, storage as never, live, yahoo);
    const out = await enrich.enrich([listing("A")]);
    expect(out.enrichedQuotes).toEqual([]);
    expect(out.missingSymbols).toEqual(["A"]);
    expect(out.missingFields.A).toEqual(["quote:live"]);
  });
});
