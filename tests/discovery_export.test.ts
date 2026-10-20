/**
 * Issue #126 (PR-F): serializers for a persisted discovery run's
 * result-set downloads (discoveryExport.ts), following the PR-B/PR-C
 * pattern — pure functions over the stored run, pinned here:
 *
 *  - CSV = one row per ranked candidate across the run's symbols,
 *    with the saved request's view (thesis / target) as context
 *    columns and the panel's headline candidate metrics;
 *  - partial/failed runs name their failed symbols, with reasons, in
 *    `#` metadata lines — a subset is never presented as the whole;
 *  - JSON = the full stored run minus the userLogin scoping stamp;
 *  - filenames carry the run's own timestamp (UTC).
 */
import { describe, it, expect } from "vitest";
import {
  discoveryCandidatesCsv,
  discoveryExportFilename,
  discoveryRunHasCandidates,
  discoveryRunJson,
} from "../src/client/discoveryExport";
import type { StoredDiscoveryRun } from "../src/client/discoveryApi";

// Fixtures -----------------------------------------------------------------

const candidate = (over: Record<string, unknown> = {}) => ({
  id: "cand-1",
  rank: 1,
  type: "long_call",
  label: "NVDA Long Call",
  symbol: "NVDA",
  underlyingPrice: 180,
  expirationDate: "2027-12-18",
  dataFreshness: "FRESH",
  legs: [],
  netDebit: 4.25,
  estimatedFees: 1.3,
  maxProfit: null,
  maxProfitUnbounded: true,
  maxLoss: 425,
  breakevens: [184.25],
  targetPnl: 850,
  targetRewardRisk: 2,
  modelImpliedProbabilityOfProfit: 0.42,
  netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1 },
  liquidityScore: 80,
  score: 77,
  scoreBreakdown: {},
  payoffCurve: [],
  scenarios: [],
  explanations: [],
  warnings: [],
  assumptions: [],
  ...over,
});

const rankedEntry = (cand: Record<string, unknown>, rank: number, compositeScore: number) => ({
  candidate: cand,
  rank,
  compositeScore,
  components: { engineScore: 1, probability: 1, rewardRisk: 1, capitalSafety: 1, liquidity: 1 },
});

const REQUEST_NVDA = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  allowedStrategies: ["long_call", "long_put"],
};

const REQUEST_MSFT = { ...REQUEST_NVDA, symbol: "MSFT", thesis: "bearish", targetPrice: 380 };

const RUN_PARTIAL = {
  id: "run-partial",
  createdAt: "2026-10-20T13:55:00.000Z",
  userLogin: "tester",
  trigger: "scheduled",
  scheduleId: "sched-abc",
  inputModel: "saved-request",
  status: "partial",
  requestCount: 2,
  completedCount: 1,
  failedCount: 1,
  symbols: ["NVDA", "MSFT"],
  requests: [REQUEST_NVDA, REQUEST_MSFT],
  outcomes: [
    {
      symbol: "NVDA",
      status: "completed",
      request: REQUEST_NVDA,
      ranked: [
        rankedEntry(candidate(), 1, 87.5),
        rankedEntry(
          candidate({ id: "cand-2", label: "NVDA Bull Call Spread, Dec", netDebit: 2.1, maxLoss: 210 }),
          2,
          71.25,
        ),
      ],
      riskReports: [],
      screenedOut: [{ id: "iron_condor", reason: "wing width" }],
      excluded: [{ reason: "insufficient liquidity", count: 3 }],
      bestTrade: {
        status: "recommended",
        riskProfile: "balanced",
        confidence: "HIGH",
        best: undefined as unknown,
        alternatives: [],
        rationale: ["ranks #1"],
        blockers: [],
        humanApprovalRequired: true,
        disclaimer: "research only",
      },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 1200, contractsMatched: 45 } },
    },
    {
      symbol: "MSFT",
      status: "failed",
      request: REQUEST_MSFT,
      error: "E*TRADE chain unavailable: session expired",
    },
  ],
} as unknown as StoredDiscoveryRun;
// Wire the best-trade pick at the first ranked entry (same object the
// store would have persisted).
(RUN_PARTIAL.outcomes[0] as any).bestTrade.best = (RUN_PARTIAL.outcomes[0] as any).ranked[0];

const RUN_FAILED = {
  id: "run-failed",
  createdAt: "2026-10-20T13:45:00.000Z",
  userLogin: "tester",
  trigger: "manual-trigger",
  inputModel: "saved-request",
  status: "failed",
  requestCount: 1,
  completedCount: 0,
  failedCount: 1,
  symbols: ["TSLA"],
  requests: [{ ...REQUEST_NVDA, symbol: "TSLA" }],
  outcomes: [
    {
      symbol: "TSLA",
      status: "failed",
      request: { ...REQUEST_NVDA, symbol: "TSLA" },
      error: "consumer credentials are not configured",
    },
  ],
} as unknown as StoredDiscoveryRun;

