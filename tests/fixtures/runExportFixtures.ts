/**
 * Fixture inputs for the S6 (#1065) shared-exporter golden pins.
 *
 * These inputs are deliberately edge-rich: commas, double quotes,
 * CR/LF, unicode, empty strings, null/undefined metric cells, zeros,
 * negative numbers, empty result sets, partial/failed/abstained
 * outcomes, derived targets, and invalid timestamps (filename
 * fallbacks). The golden captures in tests/run_export_goldens.json
 * were produced by running the LEGACY builders (the five pre-S6
 * exporter modules on main @ f4e679a) over exactly these inputs —
 * see tests/fixtures/generateRunExportGoldens.ts for the procedure.
 */

import type { ScreenerResultData } from "../../src/client/ScreenerResultsView";
import type { StoredScanRun } from "../../src/client/scannerApi";
import type { StoredDiscoveryRun } from "../../src/client/discoveryApi";
import type {
  OptionsIdeasReportExport,
  RawOptionsIdeasExport,
  RetrievedOptionsDataExport,
} from "../../src/client/runExport";

// ---------------------------------------------------------------- screen ---

const screenRowFull = {
  symbol: "NVDA",
  companyName: "NVIDIA, \"Graphics\" Ünïcode\nSecond Line",
  signal: "bullish",
  momentumScore: 91,
  lastPrice: 187.5,
  changePercent: 2.34,
  rsi14: 62,
  source: "E*TRADE live",
  indicators: {
    sentiment: "very_bullish",
    directional: true,
    rangeZone: "overbought",
    valueZone: "fair",
    screenScore: 88,
    intradayPosition: 0.9,
    rangePosition: 0.8,
    summary: "strong",
  },
  factorGrades: {
    value: "B",
    momentum: "A",
    growth: null,
    profitability: null,
    revisions: null,
    quantRating: "Strong Buy",
    valueScore: 61,
    momentumScore: 93,
    compositeScore: 84,
    gradedFactors: ["value", "momentum"],
  },
  technicals: {
    rsi14: 62,
    macdLine: 1.1,
    macdSignalLine: 0.9,
    macdHistogram: 0.2,
    macdSignal: "bullish",
    gapPercent: 1.25,
    gapDirection: "up",
    historyBars: 40,
    historySource: "yahoo",
  },
};

export const SCREEN_RUN = {
  timestamp: "2026-10-20T13:55:00.000Z",
  trigger: "scheduled",
  sector: "Technology",
  success: true,
  totalScanned: 100,
  matchedCount: 12,
  opportunities: [
    screenRowFull,
    {
      // No enrichments at all — every metric cell must be empty.
      symbol: "PLTR",
      companyName: "Palantir Technologies",
      signal: "bullish",
      momentumScore: 88,
      lastPrice: 160,
      changePercent: -1.05,
    },
    {
      // Zeros are values, not absences.
      symbol: "ZERO",
      companyName: "",
      signal: "neutral",
      momentumScore: 0,
      lastPrice: 0,
      changePercent: 0,
      indicators: { sentiment: "", screenScore: 0, rangeZone: "", valueZone: "" },
      factorGrades: { quantRating: null, value: null, momentum: null },
      technicals: { gapPercent: 0, macdHistogram: 0 },
    },
  ],
  allStocks: [
    screenRowFull,
    {
      symbol: "XYZ",
      companyName: "Carriage\rReturn Co",
      signal: "neutral",
      momentumScore: 40,
      lastPrice: 12.5,
      changePercent: 0,
      rsi14: null,
      source: "E*TRADE live",
    },
  ],
} as unknown as ScreenerResultData;

export const SCREEN_PARTIAL = {
  ...SCREEN_RUN,
  timestamp: "2026-10-20T13:50:00.000Z",
  totalScanned: 47,
  matchedCount: 5,
  partial: {
    quotedCount: 47,
    requestedCount: 100,
    failedSymbols: ["XYZ"],
    failureReasons: { other: 53 },
  },
} as unknown as ScreenerResultData;

