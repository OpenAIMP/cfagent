/**
 * Issue #1785: MEASUREMENT — per-symbol subrequest consumption of the
 * opportunity-scanner snapshot path (expire-dates + one chain fetch per
 * selected expiration, both contract types in a single chain response).
 *
 * The ~11 figure from prod counts (3 evaluated of 100 under a 35 budget)
 * is arithmetic, not a code measurement. This suite measures it through
 * the real DynamicOptionsScreener.screenOptions path with a stub E*TRADE
 * client that charges the shared budget exactly like the real client
 * (one tryConsume per fetch attempt, throw when exhausted).
 *
 * NOTE (verified while measuring): there is NO separate per-symbol quote
 * fetch in this path — the underlying price rides the chain contracts.
 * Per-symbol cost = 1 expire-dates fetch + K chain fetches, where K is
 * the number of expirations selected inside the DTE window.
 */
import { describe, it, expect } from "vitest";
import {
  DynamicOptionsScreener,
  createSubrequestBudget,
  SUBREQUEST_BUDGET_DEFERRED_REASON,
} from "../src/trading";

function makeExpirations(count: number): Array<{ year: number; month: number; day: number }> {
  const out: Array<{ year: number; month: number; day: number }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7 * (i + 1)));
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }
  return out;
}

function makeStubClient(expirationsPerSymbol: number) {
  const calls = { expireDates: 0, chains: 0, perSymbol: new Map<string, number>() };
  const charge = (symbol: string, budget: { tryConsume(): boolean } | undefined) => {
    calls.perSymbol.set(symbol, (calls.perSymbol.get(symbol) ?? 0) + 1);
    if (budget && !budget.tryConsume()) {
      throw new Error("Subrequest budget exhausted before E*TRADE option fetch.");
    }
  };
  const client = {
    supportsOptionRequestBudget: true,
    lastError: undefined as string | undefined,
    getOptionExpireDates: async (symbol: string, _expiryType: unknown, budget: { tryConsume(): boolean } | undefined) => {
      calls.expireDates++;
      charge(symbol, budget);
      return makeExpirations(expirationsPerSymbol);
    },
    getOptionChains: async (params: { symbol: string; expiryYear: number; expiryMonth: number; expiryDay: number }, budget: { tryConsume(): boolean } | undefined) => {
      calls.chains++;
      charge(params.symbol, budget);
      const call = {
        optionType: "CALL", strikePrice: 150, symbol: params.symbol,
        bid: 1.0, ask: 1.01, lastPrice: 1.005, volume: 1000, openInterest: 5000,
        delta: 0.5, gamma: 0.05, theta: -0.02, vega: 0.1, rho: 0.01, impliedVolatility: 0.45,
      };
      const put = { ...call, optionType: "PUT", delta: -0.5 };
      return {
        symbol: params.symbol,
        underlyingPrice: 150,
        selectedExpiry: { year: params.expiryYear, month: params.expiryMonth, day: params.expiryDay },
        pairs: [{ call, put }],
      };
    },
  };
  return { calls, client };
}

function makeSymbols(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `SYM${String(i).padStart(3, "0")}`);
}

describe("options scan subrequest measurement (#1785)", () => {
  it("measures per-symbol cost: 11 expirations cost 12 fetches, so a 35 budget evaluates exactly 3 of 100", async () => {
    const { calls, client } = makeStubClient(11);
    const screener = new DynamicOptionsScreener(client as never, { symbolFetchConcurrency: 1, expiryFetchConcurrency: 1, maxScanSymbols: 100 });
    const budget = createSubrequestBudget(35);
    const symbols = makeSymbols(100);
    const result = await screener.screenOptions(
      { underlyingSymbols: symbols, contractType: "BOTH", minDte: 0, maxDte: 90 },
      budget,
    );

    // The ledger caps exactly at the limit — never overspends. Note
    // the gate defers without attempting a consume, so `exhausted` is
    // only set by a failed tryConsume, not by reaching the limit.
    expect(budget.used).toBe(35);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.exhausted).toBe(true);

    // Per-symbol fetch attempts: symbol 1 and 2 fully fetched (12 each),
    // symbol 3 partially fetched (expire-dates + 10 chains = 11), then
    // the ledger is empty and every later symbol is deferred unfetched.
    expect(calls.perSymbol.get("SYM000")).toBe(12);
    expect(calls.perSymbol.get("SYM001")).toBe(12);
    expect(calls.perSymbol.get("SYM002")).toBe(11);
    // SYM003 is deferred by the gate before any fetch is attempted.
    expect(calls.perSymbol.get("SYM003") ?? 0).toBe(0);

    // Evaluated = symbols with at least one chain (2 full + 1 partial).
    const symbolsWithChains = new Set(result.contracts.map((c) => c.symbol));
    expect(symbolsWithChains.size).toBe(3);

    // Deferred symbols carry the named #1204 reason, never a broker failure.
    const deferred = (result.fetchErrors ?? []).filter((e) => e.reason === SUBREQUEST_BUDGET_DEFERRED_REASON);
    expect(deferred.length).toBe(97);
    expect(deferred.map((e) => e.symbol)).toContain("SYM003");
    expect(deferred.map((e) => e.symbol)).toContain("SYM099");
  });

  it("single-invocation deferral still works with the named reason (regression guard)", async () => {
    const { client } = makeStubClient(11);
    const screener = new DynamicOptionsScreener(client as never, { symbolFetchConcurrency: 1, expiryFetchConcurrency: 1, maxScanSymbols: 100 });
    const budget = createSubrequestBudget(35);
    const result = await screener.screenOptions(
      { underlyingSymbols: makeSymbols(10), contractType: "BOTH", minDte: 0, maxDte: 90 },
      budget,
    );
    expect(budget.used).toBe(35);
    const deferred = (result.fetchErrors ?? []).filter((e) => e.reason === SUBREQUEST_BUDGET_DEFERRED_REASON);
    expect(deferred.length).toBeGreaterThan(0);
    // Deferral is graceful: the call returns a result, it never throws.
    expect(result).toBeDefined();
  });

  it("a 2-symbol scan fits one budget and defers nothing", async () => {
    const { client } = makeStubClient(11);
    const screener = new DynamicOptionsScreener(client as never, { symbolFetchConcurrency: 1, expiryFetchConcurrency: 1, maxScanSymbols: 100 });
    const budget = createSubrequestBudget(35);
    const result = await screener.screenOptions(
      { underlyingSymbols: ["SYM000", "SYM001"], contractType: "BOTH", minDte: 0, maxDte: 90 },
      budget,
    );
    expect(budget.used).toBe(24);
    expect(budget.exhausted).toBe(false);
    const deferred = (result.fetchErrors ?? []).filter((e) => e.reason === SUBREQUEST_BUDGET_DEFERRED_REASON);
    expect(deferred).toHaveLength(0);
    expect(new Set(result.contracts.map((c) => c.symbol)).size).toBe(2);
  });
});
