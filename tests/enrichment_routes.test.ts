/**
 * Issue #1888: enrichment routes — status surface, run posting,
 * killswitch set/audit/state, calibration proposal + stopped
 * refusal, auth gate. Uses injected fakes; no provider or DO.
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleEnrichmentRoutes,
  type EnrichmentRouteContext,
} from "../src/agents/routes/enrichment";
import { InMemoryEnrichmentStore } from "../src/enrichment/enrichmentStore";
import type { EnrichmentMarketData } from "../src/enrichment/enrichmentService";
import { InMemoryFeatureFlagAdapter } from "../src/features/inMemoryFeatureFlagAdapter";

function marketData(): EnrichmentMarketData {
  return {
    isAlpacaConfigured: () => true,
    getQuote: async () => ({ ok: true }),
    getFundamentals: async () => ({ ok: true }),
    getBars: async (_s, _p, tf) =>
      tf === "1D"
        ? [{ timestamp: "t", open: 1, high: 1, low: 1, close: 1, volume: 1 }]
        : [{ timestamp: "t", open: 1, high: 1, low: 1, close: 1, volume: 1 }],
  };
}

function ctx(overrides: Partial<EnrichmentRouteContext> = {}): EnrichmentRouteContext {
  const store = new InMemoryEnrichmentStore();
  return {
    env: {},
    sql: { exec: () => [] },
    userLogin: "operator",
    recordAudit: () => undefined,
    marketData: marketData(),
    flagPort: new InMemoryFeatureFlagAdapter({}),
    breakerSnapshots: () => [],
    globalHalted: false,
    store,
    ...overrides,
  };
}

function req(path: string, init?: RequestInit): { request: Request; url: URL } {
  const request = new Request(`https://agent.internal${path}`, {
    method: "GET",
    ...init,
  });
  return { request, url: new URL(request.url) };
}

describe("enrichment routes", () => {
  it("status shows provider, coverage, breaker, killswitch state", async () => {
    const c = ctx();
    const { request, url } = req("/enrichment/status");
    const res = await handleEnrichmentRoutes(request, url, "/enrichment/status", "s", c);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.provider).toBe("yahoo");
    expect(body.killswitch).toBe("clear");
    expect(body.stopped).toBe(false);
    expect(body.quality).toBeDefined();
  });

  it("flag on selects Alpaca-fallback on status", async () => {
    const c = ctx({
      flagPort: new InMemoryFeatureFlagAdapter({ enrichment_alpaca: true }),
    });
    const { request, url } = req("/enrichment/status");
    const res = await handleEnrichmentRoutes(request, url, "/enrichment/status", "s", c);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.provider).toBe("alpaca");
    expect(body.mode).toBe("alpaca-fallback");
  });

  it("run posts, persists, and appears in status recent runs", async () => {
    const c = ctx();
    const post = req("/enrichment/run", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-9", stage: "feed", symbols: ["NVDA"] }),
    });
    const res = await handleEnrichmentRoutes(post.request, post.url, "/enrichment/run", "s", c);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { run: { symbolsServed: number } };
    expect(body.run.symbolsServed).toBe(1);
    const status = req("/enrichment/status");
    const sres = await handleEnrichmentRoutes(status.request, status.url, "/enrichment/status", "s", c);
    const sbody = (await sres?.json()) as { recentRuns: unknown[] };
    expect(sbody.recentRuns).toHaveLength(1);
  });

  it("killswitch thrown stops subsequent runs and is visible on status", async () => {
    const c = ctx();
    const set = req("/enrichment/killswitch", {
      method: "POST",
      body: JSON.stringify({ state: "halted", reason: "test" }),
    });
    const setRes = await handleEnrichmentRoutes(set.request, set.url, "/enrichment/killswitch", "s", c);
    expect(setRes?.status).toBe(200);
    const runReq = req("/enrichment/run", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-10", symbols: ["NVDA"] }),
    });
    const runRes = await handleEnrichmentRoutes(runReq.request, runReq.url, "/enrichment/run", "s", c);
    const runBody = (await runRes?.json()) as { stopped: boolean };
    expect(runBody.stopped).toBe(true);
    const status = req("/enrichment/status");
    const sres = await handleEnrichmentRoutes(status.request, status.url, "/enrichment/status", "s", c);
    const sbody = (await sres?.json()) as { killswitch: string; stopped: boolean };
    expect(sbody.killswitch).toBe("halted");
    expect(sbody.stopped).toBe(true);
    // Audit trail: the in-memory store records the change.
    expect((c.store as InMemoryEnrichmentStore).auditCalls).toHaveLength(1);
  });

  it("calibration refuses while stopped and proposes otherwise", async () => {
    const c = ctx();
    const cal = req("/enrichment/calibration");
    const res = await handleEnrichmentRoutes(cal.request, cal.url, "/enrichment/calibration", "s", c);
    expect(res?.status).toBe(200);
    const c2 = ctx({ globalHalted: true });
    const cal2 = req("/enrichment/calibration");
    const res2 = await handleEnrichmentRoutes(cal2.request, cal2.url, "/enrichment/calibration", "s", c2);
    expect(res2?.status).toBe(409);
  });

  it("mutations refuse without a verified login; unknown paths pass through", async () => {
    const c = ctx({ userLogin: "" });
    const runReq = req("/enrichment/run", {
      method: "POST",
      body: JSON.stringify({ jobId: "j", symbols: ["NVDA"] }),
    });
    const res = await handleEnrichmentRoutes(runReq.request, runReq.url, "/enrichment/run", "s", c);
    expect(res?.status).toBe(401);
    const other = req("/enrichment/nope");
    const res2 = await handleEnrichmentRoutes(other.request, other.url, "/enrichment/nope", "s", c);
    expect(res2).toBeNull();
  });

  it("run validation rejects empty symbols and bad minute timeframes", async () => {
    const c = ctx();
    const empty = req("/enrichment/run", {
      method: "POST",
      body: JSON.stringify({ jobId: "j", symbols: [] }),
    });
    expect(
      (await handleEnrichmentRoutes(empty.request, empty.url, "/enrichment/run", "s", c))?.status,
    ).toBe(400);
    const bad = req("/enrichment/run", {
      method: "POST",
      body: JSON.stringify({ jobId: "j", symbols: ["NVDA"], minuteTimeframe: "7Min" }),
    });
    expect(
      (await handleEnrichmentRoutes(bad.request, bad.url, "/enrichment/run", "s", c))?.status,
    ).toBe(400);
  });

  it("emit is called for runs (observability path)", async () => {
    const emit = vi.fn();
    const c = ctx({ emit });
    const runReq = req("/enrichment/run", {
      method: "POST",
      body: JSON.stringify({ jobId: "j-emit", symbols: ["NVDA"] }),
    });
    await handleEnrichmentRoutes(runReq.request, runReq.url, "/enrichment/run", "s", c);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].type).toBe("enrichment.completed");
  });
});
