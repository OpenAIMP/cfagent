/**
 * Issue #2180: strategy discovery runs produce a PDF + XLSX + CSV run report.
 *
 * Pins (TDD red first — the renderers, the storage seam and the mapping are new):
 *  - one row per symbol across the three input models and the three statuses:
 *    completed with a judged pick, completed-but-abstained, failed — each with
 *    its recorded reason, never a fabricated pick;
 *  - the CSV symbol table and the XLSX three tabs from the same model;
 *  - the shared leg line for the best pick's legs;
 *  - generateAndStoreDiscoveryReport: the discovery key family, the
 *    deterministic per-run keys, per-format failure isolation;
 *  - the canonical body carries every key/status;
 *  - the Runs read side: a `discovery` row's keys resolve to the discovery
 *    routes, so Docs and Reports shows all three downloads.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { PDFDocument } from "pdf-lib";
import {
  discoveryReportArtifactLinks,
  discoveryReportFileName,
  discoverySymbolRows,
} from "../src/trading/discoveryReportData";
import { generateDiscoveryReportCsv } from "../src/trading/discoveryReportCsv";
import { generateDiscoveryReportXlsx } from "../src/trading/discoveryReportXlsx";
import { generateDiscoveryReportPdf } from "../src/trading/discoveryReportPdf";
import {
  buildDiscoveryCanonicalBody,
  generateAndStoreDiscoveryReport,
} from "../src/services/discoveryReportPublish";
import { runSummaryFromReport } from "../src/services/runSummaries";
import { scheduledReportPdfUrl } from "../src/services/scheduledReports";
import type { DiscoveryReportInput } from "../src/trading/discoveryReportData";

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class PdfFailingStorage extends FakeStorage {
  async put(key: string, value: unknown): Promise<void> {
    if (String(key).includes(":pdf:")) throw new Error("r2 unavailable");
    return super.put(key, value);
  }
}

function leg(over: Record<string, unknown> = {}) {
  return {
    symbol: "NVDA  261120C00180000",
    optionType: "CALL",
    side: "BUY",
    quantity: 1,
    strike: 180,
    expirationDate: "2026-11-20",
    entryPrice: 5.25,
    ...over,
  };
}

function ranked(id: string, type = "long_call") {
  return {
    rank: 1,
    compositeScore: 82,
    components: {},
    candidate: {
      id,
      type,
      label: type === "long_call" ? "Long Call" : "Bull Put Spread",
      symbol: "NVDA",
      expirationDate: "2026-11-20",
      legs: [leg()],
      netDebit: 5.25,
      maxProfit: 475,
      maxLoss: 525,
      breakevens: [185.25],
      targetRewardRisk: 0.9,
      modelImpliedProbabilityOfProfit: 0.61,
    },
  };
}

function input(over: Partial<DiscoveryReportInput> = {}): DiscoveryReportInput {
  return {
    runId: "disc-1",
    createdAt: "2026-10-28T20:00:00.000Z",
    trigger: "scheduled",
    inputModel: "saved-request",
    status: "completed",
    summary: "2 symbols: 1 completed, 1 abstained.",
    symbols: ["NVDA", "AMD"],
    matchedCount: 1,
    totalScanned: 2,
    outcomes: [
      {
        symbol: "NVDA",
        status: "completed",
        request: { symbol: "NVDA", thesis: "bullish", riskProfile: "balanced", targetPrice: 190 } as any,
        ranked: [ranked("c-1") as any],
        bestTrade: { status: "recommended", best: ranked("c-1", "long_call") as any, alternatives: [] } as any,
        screenedOut: [],
        error: undefined,
      },
      {
        symbol: "AMD",
        status: "abstained",
        error: "no chain: the symbol returned no contracts",
      },
    ] as any,
    ...over,
  };
}

describe("discovery report row model (#2180)", () => {
  it("projects one row per symbol with the judged pick and the reasons", () => {
    const rows = discoverySymbolRows(input());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: "NVDA",
      status: "completed",
      verdict: "fit",
      best_strategy: "Long Call",
      expiration: "2026-11-20",
      score: 82,
      max_loss: 525,
      max_profit: 475,
      probability_of_profit: 0.61,
    });
    expect(rows[0].input).toContain("bullish");
    expect(rows[0].legs).toContain("BUY 1 CALL 180 2026-11-20 @ 5.25");
    expect(rows[1]).toMatchObject({ symbol: "AMD", status: "abstained", verdict: "abstained" });
    expect(rows[1].reason).toContain("no contracts");
    expect(rows[1].best_strategy).toBe("—");
  });

  it("renders a profile-derived run's derivation instead of a saved thesis", () => {
    const rows = discoverySymbolRows(
      input({
        inputModel: "profile-derived",
        outcomes: [
          {
            symbol: "NVDA",
            status: "completed",
            derivation: { thesis: "bullish", targetPrice: 191.5, expectedMovePct: 0.06 },
            bestTrade: { status: "recommended", best: ranked("c-1") as any } as any,
          },
        ] as any,
      }),
    );
    expect(rows[0].input).toContain("profile-derived");
    expect(rows[0].input).toContain("191.5");
  });

  it("renders a no-view run's constraint set, and never a thesis", () => {
    const rows = discoverySymbolRows(
      input({
        inputModel: "no-view",
        outcomes: [
          {
            symbol: "SPY",
            status: "completed",
            abstained: true,
            constraintSet: { riskProfile: "balanced", minDte: 7, maxDte: 45 },
            bestNoViewTrade: { status: "no_trade", best: undefined, alternatives: [] } as any,
          },
        ] as any,
      }),
    );
    expect(rows[0].input).toContain("constraints");
    expect(rows[0].verdict).toBe("abstained");
    expect(rows[0].reason.toLowerCase()).toContain("no trade");
  });

  it("marks a failed symbol as failed with its error", () => {
    const rows = discoverySymbolRows(
      input({ outcomes: [{ symbol: "TSLA", status: "failed", error: "provider timeout" }] as any }),
    );
    expect(rows[0]).toMatchObject({ symbol: "TSLA", status: "failed", verdict: "failed" });
    expect(rows[0].reason).toBe("provider timeout");
  });
});

describe("discovery report renderers (#2180)", () => {
  it("CSV carries the symbol table", () => {
    const csv = generateDiscoveryReportCsv(input());
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "symbol,status,input,ranked,best_strategy,expiration,score,probability_of_profit,max_loss,max_profit,legs,verdict,reason",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("NVDA");
    expect(lines[1]).toContain("Long Call");
    expect(lines[2]).toContain("AMD");
  });

  it("XLSX has Symbols, Legs and Run Summary tabs with the run's counts", () => {
    const wb = XLSX.read(generateDiscoveryReportXlsx(input()), { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Symbols", "Legs", "Run Summary"]);

    const symbols = XLSX.utils.sheet_to_json(wb.Sheets.Symbols) as Array<Record<string, unknown>>;
    expect(symbols).toHaveLength(2);
    expect(symbols[0].symbol).toBe("NVDA");
    expect(symbols[0].verdict).toBe("fit");

    const legs = XLSX.utils.sheet_to_json(wb.Sheets.Legs) as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(1);
    expect(legs[0].side).toBe("BUY");

    const summary = XLSX.utils.sheet_to_json(wb.Sheets["Run Summary"], { header: 1 }) as unknown[][];
    const byField = new Map(summary.map((row) => [String(row[0]), row[1]]));
    expect(byField.get("run_id")).toBe("disc-1");
    expect(byField.get("input_model")).toBe("saved-request");
    expect(byField.get("symbols")).toBe(2);
  });

  it("PDF is a valid document for a run and for an empty one", async () => {
    const bytes = await generateDiscoveryReportPdf(input());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);

    const empty = await generateDiscoveryReportPdf(input({ outcomes: [], symbols: [] }));
    expect(Array.from(empty.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("names the files after the run", () => {
    expect(discoveryReportFileName(input(), "pdf")).toBe("discovery_scheduled_2026-10-28T20-00-00Z_disc-1.pdf");
    expect(discoveryReportFileName(input(), "xlsx")).toMatch(/\.xlsx$/);
    expect(discoveryReportFileName(input(), "csv")).toMatch(/\.csv$/);
  });

  it("maps stored keys onto the discovery download routes", () => {
    expect(
      discoveryReportArtifactLinks({
        pdfKey: "discovery:pdf:disc-1",
        pdfStatus: "generated",
        xlsxKey: "discovery:xlsx:disc-1",
        xlsxStatus: "generated",
        csvKey: "discovery:csv:disc-1",
        csvStatus: "generated",
      }),
    ).toEqual({
      pdfKey: "discovery:pdf:disc-1",
      reportUrl: "/api/discovery/report.pdf?key=discovery%3Apdf%3Adisc-1",
      xlsxKey: "discovery:xlsx:disc-1",
      xlsxUrl: "/api/discovery/report.xlsx?key=discovery%3Axlsx%3Adisc-1",
      csvKey: "discovery:csv:disc-1",
      csvUrl: "/api/discovery/report.csv?key=discovery%3Acsv%3Adisc-1",
    });
    expect(
      discoveryReportArtifactLinks({ pdfStatus: "failed", xlsxStatus: "failed", csvStatus: "failed" }),
    ).toEqual({});
  });
});

describe("discovery report storage (#2180)", () => {
  it("stores all three formats under deterministic per-run keys", async () => {
    const storage = new FakeStorage();
    const outcome = await generateAndStoreDiscoveryReport({ env: {}, storage: storage as any, input: input() });

    expect(outcome.pdfStatus).toBe("generated");
    expect(outcome.pdfKey).toBe("discovery:pdf:disc-1");
    expect(outcome.xlsxKey).toBe("discovery:xlsx:disc-1");
    expect(outcome.csvKey).toBe("discovery:csv:disc-1");

    const csv = storage.map.get("discovery:csv:disc-1") as { fileName: string; base64: string };
    expect(csv.fileName).toBe("discovery_scheduled_2026-10-28T20-00-00Z_disc-1.csv");
    const text = Buffer.from(csv.base64, "base64").toString("utf8");
    expect(text.split("\n")[0]).toContain("best_strategy");
    expect(text).toContain("NVDA");

    const pdf = storage.map.get("discovery:pdf:disc-1") as { base64: string };
    expect(Buffer.from(pdf.base64, "base64").subarray(0, 4).toString()).toBe("%PDF");
  });

  it("records a failed PDF while the workbook and CSV still land", async () => {
    const outcome = await generateAndStoreDiscoveryReport({
      env: {},
      storage: new PdfFailingStorage() as any,
      input: input(),
    });
    expect(outcome.pdfStatus).toBe("failed");
    expect(outcome.pdfKey).toBeUndefined();
    expect(outcome.pdfError).toContain("r2 unavailable");
    expect(outcome.xlsxKey).toBe("discovery:xlsx:disc-1");
    expect(outcome.csvKey).toBe("discovery:csv:disc-1");
  });

  it("records every artifact as failed when storage is not configured", async () => {
    const outcome = await generateAndStoreDiscoveryReport({ env: {}, storage: undefined, input: input() });
    expect(outcome).toMatchObject({
      pdfStatus: "failed",
      xlsxStatus: "failed",
      csvStatus: "failed",
    });
    expect(outcome.pdfError).toContain("storage");
    expect(outcome.csvError).toContain("storage");
    expect(outcome.csvError).toContain("REPORT_004");
  });

  it("builds a canonical body that carries every key and status", () => {
    const body = buildDiscoveryCanonicalBody(
      { discoveryRunId: "disc-1", status: "completed", inputModel: "saved-request" },
      {
        pdfKey: "discovery:pdf:disc-1",
        pdfStatus: "generated",
        xlsxKey: "discovery:xlsx:disc-1",
        xlsxStatus: "generated",
        csvKey: "discovery:csv:disc-1",
        csvStatus: "failed",
        csvError: "blob down",
      },
    );
    expect(body).toMatchObject({
      discoveryRunId: "disc-1",
      pdfKey: "discovery:pdf:disc-1",
      pdfStatus: "generated",
      xlsxKey: "discovery:xlsx:disc-1",
      csvStatus: "failed",
      csvError: "blob down",
    });
  });
});

describe("discovery rows in the Runs read surface (#2180)", () => {
  const body = JSON.stringify({
    discoveryRunId: "disc-1",
    status: "completed",
    trigger: "scheduled",
    pdfKey: "discovery:pdf:disc-1",
    pdfStatus: "generated",
    xlsxKey: "discovery:xlsx:disc-1",
    xlsxStatus: "generated",
    csvKey: "discovery:csv:disc-1",
    csvStatus: "generated",
  });

  const hit = {
    id: "discovery:disc-1",
    runId: "discovery:disc-1",
    title: "Strategy discovery — saved-request",
    summary: "1 completed.",
    source: "discovery",
    createdAt: "2026-10-28T20:00:00.000Z",
    body,
  };

  it("maps all three keys to the discovery download URLs", () => {
    const summary = runSummaryFromReport(hit as any);
    expect(summary.kind).toBe("discovery");
    expect(summary.reportUrl).toBe("/api/discovery/report.pdf?key=discovery%3Apdf%3Adisc-1");
    expect(summary.xlsxUrl).toBe("/api/discovery/report.xlsx?key=discovery%3Axlsx%3Adisc-1");
    expect(summary.csvUrl).toBe("/api/discovery/report.csv?key=discovery%3Acsv%3Adisc-1");
  });

  it("scheduledReportPdfUrl serves a discovery PDF from the discovery route", () => {
    expect(scheduledReportPdfUrl("discovery", body)).toBe(
      "/api/discovery/report.pdf?key=discovery%3Apdf%3Adisc-1",
    );
  });
});
