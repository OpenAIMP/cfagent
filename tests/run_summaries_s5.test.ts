/**
 * Issue #1057 (consolidation S5): the run-summary normalization module
 * (src/services/runSummaries.ts) — the single definition site for the
 * GET /api/runs shape.
 *
 * Pinned here:
 *  1. Per-store normalization: each store's fixture row maps to the
 *     one summary shape with the store's own fields — and fields the
 *     store does not record stay null (honest absence, never invented:
 *     scan runs have no status; a canonical row without a success flag
 *     in its body has no status).
 *  2. The exact de-duplication joins: a canonical options row links
 *     its scan-store twin via the scan-run id embedded in its body
 *     (body.report.result.scanRunId); a canonical screener row claims
 *     its ScreenerAgent-feed twin via the `screener:<timestamp>`
 *     generation id. Unlinked detail rows survive.
 *  3. Merge: newest-first across stores, deterministic tie-break,
 *     limit applied after the merge.
 */
import { describe, it, expect } from "vitest";

import {
  canonicalScanRunId,
  mergeRunSummaries,
  runSummaryFromDiscoveryRun,
  runSummaryFromReport,
  runSummaryFromScanRun,
  runSummaryFromScreenerRun,
  type RunSummary,
} from "../src/services/runSummaries";
import type { ScheduledReportHit } from "../src/services/scheduledReports";
import type { ScanRunSummary } from "../src/trading/options/scanRunStore";
import type { DiscoveryRunSummary } from "../src/trading/options/discoveryRunStore";
import type { ScreenerRunResult } from "../src/agents/screener-agent";

const TS = {
  discovery: "2026-10-22T11:00:00.000Z",
  options: "2026-10-22T10:00:00.000Z",
  scan2: "2026-10-22T09:30:00.000Z",
  screener: "2026-10-22T08:00:00.000Z",
  research: "2026-10-22T07:00:00.000Z",
};

function reportHit(overrides: Partial<ScheduledReportHit> = {}): ScheduledReportHit {
  return {
    id: "rep-screener-1",
    runId: `screener:${TS.screener}`,
    title: "Market screen — NASDAQ100 (scheduled)",
    source: "screener",
    summary: "Scanned 100 symbols, 5 matched, 3 opportunities.",
    body: JSON.stringify({
      trigger: "scheduled",
      success: true,
      matchedCount: 5,
      pdfKey: "screener:pdf:abc",
      timestamp: TS.screener,
    }),
    createdAt: TS.screener,
    ...overrides,
  };
}

function scanSummary(overrides: Partial<ScanRunSummary> = {}): ScanRunSummary {
  return {
    id: "scan-1",
    generatedAt: TS.options,
    mode: "best_trade",
    modelVersion: "1.1.2",
    gate: { fit: 3, borderline: 2, noFit: 5 },
    coverage: {
      considered: 10,
      scanned: 10,
      truncated: 0,
      evaluated: 10,
      errors: 0,
      withTrades: 4,
      eventCalendar: { covered: 0, total: 0, coveragePct: 0 },
    },
    profileRef: { id: "p1", name: "Growth", version: 2 },
    userLogin: "alice",
    ...overrides,
  } as ScanRunSummary;
}

function discoverySummary(overrides: Partial<DiscoveryRunSummary> = {}): DiscoveryRunSummary {
  return {
    id: "disc-1",
    createdAt: TS.discovery,
    userLogin: "alice",
    trigger: "scheduled",
    inputModel: "saved-request",
    status: "partial",
    requestCount: 3,
    completedCount: 2,
    failedCount: 1,
    abstainedCount: 0,
    symbols: ["AAPL", "MSFT", "NVDA"],
    ...overrides,
  };
}

function screenerRun(overrides: Partial<ScreenerRunResult> = {}): ScreenerRunResult {
  return {
    timestamp: TS.screener,
    trigger: "scheduled",
    provider: "etrade",
    universe: "NASDAQ100",
    sector: "ALL",
    success: true,
    totalScanned: 100,
    matchedCount: 5,
    opportunities: [],
    allStocks: [],
    discoveryMessage: "",
    pdfKey: "screener:pdf:abc",
    ...overrides,
  } as ScreenerRunResult;
}

