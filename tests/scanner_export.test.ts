/**
 * Issue #126 (PR-C): result-set serializers for a strategy scan run
 * (src/client/runExport.ts; originally scannerExport.ts, #1065). The ScannerPanel offered only a PDF
 * report link; these pins cover the CSV/JSON result-set exports:
 *  - the CSV columns mirror the ScanResultsView results tables in
 *    both modes (fits in strategy_fit, opportunities in
 *    per_name_best), with the same best-fit pick the view renders;
 *  - run metadata leads the CSV as `#` comment lines — timestamp,
 *    universe/scope, and the fit-gate parameters the run used;
 *  - RFC 4180 escaping (via PR-B's csvEscape) for reasons/labels
 *    carrying commas, quotes, or line breaks;
 *  - a completed run with zero fits exports metadata + header only —
 *    the empty result IS the result;
 *  - the JSON is the stored run object (summary stamps + full
 *    result), and a live response is first reduced to that shape
 *    (envelope stripped, persisted run id kept);
 *  - filenames identify the run (UTC stamp + result set).
 */
import { describe, it, expect } from "vitest";
import {
  scanExportFilename,
  scanExportRunFromResult,
  scanExportRunFromStored,
  scanResultsCsv,
  scanRunJson,
} from "../src/client/runExport";
import type {
  OpportunityScanResponse,
  StoredScanRun,
} from "../src/client/scannerApi";

// Fixtures (typed against the real shapes, mirroring the panel tests) --

const gateParams = {
  minCompositeScore: 55,
  minProbabilityOfProfit: 0.35,
  requireFresh: true,
  minConfidence: "MEDIUM" as const,
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
    candidateId: "aapl-cds", label: "Bull Call Spread", compositeScore: 71.2, score: 64,
    expirationDate: "2026-11-20", legs: [], netDebit: 3.25, maxLoss: 325,
    maxProfit: 675, maxProfitUnbounded: false, targetRewardRisk: 2.08,
    probabilityOfProfit: 0.42,
  },
  evaluatedCount: 4, passedCount: 1, rejectedCount: 3, rejectionReasons: {},
};

const fitRowAapl = {
  symbol: "AAPL",
  verdict: "pass" as const,
  targetPrice: 262.5,
  targetSource: "thesis" as const,
  targetEmUnits: 0.6,
  // Two best cells: the CSV must name the higher-composite one,
  // exactly as the view's bestFitCell does.
  cells: [condorCell, spreadCell],
  gateBucket: "fit" as const,
  gateReasons: [],
};

const fitRowMsft = {
  symbol: "MSFT",
  verdict: "pass" as const,
  targetPrice: 420,
  targetSource: "thesis" as const,
  targetEmUnits: 0.55,
  cells: [condorCell],
  gateBucket: "fit" as const,
  gateReasons: ["freshness waived, per profile"],
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
  mode: "strategy_fit" as const,
  fits: [fitRowAapl, fitRowMsft],
  fitsTotal: 2,
  gate: { fit: 2, borderline: 1, noFit: 0 },
  borderline: [],
  gateParams,
  profileRef: { id: "prof-1", name: "Income", version: 2 },
  generatedAt: "2026-10-15T14:00:00.000Z",
  modelVersion: "1.2.0",
  requestSnapshot: {
    template: {
      thesis: "bullish" as const,
      targetDate: "2026-11-20",
      maxPlannedLoss: 750,
      minRewardRisk: 1.5,
      allowedStrategies: ["all" as const],
    },
    mode: "strategy_fit" as const,
    riskProfile: "balanced" as const,
    profile: null,
    request: { symbols: ["AAPL", "MSFT", "ZZZ"] },
  },
  configSnapshot: {
    maxScanSymbols: 25,
    targetFactors: { bullish: 1.1, bearish: 0.9, range_bound: 1, large_move: 1.15 },
    targetEmMultiples: { bullish: 0.6, bearish: -0.6, range_bound: 0, large_move: 1.2 },
  },
  coverage: { considered: 3, scanned: 3, truncated: 0, evaluated: 2, errors: 1, withTrades: 2 },
};

const storedFitRun = {
  id: "3f9c1e2a-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
  generatedAt: fitResult.generatedAt,
  mode: fitResult.mode,
  modelVersion: fitResult.modelVersion,
  gate: fitResult.gate,
  coverage: fitResult.coverage,
  profileRef: fitResult.profileRef,
  userLogin: "trader1",
  result: fitResult,
} as unknown as StoredScanRun;

