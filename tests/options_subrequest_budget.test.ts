import { describe, expect, it, vi } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { ETradeRestClient } from "../src/trading/etrade/client";
import { getScreenerConfig } from "../src/config/etapiConfig";
import {
  DynamicOptionsScreener,
  SUBREQUEST_BUDGET_DEFERRED_REASON,
  createSubrequestBudget,
} from "../src/trading/optionsScreener";
import { OptionsDataAgent } from "../src/trading/options/optionsDataAgent";
import { OpportunityScanner } from "../src/trading/options/opportunityScanner";

/**
 * Issue #1204 introduced a shared per-scan ledger, but it counted
 * logical provider calls. Each E*TRADE call can issue a second `.json`
 * fetch on HTTP 400/404, so the ledger could still exceed the Worker
 * request limit (#1545, matching the 100-symbol Slack failure). These
 * tests pin the fix: the budget is charged at each actual fetch attempt,
 * including fallbacks; remaining symbols are deferred with a named
 * reason (never misreported as provider failures or retried), and the
 * scan evaluates the coverage that fit.
 */

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string, expiry: ETradeOptionExpireDate): ETradeOptionChain {
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
          timeStamp: Math.floor(Date.now() / 1000),
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
          timeStamp: Math.floor(Date.now() / 1000),
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

/**
 * Counting fake client: every symbol offers EXPIRATIONS expirations in
 * the DTE window; every call is counted. Per symbol the screener's
 * fan-out is 1 (expire dates) + EXPIRATIONS (chains).
 */
const EXPIRATIONS = 3;
function makeCountingClient() {
  const expiries = [expiryAtDte(20), expiryAtDte(30), expiryAtDte(40)];
  const calls = { expireDates: 0, chains: 0, total: 0 };
  const client = {
    lastError: undefined as string | undefined,
    getOptionExpireDates: vi.fn(async (_symbol: string, _expiryType?: string, budget?: { tryConsume(): boolean }) => {
      if (budget && !budget.tryConsume()) return [];
      calls.expireDates++;
      calls.total++;
      return expiries;
    }),
    getOptionChains: vi.fn(async (params: { symbol: string; expiryYear?: number; expiryMonth?: number; expiryDay?: number }, budget?: { tryConsume(): boolean }) => {
      if (budget && !budget.tryConsume()) return null;
      calls.chains++;
      calls.total++;
      const expiry = params.expiryYear
        ? { year: params.expiryYear, month: params.expiryMonth!, day: params.expiryDay! }
        : expiries[0];
      return makeChain(params.symbol, expiry);
    }),
  };
  return { client: client as unknown as ETradeRestClient, calls };
}

function symbols(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `S${String(i).padStart(3, "0")}`);
}

describe("config: actual-fetch budget (#1545)", () => {
  it("ships a conservative default under the Workers per-invocation cap", () => {
    const cfg = getScreenerConfig();
    expect(cfg.subrequestBudget).toBe(400);
  });
});