export const SCREEN_EMPTY_ALL_SECTOR = {
  timestamp: "2026-10-20T13:40:00.000Z",
  trigger: "manual",
  sector: "ALL",
  success: true,
  totalScanned: 0,
  matchedCount: 0,
  opportunities: [],
  // allStocks omitted entirely — legacy serializes [] for it.
} as unknown as ScreenerResultData;

export const SCREEN_BAD_TIMESTAMP = {
  ...SCREEN_RUN,
  timestamp: "?? weird ts !!",
  sector: "Financial Services & Co",
} as unknown as ScreenerResultData;

// ------------------------------------------------------------------ scan ---

const scanGateParams = {
  minCompositeScore: 55,
  minProbabilityOfProfit: 0.35,
  requireFresh: true,
  minConfidence: "MEDIUM",
};

const condorCell = {
  strategyType: "iron_condor",
  best: {
    candidateId: "aapl-ic", label: "Iron Condor", compositeScore: 66.4, score: 60,
    expirationDate: "2026-11-20", legs: [], netDebit: -2.1, maxLoss: 290,
    maxProfit: 210, maxProfitUnbounded: false, targetRewardRisk: 0.72,
    probabilityOfProfit: 0.61,
  },
  evaluatedCount: 5, passedCount: 2, rejectedCount: 3, rejectionReasons: {},
};

const spreadCell = {
  strategyType: "call_debit_spread",
  best: {
    candidateId: "aapl-cds", label: "Bull Call, \"Spread\"", compositeScore: 71.2, score: 64,
    expirationDate: "2026-11-20", legs: [], netDebit: 3.25, maxLoss: 325,
    maxProfit: 675, maxProfitUnbounded: false, targetRewardRisk: 2.08,
    probabilityOfProfit: 0.42,
  },
  evaluatedCount: 4, passedCount: 1, rejectedCount: 3, rejectionReasons: {},
};

const fitRowAapl = {
  symbol: "AAPL",
  verdict: "pass",
  targetPrice: 262.5,
  targetSource: "thesis",
  targetEmUnits: 0.6,
  cells: [condorCell, spreadCell],
  gateBucket: "fit",
  gateReasons: [],
};

const fitRowMsft = {
  symbol: "MSFT",
  verdict: "pass",
  targetPrice: null,
  targetSource: null,
  targetEmUnits: null,
  cells: [condorCell],
  gateBucket: "fit",
  gateReasons: ["freshness waived, per \"profile\"\nsecond line"],
};

const fitResult = {
  scanned: 3,
  withTrades: 2,
  opportunities: [],
  skipped: [{ symbol: "ZZZ", reason: "no chain data" }],
  truncatedSymbols: 0,
  assumptions: [],
  matrix: [fitRowAapl, fitRowMsft],
  typeRollup: [],
  mode: "strategy_fit",
  fits: [fitRowAapl, fitRowMsft],
  fitsTotal: 2,
  gate: { fit: 2, borderline: 1, noFit: 0 },
  borderline: [],
  gateParams: scanGateParams,
  profileRef: { id: "prof-1", name: "Income, Growth", version: 2 },
  generatedAt: "2026-10-15T14:00:00.000Z",
  modelVersion: "1.2.0",
  requestSnapshot: {
    template: {
      thesis: "bullish",
      targetDate: "2026-11-20",
      maxPlannedLoss: 750,
      minRewardRisk: 1.5,
      allowedStrategies: ["all"],
    },
    mode: "strategy_fit",
    riskProfile: "balanced",
    profile: null,
    request: { symbols: ["AAPL", "MSFT", "ZZZ"] },
  },
  coverage: { considered: 3, scanned: 3, evaluated: 2, errors: 1, truncated: false },
};

