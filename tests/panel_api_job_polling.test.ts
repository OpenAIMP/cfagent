/**
 * Issue #71 regression: the deployed worker answers API requests with
 * an async-job stub (HTTP 202 {jobId, statusUrl}) and the real payload
 * arrives via polling — the app-wide convention is src/client/apiFetch.
 * The #63/#67 panel clients used the global fetch, read the STUB as the
 * payload, and crashed the render (`undefined.filter` / `.length`).
 * These tests reproduce that exact flow against a stubbed global fetch:
 * the first call returns 202 + stub; the poll returns the completed job
 * whose result body is the real payload.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAlerts } from "../src/client/accountApi";
import { fetchPortfolioRisk } from "../src/client/portfolioRiskApi";

function stubJobFlow(resultBody: string) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/jobs/")) {
      return Response.json({
        jobId: "job-1",
        capability: "http.request",
        status: "completed",
        statusUrl: "/api/jobs/job-1",
        responseStatus: 200,
        result: { body: resultBody, headers: { "content-type": "application/json" } },
      });
    }
    return Response.json({ jobId: "job-1", status: "queued", statusUrl: "/api/jobs/job-1" }, { status: 202 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("panel API clients vs the async-job flow (issue #71)", () => {
  it("fetchAlerts polls the job and resolves the real alerts payload", async () => {
    stubJobFlow(JSON.stringify({ count: 1, alerts: [{ id: 7, subject: "Price alert", status: "UNREAD" }] }));
    const data = await fetchAlerts("TEST");
    expect(data.count).toBe(1);
    expect(data.alerts).toHaveLength(1);
    expect(data.alerts[0].subject).toBe("Price alert");
    // The renderer's .filter must be safe on the result.
    expect(data.alerts.filter((a) => a.status === "UNREAD")).toHaveLength(1);
  });

  it("fetchAlerts coerces a payload missing the alerts array to []", async () => {
    stubJobFlow(JSON.stringify({ count: 0 }));
    const data = await fetchAlerts("TEST");
    expect(data.alerts).toEqual([]);
  });

  it("fetchPortfolioRisk polls the job and resolves the real report", async () => {
    const report = {
      asOf: new Date().toISOString(), nav: 1000, spyPrice: 500,
      rows: [], excluded: [], partial: [], undefinedRiskPositions: [],
      totals: { positionCount: 0, deltaShares: 0, deltaDollars: 0, betaWeightedDeltaDollars: null, betaWeightedSpyShares: null, gammaSharesPerDollar: 0, thetaDollarsPerDay: 0, vegaDollarsPerVolPoint: 0, rhoDollarsPerRatePoint: 0, definedMaxLoss: 0, definedMaxLossPctOfNav: null, betaCoverage: { covered: 0, total: 0, computedLive: 0, staticFallback: 0 } },
    };
    stubJobFlow(JSON.stringify(report));
    const data = await fetchPortfolioRisk("TEST");
    expect(data.nav).toBe(1000);
    expect(data.rows).toEqual([]);
    expect(data.excluded).toEqual([]);
  });

  it("fetchPortfolioRisk rejects a stub-shaped body instead of returning it to the renderer", async () => {
    // If a job stub ever reaches the client unpolled, the shape guard
    // must throw (panel shows its error state) — never resolve.
    stubJobFlow(JSON.stringify({ jobId: "job-1", status: "queued", statusUrl: "/api/jobs/job-1" }));
    await expect(fetchPortfolioRisk("TEST")).rejects.toThrow(/response shape/);
  });
});

describe("alert timestamp normalization (issue #71 follow-up)", () => {
  it("converts epoch seconds to milliseconds and leaves ms untouched", async () => {
    const { normalizeEpochMs } = await import("../src/client/accountApi");
    expect(normalizeEpochMs(1771176000)).toBe(1771176000000);
    expect(normalizeEpochMs(1771176000000)).toBe(1771176000000);
    expect(normalizeEpochMs(0)).toBe(0);
  });

  it("fetchAlerts normalizes createTime from the job payload", async () => {
    stubJobFlow(JSON.stringify({ count: 1, alerts: [{ id: 9, subject: "S", status: "UNREAD", createTime: 1771176000 }] }));
    const data = await fetchAlerts("TEST");
    expect(data.alerts[0].createTime).toBe(1771176000000);
  });
});