describe("DynamicOptionsScreener actual-fetch budget (#1545)", () => {
  it("counts each actual fetch attempt, including an API fallback attempt", async () => {
    const expiries = [expiryAtDte(20)];
    const attempts = { total: 0 };
    const client = {
      supportsOptionRequestBudget: true,
      lastError: undefined as string | undefined,
      getOptionExpireDates: async (_symbol: string, _expiryType: string | undefined, budget: { tryConsume(): boolean }) => {
        if (!budget.tryConsume()) return [];
        attempts.total++;
        return expiries;
      },
      getOptionChains: async (params: { symbol: string }, budget: { tryConsume(): boolean }) => {
        if (!budget.tryConsume()) return null;
        attempts.total++;
        // The first .json fallback would be a second real fetch attempt.
        if (!budget.tryConsume()) return null;
        attempts.total++;
        return makeChain(params.symbol, expiries[0]);
      },
    } as unknown as ETradeRestClient;
    const result = await new DynamicOptionsScreener(client, { subrequestBudget: 2 })
      .screenOptions({ underlyingSymbols: ["AAA"], minDte: 0, maxDte: 90 });

    expect(attempts.total).toBe(2);
    expect(result.totalContractsEvaluated).toBe(0);
    expect(result.fetchErrors?.some((error) => error.reason === SUBREQUEST_BUDGET_DEFERRED_REASON)).toBe(true);
  });

  it("never issues more fetches than the budget, and still evaluates the symbols that fit", async () => {
    const { client, calls } = makeCountingClient();
    const screener = new DynamicOptionsScreener(client, { subrequestBudget: 25 });
    // 20 symbols × (1 + 3) = 80 planned fetches against a budget of 25.
    const result = await screener.screenOptions({ underlyingSymbols: symbols(20), minDte: 0, maxDte: 90 });

    expect(calls.total).toBeLessThanOrEqual(25);
    expect(result.totalContractsEvaluated).toBeGreaterThan(0);
    expect(result.status).not.toBe("error");
  });

  it("reports over-budget symbols as deferred with the named budget reason — not as broker failures", async () => {
    const { client } = makeCountingClient();
    const screener = new DynamicOptionsScreener(client, { subrequestBudget: 25 });
    const result = await screener.screenOptions({ underlyingSymbols: symbols(20), minDte: 0, maxDte: 90 });

    const deferred = (result.fetchErrors ?? []).filter((e) => e.reason === SUBREQUEST_BUDGET_DEFERRED_REASON);
    // 25 fetches cover ~6 full symbols (24) plus at most one further
    // symbol's expire-dates call before the gate closes; the tail of
    // the universe is deferred outright (exact split depends on pool
    // interleaving, the count does not).
    expect(deferred.length).toBeGreaterThanOrEqual(12);
    expect(deferred.length).toBeLessThanOrEqual(14);
    expect(deferred.map((d) => d.symbol)).toContain("S019");
    // A deferral is disclosed as a warning too, so a partial scan never
    // reads as a complete one.
    expect((result.warnings ?? []).join(" ")).toMatch(/deferred/i);
    expect((result.warnings ?? []).join(" ")).toMatch(/subrequest budget/i);
  });

  it("does not retry deferred symbols inside the same invocation", async () => {
    const { client, calls } = makeCountingClient();
    const screener = new DynamicOptionsScreener(client, { subrequestBudget: 25 });
    await screener.screenOptions({ underlyingSymbols: symbols(20), minDte: 0, maxDte: 90 });
    // The #915 retry pass must not spend a single extra call on deferred
    // symbols: the total stays exactly at the budget.
    expect(calls.total).toBe(25);
  });

  it("partially fetches a symbol when the budget runs out mid-symbol, and says so", async () => {
    const { client, calls } = makeCountingClient();
    // Budget 8: three expire-dates calls land first (3), the first
    // symbol takes its 3 chains (6), the second symbol can afford
    // only 2 of its 3 chains (8) — the third is deferred, by name.
    const screener = new DynamicOptionsScreener(client, { subrequestBudget: 8 });
    const result = await screener.screenOptions({ underlyingSymbols: symbols(3), minDte: 0, maxDte: 90 });

    expect(calls.total).toBe(8);
    const partial = (result.fetchErrors ?? []).find((e) => e.symbol === "S001");
    expect(partial?.reason).toMatch(/deferred/i);
    expect(partial?.reason).toMatch(/1 of 3 expiration fetches deferred/);
  });

  it("a shared budget passed across calls is consumed cumulatively (scanner per-symbol path)", async () => {
    const { client, calls } = makeCountingClient();
    const screener = new DynamicOptionsScreener(client);
    const budget = createSubrequestBudget(10);
    const agent = new OptionsDataAgent(screener);
    // Each single-symbol snapshot costs 4 fetches. The third call finds
    // only 2 left: it fetches what fits (expire-dates + 1 of 3 chains)
    // and reports the rest deferred. The fourth call finds the budget
    // gone and defers the symbol outright, spending nothing.
    await agent.loadSnapshot({ symbol: "AAA", minDte: 0, maxDte: 90, fetchBudget: budget } as any);
    await agent.loadSnapshot({ symbol: "BBB", minDte: 0, maxDte: 90, fetchBudget: budget } as any);
    const third = await agent.loadSnapshot({ symbol: "CCC", minDte: 0, maxDte: 90, fetchBudget: budget } as any);
    const fourth = await agent.loadSnapshot({ symbol: "DDD", minDte: 0, maxDte: 90, fetchBudget: budget } as any);

    expect(calls.total).toBe(10);
    expect(budget.used).toBe(10);
    expect(third.screen.fetchErrors?.[0]?.reason).toMatch(/deferred/i);
    expect(fourth.screen.fetchErrors?.[0]?.reason).toBe(SUBREQUEST_BUDGET_DEFERRED_REASON);
  });
});

describe("OpportunityScanner under the actual-fetch budget (#1545)", () => {
  it("evaluates early symbols and skips deferred ones with the budget reason instead of failing the universe", async () => {
    const { client, calls } = makeCountingClient();
    const screener = new DynamicOptionsScreener(client, { subrequestBudget: 25 });
    const scanner = new OpportunityScanner(screener);
    const result = await scanner.scan(symbols(20), {
      thesis: "bullish",
      targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 1000,
      minRewardRisk: 0.1,
      allowedStrategies: ["long_call"],
      minDte: 0,
      maxDte: 90,
    } as any, { maxSymbols: 20 });

    expect(calls.total).toBeLessThanOrEqual(25);
    expect(result.coverage.evaluated).toBeGreaterThan(0);
    const budgetSkips = result.skipped.filter((s) => s.reason === SUBREQUEST_BUDGET_DEFERRED_REASON);
    expect(budgetSkips.length).toBeGreaterThan(0);
    // Every symbol is accounted for exactly once: evaluated (a matrix
    // row was produced) or errored (skipped at snapshot load). Note the
    // scanner's `skipped` list ALSO carries no-pick rationales for
    // evaluated symbols, so the invariant runs on coverage counts.
    expect(result.coverage.evaluated + result.coverage.errors).toBe(20);
    expect(result.coverage.errors).toBe(budgetSkips.length);
  });
});
