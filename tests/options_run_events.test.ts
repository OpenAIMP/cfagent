/**
 * Options run-record seam: the bus event is the only carrier of a
 * scheduled options run's artifacts into the job-outcome sink (the
 * bridge maps the event to a ScreenerRunOutcome, and Workflow Runs
 * builds its artifact list from that outcome). Before this pin the
 * options mapping dropped the XLSX/CSV keys and the matched count, so
 * a run that produced three artifacts showed only the PDF — or none,
 * when the PDF failed.
 *
 * Pinned here:
 *  1. options.completed carries XLSX + CSV keys/status/errors into the
 *     outcome, exactly like the stock mapping.
 *  2. withTrades becomes the outcome's matchedCount (the ledger's
 *     "matched" column), never null because the event names it
 *     differently.
 *  3. A failed PDF never fabricates a report URL.
 */
import { describe, expect, it } from "vitest";
import { screenerOutcomeFromEvent } from "../src/services/screenerFollowups";

function completedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "options.completed" as const,
    timestamp: "2026-10-28T12:00:00.000Z",
    trigger: "scheduled" as const,
    thesis: "bullish",
    universe: "TECH",
    totalScanned: 12,
    withTrades: 4,
    symbols: ["NVDA", "AAPL"],
    summary: "12 underlyings scanned · 40 contracts evaluated · 4 matched.",
    reportUrl: "/api/options/report.pdf?key=options%2Fpdf%2Frun-1",
    pdfKey: "options/pdf/run-1",
    pdfStatus: "generated" as const,
    xlsxKey: "options/xlsx/run-1",
    xlsxStatus: "generated" as const,
    csvKey: "options/csv/run-1",
    csvStatus: "generated" as const,
    opportunities: [],
    ...overrides,
  };
}

describe("options.completed → ScreenerRunOutcome", () => {
  it("carries every produced artifact key into the run outcome", () => {
    const outcome = screenerOutcomeFromEvent(completedEvent() as any);
    expect(outcome.kind).toBe("options");
    expect(outcome.pdfKeys).toEqual(["options/pdf/run-1"]);
    expect(outcome.xlsxKey).toBe("options/xlsx/run-1");
    expect(outcome.xlsxStatus).toBe("generated");
    expect(outcome.csvKey).toBe("options/csv/run-1");
    expect(outcome.csvStatus).toBe("generated");
  });

  it("maps withTrades onto matchedCount so the ledger shows matches", () => {
    const outcome = screenerOutcomeFromEvent(completedEvent() as any);
    expect(outcome.matchedCount).toBe(4);
    expect(outcome.totalScanned).toBe(12);
  });

  it("carries per-format failures instead of dropping them", () => {
    const outcome = screenerOutcomeFromEvent(
      completedEvent({
        pdfKey: undefined,
        pdfStatus: "failed",
        pdfError: "[FAILURE_REPORT_PDF_GENERATION] renderer unavailable",
        xlsxKey: undefined,
        xlsxStatus: "failed",
        xlsxError: "[FAILURE_REPORT_XLSX_GENERATION] xlsx renderer unavailable",
        csvKey: undefined,
        csvStatus: "skipped",
        csvError: "[FAILURE_REPORT_PDF_GENERATION] no rows",
        reportUrl: undefined,
      }) as any,
    );
    expect(outcome.pdfStatus).toBe("failed");
    expect(outcome.pdfKeys).toEqual([]);
    expect(outcome.xlsxStatus).toBe("failed");
    expect(outcome.xlsxError).toContain("FAILURE_REPORT_XLSX_GENERATION");
    expect(outcome.csvStatus).toBe("skipped");
    expect(outcome.csvError).toContain("FAILURE_REPORT_PDF_GENERATION");
    expect(outcome.reportUrl).toBeUndefined();
  });
});