export const SCAN_STORED_FIT = {
  id: "scan-run-1",
  generatedAt: "2026-10-15T14:00:00.000Z",
  mode: "strategy_fit",
  modelVersion: "1.2.0",
  gate: { fit: 2, borderline: 1, noFit: 0 },
  coverage: { considered: 3, scanned: 3, evaluated: 2, errors: 1, truncated: false },
  profileRef: { id: "prof-1", name: "Income, Growth", version: 2 },
  userLogin: "tester",
  result: fitResult,
} as unknown as StoredScanRun;

/** The unified route's live envelope for the same result. */
export const SCAN_LIVE_RESPONSE = {
  action: "scan_opportunities",
  success: true,
  meta: { generatedAt: "2026-10-15T14:00:00.000Z" },
  scanRunId: "scan-run-1",
  persisted: true,
  reportUrl: "/api/reports/scan-run-1",
  ...fitResult,
} as unknown as Parameters<
  typeof import("../../src/client/scannerExport").scanExportRunFromResult
>[0];

const perNameResult = {
  scanned: 2,
  withTrades: 1,
  skipped: [],
  truncatedSymbols: 0,
  assumptions: [],
  matrix: [],
  typeRollup: [],
  mode: "per_name_best",
  fits: [],
  fitsTotal: 0,
  gate: { fit: 1, borderline: 0, noFit: 1 },
  borderline: [],
  gateParams: scanGateParams,
  profileRef: null,
  generatedAt: "2026-10-16T09:30:00.000Z",
  modelVersion: "1.2.0",
  requestSnapshot: { request: { symbols: ["NVDA", "TSLA", "AMD"] } },
  coverage: { considered: 3, scanned: 2, evaluated: 2, errors: 0, truncated: true },
  opportunities: [
    {
      symbol: "NVDA",
      score: 81,
      targetPrice: 200,
      targetSource: "thesis",
      targetEmUnits: 0.5,
      gateBucket: "fit",
      gateReasons: [],
      pick: {
        status: "trade",
        best: {
          compositeScore: 88.5,
          candidate: {
            label: "Bull Call Spread, Nov",
            netDebit: 4.1,
            maxLoss: 410,
            modelImpliedProbabilityOfProfit: 0.47,
          },
        },
      },
    },
    {
      symbol: "TSLA",
      score: 12,
      targetPrice: null,
      targetSource: null,
      targetEmUnits: null,
      gateBucket: "no_fit",
      gateReasons: ["no qualifying trade"],
      pick: { status: "no_trade", best: null },
    },
    {
      // No pick at all — score falls back to the row's own score.
      symbol: "AMD",
      score: 0,
      targetPrice: 150,
      targetSource: "analyst",
      targetEmUnits: 0,
      gateBucket: null,
      gateReasons: undefined,
      pick: null,
    },
  ],
};

export const SCAN_STORED_PER_NAME = {
  // No id (a run assembled before persistence), no profile.
  generatedAt: "2026-10-16T09:30:00.000Z",
  mode: "per_name_best",
  modelVersion: "1.2.0",
  gate: { fit: 1, borderline: 0, noFit: 1 },
  coverage: { considered: 3, scanned: 2, evaluated: 2, errors: 0, truncated: true },
  profileRef: null,
  result: perNameResult,
} as unknown as StoredScanRun;

export const SCAN_EMPTY_FITS = {
  id: "scan-run-empty",
  generatedAt: "",
  mode: "strategy_fit",
  modelVersion: "1.2.0",
  gate: { fit: 0, borderline: 0, noFit: 3 },
  coverage: null,
  profileRef: null,
  result: {
    ...fitResult,
    fits: [],
    fitsTotal: 0,
    gate: { fit: 0, borderline: 0, noFit: 3 },
    profileRef: null,
    gateParams: undefined,
    requestSnapshot: undefined,
    coverage: undefined,
    matrix: [],
  },
} as unknown as StoredScanRun;

// ------------------------------------------------------------- discovery ---

