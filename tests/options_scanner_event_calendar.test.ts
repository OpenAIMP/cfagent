import { describe, expect, it } from "vitest";
import {
  OpportunityScanner,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";
import type { EventCalendarInfo } from "../src/trading/options/strategyEngine";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

/**
 * Issue #16 slice 2 — scanner wiring for the event calendar.
 *
 * The scanner itself never fetches: callers pre-fetch per-name calendar
 * facts and pass them in as `eventCalendarBySymbol`. These tests pin:
 *  - a covered event-adjacent name is excluded under eventPolicy
 *    "exclude" while a covered non-event name still trades;
 *  - without supplied calendars the legacy unverified behavior holds;
 *  - result.coverage.eventCalendar reports per-run coverage;
 *  - "warn" annotations reach the scan's picks;
 *  - a template-level eventCalendar never leaks across names (calendar
 *    facts are per-name; the template is shared).
 */

const DAY_MS = 86_400_000;
const expiryDate = new Date(Date.now() + 30 * DAY_MS).toISOString().slice(0, 10);
const isoIn = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

function baseTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: expiryDate,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread"],
    minDte: 14,
    maxDte: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    maxQuoteAgeSeconds: 60,
    eventPolicy: "warn",
    ...overrides,
  };
}

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

function makeContracts(symbol: string, spot: number): ScreenedOptionContractItem[] {
  const now = Date.now();
  return [0.9, 0.95, 1, 1.05, 1.1].flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const callMid = legMid(spot, strike, "CALL");
    const putMid = legMid(spot, strike, "PUT");
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: "FRESH" as const,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
    };
    return [
      { ...base, optionType: "CALL" as const, symbol: `${symbol}${strike}C`, osiKey: `${symbol}-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `${symbol}${strike}P`, osiKey: `${symbol}-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

function fakeScreener(spots: Record<string, number>): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      const contracts = makeContracts(symbol, spots[symbol] ?? 100);
      return {
        contracts,
        matchedCount: contracts.length,
        totalContractsEvaluated: contracts.length,
        totalUnderlyingsScanned: 1,
        scannedAt: new Date().toISOString(),
        rejections: [],
      } as unknown as OptionScreenResult;
    },
  } as unknown as DynamicOptionsScreener;
}

const covered = (partial: Partial<EventCalendarInfo> = {}): EventCalendarInfo => ({
  covered: true,
  source: "yahoo-calendarEvents",
  earningsDate: null,
  daysToEarnings: null,
  exDividendDate: null,
  daysToExDiv: null,
  ...partial,
});

describe("OpportunityScanner event calendar wiring (issue #16 slice 2)", () => {
  it("exclude drops only the covered event-adjacent name and reports full coverage", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ NEAR: 100, FAR: 100 }));
    const result = await scanner.scan(
      ["NEAR", "FAR"],
      baseTemplate({ eventPolicy: "exclude" }),
      {
        eventCalendarBySymbol: {
          NEAR: covered({ earningsDate: isoIn(5), daysToEarnings: 5 }),
          FAR: covered({ earningsDate: isoIn(45), daysToEarnings: 45 }),
        },
      }
    );

    expect(result.opportunities.map((row) => row.symbol)).toEqual(["FAR"]);
    expect(result.matrix.find((row) => row.symbol === "NEAR")?.verdict).toBe("no_pass");
    expect(result.coverage.eventCalendar).toEqual({ covered: 2, total: 2, coveragePct: 100 });
    expect(result.assumptions.some((line) => line.includes("calendar coverage"))).toBe(true);
  });

  it("without supplied calendars, exclude keeps the legacy unverified behavior and reports zero coverage", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ NEAR: 100, FAR: 100 }));
    const result = await scanner.scan(["NEAR", "FAR"], baseTemplate({ eventPolicy: "exclude" }));

    expect(result.opportunities).toHaveLength(0);
    expect(result.coverage.eventCalendar).toEqual({ covered: 0, total: 2, coveragePct: 0 });
  });

  it("warn annotations reach the scan picks for covered names", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ NEAR: 100 }));
    const result = await scanner.scan(["NEAR"], baseTemplate({ eventPolicy: "warn" }), {
      eventCalendarBySymbol: {
        NEAR: covered({ earningsDate: isoIn(5), daysToEarnings: 5 }),
      },
    });

    const row = result.opportunities.find((r) => r.symbol === "NEAR");
    expect(row).toBeDefined();
    const warnings = row!.pick.best?.candidate.warnings ?? [];
    expect(warnings.some((warning) => warning.includes("Earnings in 5 days"))).toBe(true);
    expect(result.coverage.eventCalendar).toEqual({ covered: 1, total: 1, coveragePct: 100 });
  });

  it("partial coverage is reported as supplied, name by name", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ NEAR: 100, FAR: 100 }));
    const result = await scanner.scan(["NEAR", "FAR"], baseTemplate(), {
      eventCalendarBySymbol: {
        NEAR: covered({ earningsDate: isoIn(45), daysToEarnings: 45 }),
      },
    });

    expect(result.coverage.eventCalendar).toEqual({ covered: 1, total: 2, coveragePct: 50 });
  });

  it("a template-level eventCalendar never leaks across names", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ NEAR: 100, FAR: 100 }));
    const result = await scanner.scan(
      ["NEAR", "FAR"],
      baseTemplate({
        eventPolicy: "exclude",
        eventCalendar: covered({ earningsDate: isoIn(45), daysToEarnings: 45 }),
      })
    );

    // The template's calendar belongs to no name: both stay unverified,
    // so exclude withholds both — the calendar must not make FAR (or
    // NEAR) look covered.
    expect(result.opportunities).toHaveLength(0);
    expect(result.coverage.eventCalendar).toEqual({ covered: 0, total: 2, coveragePct: 0 });
  });
});
