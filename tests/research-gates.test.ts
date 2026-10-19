/**
 * Issue #319 — stage-gate tests (spec §5 failure actions).
 */
import { describe, it, expect } from "vitest";
import {
  runStageGates,
  type GateCandidate,
  type GateContext,
} from "../src/services/researchGates";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";
import { verticalSpreadEconomics } from "../src/services/researchEconomics";
import type { ResearchLeg } from "../src/services/researchEconomics";

const NOW = Date.now();

function spreadLegs(): ResearchLeg[] {
  return [
    {
      optionType: "call", strike: 100, expiry: "2026-12-18", dte: 35,
      bid: 4.8, ask: 5.0, iv: 0.4, volume: 100, openInterest: 500,
      quantity: 1, quoteTimestamp: NOW - 60_000,
    },
    {
      optionType: "call", strike: 110, expiry: "2026-12-18", dte: 35,
      bid: 1.0, ask: 1.1, iv: 0.4, volume: 100, openInterest: 500,
      quantity: -1, quoteTimestamp: NOW - 60_000,
    },
  ];
}

function candidate(overrides: Partial<GateCandidate> = {}): GateCandidate {
  const legs = spreadLegs();
  return {
    symbol: "AAA",
    outlook: "bullish",
    thesis: "AAA screens bullish on an uptrend with aligned momentum in a bull regime.",
    quote: {
      price: 100,
      timestamp: NOW - 60_000,
      marketCap: 10e9,
      quoteStatus: "live",
      source: "etrade",
    },
    chain: { underlyingPrice: 100, asOf: NOW - 60_000, provenance: "live" },
    legs,
    structure: "vertical_spread",
    economics: verticalSpreadEconomics(legs, 100),
    expectedMovePct: 0.08,
    eventRisk: null,
    hasNearTermShortLeg: false,
    sources: ["etrade:quote", "chain:live"],
    limitations: ["Catalyst feed unavailable."],
    falsificationPresent: true,
    ...overrides,
  };
}

const ctx: GateContext = { config: RESEARCH_CONFIG_DEFAULTS, now: NOW };

describe("runStageGates", () => {
  it("qualifies a clean candidate", () => {
    const out = runStageGates(candidate(), ctx);
    expect(out.status).toBe("qualified");
    expect(out.gateResults.every((g) => g.passed)).toBe(true);
  });

  it("data_integrity: stale quote → unverified (refresh_or_unverified)", () => {
    const c = candidate({
      quote: { price: 100, timestamp: NOW - 10_000_000, marketCap: 10e9, quoteStatus: "live", source: "etrade" },
    });
    const out = runStageGates(c, ctx);
    expect(out.status).toBe("unverified");
    expect(out.gateResults[0].gate).toBe("data_integrity");
  });

  it("data_integrity: missing quote → unverified", () => {
    const out = runStageGates(candidate({ quote: null }), ctx);
    expect(out.status).toBe("unverified");
  });

  it("contract_integrity: multi-expiry vertical → rejected", () => {
    const legs = spreadLegs();
    legs[1] = { ...legs[1], expiry: "2027-01-15" };
    const out = runStageGates(candidate({ legs }), ctx);
    expect(out.status).toBe("rejected");
    expect(out.rejectionReason).toMatch(/contract_integrity/);
  });

  it("quote_quality: wide spread → watchlist (soft quality failure, idea stays valid)", () => {
    const legs = spreadLegs();
    legs[0] = { ...legs[0], bid: 1.0, ask: 9.0 };
    const out = runStageGates(
      candidate({ legs, economics: verticalSpreadEconomics(legs, 100) }),
      ctx
    );
    expect(out.status).toBe("watchlist");
    expect(out.rejectionReason).toMatch(/spread/);
  });

  it("quote_quality: calibrated chain → watchlist_only (never qualified)", () => {
    const out = runStageGates(
      candidate({ chain: { underlyingPrice: 100, asOf: NOW, provenance: "calibrated" } }),
      ctx
    );
    expect(out.status).toBe("watchlist");
  });

  it("quote_quality: unavailable chain → rejected", () => {
    const out = runStageGates(
      candidate({ chain: { underlyingPrice: 100, asOf: NOW, provenance: "unavailable" } }),
      ctx
    );
    expect(out.status).toBe("rejected");
  });

  it("thesis_coherence: unknown outlook → rejected", () => {
    const out = runStageGates(candidate({ outlook: "unknown", thesis: "No outlook." }), ctx);
    expect(out.status).toBe("rejected");
  });

  it("thesis_coherence: structure/outlook mismatch → rejected", () => {
    const out = runStageGates(candidate({ structure: "iron_condor" }), ctx);
    expect(out.status).toBe("rejected");
    expect(out.rejectionReason).toMatch(/does not express/);
  });

  it("strategy_integrity: tampered economics fail independent recomputation", () => {
    const legs = spreadLegs();
    const econ = verticalSpreadEconomics(legs, 100);
    const out = runStageGates(
      candidate({ economics: { ...econ, maxLoss: econ.maxLoss + 50 } }),
      ctx
    );
    expect(out.status).toBe("rejected");
    expect(out.rejectionReason).toMatch(/strategy_integrity/);
  });

  it("risk_review: near-term short leg → escalate_or_reject", () => {
    const out = runStageGates(candidate({ hasNearTermShortLeg: true }), ctx);
    expect(out.status).toBe("rejected");
    expect(out.rejectionReason).toMatch(/risk_review/);
  });

  it("risk_review: event inside the window → rejected", () => {
    const out = runStageGates(candidate({ eventRisk: "Earnings in 5 days." }), ctx);
    expect(out.status).toBe("rejected");
  });

  it("publication: missing sources → not actionable", () => {
    const out = runStageGates(candidate({ sources: [] }), ctx);
    expect(out.status).toBe("rejected");
    expect(out.rejectionReason).toMatch(/publication/);
  });

  it("publication: missing falsification → not actionable", () => {
    const out = runStageGates(candidate({ falsificationPresent: false }), ctx);
    expect(out.status).toBe("rejected");
  });
});