describe("run-summary normalization (S5)", () => {
  it("canonical screener report → kind screener with its recorded fields", () => {
    const row = runSummaryFromReport(reportHit());
    expect(row.kind).toBe("screener");
    expect(row.id).toBe("rep-screener-1");
    expect(row.runId).toBe(`screener:${TS.screener}`);
    expect(row.trigger).toBe("scheduled");
    expect(row.status).toBe("completed");
    expect(row.resultCount).toBe(5);
    expect(row.pdfKey).toBe("screener:pdf:abc");
    expect(row.reportUrl).toBe("/api/screener/report.pdf?key=screener%3Apdf%3Aabc");
    expect(row.reportId).toBe("rep-screener-1");
    expect(row.scanRunId).toBeNull();
  });

  it("canonical options report → kind options_scanner, carrying the scan link", () => {
    const row = runSummaryFromReport(
      reportHit({
        id: "rep-options-1",
        runId: `options_scanner:${TS.options}:balanced`,
        source: "options_scanner",
        title: "Options scanner — balanced",
        body: JSON.stringify({
          generatedAt: TS.options,
          report: { result: { scanRunId: "scan-1", withTrades: 7, pdfKey: "options:pdf:k2" } },
        }),
        createdAt: TS.options,
      }),
    );
    expect(row.kind).toBe("options_scanner");
    expect(row.scanRunId).toBe("scan-1");
    expect(row.resultCount).toBe(7);
    expect(row.pdfKey).toBe("options:pdf:k2");
    // No success flag recorded in this body shape → no invented status.
    expect(row.status).toBeNull();
    expect(row.trigger).toBeNull();
  });

  it("canonical research report → kind report, no screening fields invented", () => {
    const row = runSummaryFromReport(
      reportHit({
        id: "rep-research-1",
        runId: "research:1",
        source: "research_report",
        title: "Daily research",
        body: JSON.stringify({ sheets: [] }),
        createdAt: TS.research,
      }),
    );
    expect(row.kind).toBe("report");
    expect(row.source).toBe("research_report");
    expect(row.status).toBeNull();
    expect(row.resultCount).toBeNull();
    expect(row.reportId).toBe("rep-research-1");
  });

  it("scan-store summary → options_scanner with honest nulls (no status, no pdf)", () => {
    const row = runSummaryFromScanRun(scanSummary());
    expect(row.kind).toBe("options_scanner");
    expect(row.id).toBe("scan-1");
    expect(row.scanRunId).toBe("scan-1");
    expect(row.reportId).toBeNull();
    expect(row.status).toBeNull();
    expect(row.trigger).toBeNull();
    expect(row.pdfKey).toBeNull();
    expect(row.reportUrl).toBeNull();
    expect(row.resultCount).toBe(10);
    expect(row.title).toContain("Growth");
    expect(row.summary).toContain("3 fit");
  });

  it("discovery summary → discovery kind with the store's status + trigger verbatim", () => {
    const row = runSummaryFromDiscoveryRun(discoverySummary());
    expect(row.kind).toBe("discovery");
    expect(row.status).toBe("partial");
    expect(row.trigger).toBe("scheduled");
    expect(row.resultCount).toBe(2);
    expect(row.reportId).toBeNull();
    expect(row.summary).toContain("1 failed");
  });

  it("screener-feed run → screener kind under its generation id", () => {
    const row = runSummaryFromScreenerRun(screenerRun());
    expect(row.kind).toBe("screener");
    expect(row.id).toBe(`screener:${TS.screener}`);
    expect(row.runId).toBe(`screener:${TS.screener}`);
    expect(row.status).toBe("completed");
    expect(row.resultCount).toBe(5);
    expect(row.reportId).toBeNull();
    expect(row.reportUrl).toBe("/api/screener/report.pdf?key=screener%3Apdf%3Aabc");
  });

  it("canonicalScanRunId reads the link from every body shape the writers produce", () => {
    expect(canonicalScanRunId(JSON.stringify({ report: { result: { scanRunId: "a" } } }))).toBe("a");
    expect(canonicalScanRunId(JSON.stringify({ result: { scanRunId: "b" } }))).toBe("b");
    expect(canonicalScanRunId(JSON.stringify({ scanRunId: "c" }))).toBe("c");
    expect(canonicalScanRunId(JSON.stringify({ report: { result: {} } }))).toBeNull();
    expect(canonicalScanRunId("not json")).toBeNull();
  });
});

