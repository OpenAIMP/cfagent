/**
 * Issue #1569 (twin of #1291): the scheduled path feeds the options
 * CSV generator an OpportunityScanResult, but generateOptionsCsv
 * reads the OptionScreenResult shape — so scheduled CSVs emitted
 * headers only on good runs.
 *
 * Pins: the scheduled seam passes ADAPTED input to
 * generateAndStoreOptionsCsv (so the stored CSV has data rows, not
 * headers only); a manual-shaped result passes through unchanged;
 * the raw scheduled shape alone yields headers only (the defect);
 * the XLSX seam is untouched (its arg is still adapted, as #1291).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";
import { UnifiedOptionsService } from "../src/trading";
import { adaptOpportunityScanToOptionScreenResult } from "../src/trading/optionsReportXlsx";
import {
  generateOptionsCsv,
  optionsCsvFileName,
} from "../src/trading/screenerReportCsv";

vi.mock("../src/services/eventCalendar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/eventCalendar")>();
  return {
    ...actual,
    getEventCalendarCoverage: vi.fn(async () => ({ bySymbol: [] })),
  };
});

vi.mock("../src/services/unifiedReportPipeline", () => ({
  runReportPipeline: vi.fn(async () => ({
    pdfStatus: "failed",
    pdfError: "mocked",
  })),
}));

function leg(over: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL  261024C00250000",
    optionType: "CALL",
    side: "BUY",
    quantity: 1,
    strike: 250,
    expirationDate: "2026-11-13",
    daysToExpiration: 21,
    entryPrice: 3.2,
    bid: 3.1,
    ask: 3.3,
    impliedVolatility: 0.284,
    delta: 0.42,
    gamma: 0.03,
    theta: -0.05,
    vega: 0.12,
    openInterest: 21000,
    volume: 5400,
    spreadPct: 2.1,
    quoteFreshness: "FRESH",
    multiplier: 100,
    ...over,
  };
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    id: "bull-call-spread",
    rank: 1,
    type: "BULL_CALL_SPREAD",
    label: "Bull Call Spread",
    symbol: "AAPL",
    underlyingPrice: 248.1,
    expirationDate: "2026-11-13",
    dataFreshness: "FRESH",
    legs: [leg()],
    netDebit: 3.2,
    netGreeks: { delta: 0.42, gamma: 0.03, theta: -0.05, vega: 0.12 },
    score: 87,
    scoreBreakdown: {},
    payoffCurve: [],
    scenarios: [],
    explanations: [],
    warnings: [],
    assumptions: [],
    ...over,
  };
}

function scheduledScan(): Record<string, unknown> {
  return {
    scanned: 4,
    withTrades: 2,
    opportunities: [
      {
        symbol: "AAPL",
        underlyingPrice: 248.1,
        targetPrice: 260,
        targetSource: "model",
        pick: {
          status: "recommended",
          riskProfile: "balanced",
          confidence: "HIGH",
          best: { candidate: candidate(), rank: 1, compositeScore: 87, components: {} },
          alternatives: [],
          rationale: [],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 87,
        gateBucket: "fit",
        gateReasons: [],
      },
      {
        symbol: "MSFT",
        underlyingPrice: 510.4,
        targetPrice: 530,
        targetSource: "model",
        pick: {
          status: "recommended",
          riskProfile: "balanced",
          confidence: "MEDIUM",
          best: {
            candidate: candidate({
              id: "bull-put-spread",
              type: "BULL_PUT_SPREAD",
              label: "Bull Put Spread",
              symbol: "MSFT",
              underlyingPrice: 510.4,
              legs: [
                leg({
                  symbol: "MSFT  261024P00500000",
                  optionType: "PUT",
                  strike: 500,
                  bid: 2.1,
                  ask: 2.3,
                  entryPrice: 2.2,
                  impliedVolatility: 0.24,
                  delta: -0.3,
                }),
              ],
            }),
            rank: 1,
            compositeScore: 82,
            components: {},
          },
          alternatives: [],
          rationale: [],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 82,
        gateBucket: "borderline",
        gateReasons: ["confidence"],
      },
      {
        // No best pick: no contract row for this name.
        symbol: "NVDA",
        underlyingPrice: 180.2,
        targetPrice: 190,
        targetSource: "model",
        pick: {
          status: "no_trade",
          riskProfile: "balanced",
          confidence: "LOW",
          alternatives: [],
          rationale: ["No qualifying strategy"],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 0,
        gateBucket: "no_fit",
        gateReasons: ["No qualifying strategy"],
      },
    ],
    skipped: [{ symbol: "TSLA", reason: "Chain fetch failed" }],
    assumptions: ["Targets scoped to the stated thesis."],
    mode: "per_name_best",
    generatedAt: "2026-10-24T09:05:29Z",
    modelVersion: "1.2.0",
    requestSnapshot: {
      template: { thesis: "BULLISH", targetDate: "2026-11-13" },
      mode: "per_name_best",
      riskProfile: "balanced",
      profile: null,
    },
    coverage: {
      considered: 5,
      scanned: 4,
      truncated: 1,
      evaluated: 3,
      errors: 1,
      withTrades: 2,
    },
  };
}

describe("scheduled options CSV shape (#1569)", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;

  beforeEach(() => {
    const mockSql = { exec: vi.fn(() => []) };
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
    mockOrm = new DatabaseORM(mockSql as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runScheduledCsvSeam() {
    const scan = scheduledScan();
    vi.spyOn(UnifiedOptionsService.prototype, "execute").mockResolvedValue({
      success: true,
      summary: "mock scheduled options scan",
      data: scan,
    } as any);
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    let csvArg: unknown;
    let xlsxArg: unknown;
    (service as any).getScreenerAgent = () => ({
      generateAndStoreOptionsXlsx: async (input: unknown) => {
        xlsxArg = input;
        return { key: "xlsx-key", fileName: "options-report-x.xlsx" };
      },
      getOptionsXlsxByKey: async () => null,
      generateAndStoreOptionsCsv: async (input: unknown) => {
        csvArg = input;
        return { key: "csv-key", fileName: "options-report-x.csv" };
      },
      getOptionsCsvByKey: async () => null,
    });
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
    });
    expect(result.success).toBe(true);
    return { csvArg, xlsxArg };
  }

  it("the scheduled seam passes adapted input to generateAndStoreOptionsCsv, so the CSV has data rows", async () => {
    const { csvArg } = await runScheduledCsvSeam();
    const adapted = csvArg as Record<string, unknown>;
    expect(Array.isArray(adapted.contracts)).toBe(true);
    expect((adapted.contracts as unknown[]).length).toBe(2);
    const csv = generateOptionsCsv(adapted as never);
    const lines = csv.trim().split("\n");
    // Header + 2 data rows (NVDA has no pick, so no row).
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain("AAPL");
    expect(lines[1]).toContain(",250,");
    expect(lines[2]).toContain("MSFT");
    expect(csv).not.toContain("NVDA");
    // The adapted scannedAt drives the filename date (not today).
    expect(optionsCsvFileName(adapted as never)).toBe(
      "options-report-2026-10-24.csv",
    );
  });

  it("the raw scheduled shape alone yields headers only (the defect, before the seam adapts it)", () => {
    const csv = generateOptionsCsv(scheduledScan() as never);
    expect(csv.trim().split("\n").length).toBe(1);
  });

  it("a manual-shaped result passes through the adapter unchanged", () => {
    const manual = {
      contracts: [
        {
          underlyingSymbol: "AAPL",
          underlyingPrice: 248.1,
          optionType: "CALL",
          strikePrice: 250,
          expirationDate: "2026-11-13",
          daysToExpiration: 21,
          moneyness: "OTM",
          bid: 3.1,
          ask: 3.3,
          lastPrice: 3.2,
        },
      ],
      scannedAt: "2026-10-24T09:05:29Z",
    };
    const adapted = adaptOpportunityScanToOptionScreenResult(manual as never);
    expect(adapted).toBe(manual as never);
    expect(generateOptionsCsv(adapted)).toBe(generateOptionsCsv(manual as never));
    expect(generateOptionsCsv(adapted).trim().split("\n").length).toBe(2);
  });

  it("the XLSX seam still receives adapted input (unchanged by this slice)", async () => {
    const { xlsxArg } = await runScheduledCsvSeam();
    expect(Array.isArray((xlsxArg as Record<string, unknown>).contracts)).toBe(true);
    expect(((xlsxArg as Record<string, unknown>).contracts as unknown[]).length).toBe(2);
  });
});
