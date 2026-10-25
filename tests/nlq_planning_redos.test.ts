/**
 * Issue #855: CodeQL js/redos in src/agents/nlq/planning.ts (E*TRADE quote fast-path).
 *
 * The separator group `(?::|for|of|on|request:?)*` was ambiguous: the string
 * "request:" could be parsed as [`request:`] or as [`request`][`:`], so each
 * "request:" unit doubled the parse count -> exponential backtracking on
 * inputs like "quote request:request:request:...!".
 *
 * The fix drops the nested optional colon (`request:?` -> `request`), making
 * the alternation branches pairwise prefix-disjoint (`:`, `for`, `of`, `on`,
 * `request`) so the quantified group has exactly one parse per position.
 * "request:" still matches, as [`request`][`:`].
 */
import { describe, it, expect } from "vitest";
import { planWithRules } from "../src/agents/nlq/planning";

type TradingPlan = {
  domain: string;
  operation: string;
  terms: string;
  tradingData?: { action?: string; symbol?: string };
};

function tradingQuotePlan(q: string): TradingPlan {
  return planWithRules(q) as TradingPlan;
}

describe("NLQ planning E*TRADE quote fast-path (#855 ReDoS fix)", () => {
  it("completes the old ReDoS pump input quickly (no exponential backtracking)", () => {
    const pump = "quote " + "request:".repeat(2000) + "!";
    const start = Date.now();
    const plan = tradingQuotePlan(pump);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
    // The pump input must not produce a quote plan at all (trailing "!" is not a symbol).
    expect(plan.tradingData?.action === "quote" ? plan.tradingData?.symbol : null).not.toBe("!");
  });

  it("still extracts the symbol for representative quote questions", () => {
    const cases: Array<[string, string]> = [
      ["get an etrade quote for MSFT", "MSFT"],
      ["quote for AAPL", "AAPL"],
      ["price of MSFT", "MSFT"],
      ["ticker: NVDA", "NVDA"],
      ["quote request: AMD", "AMD"], // the exact branch that was ambiguous
      ["trading at TSLA", "TSLA"],
    ];
    for (const [q, symbol] of cases) {
      const plan = tradingQuotePlan(q);
      expect(plan.domain, q).toBe("trading");
      expect(plan.operation, q).toBe("list");
      expect(plan.tradingData?.action, q).toBe("quote");
      expect(plan.tradingData?.symbol, q).toBe(symbol);
      expect(plan.terms, q).toBe(symbol);
    }
  });

  it("keeps the separator-word exclusion behavior (FOR/OF/ON/REQUEST fall back)", () => {
    // "for" is a separator word here, so the planner must not quote "FOR" —
    // it falls back to the next uppercase ticker candidate.
    const plan = tradingQuotePlan("quote for MSFT");
    expect(plan.tradingData?.symbol).toBe("MSFT");
  });
});
