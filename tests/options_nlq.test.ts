import { describe, expect, it } from "vitest";
import { parseOptionsStrategyIntent } from "../src/agents/nlqOptionsStrategy";

describe("options strategy NLQ parsing", () => {
  it("routes best-trade questions with parsed constraints", () => {
    const i = parseOptionsStrategyIntent("What is the best trade for NVDA bullish target $260 by 2026-11-20 max loss $500 conservative");
    expect(i?.action).toBe("options_best_trade");
    expect(i?.filters.request).toMatchObject({ symbol: "NVDA", thesis: "bullish", targetPrice: 260, targetDate: "2026-11-20", maxPlannedLoss: 500 });
    expect(i?.filters.riskProfile).toBe("conservative");
  });

  it("routes strategy screens and picks requested templates", () => {
    const i = parseOptionsStrategyIntent("Rank bearish AAPL put debit spreads and call credit spreads 20 to 45 DTE pop above 40%");
    expect(i?.action).toBe("options_strategies");
    expect(i?.filters.request.symbol).toBe("AAPL");
    expect(i?.filters.request.thesis).toBe("bearish");
    expect(i?.filters.request.allowedStrategies).toEqual(expect.arrayContaining(["put_debit_spread", "call_credit_spread"]));
    expect(i?.filters.request).toMatchObject({ minDte: 20, maxDte: 45 });
    expect(i?.filters.strategyFilter.minProbabilityOfProfit).toBe(0.4);
  });

  it("infers thesis from iron condors and leaves single-contract screens alone", () => {
    expect(parseOptionsStrategyIntent("Show iron condors on SPY")?.filters.request.thesis).toBe("range_bound");
    expect(parseOptionsStrategyIntent("Screen call options for NVDA with delta above 0.35")).toBeNull();
    expect(parseOptionsStrategyIntent("Buy 10 NVDA")).toBeNull();
  });

  it("routes watchlist, symbol-list and universe questions to the opportunity scanner", () => {
    const w = parseOptionsStrategyIntent("Find the best bullish option trades across my Semis watchlist max loss $500");
    expect(w?.action).toBe("options_opportunities");
    expect(w?.filters.scope).toEqual({ kind: "watchlist", name: "Semis" });
    const s = parseOptionsStrategyIntent("Best bullish option trades for NVDA, AMD and AVGO");
    expect(s?.filters.scope).toEqual({ kind: "symbols", symbols: ["NVDA", "AMD", "AVGO"] });
    const u = parseOptionsStrategyIntent("Find best bullish option opportunities across large cap stocks top 8 conservative");
    expect(u?.filters.scope).toMatchObject({ kind: "universe", maxSymbols: 8 });
    expect(u?.filters.riskProfile).toBe("conservative");
  });

  it("routes arm-named comparison questions to the three-way comparison action", () => {
    const i = parseOptionsStrategyIntent("Compare llm vs quant strategies for NVDA bullish target $260 max loss $500");
    expect(i?.action).toBe("options_comparison");
    expect(i?.filters.request.symbol).toBe("NVDA");
    const h = parseOptionsStrategyIntent("Compare the hybrid and quant iron condors for SPY range bound");
    expect(h?.action).toBe("options_comparison");
    expect(h?.filters.request.symbol).toBe("SPY");
  });

  it("does not claim comparison for arm-less, cross-symbol, or scoped compare questions", () => {
    // No arm words: stays a strategies question.
    expect(parseOptionsStrategyIntent("Compare option strategies for NVDA bullish")?.action).toBe("options_strategies");
    // Cross-symbol compare is not a single-snapshot comparison: the
    // symbol-list scan answers it, not the comparison action.
    expect(parseOptionsStrategyIntent("Compare NVDA vs AMD bullish strategies")?.action).not.toBe("options_comparison");
    // Scoped (watchlist) compare: the scan wins; comparison is
    // single-symbol only.
    expect(parseOptionsStrategyIntent("Compare llm vs quant strategies across my Semis watchlist")?.action).toBe("options_opportunities");
  });
});
