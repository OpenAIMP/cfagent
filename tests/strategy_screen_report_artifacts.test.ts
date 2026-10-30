/**
 * Issue #2162: strategy screens produce PDF + XLSX + CSV report artifacts.
 *
 * Pins (TDD red first — the read-side mapping and link mapping are new):
 *  - the strategy report row model: ranked + best-trade + alternatives,
 *    de-duplicated by candidate id, AI rank/score/rationale joined by id;
 *  - the three renderers: CSV header/rows/escaping, XLSX tabs, a valid PDF;
 *  - ScreenerAgent.generateAndStoreStrategyReport: options key families,
 *    per-format statuses, and per-format failure isolation (a failed PDF
 *    never blocks the workbook or the CSV);
 *  - the run-summary read side: an `options_strategy` row's keys map to
 *    the /api/options/report.* URLs, so Docs and Reports shows all three.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { PDFDocument } from "pdf-lib";
import {
  buildStrategyReportInput,
  generateStrategyReportCsv,
  generateStrategyReportPdf,
  generateStrategyReportXlsx,
  normalizeStrategyRows,
  strategyReportArtifactLinks,
  strategyReportFileName,
  type StrategyReportInput,
} from "../src/trading/strategyReport";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { runSummaryFromReport } from "../src/services/runSummaries";
import { scheduledReportPdfUrl } from "../src/services/scheduledReports";

function candidate(over: Record<string, any> = {}) {
  return {
    id: "c-1",
    type: "long_call",
    label: "Long Call",
    symbol: "NVDA",
    expirationDate: "2026-11-20",
    legs: [
      {
        symbol: "NVDA  261120C00180000",
        optionType: "CALL",
        side: "BUY",
        quantity: 1,
        strike: 180,
        expirationDate: "2026-11-20",
        entryPrice: 5.25,
        impliedVolatility: 0.42,
        delta: 0.51,
        openInterest: 12000,
        volume: 3400,
      },
    ],
    netDebit: 5.25,
    maxProfit: 475,
    maxProfitUnbounded: false,
    maxLoss: 525,
    breakevens: [185.25],
    targetRewardRisk: 0.9,
    modelImpliedProbabilityOfProfit: 0.61,
    rationale: "Momentum intact above the 20-day.",
    explanations: ["Above the 20-day"],
    ...over,
  };
}

function ranked(id: string, rank: number, over: Record<string, any> = {}) {
  return { candidate: candidate({ id, ...over }), rank, compositeScore: 90 - rank, components: {} } as any;
}

function input(over: Partial<StrategyReportInput> = {}): StrategyReportInput {
  return {
    symbol: "NVDA",
    action: "strategies",
    generatedAt: "2026-10-28T18:00:00.000Z",
    summary: "2 ranked strategies for NVDA.",
    ranked: [ranked("c-1", 1), ranked("c-2", 2, { type: "bull_put_spread", label: "Bull Put Spread" })],
    ...over,
  };
}

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

class CsvFailingStorage extends FakeStorage {
  async put(key: string, value: unknown): Promise<void> {
    if (String(key).includes(":csv:")) throw new Error("r2 unavailable");
    return super.put(key, value);
  }
}

class XlsxFailingStorage extends FakeStorage {
  async put(key: string, value: unknown): Promise<void> {
    if (String(key).includes(":xlsx:")) throw new Error("r2 unavailable");
    return super.put(key, value);
  }
}

function makeAgent(storage: FakeStorage): ScreenerAgent {
  return new ScreenerAgent({ storage } as any, {} as any);
}

describe("strategy report row model (#2162)", () => {
  it("joins AI rows by candidate id and keeps one row per candidate", () => {
    const best = ranked("c-2", 1, { type: "bull_put_spread", label: "Bull Put Spread" });
    const rows = normalizeStrategyRows({
      symbol: "NVDA",
      ranked: [ranked("c-1", 2)],
      bestTrade: { best, alternatives: [ranked("c-1", 3)] },
      ai: { model: "test", status: "ok", rows: [{ candidateId: "c-2", rank: 1, score: 87.4, rationale: "Clean risk/reward" }] },
    });
    // The best trade leads; its alternative is the already-ranked c-1, so no duplicate row.
    expect(rows.map((row) => row.strategy)).toEqual(["bull_put_spread", "long_call"]);
    expect(rows[0].aiRank).toBe(1);
    expect(rows[0].aiScore).toBe(87.4);
    expect(rows[0].aiRationale).toBe("Clean risk/reward");
    expect(rows[1].aiRank).toBeNull();

    const withAlternatives = normalizeStrategyRows({
      symbol: "NVDA",
      bestTrade: { best, alternatives: [ranked("c-1", 3)] },
    });
    expect(withAlternatives.map((row) => row.strategy)).toEqual(["bull_put_spread", "long_call"]);
  });

  it("marks an unbounded max profit instead of inventing a number", () => {
    const [row] = normalizeStrategyRows({
      symbol: "NVDA",
      ranked: [ranked("c-1", 1, { maxProfitUnbounded: true, maxProfit: 999999 })],
    });
    expect(row.maxProfit).toBeNull();
    expect(row.probabilityOfProfit).toBe(0.61);
    expect(row.rewardRisk).toBe(0.9);
  });

  it("builds the input from the unified action payload (quant ranked + llm rows)", () => {
    const built = buildStrategyReportInput({
      action: "llm_ideas",
      request: { symbol: "AAPL", thesis: "bullish", riskProfile: "balanced" },
      data: {
        quant: { ranked: [ranked("q-1", 1, { symbol: "AAPL" })] },
        llm: { model: "m", status: "ok", ranked: [{ candidateId: "q-1", rank: 1, score: 80, rationale: "fit" }] },
        screenedOut: [{ id: "iron_condor", reason: "no fit" }],
      },
      summary: "1 idea",
      generatedAt: "2026-10-28T18:00:00.000Z",
    });
    expect(built.symbol).toBe("AAPL");
    expect(built.thesis).toBe("bullish");
    expect(built.riskProfile).toBe("balanced");
    expect(built.ranked).toHaveLength(1);
    expect(built.ai?.rows?.[0]?.candidateId).toBe("q-1");
    expect(built.screenedOut).toEqual([{ id: "iron_condor", reason: "no fit" }]);
  });

  it("joins llm_evaluate's rank-ordered rankings back to their candidates", () => {
    const built = buildStrategyReportInput({
      action: "llm_evaluate",
      request: { symbol: "NVDA" },
      data: {
        quant: { ranked: [ranked("q-1", 1), ranked("q-2", 2, { type: "bull_put_spread" })] },
        llm: {
          model: "m",
          status: "complete",
          rankings: [
            { rank: 1, strategy: "Long Call", rationale: "Best fit for the thesis" },
            { rank: 2, strategy: "Bull Put Spread", rationale: "Lower conviction" },
          ],
        },
      },
    });
    expect(built.ai?.rows).toHaveLength(2);
    expect(built.ai?.rows?.[0]).toMatchObject({ candidateId: "q-1", rank: 1, rationale: "Best fit for the thesis" });
    expect(built.ai?.rows?.[1]).toMatchObject({ candidateId: "q-2", rank: 2 });
    const rows = normalizeStrategyRows(built);
    expect(rows[0].aiRationale).toBe("Best fit for the thesis");
  });
});

describe("strategy report renderers (#2162)", () => {
  it("CSV carries the ranked rows, economics and AI columns", () => {
    const csv = generateStrategyReportCsv(
      input({
        ai: { model: "m", status: "ok", rows: [{ candidateId: "c-1", rank: 1, score: 88, rationale: "Tight, liquid, fits the thesis" }] },
      }),
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "rank,strategy,label,symbol,expiration,legs,net_debit,max_profit,max_loss,breakevens,reward_risk,probability_of_profit,composite_score,ai_rank,ai_score,ai_rationale",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("long_call");
    expect(lines[1]).toContain("NVDA");
    expect(lines[1]).toContain("185.25");
    expect(lines[1]).toContain("0.61");
    expect(lines[1]).toContain('"Tight, liquid, fits the thesis"');
  });

  it("XLSX has Strategies, Legs and Summary tabs with the run's numbers", () => {
    const wb = XLSX.read(generateStrategyReportXlsx(input()), { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Strategies", "Legs", "Summary"]);
    const strategies = XLSX.utils.sheet_to_json(wb.Sheets.Strategies) as Array<Record<string, unknown>>;
    expect(strategies).toHaveLength(2);
    expect(strategies[0].symbol).toBe("NVDA");
    expect(strategies[0].legs).toContain("BUY 1 CALL 180");
    const legs = XLSX.utils.sheet_to_json(wb.Sheets.Legs) as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(2);
    expect(legs[0].strike).toBe(180);
    const summary = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 }) as unknown[][];
    const byField = new Map(summary.map((row) => [String(row[0]), row[1]]));
    expect(byField.get("ranked_strategies")).toBe(2);
    expect(byField.get("symbol")).toBe("NVDA");
    expect(byField.get("action")).toBe("strategies");
  });

  it("renders a best-trade screen's legs on the Legs tab", () => {
    const wb = XLSX.read(
      generateStrategyReportXlsx(input({ ranked: [], bestTrade: { best: ranked("c-9", 1), alternatives: [] } })),
      { type: "buffer" },
    );
    const strategies = XLSX.utils.sheet_to_json(wb.Sheets.Strategies) as Array<Record<string, unknown>>;
    expect(strategies).toHaveLength(1);
    const legs = XLSX.utils.sheet_to_json(wb.Sheets.Legs) as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(1);
    expect(legs[0].strategy).toBe("Long Call");
  });

  it("PDF is a valid document for rows and for an empty screen", async () => {
    const withRows = await generateStrategyReportPdf(input());
    expect(Array.from(withRows.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    const doc = await PDFDocument.load(withRows);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);

    const empty = await generateStrategyReportPdf(input({ ranked: [] }));
    expect(Array.from(empty.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("file name carries the symbol and the action", () => {
    expect(strategyReportFileName({ symbol: "nvda", action: "best-trade" }, "pdf")).toBe("options-strategy-NVDA-best-trade.pdf");
    expect(strategyReportFileName({ symbol: "a b/c", action: "llm_ideas" }, "csv")).toBe("options-strategy-ABC-llm_ideas.csv");
  });

  it("maps stored keys to the established options download URLs", () => {
    expect(
      strategyReportArtifactLinks({
        pdfKey: "options:pdf:strategy:1",
        pdfStatus: "generated",
        xlsxKey: "options:xlsx:strategy:1",
        xlsxStatus: "generated",
        csvKey: "options:csv:strategy:1",
        csvStatus: "generated",
      }),
    ).toEqual({
      pdfKey: "options:pdf:strategy:1",
      reportUrl: "/api/options/report.pdf?key=options%3Apdf%3Astrategy%3A1",
      xlsxKey: "options:xlsx:strategy:1",
      xlsxUrl: "/api/options/report.xlsx?key=options%3Axlsx%3Astrategy%3A1",
      csvKey: "options:csv:strategy:1",
      csvUrl: "/api/options/report.csv?key=options%3Acsv%3Astrategy%3A1",
    });
    expect(
      strategyReportArtifactLinks({ pdfStatus: "failed", pdfError: "boom", xlsxStatus: "failed", csvStatus: "failed" }),
    ).toEqual({});
  });
});

describe("ScreenerAgent strategy report storage (#2162)", () => {
  it("stores the three formats under the options key families and records their status", async () => {
    const storage = new FakeStorage();
    const outcome = await makeAgent(storage).generateAndStoreStrategyReport(input());

    expect(outcome.pdfStatus).toBe("generated");
    expect(outcome.pdfKey).toMatch(/^options:pdf:strategy:[0-9a-f]{8}$/);
    expect(outcome.xlsxStatus).toBe("generated");
    expect(outcome.xlsxKey).toMatch(/^options:xlsx:strategy:[0-9a-f]{8}$/);
    expect(outcome.csvStatus).toBe("generated");
    expect(outcome.csvKey).toMatch(/^options:csv:strategy:[0-9a-f]{8}$/);

    const csv = storage.map.get(outcome.csvKey!) as { fileName: string; base64: string };
    expect(csv.fileName).toBe("options-strategy-NVDA-strategies.csv");
    const text = Buffer.from(csv.base64, "base64").toString("utf8");
    expect(text.split("\n")[0]).toContain("ai_rationale");
    expect(text).toContain("long_call");

    const pdf = storage.map.get(outcome.pdfKey!) as { fileName: string; base64: string };
    expect(pdf.fileName).toBe("options-strategy-NVDA-strategies.pdf");
    expect(Buffer.from(pdf.base64, "base64").subarray(0, 4).toString()).toBe("%PDF");
  });

  it("records a failed PDF without losing the workbook or the CSV", async () => {
    const storage = new PdfFailingStorage();
    const outcome = await makeAgent(storage).generateAndStoreStrategyReport(input());

    expect(outcome.pdfStatus).toBe("failed");
    expect(outcome.pdfKey).toBeUndefined();
    expect(outcome.pdfError).toContain("r2 unavailable");
    expect(outcome.xlsxStatus).toBe("generated");
    expect(outcome.xlsxKey).toBeTruthy();
    expect(outcome.csvStatus).toBe("generated");
    expect(outcome.csvKey).toBeTruthy();
  });

  it("records a failed workbook from the catalog without losing the CSV or the PDF (#2262)", async () => {
    const storage = new XlsxFailingStorage();
    const outcome = await makeAgent(storage).generateAndStoreStrategyReport(input());

    expect(outcome.xlsxStatus).toBe("failed");
    expect(outcome.xlsxKey).toBeUndefined();
    expect(outcome.xlsxError).toContain("FAILURE_REPORT_XLSX_GENERATION");
    expect(outcome.pdfStatus).toBe("generated");
    expect(outcome.pdfKey).toBeTruthy();
    expect(outcome.csvStatus).toBe("generated");
    expect(outcome.csvKey).toBeTruthy();
  });

  it("records a failed CSV from the catalog without losing the workbook or the PDF (#2255)", async () => {
    const storage = new CsvFailingStorage();
    const outcome = await makeAgent(storage).generateAndStoreStrategyReport(input());

    expect(outcome.csvStatus).toBe("failed");
    expect(outcome.csvKey).toBeUndefined();
    expect(outcome.csvError).toContain("FAILURE_REPORT_CSV_GENERATION");
    expect(outcome.xlsxStatus).toBe("generated");
    expect(outcome.xlsxKey).toBeTruthy();
    expect(outcome.pdfStatus).toBe("generated");
    expect(outcome.pdfKey).toBeTruthy();
  });
});

describe("strategy run artifacts in the Runs read surface (#2162)", () => {
  const body = JSON.stringify({
    trigger: "manual",
    success: true,
    action: "strategies",
    symbol: "NVDA",
    withTrades: 2,
    pdfKey: "options:pdf:strategy:1",
    pdfStatus: "generated",
    xlsxKey: "options:xlsx:strategy:1",
    xlsxStatus: "generated",
    csvKey: "options:csv:strategy:1",
    csvStatus: "generated",
  });

  const hit = {
    id: "options_strategy:strategies:NVDA:1",
    runId: "options_strategy:strategies:NVDA:1",
    title: "Options strategy screener — NVDA (strategies)",
    summary: "2 ranked strategies for NVDA.",
    source: "options_strategy",
    createdAt: "2026-10-28T18:00:00.000Z",
    body,
  };

  it("maps all three keys to the options download URLs", () => {
    const summary = runSummaryFromReport(hit as any);
    expect(summary.kind).toBe("options_scanner");
    expect(summary.reportUrl).toBe("/api/options/report.pdf?key=options%3Apdf%3Astrategy%3A1");
    expect(summary.xlsxUrl).toBe("/api/options/report.xlsx?key=options%3Axlsx%3Astrategy%3A1");
    expect(summary.csvUrl).toBe("/api/options/report.csv?key=options%3Acsv%3Astrategy%3A1");
    expect(summary.pdfStatus).toBe("generated");
    expect(summary.xlsxStatus).toBe("generated");
    expect(summary.csvStatus).toBe("generated");
  });

  it("scheduledReportPdfUrl serves an options_strategy PDF from the options route", () => {
    expect(scheduledReportPdfUrl("options_strategy", body)).toBe(
      "/api/options/report.pdf?key=options%3Apdf%3Astrategy%3A1",
    );
  });
});
