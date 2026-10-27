import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/marketDataResearch", () => ({
  getYahooCrumbSession: vi.fn(),
}));

import { getYahooCrumbSession } from "../src/services/marketDataResearch";
import {
  __resetEventCalendarCache,
  getEventCalendarCoverage,
  getSymbolEventCalendar,
  toEventCalendarInfo,
} from "../src/services/eventCalendar";

/**
 * Issue #16 — the earnings/dividend event calendar service.
 *
 * Hermetic: the Yahoo crumb session is mocked and global fetch is stubbed
 * with a URL-routed fake (parsed hostname + pathname, never substring
 * routing). The service must never throw and must never guess: any
 * failure to get a live answer for a name is reported as covered: false.
 */

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0); // 2026-10-21

const sessionMock = vi.mocked(getYahooCrumbSession);

function calendarPayload(symbol: string): unknown {
  if (symbol === "XYZ") {
    return {
      quoteSummary: {
        result: [{
          calendarEvents: {
            earnings: {
              earningsDate: [
                { raw: Date.UTC(2026, 9, 26) / 1000, fmt: "2026-10-26" },
                { raw: Date.UTC(2026, 9, 27) / 1000, fmt: "2026-10-27" },
              ],
            },
            exDividendDate: { raw: Date.UTC(2026, 9, 24) / 1000, fmt: "2026-10-24" },
          },
        }],
        error: null,
      },
    };
  }
  if (symbol === "NOEVT") {
    return { quoteSummary: { result: [{ calendarEvents: {} }], error: null } };
  }
  if (symbol === "PAST") {
    return {
      quoteSummary: {
        result: [{
          calendarEvents: {
            earnings: { earningsDate: [{ raw: Date.UTC(2026, 9, 1) / 1000, fmt: "2026-10-01" }] },
            exDividendDate: { raw: Date.UTC(2026, 8, 30) / 1000, fmt: "2026-09-30" },
          },
        }],
        error: null,
      },
    };
  }
  return null;
}

function installFetchStub() {
  const stub = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.hostname === "query2.finance.yahoo.com" && url.pathname.startsWith("/v10/finance/quoteSummary/")) {
      const symbol = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (symbol === "BAD") {
        return new Response("upstream error", { status: 500 });
      }
      const payload = calendarPayload(symbol);
      if (!payload) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unstubbed fetch in event_calendar test: ${url.hostname}${url.pathname}`);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("event calendar service (issue #16)", () => {
  beforeEach(() => {
    __resetEventCalendarCache();
    sessionMock.mockReset();
    sessionMock.mockResolvedValue({ cookie: "cookie", crumb: "crumb", expiresAt: Date.now() + 3600_000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns days-to-earnings and days-to-ex-div for a covered name", async () => {
    installFetchStub();
    const result = await getSymbolEventCalendar("XYZ", NOW);

    expect(result.covered).toBe(true);
    expect(result.symbol).toBe("XYZ");
    expect(result.earningsDate).toBe("2026-10-26");
    expect(result.daysToEarnings).toBe(5);
    expect(result.exDividendDate).toBe("2026-10-24");
    expect(result.daysToExDiv).toBe(3);
    expect(result.source).toBe("yahoo-calendarEvents");
  });

  it("reports a name with no scheduled events as covered with null days", async () => {
    installFetchStub();
    const result = await getSymbolEventCalendar("NOEVT", NOW);

    expect(result.covered).toBe(true);
    expect(result.daysToEarnings).toBeNull();
    expect(result.daysToExDiv).toBeNull();
  });

  it("ignores events in the past instead of reporting negative days", async () => {
    installFetchStub();
    const result = await getSymbolEventCalendar("PAST", NOW);

    expect(result.covered).toBe(true);
    expect(result.daysToEarnings).toBeNull();
    expect(result.daysToExDiv).toBeNull();
  });

  it("reports an upstream failure as uncovered instead of throwing or guessing", async () => {
    installFetchStub();
    const result = await getSymbolEventCalendar("BAD", NOW);

    expect(result.covered).toBe(false);
    expect(result.daysToEarnings).toBeNull();
    expect(result.daysToExDiv).toBeNull();
  });

  it("reports no session as uncovered and does not fetch", async () => {
    const stub = installFetchStub();
    sessionMock.mockResolvedValue(null);
    const result = await getSymbolEventCalendar("XYZ", NOW);

    expect(result.covered).toBe(false);
    expect(stub).not.toHaveBeenCalled();
  });

  it("caches covered results per symbol", async () => {
    const stub = installFetchStub();
    const first = await getSymbolEventCalendar("XYZ", NOW);
    const second = await getSymbolEventCalendar("XYZ", NOW);

    expect(second).toEqual(first);
    expect(stub.mock.calls.length).toBe(1);
  });

  it("does not cache uncovered results, so a recovering feed is picked up", async () => {
    const stub = installFetchStub();
    await getSymbolEventCalendar("BAD", NOW);
    await getSymbolEventCalendar("BAD", NOW);

    expect(stub.mock.calls.length).toBe(2);
  });

  it("projects to the engine-facing info shape (no service bookkeeping)", async () => {
    installFetchStub();
    const cal = await getSymbolEventCalendar("XYZ", NOW);

    expect(toEventCalendarInfo(cal)).toEqual({
      covered: true,
      source: "yahoo-calendarEvents",
      earningsDate: "2026-10-26",
      daysToEarnings: 5,
      exDividendDate: "2026-10-24",
      daysToExDiv: 3,
    });
  });

  it("computes per-run coverage across a set of names", async () => {
    installFetchStub();
    const coverage = await getEventCalendarCoverage(["XYZ", "NOEVT", "BAD"], NOW);

    expect(coverage.total).toBe(3);
    expect(coverage.coveredCount).toBe(2);
    expect(coverage.coveragePct).toBeCloseTo(66.7, 1);
    expect(coverage.bySymbol.get("XYZ")?.covered).toBe(true);
    expect(coverage.bySymbol.get("BAD")?.covered).toBe(false);
  });

  it("bounds cold-calendar requests for a 100-symbol options scan", async () => {
    const stub = installFetchStub();
    const symbols = ["XYZ", ...Array.from({ length: 99 }, (_, i) => `S${i}`)];
    const coverage = await getEventCalendarCoverage(symbols, NOW);

    expect(stub).toHaveBeenCalledTimes(5);
    expect(coverage.total).toBe(100);
    expect(coverage.bySymbol.size).toBe(100);
    expect(coverage.bySymbol.get("XYZ")?.covered).toBe(true);
    expect(coverage.bySymbol.get("S98")?.covered).toBe(false);
  });
});