describe("run-summary merge (S5)", () => {
  const canonicalOptions = () =>
    runSummaryFromReport(
      reportHit({
        id: "rep-options-1",
        runId: `options_scanner:${TS.options}:balanced`,
        source: "options_scanner",
        title: "Options scanner — balanced",
        body: JSON.stringify({ report: { result: { scanRunId: "scan-1", withTrades: 7 } } }),
        createdAt: TS.options,
      }),
    );

  it("de-duplicates a scan run that exists in both stores (canonical wins)", () => {
    const merged = mergeRunSummaries(
      [[canonicalOptions()], [runSummaryFromScanRun(scanSummary())], [], []],
      50,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].reportId).toBe("rep-options-1");
  });

  it("de-duplicates a screener run present in both mas_reports and the feed", () => {
    const merged = mergeRunSummaries(
      [[runSummaryFromReport(reportHit())], [], [], [runSummaryFromScreenerRun(screenerRun())]],
      50,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].reportId).toBe("rep-screener-1");
  });

  it("keeps unlinked detail rows and merges newest-first across stores", () => {
    const rows: RunSummary[] = mergeRunSummaries(
      [
        [runSummaryFromReport(reportHit()), canonicalOptions()],
        [
          runSummaryFromScanRun(scanSummary()),
          runSummaryFromScanRun(scanSummary({ id: "scan-2", generatedAt: TS.scan2 })),
        ],
        [runSummaryFromDiscoveryRun(discoverySummary())],
        [runSummaryFromScreenerRun(screenerRun())],
      ],
      50,
    );
    // scan-1 + the feed twin of the canonical screener are deduped away.
    expect(rows.map((r) => r.id)).toEqual([
      "disc-1",
      "rep-options-1",
      "scan-2",
      "rep-screener-1",
    ]);
    expect(rows.map((r) => r.createdAt)).toEqual([TS.discovery, TS.options, TS.scan2, TS.screener]);
  });

  it("applies the limit after merging", () => {
    const rows = mergeRunSummaries(
      [
        [runSummaryFromReport(reportHit()), canonicalOptions()],
        [runSummaryFromScanRun(scanSummary({ id: "scan-2", generatedAt: TS.scan2 }))],
        [runSummaryFromDiscoveryRun(discoverySummary())],
        [],
      ],
      2,
    );
    expect(rows.map((r) => r.id)).toEqual(["disc-1", "rep-options-1"]);
  });
});

