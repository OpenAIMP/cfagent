import { describe, expect, it } from "vitest";
import type { ScreenedOptionContractItem } from "../src/types";
import {
  recommendNoViewStrategies,
  recommendOptionStrategies,
  type EventCalendarInfo,
  type NoViewStrategyRequest,
  type StrategyRequest,
} from "../src/trading/options/strategyEngine";

/**
 * Issue #16 — meaningful eventPolicy.
 *
 * Before #16 the engine had no earnings/dividend calendar at all:
 * eventPolicy "exclude" withheld EVERY candidate ("event risk cannot be
 * verified") and every candidate carried the warning "Earnings and
 * dividend dates are not connected; event risk is unverified."
 *
 * These tests pin the new semantics: when a caller supplies calendar
 * coverage for the name, "warn" annotates candidates with the actual
 * days-to-event, and "exclude" withholds only candidates whose horizon
 * spans the event. When coverage is absent the old unverified behavior
 * is preserved exactly — no guessing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const expiry = new Date(Date.now() + 30 * DAY_MS);
const expiryDate = expiry.toISOString().slice(0, 10);
const isoIn = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

function makeContracts(): ScreenedOptionContractItem[] {
  const quoteTimestamp = Date.now();
  return [90, 95, 100, 105, 110].flatMap((strike) => {
    const timeValue = Math.max(0.3, 3 - Math.abs(strike - 100) * 0.12);
    const callMid = Math.max(0.3, Math.max(100 - strike, 0) + timeValue);
    const putMid = Math.max(0.3, Math.max(strike - 100, 0) + timeValue);
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (100 - strike) / 40));
    const base = {
      underlyingSymbol: "XYZ",
      underlyingPrice: 100,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: Math.abs(strike - 100),
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(quoteTimestamp).toISOString(),
      quoteFreshness: "FRESH" as const,
      bidSize: 10,
      askSize: 10,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      spreadOi: undefined,
      technicalSignal: "Test fixture",
      highlightReason: "Test fixture",
      volumeOiRatio: 0.5,
    };
    return [
      {
        ...base,
        optionType: "CALL" as const,
        symbol: `XYZ${strike}C`,
        strikePrice: strike,
        bid: callMid - 0.1,
        ask: callMid + 0.1,
        delta,
      },
      {
        ...base,
        optionType: "PUT" as const,
        symbol: `XYZ${strike}P`,
        strikePrice: strike,
        bid: putMid - 0.1,
        ask: putMid + 0.1,
        delta: -delta,
      },
    ];
  });
}

function request(overrides: Partial<StrategyRequest> = {}): StrategyRequest {
  return {
    symbol: "XYZ",
    thesis: "bullish",
    targetPrice: 110,
    targetDate: isoIn(14),
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 1_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread"],
    ...overrides,
  };
}

function noViewRequest(overrides: Partial<NoViewStrategyRequest> = {}): NoViewStrategyRequest {
  return {
    symbol: "XYZ",
    maxPlannedLoss: 1_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "long_put", "call_debit_spread", "put_debit_spread", "long_straddle"],
    ...overrides,
  };
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

describe("eventPolicy with calendar coverage (issue #16) — viewed path", () => {
  it("exclude no longer zeroes out a covered name whose earnings fall after the candidate horizon", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({
        eventPolicy: "exclude",
        eventCalendar: covered({ earningsDate: isoIn(45), daysToEarnings: 45 }),
      })
    );

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.excluded.some((entry) => entry.reason.includes("event calendar"))).toBe(false);
    expect(result.excluded.some((entry) => entry.reason.includes("cannot be verified"))).toBe(false);
  });

  it("exclude withholds candidates whose horizon spans an earnings date, naming the event", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({
        eventPolicy: "exclude",
        eventCalendar: covered({ earningsDate: isoIn(5), daysToEarnings: 5 }),
      })
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.status).toBe("no_candidates");
    expect(result.excluded.some((entry) => entry.reason.includes("earnings in 5 days"))).toBe(true);
  });

  it("exclude withholds candidates spanning an ex-dividend date", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({
        eventPolicy: "exclude",
        eventCalendar: covered({ exDividendDate: isoIn(3), daysToExDiv: 3 }),
      })
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.excluded.some((entry) => entry.reason.includes("ex-dividend date in 3 days"))).toBe(true);
  });

  it("exclude with a covered name and no scheduled events returns candidates", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({ eventPolicy: "exclude", eventCalendar: covered() })
    );

    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("exclude without coverage keeps the unverified behavior (no guessing)", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({ eventPolicy: "exclude", eventCalendar: { covered: false } })
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.excluded[0].reason).toContain("event calendar");
  });

  it("warn annotates candidates with days-to-earnings instead of the unverified warning", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({
        eventPolicy: "warn",
        eventCalendar: covered({ earningsDate: isoIn(5), daysToEarnings: 5 }),
      })
    );

    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    expect(candidate.warnings.some((warning) => warning.includes("Earnings in 5 days"))).toBe(true);
    expect(candidate.warnings.some((warning) => warning.includes("before this candidate's final expiry"))).toBe(true);
    expect(candidate.warnings.some((warning) => warning.includes("not connected; event risk is unverified"))).toBe(false);
  });

  it("warn still annotates when earnings fall after the candidate horizon", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({
        eventPolicy: "warn",
        eventCalendar: covered({ earningsDate: isoIn(45), daysToEarnings: 45 }),
      })
    );

    const candidate = result.candidates[0];
    expect(candidate.warnings.some((warning) => warning.includes("Earnings in 45 days"))).toBe(true);
    expect(candidate.warnings.some((warning) => warning.includes("after this candidate's final expiry"))).toBe(true);
  });

  it("warn with coverage and no scheduled events says the calendar was checked", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({ eventPolicy: "warn", eventCalendar: covered() })
    );

    const candidate = result.candidates[0];
    expect(candidate.warnings.some((warning) => warning.includes("Event calendar checked"))).toBe(true);
    expect(candidate.warnings.some((warning) => warning.includes("not connected; event risk is unverified"))).toBe(false);
  });

  it("warn without coverage keeps the unverified warning", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({ eventPolicy: "warn" })
    );

    const candidate = result.candidates[0];
    expect(candidate.warnings.some((warning) => warning.includes("not connected; event risk is unverified"))).toBe(true);
  });

  it("covered runs replace the unverified assumptions with a connected-calendar note", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({ eventPolicy: "warn", eventCalendar: covered({ daysToEarnings: 45, earningsDate: isoIn(45) }) })
    );

    expect(result.assumptions.some((line) => line.includes("Event risk is unverified"))).toBe(false);
    expect(result.assumptions.some((line) => line.toLowerCase().includes("calendar connected"))).toBe(true);
  });
});

describe("eventPolicy with calendar coverage (issue #16) — no-view path", () => {
  it("exclude no longer zeroes out a covered non-event name", () => {
    const result = recommendNoViewStrategies(
      makeContracts(),
      noViewRequest({
        eventPolicy: "exclude",
        eventCalendar: covered({ earningsDate: isoIn(45), daysToEarnings: 45 }),
      })
    );

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.excluded.some((entry) => entry.reason.includes("cannot be verified"))).toBe(false);
  });

  it("exclude withholds no-view candidates spanning an earnings date", () => {
    const result = recommendNoViewStrategies(
      makeContracts(),
      noViewRequest({
        eventPolicy: "exclude",
        eventCalendar: covered({ earningsDate: isoIn(5), daysToEarnings: 5 }),
      })
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.excluded.some((entry) => entry.reason.includes("earnings in 5 days"))).toBe(true);
  });

  it("warn annotates no-view candidates with days-to-earnings", () => {
    const result = recommendNoViewStrategies(
      makeContracts(),
      noViewRequest({
        eventPolicy: "warn",
        eventCalendar: covered({ earningsDate: isoIn(5), daysToEarnings: 5 }),
      })
    );

    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    expect(candidate.warnings.some((warning) => warning.includes("Earnings in 5 days"))).toBe(true);
    expect(candidate.warnings.some((warning) => warning.includes("not connected; event risk is unverified"))).toBe(false);
  });
});