const discCandidate = (over: Record<string, unknown> = {}) => ({
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

const discRankedEntry = (cand: Record<string, unknown>, rank: number, compositeScore: number) => ({
  candidate: cand,
  rank,
  compositeScore,
  components: { engineScore: 1, probability: 1, rewardRisk: 1, capitalSafety: 1, liquidity: 1 },
});

const DISC_REQUEST_NVDA = {
  symbol: "NVDA",
  thesis: "bullish, \"strong\" conviction",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  allowedStrategies: ["long_call", "long_put"],
};

export const DISCOVERY_VIEWED_PARTIAL = {
  id: "run-partial",
  createdAt: "2026-10-20T13:55:00.000Z",
  userLogin: "tester",
  trigger: "scheduled",
  scheduleId: "sched-abc",
  inputModel: "saved-request",
  status: "partial",
  requestCount: 3,
  completedCount: 1,
  failedCount: 1,
  symbols: ["NVDA", "MSFT", "AAPL"],
  requests: [DISC_REQUEST_NVDA],
  outcomes: [
    {
      symbol: "NVDA",
      status: "completed",
      request: DISC_REQUEST_NVDA,
      ranked: [
        discRankedEntry(discCandidate(), 1, 87.5),
        discRankedEntry(
          discCandidate({ id: "cand-2", label: "NVDA Bull Call Spread, Dec", netDebit: 2.1, maxLoss: 210, maxProfit: 0 }),
          2,
          71.25,
        ),
      ],
      riskReports: [],
      screenedOut: [],
      excluded: [{ reason: "insufficient liquidity", count: 3 }],
      bestTrade: {
        status: "recommended",
        riskProfile: "balanced",
        confidence: "HIGH",
        best: { candidate: { id: "cand-1" } },
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
      request: { ...DISC_REQUEST_NVDA, symbol: "MSFT" },
      error: "chain load failed, reason: \"timeout\"\nretry exhausted",
    },
    {
      symbol: "AAPL",
      status: "abstained",
      request: { ...DISC_REQUEST_NVDA, symbol: "AAPL" },
      error: "no view confidence",
      derivation: {
        targetPrice: 262.5,
        spot: 250,
        emMultiple: 0.6,
        expectedMovePct: 0.0833,
        windowExpiry: "2026-11-20",
        windowDays: 30,
        profileRef: { name: "Income, Growth", version: 2 },
      },
    },
  ],
} as unknown as StoredDiscoveryRun;

const noViewCandidate = (over: Record<string, unknown> = {}) => ({
  ...discCandidate(),
  id: "nv-1",
  expirationDate: "2026-11-20",
  score: 74,
  structureRewardRisk: null as number | null,
  scoreModel: "no-view-v1",
  ...over,
});

const discConstraintSet = (request: Record<string, unknown>) => ({
  source: "no-view",
  request,
  expectedIvDirection: "unchanged",
});

const CONSTRAINT_NVDA_NV = {
  symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1,
  minProbabilityOfProfit: 0.35, minDte: 7, maxDte: 45, riskProfile: "balanced",
};
// Omits the POP floor and the DTE window entirely.
const CONSTRAINT_AAPL_NV = { symbol: "AAPL", maxPlannedLoss: 250, minRewardRisk: 2, riskProfile: "conservative" };
// Only a max DTE.
const CONSTRAINT_MSFT_NV = { symbol: "MSFT", maxPlannedLoss: 300, minRewardRisk: 1.5, maxDte: 30 };

export const DISCOVERY_NOVIEW = {
  id: "run-noview",
  createdAt: "2026-10-20T14:15:00.000Z",
  userLogin: "tester",
  trigger: "scheduled",
  scheduleId: "sched-noview",
  inputModel: "no-view",
  status: "partial",
  requestCount: 3,
  completedCount: 1,
  failedCount: 1,
  abstainedCount: 1,
  symbols: ["NVDA", "MSFT", "AAPL"],
  requests: [],
  constraintSets: [
    discConstraintSet(CONSTRAINT_NVDA_NV),
    discConstraintSet(CONSTRAINT_MSFT_NV),
    discConstraintSet(CONSTRAINT_AAPL_NV),
  ],
  outcomes: [
    {
      symbol: "NVDA",
      status: "completed",
      constraintSet: discConstraintSet(CONSTRAINT_NVDA_NV),
      rankedNoView: [
        discRankedEntry(noViewCandidate(), 1, 82.5),
        discRankedEntry(
          noViewCandidate({
            id: "nv-2", type: "bull_put_spread", label: "NVDA Bull Put Spread",
            netDebit: -1.8, maxProfit: 180, maxProfitUnbounded: false, maxLoss: 320,
            structureRewardRisk: 0.5625,
          }),
          2,
          64,
        ),
      ],
      excluded: [{ reason: "max planned loss exceeded", count: 2 }],
      bestNoViewTrade: {
        status: "research_only",
        best: undefined as unknown,
      },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 1200, contractsMatched: 45 } },
    },
    {
      symbol: "MSFT",
      status: "completed",
      abstained: true,
      constraintSet: discConstraintSet(CONSTRAINT_MSFT_NV),
      rankedNoView: [],
      excluded: [
        { reason: "insufficient liquidity", count: 3 },
        { reason: "probability of profit below the floor", count: 2 },
      ],
      bestNoViewTrade: { status: "no_trade", best: undefined as unknown },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 800, contractsMatched: 0 } },
    },
    {
      symbol: "AAPL",
      status: "failed",
      constraintSet: discConstraintSet(CONSTRAINT_AAPL_NV),
      error: "E*TRADE chain unavailable: session expired",
    },
  ],
} as unknown as StoredDiscoveryRun;
// The panel stores the best pick as the ranked ENTRY (best.candidate is
// the entry's candidate) — mirror that wiring for the pick flag.
(DISCOVERY_NOVIEW.outcomes[0] as any).bestNoViewTrade.best =
  (DISCOVERY_NOVIEW.outcomes[0] as any).rankedNoView[0];

