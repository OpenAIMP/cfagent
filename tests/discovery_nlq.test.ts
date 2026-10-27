import { describe, expect, it } from "vitest";

import {
  parseOptionsStrategyIntent,
  runOptionsStrategyAction,
} from "../src/agents/nlqOptionsStrategy";
import type { DiscoveryRunOutcome } from "../src/services/discoveryService";
import type { StoredDiscoverySetupRun } from "../src/trading";

/**
 * Issue #14 slice 5b — the NLQ discovery surface (issue #1918:
 * discovery phrasing now routes to the unified `options_fit_discovery`
 * action's scope leg; the removed `options_discovery` action's pins
 * were updated to the surviving action in the same change).
 *
 * A view-less prompt ("discover setups across my watchlist") must
 * reach the discovery pipeline with the watchlist universe as the
 * default scope (Decision 1), and the runner's formatted cards are
 * the answer. Ordinary scan questions must NOT be hijacked.
 */

describe("parseOptionsStrategyIntent — discovery phrasing", () => {
  it("routes a discovery prompt to options_fit_discovery with the watchlist default scope", () => {
    const intent = parseOptionsStrategyIntent("discover setups across my watchlist");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.scope?.kind).toBe("watchlist");
  });

  it("keeps a named watchlist scope", () => {
    const intent = parseOptionsStrategyIntent("find setups in my Semis watchlist");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.scope).toMatchObject({ kind: "watchlist" });
  });

  it("does not hijack an ordinary opportunity scan", () => {
    const intent = parseOptionsStrategyIntent("scan my watchlist for bullish option trades");
    expect(intent?.action).toBe("options_opportunities");
  });

  it("does not hijack a single-name strategy question", () => {
    const intent = parseOptionsStrategyIntent("what is the best options trade for NVDA");
    expect(intent?.action).not.toBe("options_fit_discovery");
  });
});

const FAKE_OUTCOME: DiscoveryRunOutcome = {
  run: {
    id: "run-nlq-1",
    createdAt: "2026-10-22T12:00:00.000Z",
    scopeKey: "nlq:venus:watchlist:all",
    source: "nlq",
    configHash: "abc12345",
    modelVersion: "discovery-v1",
    counts: { considered: 2, setups: 1, abstentions: 1, prescreenedOut: 0, errors: 0 },
    items: [
      {
        kind: "setup",
        symbol: "AAA",
        thesis: "bullish",
        ruleId: "trend-up",
        confidence: "MEDIUM",
        discoveryScore: 72,
        gateBucket: "fit",
        targetPrice: 105.16,
        targetDate: "2026-11-20",
        firedSignals: ["TREND_UP", "LIQUIDITY_OK"],
        evidence: "trend fixture evidence",
      },
      { kind: "abstention", symbol: "BBB", stage: "inference", reason: "no setup for BBB — no signals fired", nearMissSignals: [] },
    ],
    userLogin: "venus",
  } as StoredDiscoverySetupRun,
  deltas: [],
  errors: [],
};

function fakeEtrade(watchlists: Array<{ name: string; symbols: string[] }> = []) {
  return {
    client: undefined as never,
    fetchQuoteRemote: async () => ({ lastPrice: 100 }),
    getWatchlists: async () => watchlists,
    screenMarketsAsync: async () => ({ stocks: [] as Array<{ symbol: string; marketCap?: number }> }),
  };
}

describe("runOptionsStrategyAction — options_fit_discovery scope leg", () => {
  it("runs the discovery runner over the listed symbols and returns the cards", async () => {
    const seen: string[] = [];
    const runner = {
      run: async (req: { symbols: string[]; scopeKey: string }) => {
        seen.push(...req.symbols);
        expect(req.scopeKey).toContain("nlq:");
        return FAKE_OUTCOME;
      },
    };
    const res = await runOptionsStrategyAction(
      fakeEtrade(),
      "options_fit_discovery",
      {
        request: {},
        riskProfile: "balanced",
        strategyFilter: {},
        targetPriceInferred: false,
        thesisInferred: false,
        scope: { kind: "symbols", symbols: ["AAA", "BBB"] },
      } as never,
      { discoveryRunner: runner as never, userLogin: "venus" },
    );
    expect(seen).toEqual(["AAA", "BBB"]);
    expect(res.status).toBe("success");
    expect(res.count).toBe(1);
    expect(res.summary).toContain("AAA bullish — rule trend-up, score 72 (fit)");
    expect(res.summary).toContain("Evidence: trend fixture evidence");
    expect(res.summary).toContain("BBB — abstained (inference)");
    expect(res.discoveryRunId).toBe("run-nlq-1");
  });

  it("resolves a watchlist scope through the caller's watchlists", async () => {
    const seen: string[] = [];
    const runner = {
      run: async (req: { symbols: string[] }) => {
        seen.push(...req.symbols);
        return FAKE_OUTCOME;
      },
    };
    const res = await runOptionsStrategyAction(
      fakeEtrade([{ name: "Semis", symbols: ["NVDA", "AMD"] }]),
      "options_fit_discovery",
      {
        request: {},
        riskProfile: "balanced",
        strategyFilter: {},
        targetPriceInferred: false,
        thesisInferred: false,
        scope: { kind: "watchlist", name: "Semis" },
      } as never,
      { discoveryRunner: runner as never, userLogin: "venus" },
    );
    expect(res.status).toBe("success");
    expect(seen).toEqual(["NVDA", "AMD"]);
  });

  it("fails honestly when discovery is not wired in this context", async () => {
    const res = await runOptionsStrategyAction(
      fakeEtrade(),
      "options_fit_discovery",
      {
        request: {},
        riskProfile: "balanced",
        strategyFilter: {},
        targetPriceInferred: false,
        thesisInferred: false,
        scope: { kind: "symbols", symbols: ["AAA"] },
      } as never,
      { userLogin: "venus" },
    );
    expect(res.status).toBe("invalid_request");
    expect(res.summary).toContain("isn't wired");
  });

  it("fails helpfully when the caller has no watchlists for the default scope", async () => {
    const runner = { run: async () => FAKE_OUTCOME };
    const res = await runOptionsStrategyAction(
      fakeEtrade([]),
      "options_fit_discovery",
      {
        request: {},
        riskProfile: "balanced",
        strategyFilter: {},
        targetPriceInferred: false,
        thesisInferred: false,
        scope: { kind: "watchlist" },
      } as never,
      { discoveryRunner: runner as never, userLogin: "venus" },
    );
    expect(res.status).toBe("invalid_request");
    expect(res.summary).toContain("no saved watchlists");
  });
});
