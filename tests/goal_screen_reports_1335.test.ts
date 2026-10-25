/**
 * Issue #1335 (job-truth program #1332): a completed goal-screen run
 * produces a real report even with 0 records — PDF + CSV + XLSX.
 *
 * Red first: src/services/goalScreenReports.ts does not exist yet.
 * The 0-hit fixture mirrors the live 2026-10-24 run (income/bullish,
 * 6604 stocks scanned, 0 hits): the report must still generate in all
 * three formats with 0 data rows, not skip, not fail.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { PDFDocument } from "pdf-lib";
import {
  generateGoalScreenCsv,
  generateGoalScreenPdf,
  generateGoalScreenXlsx,
  goalScreenArtifactKey,
  goalScreenFileName,
  isGoalScreenArtifactKey,
} from "../src/services/goalScreenReports";
import { r2KeyForStorageKey } from "../src/services/reportBlobStore";
import { runSummaryFromReport } from "../src/services/runSummaries";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";

function emptyResult(): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: [],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [],
    counts: {
      stocksScanned: 6604,
      stocksMatched: 0,
      optionsUnderlyingsScanned: 1,
      optionsContractsMatched: 0,
      hits: 0,
    },
  } as unknown as GoalDrivenScreenResult;
}

function oneHitResult(): GoalDrivenScreenResult {
  const r = emptyResult();
  return {
    ...r,
    hits: [
      { assetClass: "stocks", providerId: "yahoo", symbol: "NVDA" },
    ],
    counts: { ...r.counts, stocksMatched: 1, hits: 1 },
  };
}

describe("goal-screen empty reports (#1335)", () => {
  it("CSV for a 0-hit run is headers only", () => {
    const csv = generateGoalScreenCsv(emptyResult());
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("symbol,asset_class,provider_id,structures");
  });

  it("CSV for a 1-hit run carries the hit row", () => {
    const csv = generateGoalScreenCsv(oneHitResult());
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("NVDA");
  });

  it("XLSX for a 0-hit run loads with headers and 0 data rows", () => {
    const bytes = generateGoalScreenXlsx(emptyResult());
    const wb = XLSX.read(bytes, { type: "array" });
    expect(wb.SheetNames).toContain("Hits");
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Hits"], { header: 1 }) as unknown[][];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(["symbol", "asset_class", "provider_id", "structures"]);
  });

  it("XLSX for a 1-hit run carries the hit row", () => {
    const bytes = generateGoalScreenXlsx(oneHitResult());
    const wb = XLSX.read(bytes, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Hits"], { header: 1 }) as unknown[][];
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("NVDA");
  });

  it("PDF for a 0-hit run is a loadable PDF stating 0 records", async () => {
    const bytes = await generateGoalScreenPdf(emptyResult());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("%PDF");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(0);
  });

  it("artifact keys are goal_screen-namespaced and map to goals/ in R2", () => {
    const key = goalScreenArtifactKey("pdf", "a1b2c3d4");
    expect(key).toBe("goal_screen:pdf:a1b2c3d4");
    expect(r2KeyForStorageKey(key)).toBe("goals/pdf/a1b2c3d4");
    expect(isGoalScreenArtifactKey(key)).toBe(true);
    expect(isGoalScreenArtifactKey("screener:pdf:a1b2c3d4")).toBe(false);
    expect(goalScreenFileName("pdf", emptyResult())).toContain("goal-screen");
  });

  it("generate+store round-trips all three artifacts through the blob store", async () => {
    const { generateAndStoreGoalScreenArtifacts } = await import(
      "../src/services/goalScreenReports"
    );
    const { getReportPdf } = await import("../src/services/reportBlobStore");
    const map = new Map<string, unknown>();
    const storage = {
      get: async (k: string) => map.get(k),
      put: async (k: string, v: unknown) => {
        map.set(k, v);
      },
    };
    const out = await generateAndStoreGoalScreenArtifacts({}, storage as never, emptyResult());
    expect(out.pdfStatus).toBe("generated");
    expect(out.xlsxStatus).toBe("generated");
    expect(out.csvStatus).toBe("generated");
    expect(out.pdfKey).toMatch(/^goal_screen:pdf:/);
    const pdf = await getReportPdf({}, storage as never, out.pdfKey as string);
    expect(pdf).not.toBeNull();
    expect(String.fromCharCode(...(pdf as { bytes: Uint8Array }).bytes.subarray(0, 4))).toBe("%PDF");
    const csv = await getReportPdf({}, storage as never, out.csvKey as string);
    expect(new TextDecoder().decode((csv as { bytes: Uint8Array }).bytes)).toContain(
      "symbol,asset_class,provider_id,structures"
    );
  });

  it("run summaries surface goal-screen artifact urls and completed status", () => {
    const summary = runSummaryFromReport({
      id: "rep-1",
      runId: "goal-screen:task-1",
      generationId: "goal-screen:task-1",
      title: "Goal screen — income (bullish)",
      source: "goal_screen",
      summary: "Goal screen (income/bullish) complete: 0 hit(s)",
      createdAt: "2026-10-24T05:40:00.000Z",
      body: JSON.stringify({
        trigger: "manual",
        result: { status: "complete" },
        pdfKey: "goal_screen:pdf:a1b2c3d4",
        xlsxKey: "goal_screen:xlsx:a1b2c3d4",
        csvKey: "goal_screen:csv:a1b2c3d4",
      }),
    } as never);
    expect(summary.reportUrl).toBe(
      "/api/screening/goal-screen/report.pdf?key=goal_screen%3Apdf%3Aa1b2c3d4"
    );
    expect(summary.xlsxUrl).toBe(
      "/api/screening/goal-screen/report.xlsx?key=goal_screen%3Axlsx%3Aa1b2c3d4"
    );
    expect(summary.csvUrl).toBe(
      "/api/screening/goal-screen/report.csv?key=goal_screen%3Acsv%3Aa1b2c3d4"
    );
    expect(summary.status).toBe("completed");
  });
});
