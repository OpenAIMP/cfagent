import { describe, it, expect } from "vitest";
import { RiskPolicyEngine, DEFAULT_POLICY_LIMITS } from "../src/trading/riskPolicyEngine";

/**
 * #79: RiskPolicyEngine enforces the four limits.
 */

describe("#79 RiskPolicyEngine", () => {
  const engine = new RiskPolicyEngine();
  const healthy = { dailyRealizedPnl: 0, currentHeat: 0 };

  it("passes an allowed action within limits", () => {
    const v = engine.check({ type: "draft_order", notional: 10_000, addedHeat: 5_000 }, healthy);
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.rules).toContain("action-allowlist");
  });

  it("denies an action outside the allowlist", () => {
    const v = engine.check({ type: "place_order" }, healthy);
    expect(v.passed).toBe(false);
    expect(v.reasons[0]).toContain("allowlist");
  });

  it("denies a position over the notional cap", () => {
    const v = engine.check(
      { type: "draft_order", notional: DEFAULT_POLICY_LIMITS.maxPositionNotional + 1 },
      healthy
    );
    expect(v.passed).toBe(false);
    expect(v.reasons[0]).toContain("cap");
  });

  it("halts when the daily loss breaker trips", () => {
    const v = engine.check(
      { type: "screen" },
      { dailyRealizedPnl: -(DEFAULT_POLICY_LIMITS.maxDailyLoss + 1), currentHeat: 0 }
    );
    expect(v.passed).toBe(false);
    expect(v.reasons[0]).toContain("halted");
  });

  it("denies heat over the portfolio cap", () => {
    const v = engine.check(
      { type: "draft_order", addedHeat: DEFAULT_POLICY_LIMITS.maxPortfolioHeat + 1 },
      healthy
    );
    expect(v.passed).toBe(false);
    expect(v.reasons[0]).toContain("heat");
  });

  it("exposes the limits for the UI (single source of truth)", () => {
    const limits = engine.getLimits();
    expect(limits.maxPositionNotional).toBe(200_000);
    expect(limits.allowedActions).toContain("screen");
  });
});
