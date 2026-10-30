/** @vitest-environment jsdom */
/**
 * Issue #2438 (ScreenersHub redesign): the provider connectivity
 * dashboard — one row per registered provider, health from stored
 * state only, hosted in ScreenersHub.
 *
 * Pins:
 *  - one row per provider from GET /api/data-providers (server-computed
 *    capture health; the dashboard formats only);
 *  - "no-data" renders as unknown, never as healthy;
 *  - credential presence is a reference name only, never a value;
 *  - the E*TRADE row shows token presence PER RESOLUTION SCOPE
 *    (login-scoped, unscoped, internal-id, alias-login) from
 *    GET /api/etrade/oauth/status presence data;
 *  - the dashboard issues GET reads only: no Run/Analyze/Scan/Refresh/
 *    Verify/Test & Sync call on load (or on poll) — nothing here may
 *    enqueue, execute, or re-fire a run.
 *
 * Harness follows tests/screeners_hub_auto_runs.test.tsx: the REAL
 * apiFetch is driven against a stubbed global fetch.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderConnectivityDashboard } from "../src/client/ProviderConnectivityDashboard";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; method: string }> = [];

function healthFixture(overrides: Record<string, unknown>) {
  return {
    status: "healthy",
    totalCaptures: 10,
    capturedCount: 9,
    failedCount: 1,
    failureRate: 0.1,
    lastSuccessAt: "2026-10-30T11:00:00.000Z",
    lastFailureAt: "2026-10-30T10:00:00.000Z",
    consecutiveFailures: 0,
    totalRawBytes: 2048,
    capturesLast24h: 5,
    failuresLast24h: 1,
    byCapability: {},
    ...overrides,
  };
}

function providerFixture(overrides: Record<string, unknown>) {
  return {
    id: "etrade",
    adapterKind: "etrade",
    lifecycleState: "enabled",
    enabled: true,
    precedence: 1,
    credentialRef: "env:ETRADE_API_KEY",
    config: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    declaredCapabilities: ["quotes"],
    verification: { verifiedAt: "2026-10-02T00:00:00.000Z", summary: "ok", verifiedBy: "operator" },
    serving: true,
    health: healthFixture({}),
    ...overrides,
  };
}

const PROVIDERS = [
  providerFixture({}),
  providerFixture({
    id: "yahoo",
    adapterKind: "yahoo",
    lifecycleState: "enabled",
    credentialRef: null,
    health: healthFixture({ status: "degraded", failureRate: 0.4, failedCount: 4 }),
  }),
  providerFixture({
    id: "public",
    adapterKind: "public",
    lifecycleState: "registered",
    enabled: false,
    credentialRef: null,
    serving: false,
    verification: null,
    health: healthFixture({
      status: "no-data",
      totalCaptures: 0,
      capturedCount: 0,
      failedCount: 0,
      failureRate: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      totalRawBytes: 0,
      capturesLast24h: 0,
      failuresLast24h: 0,
    }),
  }),
];

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ? String(input.url) : String(input);
    const method = (init?.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();
    fetchCalls.push({ url, method });
    if (url.includes("/api/data-providers")) {
      return Response.json({ providers: PROVIDERS, routes: [] });
    }
    if (url.includes("/api/etrade/oauth/status")) {
      return Response.json({
        authenticated: true,
        environment: "PROD",
        tokenScopes: { loginScoped: true, unscoped: false, internalId: true, aliasLogin: false },
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDashboard() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ProviderConnectivityDashboard />);
  });
  await flush();
  await flush();
}

beforeEach(() => {
  fetchCalls.length = 0;
  stubFetch();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("ProviderConnectivityDashboard (#2438)", () => {
  it("renders one row per registered provider with server-computed health", async () => {
    await renderDashboard();
    const text = container.textContent || "";
    expect(text).toContain("etrade");
    expect(text).toContain("yahoo");
    expect(text).toContain("public");
    expect(text).toContain("Healthy");
    expect(text).toContain("Degraded");
  });

  it("renders no-data as unknown, never as healthy", async () => {
    await renderDashboard();
    const rows = Array.from(container.querySelectorAll("[data-provider-row]"));
    const publicRow = rows.find((r) => (r.getAttribute("data-provider-row") || "") === "public");
    expect(publicRow).toBeDefined();
    expect(publicRow?.textContent || "").toContain("Unknown");
    expect(publicRow?.textContent || "").not.toContain("Healthy");
  });

  it("shows credential presence as a reference name only, never a value", async () => {
    await renderDashboard();
    const text = container.textContent || "";
    expect(text).toContain("env:ETRADE_API_KEY");
    expect(text).not.toContain("ET_API_SECRET");
  });

  it("shows E*TRADE token presence per resolution scope", async () => {
    await renderDashboard();
    const rows = Array.from(container.querySelectorAll("[data-provider-row]"));
    const etradeRow = rows.find((r) => (r.getAttribute("data-provider-row") || "") === "etrade");
    expect(etradeRow).toBeDefined();
    const rowText = etradeRow?.textContent || "";
    expect(rowText).toContain("login-scoped");
    expect(rowText).toContain("unscoped");
    expect(rowText).toContain("internal-id");
    expect(rowText).toContain("alias-login");
  });

  it("issues GET reads only — no run, verify, or test action on load", async () => {
    await renderDashboard();
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const call of fetchCalls) {
      expect(call.method).toBe("GET");
    }
    const urls = fetchCalls.map((c) => c.url).join(" ");
    expect(urls).not.toMatch(/verify|test|sync|analyze|scan|run/i);
    expect(fetchCalls.some((c) => c.url.includes("/api/data-providers"))).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes("/api/etrade/oauth/status"))).toBe(true);
  });
});
