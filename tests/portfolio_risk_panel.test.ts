/**
 * Issue #63: Portfolio Risk panel view-model helpers.
 * The panel is a display layer; the pieces that carry meaning — turning a
 * hedge DRAFT into the order ticket's hand-off context, and formatting the
 * backends' honesty states — are pinned here.
 */
import { describe, it, expect } from "vitest";
import { fmtSignedUsd, fmtUsd, hedgeProposalToTradeContext } from "../src/client/portfolioRiskApi";
import type { HedgeProposal } from "../src/services/hedgeProposals";

const sharesProposal: HedgeProposal = {
  instrument: "SPY_SHARES", status: "DRAFT", side: "SELL", symbol: "SPY", quantity: 100,
  estimatedCost: -50000, preHedgeBetaWeightedDeltaDollars: 50000, postHedgeBetaWeightedDeltaDollars: 0,
  withinToleranceAfterHedge: true, rationale: "test",
};
const putsProposal: HedgeProposal = {
  instrument: "SPY_PUTS", status: "DRAFT", side: "BUY", symbol: "SPY", quantity: 2,
  strike: 500, expirationDate: "2026-11-14", estimatedCost: 1300,
  preHedgeBetaWeightedDeltaDollars: 50000, postHedgeBetaWeightedDeltaDollars: 5000,
  withinToleranceAfterHedge: false, rationale: "test",
};

describe("hedgeProposalToTradeContext (HITL hand-off)", () => {
  it("maps the share hedge onto the order ticket fields", () => {
    const ctx = hedgeProposalToTradeContext(sharesProposal, 500);
    expect(ctx.symbol).toBe("SPY");
    expect(ctx.action).toBe("SELL");
    expect(ctx.quantity).toBe(100);
    expect(ctx.underlyingPrice).toBe(500);
    expect(ctx.label).toContain("Hedge draft");
    expect(ctx.label).toContain("100 SPY shares");
    expect(ctx.legs[0]).toContain("SELL 100 SPY shares");
  });

  it("maps the put hedge with strike, expiry and cost in the legs text", () => {
    const ctx = hedgeProposalToTradeContext(putsProposal, 500);
    expect(ctx.action).toBe("BUY");
    expect(ctx.quantity).toBe(2);
    expect(ctx.legs[0]).toContain("500 PUT");
    expect(ctx.legs[0]).toContain("2026-11-14");
    expect(ctx.label).toContain("→");
  });
});

describe("formatting", () => {
  it("renders signed dollars and em-dashes for unavailable values", () => {
    expect(fmtSignedUsd(1234)).toBe("+$1,234");
    expect(fmtSignedUsd(-50)).toBe("−$50");
    expect(fmtSignedUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(500, 2)).toBe("$500.00");
  });
});

import { buildEvaluateCandidate } from "../src/client/portfolioRiskApi";
import { parseSymbolList } from "../src/client/accountApi";

describe("buildEvaluateCandidate (issue #67)", () => {
  const full = {
    deltaShares: "100", deltaDollars: "5000", betaWeightedDeltaDollars: "6000",
    gammaSharesPerDollar: "2.5", thetaDollarsPerDay: "-40", vegaDollarsPerVolPoint: "120",
    rhoDollarsPerRatePoint: "30", definedMaxLoss: "2000",
  };
  it("parses a complete form", () => {
    const c = buildEvaluateCandidate(full);
    expect(c?.deltaDollars).toBe(5000);
    expect(c?.betaWeightedDeltaDollars).toBe(6000);
    expect(c?.definedMaxLoss).toBe(2000);
  });
  it("treats a blank beta-weighted delta as unknown (null), not zero", () => {
    const c = buildEvaluateCandidate({ ...full, betaWeightedDeltaDollars: "" });
    expect(c?.betaWeightedDeltaDollars).toBeNull();
  });
  it("rejects missing or non-numeric required fields", () => {
    expect(buildEvaluateCandidate({ ...full, deltaDollars: "" })).toBeNull();
    expect(buildEvaluateCandidate({ ...full, thetaDollarsPerDay: "abc" })).toBeNull();
  });
});

describe("parseSymbolList (issue #67)", () => {
  it("splits, uppercases and dedupes", () => {
    expect(parseSymbolList("aapl, msft  AAPL;spy")).toEqual(["AAPL", "MSFT", "SPY"]);
    expect(parseSymbolList("")).toEqual([]);
  });
});
