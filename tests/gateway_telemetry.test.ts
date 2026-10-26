/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * Pins the additive telemetry wiring: the summary body gains a
 * `gateway` field only when the gatewayStats dep is provided, so
 * existing callers and tests are unchanged when it is absent.
 * Follows the #1742 injected-dep pattern (breakerSnapshots /
 * retrievalStats), no new route, no IAAA catalog change.
 */
import { describe, expect, it } from "vitest";
import { InMemoryTelemetryAdapter } from "../src/telemetry/inMemoryTelemetryAdapter";
import {
  handleTelemetrySummaryRoute,
  type TelemetryRouteSession,
} from "../src/telemetry/telemetryRoute";
import type { GatewayStatsSnapshot } from "../src/gateway/gatewayPorts";

const SIGNED_IN: TelemetryRouteSession = { githubLogin: "owner:bob", internalUserId: "user-2" };

describe("telemetry summary gateway field (#1741)", () => {
  it("gateway field is present when the dep is provided, absent otherwise", async () => {
    const store = new InMemoryTelemetryAdapter();
    const gatewayStats: () => GatewayStatsSnapshot = () => ({
      requests: 3,
      cacheHits: 1,
      fallbacks: 1,
      failures: 0,
      rateLimited: 0,
      attemptsByModel: { "@cf/m": 4 },
    });
    const breakerSnapshots = () => [];
    const retrievalStats = () => ({
      totalRetrievals: 0,
      totalDense: 0,
      totalGraph: 0,
      degradedCount: 0,
      lastCompletedAtMs: null,
    });
    const withDep = await handleTelemetrySummaryRoute({
      session: SIGNED_IN,
      method: "GET",
      tenantId: "primary",
      store,
      breakerSnapshots,
      retrievalStats,
      gatewayStats,
    });
    expect(withDep.status).toBe(200);
    const bodyWith = (await withDep.json()) as { gateway?: GatewayStatsSnapshot };
    expect(bodyWith.gateway).toEqual({
      requests: 3,
      cacheHits: 1,
      fallbacks: 1,
      failures: 0,
      rateLimited: 0,
      attemptsByModel: { "@cf/m": 4 },
    });

    const withoutDep = await handleTelemetrySummaryRoute({
      session: SIGNED_IN,
      method: "GET",
      tenantId: "primary",
      store,
      breakerSnapshots,
      retrievalStats,
    });
    expect(withoutDep.status).toBe(200);
    const bodyWithout = (await withoutDep.json()) as { gateway?: unknown };
    expect("gateway" in bodyWithout).toBe(false);
  });
});