const perNameResult = {
  ...fitResult,
  mode: "per_name_best" as const,
  fits: [],
  fitsTotal: 0,
  matrix: [],
  requestSnapshot: { ...fitResult.requestSnapshot, mode: "per_name_best" as const },
  opportunities: [
    {
      symbol: "AAPL",
      underlyingPrice: 250,
      targetPrice: 262.5,
      targetSource: "thesis" as const,
      targetEmUnits: 0.6,
      score: 71.2,
      gateBucket: "fit" as const,
      gateReasons: [],
      pick: {
        status: "recommended" as const,
        riskProfile: "balanced" as const,
        confidence: "HIGH" as const,
        alternatives: [],
        rationale: [],
        blockers: [],
        humanApprovalRequired: true as const,
        disclaimer: "",
        best: {
          rank: 1,
          compositeScore: 71.2,
          components: {
            engineScore: 0, probability: 0, rewardRisk: 0,
            capitalSafety: 0, liquidity: 0, dataQuality: 0,
          },
          candidate: {
            id: "cand-1",
            type: "call_debit_spread" as const,
            label: 'Bull "Call" Spread, Nov',
            legs: [],
            netDebit: 3.25,
            maxLoss: 325,
            maxProfit: 675,
            modelImpliedProbabilityOfProfit: 0.42,
          },
        },
      },
    },
    {
      symbol: "TSLA",
      underlyingPrice: 240,
      targetPrice: 228,
      targetSource: "thesis" as const,
      targetEmUnits: -0.5,
      score: 0,
      gateBucket: "borderline" as const,
      gateReasons: ["no qualifying trade"],
      pick: {
        status: "no_trade" as const,
        riskProfile: "balanced" as const,
        confidence: "LOW" as const,
        alternatives: [],
        rationale: [],
        blockers: [],
        humanApprovalRequired: true as const,
        disclaimer: "",
      },
    },
  ],
};

const livePerNameResponse = {
  ...perNameResult,
  action: "opportunities",
  success: true,
  scanRunId: "run-live-1",
  persisted: true,
  reportUrl: "/api/options/report.pdf?key=options:pdf:live.pdf",
  meta: { generatedAt: perNameResult.generatedAt, environment: "PROD" },
} as unknown as OpportunityScanResponse;

// Adapters ---------------------------------------------------------------

describe("scanExportRunFromStored / scanExportRunFromResult", () => {
  it("a stored run exports as itself — stamps copied from the summary", () => {
    const run = scanExportRunFromStored(storedFitRun);
    expect(run.id).toBe(storedFitRun.id);
    expect(run.generatedAt).toBe("2026-10-15T14:00:00.000Z");
    expect(run.mode).toBe("strategy_fit");
    expect(run.modelVersion).toBe("1.2.0");
    expect(run.gate).toEqual({ fit: 2, borderline: 1, noFit: 0 });
    expect(run.coverage).toEqual(fitResult.coverage);
    expect(run.profileRef).toEqual({ id: "prof-1", name: "Income", version: 2 });
    expect(run.result).toBe(storedFitRun.result);
  });

  it("a live response is reduced to the stored shape: envelope stripped, run id kept", () => {
    const run = scanExportRunFromResult(livePerNameResponse);
    expect(run.id).toBe("run-live-1");
    expect(run.generatedAt).toBe("2026-10-15T14:00:00.000Z");
    const parsed = JSON.parse(scanRunJson(run));
    expect(parsed.result.action).toBeUndefined();
    expect(parsed.result.success).toBeUndefined();
    expect(parsed.result.meta).toBeUndefined();
    expect(parsed.result.scanRunId).toBeUndefined();
    expect(parsed.result.persisted).toBeUndefined();
    expect(parsed.result.reportUrl).toBeUndefined();
    // The result content itself is intact.
    expect(parsed.result.opportunities).toHaveLength(2);
  });

  it("an unpersisted live response carries no run id", () => {
    const { scanRunId: _id, persisted: _p, ...rest } = livePerNameResponse;
    const run = scanExportRunFromResult(rest as OpportunityScanResponse);
    expect(run.id).toBeUndefined();
    expect(JSON.parse(scanRunJson(run)).id).toBeUndefined();
  });
});

// CSV ---------------------------------------------------------------------