export const DISCOVERY_FAILED = {
  id: "run-failed",
  createdAt: "not-a-timestamp",
  userLogin: "tester",
  trigger: "manual-trigger",
  inputModel: "saved-request",
  status: "failed",
  requestCount: 1,
  completedCount: 0,
  failedCount: 1,
  symbols: ["NVDA"],
  requests: [DISC_REQUEST_NVDA],
  outcomes: [
    { symbol: "NVDA", status: "failed", request: DISC_REQUEST_NVDA, error: undefined },
  ],
} as unknown as StoredDiscoveryRun;

// ---------------------------------------------------------- options XLS ---

const xlsChainRaw = {
  OptionChainResponse: {
    OptionPair: [{ Call: { symbol: "NVDA261120C00200000" }, Put: { symbol: "NVDA261120P00200000" } }],
  },
};

export const XLS_RAW_PLAIN: RawOptionsIdeasExport = {
  symbol: "NVDA",
  question: "What are the best NVDA trades, \"risk-defined\" only? Ünïcode",
  expirations: [{ year: 2026, month: 11, day: 20, expiryType: "REGULAR" }],
  optionChains: [
    { raw: xlsChainRaw, note: "wrapped chain — raw payload is exported" },
    { symbol: "NVDA", pairs: [] },
  ],
  // >240 chars so the prompt chunker splits it; unicode included.
  systemPrompt: `You are an expert options strategist. ${"Analyze carefully. ".repeat(30)}Ünïcode tail`,
  userPrompt: "Underlying: NVDA",
  selection: { contractsAvailable: 120, contractsIncluded: 96, truncated: true },
};

