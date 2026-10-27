/**
 * Issue #1888: enrichment quality feeds the telemetry summary —
 * the optional enrichmentStats dep adds the `enrichment` field
 * when provided, and nothing when absent or null.
 */
import { describe, expect, it } from "vitest";
import { InMemoryTelemetryAdapter } from "../src/telemetry/inMemoryTelemetryAdapter";
import { handleTelemetrySummaryRoute } from "../src/telemetry/telemetryRoute";
import { summarizeEnrichmentQuality } from "../src/enrichment/enrichmentPorts";

const SESSION = { githubLogin: "owner:alice", internalUserId: "user-1" };

function baseDeps(store: unknown) {
  return {
    session: SESSION,
    method: "GET",
    tenantId: "primary",
    store: store as never,
    breakerSnapshots: () => [],
    retrievalStats: () => ({
      total: 0,
      byType: {},
      recent: [],
    }),
  };
}

describe("telemetry summary enrichment field", () => {
  it("includes enrichment quality when the dep provides it", async () => {
    const store = new InMemoryTelemetryAdapter();
    const quality = summarizeEnrichmentQuality([
      {
        id: "enr-1",
        jobId: "job-1",
        stage: "feed",
        provider: "yahoo",
        mode: "yahoo",
        minuteTimeframe: "1Min",
        symbolsRequested: 2,
        symbolsServed: 2,
        barsFetched: 10,
        dailyBars: 4,
        minuteBars: 6,
        fallbacks: 0,
        errors: [],
        partial: false,
        stopped: false,
        breakerState: [],
        killswitchState: "clear",
        createdAt: new Date(0).toISOString(),
        results: [],
      },
    ]);
    const res = await handleTelemetrySummaryRoute({
      ...baseDeps(store),
      enrichmentStats: () => quality,
    });
    const body = (await res.json()) as { enrichment?: { runs: number; coveragePct: number } };
    expect(body.enrichment?.runs).toBe(1);
    expect(body.enrichment?.coveragePct).toBe(100);
  });

  it("omits the field when the dep is absent or returns null", async () => {
    const store = new InMemoryTelemetryAdapter();
    const res = await handleTelemetrySummaryRoute(baseDeps(store));
    const body = (await res.json()) as Record<string, unknown>;
    expect("enrichment" in body).toBe(false);
    const res2 = await handleTelemetrySummaryRoute({
      ...baseDeps(store),
      enrichmentStats: () => null,
    });
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect("enrichment" in body2).toBe(false);
  });
});