describe("scanResultsCsv — strategy_fit fits", () => {
  const csv = scanResultsCsv(scanExportRunFromStored(storedFitRun));
  const lines = csv.split("\r\n");

  it("leads with metadata: run stamp, profile, symbols, coverage, gate counts, gate params", () => {
    expect(lines[0]).toBe("# cfagent strategy scan results — fits");
    expect(lines[1]).toBe(
      "# run: 2026-10-15T14:00:00.000Z · mode: strategy_fit · scan model v1.2.0 · profile: Income v2 · run id: 3f9c1e2a-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
    );
    expect(lines[2]).toBe("# symbols: AAPL, MSFT, ZZZ");
    expect(lines[3]).toBe("# coverage: considered 3 · scanned 3 · evaluated 2 · skipped 1 · truncated 0");
    expect(lines[4]).toBe("# gate: 2 fit / 1 borderline / 0 no fit · fits total: 2 · rows in this file: 2");
    expect(lines[5]).toBe(
      "# fit gate: min composite score 55 · min probability of profit 0.35 · require fresh: yes · min confidence: MEDIUM",
    );
  });

  it("columns mirror the results table the view displays", () => {
    expect(lines[6]).toBe(
      "symbol,strategy,compositeScore,probabilityOfProfit,targetPrice,targetSource,targetEmUnits,netDebit,maxLoss,gateBucket,gateReasons",
    );
  });

  it("rows carry the view's best fit (highest composite cell) and raw values", () => {
    // AAPL has two best cells (66.4 condor, 71.2 spread): the view's
    // bestFitCell renders the spread — the CSV must name the same one.
    expect(lines[7]).toBe("AAPL,Bull Call Spread,71.2,0.42,262.5,thesis,0.6,3.25,325,fit,");
    // The reasons field contains a comma: it is quoted (RFC 4180).
    expect(lines[8]).toBe('MSFT,Iron Condor,66.4,0.61,420,thesis,0.55,-2.1,290,fit,"freshness waived, per profile"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

describe("scanResultsCsv — per_name_best opportunities", () => {
  const csv = scanResultsCsv(scanExportRunFromResult(livePerNameResponse));
  const lines = csv.split("\r\n");

  it("labels the set as opportunities and omits the fits-total segment", () => {
    expect(lines[0]).toBe("# cfagent strategy scan results — opportunities");
    expect(lines[4]).toBe("# gate: 2 fit / 1 borderline / 0 no fit · rows in this file: 2");
  });

  it("rows mirror the opportunities table: pick label/score/POP, no-trade named", () => {
    const aapl = lines.find((l) => l.startsWith("AAPL,"));
    // The label carries a quote and a comma — escaped per RFC 4180.
    expect(aapl).toBe('AAPL,"Bull ""Call"" Spread, Nov",71.2,0.42,262.5,thesis,0.6,3.25,325,fit,');
    const tsla = lines.find((l) => l.startsWith("TSLA,"));
    expect(tsla).toBe("TSLA,No qualifying trade,0,,228,thesis,-0.5,,,borderline,no qualifying trade");
  });
});

describe("scanResultsCsv — zero fits", () => {
  it("a completed run with no fits exports metadata + header and no rows", () => {
    const emptyRun = {
      ...storedFitRun,
      id: "empty-run",
      gate: { fit: 0, borderline: 2, noFit: 1 },
      result: {
        ...fitResult,
        fits: [],
        fitsTotal: 0,
        gate: { fit: 0, borderline: 2, noFit: 1 },
      },
    } as unknown as StoredScanRun;
    const csv = scanResultsCsv(scanExportRunFromStored(emptyRun));
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(7); // 6 metadata lines + column header
    expect(lines[4]).toBe("# gate: 0 fit / 2 borderline / 1 no fit · fits total: 0 · rows in this file: 0");
    expect(lines[6]).toContain("symbol,strategy,compositeScore");
  });
});

// JSON + filenames ----------------------------------------------------------

describe("scanRunJson + scanExportFilename", () => {
  it("the JSON is the stored run object: summary stamps + full result", () => {
    const parsed = JSON.parse(scanRunJson(scanExportRunFromStored(storedFitRun)));
    expect(Object.keys(parsed)).toEqual([
      "id", "generatedAt", "mode", "modelVersion", "gate", "coverage", "profileRef", "result",
    ]);
    expect(parsed.id).toBe(storedFitRun.id);
    expect(parsed.result.fits).toHaveLength(2);
    expect(parsed.result.gateParams).toEqual(gateParams);
    // The per-user scoping stamp is not part of the export.
    expect(parsed.userLogin).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("trader1");
  });

  it("filenames identify the run by its own UTC timestamp and set", () => {
    const run = scanExportRunFromStored(storedFitRun);
    expect(scanExportFilename(run, "results-csv")).toBe("scan-20261015-140000-fits.csv");
    expect(scanExportFilename(run, "run-json")).toBe("scan-20261015-140000.json");
    const perName = scanExportRunFromResult(livePerNameResponse);
    expect(scanExportFilename(perName, "results-csv")).toBe("scan-20261015-140000-opportunities.csv");
  });
});