export const XLS_RAW_GROUPED: RawOptionsIdeasExport = {
  symbol: "SPY",
  question: "Grouped question",
  expirations: [],
  optionChains: [],
  systemPrompt: "top-level system prompt (unused when groups exist)",
  userPrompt: "top-level user prompt (unused when groups exist)",
  groupInputs: [
    {
      id: "g1",
      label: "Nov 2026",
      symbol: "SPY",
      question: "q1",
      expirations: [{ year: 2026, month: 11, day: 20, expiryType: "REGULAR" }],
      optionChains: [{ raw: xlsChainRaw }],
      systemPrompt: "group one system",
      userPrompt: "group one user",
      selection: { contractsAvailable: 40, contractsIncluded: 40, truncated: false },
    },
    {
      id: "g2",
      label: "Dec 2026",
      symbol: "SPY",
      question: "q2",
      expirations: [],
      optionChains: [],
      systemPrompt: "group two system",
      userPrompt: "group two user",
    },
  ],
  finalRanking: { systemPrompt: "rank system", userPrompt: "rank user" },
};

export const XLS_RETRIEVED: RetrievedOptionsDataExport = {
  symbol: "SPY",
  question: "Retrieve complete raw option chains for SPY.",
  dataSource: "etrade",
  expirations: [{ year: 2026, month: 11, day: 20, expiryType: "REGULAR" }],
  optionChains: [{ raw: xlsChainRaw }, { symbol: "SPY", pairs: [{ call: {}, put: {} }] }],
};

const xlsContract = (over: Record<string, unknown> = {}) => ({
  symbol: "NVDA261120C00200000",
  optionType: "call",
  strikePrice: 200,
  bid: 4.1,
  ask: 4.3,
  lastPrice: 4.2,
  volume: 1500,
  openInterest: 8200,
  delta: 0.52,
  gamma: 0.021,
  theta: -0.045,
  vega: 0.11,
  rho: 0.03,
  impliedVolatility: 0.34,
  ...over,
});

export const XLS_REPORT: OptionsIdeasReportExport = {
  symbol: "NVDA",
  question: "Best risk-defined NVDA trades?",
  dataCoverage: {
    expirationCount: 2,
    chainCount: 2,
    contractCount: 240,
    sentContractCount: 180,
    estimatedInputTokens: 42000,
    inputTruncated: true,
  },
  groups: [
    {
      id: "g1",
      label: "Nov 2026",
      status: "complete",
      model: "model-x",
      answer: "Bull call spread, ranked first.\nSecond line.",
      contractSymbols: ["NVDA261120C00200000", "NVDA261120P00180000"],
      contractWarnings: ["wide spread on the put leg"],
      contractDetails: [
        { symbol: "NVDA261120C00200000", expiration: "2026-11-20", contract: xlsContract() as any },
        {
          symbol: "NVDA261120P00180000",
          expiration: "2026-11-20",
          contract: xlsContract({
            symbol: "NVDA261120P00180000", optionType: "put", strikePrice: 180,
            delta: -0.31, impliedVolatility: 0.36,
          }) as any,
        },
      ],
      expirationCount: 1,
      contractCount: 120,
      sentContractCount: 90,
      inputTruncated: false,
    },
    {
      id: "g2",
      label: "Dec 2026",
      status: "error",
      error: "model timeout",
      expirationCount: 1,
      contractCount: 120,
      sentContractCount: 90,
      inputTruncated: true,
    },
  ],
  finalAnalysis: {
    status: "complete",
    model: "model-x",
    answer: "Overall: prefer the November spread.",
    rankings: [
      { rank: 1, groupId: "g1", strategy: "Bull Call Spread", rationale: "Best reward/risk, liquid" },
      { rank: 2, groupId: "g-missing", strategy: "Iron Condor", rationale: "Group label falls back to the id" },
    ],
  },
};

export const XLS_REPORT_MINIMAL: OptionsIdeasReportExport = {
  symbol: "SPY",
  question: "",
  dataCoverage: { expirationCount: 0, chainCount: 0, contractCount: 0 },
  groups: [],
  finalAnalysis: { status: "error", error: "no groups completed" },
};
