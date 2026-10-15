/**
 * Issue #37 (G4): thinkHarness guardrails run on real state or not at all.
 * Pins the acceptance criteria: no decision is ever produced from the old
 * hardcoded spread / fallback prices / $50,000 default balance, and the
 * inputs-unavailable path fails closed with provenance reported.
 */
import { describe, it, expect } from "vitest";
import { ETradeThinkHarness, type ThinkStateProvider } from "../src/services/thinkHarness";

const noState: ThinkStateProvider = {
  async getLiveQuote() { return null; },
  async getLiveAccountBalanceUSD() { return null; },
};

function liveState(quote: { lastPrice: number; bid: number; ask: number } | null, balance: number | null): ThinkStateProvider {
  return {
    async getLiveQuote() { return quote; },
    async getLiveAccountBalanceUSD() { return balance; },
  };
}

describe("fail closed when inputs are unavailable", () => {
  it("produces INPUTS_UNAVAILABLE instead of deciding on defaults", async () => {
    const harness = new ETradeThinkHarness(undefined, undefined, noState);
    const result = await harness.evaluateTradeWithThinking({ symbol: "NVDA", action: "BUY", quantity: 10, orderType: "MARKET" });
    expect(result.approved).toBe(false);
    expect(result.recommendation).toBe("INPUTS_UNAVAILABLE");
    expect(result.proposedDraft).toBeUndefined();
    expect(result.inputSources).toEqual({ price: "unavailable", accountBalance: "unavailable", spread: "unavailable" });
    expect(result.reason).toContain("inputs unavailable");
    // The old ghost values must not leak into the output.
    expect(JSON.stringify(result)).not.toContain("50000");
  });

  it("fails closed on spread alone, even with provided price and balance", async () => {
    const harness = new ETradeThinkHarness(undefined, undefined, noState);
    const result = await harness.evaluateTradeWithThinking({
      symbol: "AAPL", action: "BUY", quantity: 5, orderType: "LIMIT", price: 200, accountBalanceUSD: 30000,
    });
    expect(result.recommendation).toBe("INPUTS_UNAVAILABLE");
    expect(result.inputSources.price).toBe("provided");
    expect(result.inputSources.accountBalance).toBe("provided");
    expect(result.inputSources.spread).toBe("unavailable");
  });
});

describe("decisions from live state", () => {
  it("computes spread and concentration from the live quote and balance", async () => {
    // bid 99.90 / ask 100.10 -> spread 0.2%; balance $40,000; 10 sh @ $100 = $1,000 = 2.5%
    const harness = new ETradeThinkHarness(undefined, undefined, liveState({ lastPrice: 100, bid: 99.9, ask: 100.1 }, 40000));
    const result = await harness.evaluateTradeWithThinking({ symbol: "ACME", action: "BUY", quantity: 10, orderType: "LIMIT" });
    expect(result.approved).toBe(true);
    expect(result.recommendation).toBe("PROCEED_TO_HITL");
    expect(result.inputSources).toEqual({ price: "live", accountBalance: "live", spread: "live" });
    const liquidity = result.steps.find((s) => s.phase === "market_condition");
    expect(liquidity?.metricValue).toBeCloseTo(0.2, 3);
    const risk = result.steps.find((s) => s.phase === "risk_limits");
    expect(risk?.metricValue).toBe(2.5);
    expect(result.proposedDraft?.estimatedPrice).toBe(100);
  });

  it("fails the liquidity phase on a genuinely wide live spread", async () => {
    // bid 90 / ask 110 -> spread 20% > 0.5% threshold (WARN in the legacy
    // shape was PASS at an assumed 0.05%; a WARN does not block, so assert
    // the metric and status reflect reality instead of the old assumption)
    const harness = new ETradeThinkHarness(undefined, undefined, liveState({ lastPrice: 100, bid: 90, ask: 110 }, 100000));
    const result = await harness.evaluateTradeWithThinking({ symbol: "ACME", action: "BUY", quantity: 1, orderType: "LIMIT" });
    const liquidity = result.steps.find((s) => s.phase === "market_condition");
    expect(liquidity?.metricValue).toBeCloseTo(20, 1);
    expect(liquidity?.status).toBe("WARN");
    expect(result.recommendation).toBe("REVISE_PARAMETERS");
  });

  it("enforces concentration against the PROVIDED balance, not a $50,000 ghost", async () => {
    // Provided balance $1,000; order 100 sh @ $100 (live price) = $10,000 = 1000% -> FAIL
    const harness = new ETradeThinkHarness(undefined, undefined, liveState({ lastPrice: 100, bid: 99.9, ask: 100.1 }, null));
    const result = await harness.evaluateTradeWithThinking({
      symbol: "ACME", action: "BUY", quantity: 100, orderType: "LIMIT", accountBalanceUSD: 1000,
    });
    expect(result.approved).toBe(false);
    expect(result.recommendation).toBe("REJECT_RISK_LIMIT");
    expect(result.inputSources.accountBalance).toBe("provided");
    const risk = result.steps.find((s) => s.phase === "risk_limits");
    expect(risk?.status).toBe("FAIL");
    expect(risk?.metricValue).toBe(1000);
  });
});
