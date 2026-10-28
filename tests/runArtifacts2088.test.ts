/**
 * Issue #2088: consistent multi-format production in the Runs surface.
 *
 * Pins (TDD red first):
 *  - merge inheritance extends to XLSX/CSV keys + urls + statuses:
 *    a canonical twin no longer hides the detail record's workbook
 *    keys (the 03:50 mechanism), under the same-artifact rule;
 *  - RunSummary carries xlsxStatus/xlsxError/csvStatus/csvError
 *    (optional: older rows lack them) and both the canonical and
 *    the screener-run mappers fill them;
 *  - toDocumentRows carries the failure fields through, so the Docs
 *    page can show a recorded failure instead of a bare "—".
 */
import { describe, it, expect } from "vitest";
import {
  mergeRunSummaries,
  runSummaryFromReport,
  runSummaryFromScreenerRun,
  type RunSummary,
} from "../src/services/runSummaries";
import { toDocumentRows } from "../src/client/docsAndReports";

function base(over: Partial<RunSummary> = {}): RunSummary {
  return {
    kind: "screener",
    id: "screener:2026-10-28T07:50:04.014Z",
    runId: "screener:2026-10-28T07:50:04.014Z",
    title: "Market screen — NASDAQ100",
    summary: "Scanned 100 symbols, 100 matched.",
    trigger: "manual",
    createdAt: "2026-10-28T07:50:04.014Z",
    status: "completed",
    resultCount: 100,
    pdfKey: "screener:pdf:1",
    reportUrl: "/api/screener/report.pdf?key=screener%3Apdf%3A1",
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: "generated",
    pdfError: null,
    reportId: null,
    scanRunId: null,
    discoveryRunId: null,
    source: "screener",
    ...over,
  } as RunSummary;
}

describe("merge inheritance (xlsx/csv)", () => {
  it("a canonical twin inherits the detail record's workbook keys", () => {
    const detail = base({
      xlsxKey: "screener:xlsx:1",
      xlsxUrl: "/api/screener/report.xlsx?key=screener%3Axlsx%3A1",
      csvKey: "screener:csv:1",
      csvUrl: "/api/screener/report.csv?key=screener%3Acsv%3A1",
      xlsxStatus: "generated",
      csvStatus: "generated",
    });
    const canonical = base({ reportId: "rep-1" });
    const [merged] = mergeRunSummaries([[detail], [canonical]], 10);
    expect(merged.xlsxKey).toBe("screener:xlsx:1");
    expect(merged.xlsxUrl).toContain("/api/screener/report.xlsx");
    expect(merged.csvKey).toBe("screener:csv:1");
    expect(merged.csvUrl).toContain("/api/screener/report.csv");
    expect(merged.xlsxStatus).toBe("generated");
    expect(merged.csvStatus).toBe("generated");
  });

  it("does not inherit a twin's status for a different artifact key", () => {
    const detail = base({
      xlsxKey: "screener:xlsx:other",
      xlsxUrl: "/api/screener/report.xlsx?key=screener%3Axlsx%3Aother",
      xlsxStatus: "failed",
      xlsxError: "boom",
    });
    const canonical = base({
      reportId: "rep-1",
      xlsxKey: "screener:xlsx:1",
      xlsxUrl: "/api/screener/report.xlsx?key=screener%3Axlsx%3A1",
    });
    const [merged] = mergeRunSummaries([[detail], [canonical]], 10);
    expect(merged.xlsxKey).toBe("screener:xlsx:1");
    expect(merged.xlsxStatus).toBeNull();
    expect(merged.xlsxError).toBeNull();
  });
});

describe("screener-run mapper (failure fields)", () => {
  it("carries xlsx/csv statuses and errors from the run record", () => {
    const summary = runSummaryFromScreenerRun({
      timestamp: "2026-10-28T07:50:04.014Z",
      universe: "NASDAQ100",
      success: true,
      totalScanned: 100,
      matchedCount: 100,
      opportunities: [],
      trigger: "manual",
      pdfKey: "screener:pdf:1",
      pdfStatus: "generated",
      xlsxStatus: "failed",
      xlsxError: "blob store unavailable",
      csvStatus: "failed",
      csvError: "blob store unavailable",
    } as any);
    expect(summary.xlsxStatus).toBe("failed");
    expect(summary.xlsxError).toBe("blob store unavailable");
    expect(summary.csvStatus).toBe("failed");
    expect(summary.csvError).toBe("blob store unavailable");
  });
});

describe("canonical mapper (failure fields)", () => {
  it("reads xlsx/csv statuses and errors from the canonical body", () => {
    const summary = runSummaryFromReport({
      id: "rep-1",
      runId: "screener:2026-10-28T07:50:04.014Z",
      title: "Market screen — NASDAQ100",
      summary: "Scanned 100 symbols.",
      source: "screener",
      createdAt: "2026-10-28T07:50:04.014Z",
      body: JSON.stringify({
        trigger: "manual",
        success: true,
        pdfKey: "screener:pdf:1",
        xlsxKey: null,
        xlsxStatus: "failed",
        xlsxError: "blob store unavailable",
        csvKey: null,
        csvStatus: "failed",
        csvError: "blob store unavailable",
      }),
    } as any);
    expect(summary.xlsxStatus).toBe("failed");
    expect(summary.xlsxError).toBe("blob store unavailable");
    expect(summary.csvStatus).toBe("failed");
  });
});

describe("toDocumentRows (failure fields)", () => {
  it("carries xlsx/csv failure state through to the document row", () => {
    const [row] = toDocumentRows([
      base({ xlsxStatus: "failed", xlsxError: "blob store unavailable", csvStatus: "failed" }),
    ]);
    expect(row.xlsxStatus).toBe("failed");
    expect(row.xlsxError).toBe("blob store unavailable");
    expect(row.csvStatus).toBe("failed");
  });
});
