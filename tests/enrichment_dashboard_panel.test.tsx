/** @vitest-environment jsdom */
/**
 * Issue #1888: enrichment dashboard panel renders provider,
 * coverage, killswitch state, and recent runs from the status
 * surface, with an honest empty state before the first run.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { EnrichmentDashboard } from "../src/client/EnrichmentDashboard";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS = {
  ok: true,
  provider: "yahoo",
  mode: "yahoo",
  flag: { enrichment_alpaca: false },
  alpacaConfigured: false,
  killswitch: "clear",
  globalHalt: false,
  stopped: false,
  breakerState: [{ providerId: "yahoo", state: "closed" }],
  quality: {
    runs: 1,
    symbolsRequested: 2,
    symbolsServed: 2,
    barsFetched: 10,
    fallbacks: 0,
    partialRuns: 0,
    stoppedRuns: 0,
    coveragePct: 100,
  },
  recentRuns: [
    {
      id: "enr-1",
      jobId: "job-1",
      stage: "feed",
      provider: "yahoo",
      mode: "yahoo",
      symbolsRequested: 2,
      symbolsServed: 2,
      barsFetched: 10,
      fallbacks: 0,
      partial: false,
      stopped: false,
      createdAt: "2026-10-27T00:00:00.000Z",
    },
  ],
};

function stubFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EnrichmentDashboard", () => {
  it("renders provider, coverage, killswitch, and runs", async () => {
    stubFetch(STATUS);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<EnrichmentDashboard userLogin="operator" />);
    });
    expect(container.textContent).toMatch(/Yahoo/);
    expect(container.textContent).toMatch(/Clear/);
    expect(container.textContent).toMatch(/job-1/);
    expect(container.textContent).toMatch(/2\/2/);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the empty state when no runs exist", async () => {
    stubFetch({ ...STATUS, recentRuns: [], quality: { ...STATUS.quality, runs: 0 } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<EnrichmentDashboard userLogin="operator" />);
    });
    expect(container.textContent).toMatch(/No enrichment runs yet/);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