// CSV ----------------------------------------------------------------------

describe("discoveryCandidatesCsv (#126 PR-F)", () => {
  const csv = discoveryCandidatesCsv(RUN_PARTIAL);
  const lines = csv.split("\r\n");

  it("carries run metadata: time, trigger + schedule, input model, status, counts", () => {
    expect(lines[0]).toBe("# cfagent discovery run results — ranked candidates");
    expect(lines[1]).toContain("2026-10-20T13:55:00.000Z");
    expect(lines[1]).toContain("Scheduled · schedule sched-abc");
    expect(lines[1]).toContain("input model: saved-request");
    expect(lines[1]).toContain("status: partial");
    expect(lines[2]).toContain("symbols: NVDA, MSFT");
    expect(lines[2]).toContain("rows in this file: 2");
  });

  it("names failed symbols with their recorded reasons", () => {
    expect(lines[3]).toBe("# FAILED: MSFT — E*TRADE chain unavailable: session expired");
  });

  it("emits one row per ranked candidate with the saved view as context columns", () => {
    const header = lines[4].split(",");
    expect(header.slice(0, 6)).toEqual(["symbol", "thesis", "targetPrice", "targetDate", "rank", "strategy"]);
    const row1 = lines[5];
    expect(row1).toContain("NVDA,bullish,200,2027-12-18,1,NVDA Long Call");
    expect(row1).toContain("87.5"); // composite score
    expect(row1).toContain("0.42"); // POP as the stored fraction
    expect(row1).toContain("4.25"); // net debit
    expect(row1).toContain("425"); // max loss
    expect(row1.endsWith("yes")).toBe(true); // the best-trade pick is flagged
    const row2 = lines[6];
    expect(row2).toContain("NVDA Bull Call Spread"); // comma in the label is CSV-escaped
    expect(row2).toContain('"NVDA Bull Call Spread, Dec"');
    expect(row2.endsWith("yes")).toBe(false);
  });

  it("a failed run exports metadata + header and no candidate rows", () => {
    const failedCsv = discoveryCandidatesCsv(RUN_FAILED);
    const failedLines = failedCsv.split("\r\n").filter((l) => l.length > 0);
    expect(failedLines.some((l) => l.startsWith("# FAILED: TSLA"))).toBe(true);
    expect(failedLines).toHaveLength(5); // 4 metadata lines + the column header
  });
});

// JSON ---------------------------------------------------------------------

describe("discoveryRunJson (#126 PR-F)", () => {
  it("round-trips the full stored run (requests + outcomes) minus the scoping stamp", () => {
    const parsed = JSON.parse(discoveryRunJson(RUN_PARTIAL));
    expect(parsed.id).toBe("run-partial");
    expect(parsed.status).toBe("partial");
    expect(parsed.requests).toHaveLength(2);
    expect(parsed.outcomes[0].ranked).toHaveLength(2);
    expect(parsed.outcomes[1].error).toContain("session expired");
    expect("userLogin" in parsed).toBe(false);
  });

  it("a failed run's JSON is its diagnostic record (error preserved)", () => {
    const parsed = JSON.parse(discoveryRunJson(RUN_FAILED));
    expect(parsed.status).toBe("failed");
    expect(parsed.outcomes[0].error).toBe("consumer credentials are not configured");
  });
});

// Filenames + candidate presence -------------------------------------------

describe("discovery export filenames and candidate presence (#126 PR-F)", () => {
  it("carry the run's own timestamp in UTC", () => {
    expect(discoveryExportFilename(RUN_PARTIAL, "candidates-csv")).toBe("discovery-20261020-135500.csv");
    expect(discoveryExportFilename(RUN_PARTIAL, "run-json")).toBe("discovery-20261020-135500.json");
    expect(discoveryExportFilename(RUN_FAILED, "run-json")).toBe("discovery-20261020-134500.json");
  });

  it("has-candidates reflects the outcomes, not the run status alone", () => {
    expect(discoveryRunHasCandidates(RUN_PARTIAL)).toBe(true);
    expect(discoveryRunHasCandidates(RUN_FAILED)).toBe(false);
  });
});

// Profile-derived runs (issue #533, PR-533B) ------------------------------

const PROFILE_REF = { id: "prof-1", name: "Income", version: 3 };

const DERIVATION_NVDA = {
  source: "profile-derived",
  spot: 130,
  spotSource: "chain",
  atmIv: 0.45,
  expectedMovePct: 0.1311,
  windowExpiry: "2026-11-20",
  windowDays: 31,
  emMultiple: 0.6,
  thesis: "bullish",
  targetPrice: 140.23,
  profileRef: PROFILE_REF,
};