describe("#1239 UI truth (pdfStatus/pdfError + twin inheritance)", () => {
  it("canonical body carries pdfStatus/pdfError (top-level and result-nested)", () => {
    const top = runSummaryFromReport(reportHit({
      body: JSON.stringify({ success: true, pdfKey: "screener:pdf:abc", pdfStatus: "generated" }),
    }));
    expect(top.pdfStatus).toBe("generated");
    expect(top.pdfError).toBeNull();
    const nested = runSummaryFromReport(reportHit({
      body: JSON.stringify({ success: true, report: { result: { pdfStatus: "failed", pdfError: "render blew up" } } }),
    }));
    expect(nested.pdfStatus).toBe("failed");
    expect(nested.pdfError).toBe("render blew up");
  });

  it("screener-feed run carries its pdfStatus/pdfError", () => {
    const row = runSummaryFromScreenerRun(screenerRun({ pdfKey: undefined, pdfStatus: "failed", pdfError: "boom" } as Partial<ScreenerRunResult>));
    expect(row.pdfKey).toBeNull();
    expect(row.reportUrl).toBeNull();
    expect(row.pdfStatus).toBe("failed");
    expect(row.pdfError).toBe("boom");
  });

  it("scan summary with a stamped pdfKey projects the options download URL", () => {
    const row = runSummaryFromScanRun(scanSummary({ pdfKey: "options:pdf:xyz" }));
    expect(row.pdfKey).toBe("options:pdf:xyz");
    expect(row.reportUrl).toBe("/api/options/report.pdf?key=options%3Apdf%3Axyz");
    expect(row.pdfStatus).toBe("generated");
  });

  it("merge: the canonical winner inherits PDF facts from its dropped screener twin", () => {
    const canonical = runSummaryFromReport(reportHit({
      body: JSON.stringify({ trigger: "scheduled", success: true, matchedCount: 5, timestamp: TS.screener }),
    }));
    expect(canonical.pdfKey).toBeNull();
    const twin = runSummaryFromScreenerRun(screenerRun({ pdfStatus: "generated" } as Partial<ScreenerRunResult>));
    const merged = mergeRunSummaries([[canonical], [], [], [twin]], 50);
    expect(merged).toHaveLength(1);
    expect(merged[0].pdfKey).toBe("screener:pdf:abc");
    expect(merged[0].reportUrl).toBe("/api/screener/report.pdf?key=screener%3Apdf%3Aabc");
    expect(merged[0].pdfStatus).toBe("generated");
  });

  it("merge: the canonical winner inherits from its dropped scan twin (options join)", () => {
    const canonical = runSummaryFromReport(reportHit({
      id: "rep-options-1",
      runId: `options_scanner:${TS.options}:balanced`,
      source: "options_scanner",
      title: "Options scanner — balanced",
      body: JSON.stringify({ report: { result: { scanRunId: "scan-1", withTrades: 7 } } }),
      createdAt: TS.options,
    }));
    const twin = runSummaryFromScanRun(scanSummary({ pdfKey: "options:pdf:xyz" }));
    const merged = mergeRunSummaries([[canonical], [twin], [], []], 50);
    expect(merged).toHaveLength(1);
    expect(merged[0].pdfKey).toBe("options:pdf:xyz");
    expect(merged[0].reportUrl).toBe("/api/options/report.pdf?key=options%3Apdf%3Axyz");
  });

  it("merge: the winner's own PDF facts are never overwritten by the twin", () => {
    const canonical = runSummaryFromReport(reportHit());
    const twin = runSummaryFromScreenerRun(screenerRun({ pdfKey: "screener:pdf:OTHER", pdfStatus: "failed", pdfError: "twin error" } as Partial<ScreenerRunResult>));
    const merged = mergeRunSummaries([[canonical], [], [], [twin]], 50);
    expect(merged).toHaveLength(1);
    expect(merged[0].pdfKey).toBe("screener:pdf:abc");
    expect(merged[0].pdfError).toBeNull();
  });
});

describe("scan-row partial projection (issue #1850)", () => {
  it("carries partial and appends the partial segment to the row summary", () => {
    const row = runSummaryFromScanRun(
      scanSummary({
        partial: { evaluatedCount: 7, consideredCount: 10, coverageErrors: 2, truncatedCount: 1 },
      }),
    );
    expect(row.partial).toEqual({ evaluatedCount: 7, consideredCount: 10, coverageErrors: 2, truncatedCount: 1 });
    expect(row.summary).toContain("Partial coverage — qualified partial results: evaluated 7 of 10 underlyings (2 failures, 1 truncated).");
  });

  it("absent partial reads as null and leaves the summary untouched", () => {
    const row = runSummaryFromScanRun(scanSummary());
    expect(row.partial).toBeNull();
    expect(row.summary).not.toContain("Partial");
  });
});
describe("run documents and recorded run source (#2062)", () => {
  it("reads XLSX/CSV keys and the recorded family from a canonical screener body", () => {
    const summary = runSummaryFromReport(
      reportHit({
        body: JSON.stringify({
          trigger: "scheduled",
          success: true,
          matchedCount: 5,
          pdfKey: "screener:pdf:abc",
          xlsxKey: "screener:xlsx:x1",
          csvKey: "screener:csv:c1",
          runSource: "stock",
          timestamp: TS.screener,
        }),
      }),
    );
    expect(summary.xlsxKey).toBe("screener:xlsx:x1");
    expect(summary.xlsxUrl).toBe("/api/screener/report.xlsx?key=screener%3Axlsx%3Ax1");
    expect(summary.csvKey).toBe("screener:csv:c1");
    expect(summary.csvUrl).toBe("/api/screener/report.csv?key=screener%3Acsv%3Ac1");
    expect(summary.runSource).toBe("stock");
  });

  it("falls back to the kind's family when the body records no source", () => {
    expect(runSummaryFromReport(reportHit()).runSource).toBe("stock");
    expect(runSummaryFromScreenerRun(screenerRun()).runSource).toBe("stock");
  });

  it("keeps absent artifact keys null rather than inventing links", () => {
    const summary = runSummaryFromReport(reportHit());
    expect(summary.xlsxKey).toBeNull();
    expect(summary.csvUrl).toBeNull();
  });
});