const DERIVATION_AAPL = {
  ...DERIVATION_NVDA,
  spot: 260,
  atmIv: 0.3,
  expectedMovePct: 0.0875,
  emMultiple: -0.6,
  thesis: "bearish",
  targetPrice: 246.35,
};

const REQUEST_NVDA_DERIVED = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 140.23,
  targetDate: "2026-11-20",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  allowedStrategies: ["long_call", "long_put"],
};

const REQUEST_AAPL_DERIVED = {
  ...REQUEST_NVDA_DERIVED,
  symbol: "AAPL",
  thesis: "bearish",
  targetPrice: 246.35,
};

const RUN_DERIVED = {
  id: "run-derived",
  createdAt: "2026-10-20T14:05:00.000Z",
  userLogin: "tester",
  trigger: "scheduled",
  scheduleId: "sched-derived",
  inputModel: "profile-derived",
  profileRef: PROFILE_REF,
  status: "partial",
  requestCount: 2,
  completedCount: 1,
  failedCount: 1,
  abstainedCount: 1,
  symbols: ["NVDA", "MSFT", "AAPL"],
  requests: [REQUEST_NVDA_DERIVED, REQUEST_AAPL_DERIVED],
  outcomes: [
    {
      symbol: "NVDA",
      status: "completed",
      request: REQUEST_NVDA_DERIVED,
      derivation: DERIVATION_NVDA,
      ranked: [rankedEntry(candidate(), 1, 87.5)],
      riskReports: [],
      screenedOut: [],
      excluded: [],
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 1200, contractsMatched: 45 } },
    },
    {
      symbol: "MSFT",
      status: "abstained",
      error: "no usable IV in the live chain for MSFT — no expected move can be derived",
    },
    {
      symbol: "AAPL",
      status: "failed",
      request: REQUEST_AAPL_DERIVED,
      derivation: DERIVATION_AAPL,
      error: "chain fetch failed",
    },
  ],
} as unknown as StoredDiscoveryRun;

describe("discoveryCandidatesCsv — profile-derived runs (#533)", () => {
  const csv = discoveryCandidatesCsv(RUN_DERIVED);
  const lines = csv.split("\r\n");

  it("stamps the input model in the metadata header", () => {
    expect(lines[1]).toContain("input model: profile-derived");
    expect(lines[1]).toContain("status: partial");
    expect(lines[2]).toContain("symbols: NVDA, MSFT, AAPL");
  });

  it("adds one # DERIVED line per derived symbol with the full derivation", () => {
    expect(lines).toContain(
      "# DERIVED: NVDA target $140.23 = spot $130.00 × (1 + 0.6 × EM 13.11%) · window 2026-11-20 (31d) · profile Income v3"
    );
    // A failed outcome that got far enough to derive still shows its
    // derivation, ahead of its FAILED line.
    expect(lines).toContain(
      "# DERIVED: AAPL target $246.35 = spot $260.00 × (1 + -0.6 × EM 8.75%) · window 2026-11-20 (31d) · profile Income v3"
    );
    expect(lines).toContain("# FAILED: AAPL — chain fetch failed");
  });

  it("adds one # ABSTAINED line per abstention, with its reason and no target", () => {
    expect(lines).toContain(
      "# ABSTAINED: MSFT — no usable IV in the live chain for MSFT — no expected move can be derived"
    );
  });

  it("still emits the completed symbol's candidate rows under its constructed view", () => {
    expect(csv).toContain("NVDA,bullish,140.23,2026-11-20,1,NVDA Long Call");
    expect(discoveryRunHasCandidates(RUN_DERIVED)).toBe(true);
  });

  it("saved-request CSVs gain no DERIVED/ABSTAINED lines (byte-identical headers)", () => {
    const savedCsv = discoveryCandidatesCsv(RUN_PARTIAL);
    expect(savedCsv).not.toContain("# DERIVED:");
    expect(savedCsv).not.toContain("# ABSTAINED:");
    expect(savedCsv.split("\r\n")[3]).toBe("# FAILED: MSFT — E*TRADE chain unavailable: session expired");
  });
});

describe("discoveryRunJson — profile-derived runs (#533)", () => {
  it("carries the derivation records and abstentions verbatim, minus the scoping stamp", () => {
    const parsed = JSON.parse(discoveryRunJson(RUN_DERIVED));
    expect(parsed.inputModel).toBe("profile-derived");
    expect(parsed.profileRef).toEqual(PROFILE_REF);
    expect(parsed.outcomes[0].derivation).toEqual(DERIVATION_NVDA);
    expect(parsed.outcomes[2].derivation).toEqual(DERIVATION_AAPL);
    expect(parsed.outcomes[1].status).toBe("abstained");
    expect(parsed.outcomes[1].error).toContain("no usable IV");
    // An abstention produced no request and no target — none is exported.
    expect("request" in parsed.outcomes[1]).toBe(false);
    expect("userLogin" in parsed).toBe(false);
  });
});
