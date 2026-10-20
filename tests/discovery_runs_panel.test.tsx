/** @vitest-environment jsdom */
/**
 * Issue #126 (PR-F): the Discovery runs section in Options Research
 * reviews the PERSISTED runs of the scheduled-discovery backend
 * (PR-E) — separate from the interactive StrategyDiscoveryPanel,
 * whose results are never stored.
 *
 * Harness follows tests/screeners_hub_auto_runs.test.tsx (PR-A): the
 * REAL apiFetch driven against a stubbed global fetch (the routes
 * answer 200 directly), the component rendered with react-dom/client
 * in jsdom, downloads captured via URL.createObjectURL + anchor
 * click (the PR-B pattern).
 *
 * Pins:
 *  - the run list renders every persisted run with time, trigger
 *    provenance (schedule id when present), the saved-request input
 *    label, status badge, symbols, and completion counts;
 *  - the latest run is the default selection; its detail renders the
 *    per-symbol saved view, the ranked candidates with the panel's
 *    headline metrics, the highlighted best trade, screened/excluded
 *    counts, and the failed symbol named with its reason;
 *  - a failed run renders its status + per-symbol reasons (never an
 *    empty table), offers its JSON diagnostic download, and offers
 *    NO candidate CSV;
 *  - downloads target the VIEWED run (filename carries its
 *    timestamp; CSV content names its failures);
 *  - no runs → an honest empty state, no fabricated sample data.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiscoveryRunsPanel } from "../src/client/options/DiscoveryRunsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures -----------------------------------------------------------------
// Shaped like the store's DiscoveryRunSummary / StoredDiscoveryRun
// (discoveryRunStore.ts) as the PR-E read routes return them, so a
// server shape change breaks these tests on purpose.

const candidate = (over: Record<string, unknown> = {}) => ({
  id: "cand-1",
  rank: 1,
  type: "long_call",
  label: "NVDA Long Call",
  symbol: "NVDA",
  underlyingPrice: 180,
  expirationDate: "2027-12-18",
  dataFreshness: "FRESH",
  legs: [],
  netDebit: 4.25,
  estimatedFees: 1.3,
  maxProfit: null,
  maxProfitUnbounded: true,
  maxLoss: 425,
  breakevens: [184.25],
  targetPnl: 850,
  targetRewardRisk: 2,
  modelImpliedProbabilityOfProfit: 0.42,
  netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1 },
  liquidityScore: 80,
  score: 77,
  payoffCurve: [],
  scenarios: [],
  explanations: [],
  warnings: [],
  assumptions: [],
  ...over,
});

const rankedEntry = (cand: Record<string, unknown>, rank: number, compositeScore: number) => ({
  candidate: cand,
  rank,
  compositeScore,
  components: { engineScore: 1, probability: 1, rewardRisk: 1, capitalSafety: 1, liquidity: 1 },
});

const REQUEST_NVDA = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  allowedStrategies: ["long_call", "long_put"],
};
const REQUEST_MSFT = { ...REQUEST_NVDA, symbol: "MSFT", thesis: "bearish", targetPrice: 380 };
const REQUEST_AAPL = { ...REQUEST_NVDA, symbol: "AAPL", targetPrice: 260 };
const REQUEST_TSLA = { ...REQUEST_NVDA, symbol: "TSLA", targetPrice: 300 };

const NVDA_RANKED = [
  rankedEntry(candidate(), 1, 87.5),
  rankedEntry(candidate({ id: "cand-2", label: "NVDA Bull Call Spread", netDebit: 2.1, maxLoss: 210 }), 2, 71.25),
];

const RUN_PARTIAL = {
  id: "run-partial",
  createdAt: "2026-10-20T13:55:00.000Z",
  trigger: "scheduled",
  scheduleId: "sched-abc",
  inputModel: "saved-request",
  status: "partial",
  requestCount: 2,
  completedCount: 1,
  failedCount: 1,
  symbols: ["NVDA", "MSFT"],
  requests: [REQUEST_NVDA, REQUEST_MSFT],
  outcomes: [
    {
      symbol: "NVDA",
      status: "completed",
      request: REQUEST_NVDA,
      ranked: NVDA_RANKED,
      riskReports: [],
      screenedOut: [{ id: "iron_condor", reason: "wing width" }],
      excluded: [{ reason: "insufficient liquidity", count: 3 }],
      bestTrade: {
        status: "recommended",
        riskProfile: "balanced",
        confidence: "HIGH",
        best: NVDA_RANKED[0],
        alternatives: [NVDA_RANKED[1]],
        rationale: ["NVDA Long Call ranks #1 for a balanced profile."],
        blockers: [],
        humanApprovalRequired: true,
        disclaimer: "research only",
      },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 1200, contractsMatched: 45 } },
    },
    { symbol: "MSFT", status: "failed", request: REQUEST_MSFT, error: "E*TRADE chain unavailable: session expired" },
  ],
};

const RUN_COMPLETED = {
  id: "run-completed",
  createdAt: "2026-10-20T13:50:00.000Z",
  trigger: "scheduled",
  inputModel: "saved-request",
  status: "completed",
  requestCount: 1,
  completedCount: 1,
  failedCount: 0,
  symbols: ["AAPL"],
  requests: [REQUEST_AAPL],
  outcomes: [
    {
      symbol: "AAPL",
      status: "completed",
      request: REQUEST_AAPL,
      ranked: [rankedEntry(candidate({ id: "aapl-1", label: "AAPL Long Call", symbol: "AAPL" }), 1, 66)],
      riskReports: [],
      screenedOut: [],
      excluded: [],
      bestTrade: {
        status: "no_trade",
        riskProfile: "balanced",
        confidence: "LOW",
        alternatives: [],
        rationale: ["No AAPL strategy satisfied the bullish thesis, risk cap and reward/risk minimum."],
        blockers: ["No qualifying candidates"],
        humanApprovalRequired: true,
        disclaimer: "research only",
      },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 900, contractsMatched: 12 } },
    },
  ],
};

const RUN_FAILED = {
  id: "run-failed",
  createdAt: "2026-10-20T13:45:00.000Z",
  trigger: "manual-trigger",
  inputModel: "saved-request",
  status: "failed",
  requestCount: 1,
  completedCount: 0,
  failedCount: 1,
  symbols: ["TSLA"],
  requests: [REQUEST_TSLA],
  outcomes: [
    { symbol: "TSLA", status: "failed", request: REQUEST_TSLA, error: "consumer credentials are not configured" },
  ],
};

const ALL_RUNS = [RUN_PARTIAL, RUN_COMPLETED, RUN_FAILED];
const SUMMARIES = ALL_RUNS.map(({ requests: _r, outcomes: _o, ...summary }) => summary);
const DETAILS: Record<string, unknown> = {
  "run-partial": RUN_PARTIAL,
  "run-completed": RUN_COMPLETED,
  "run-failed": RUN_FAILED,
};

// Harness ------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;
let listPayload: { count: number; runs: unknown[] } = { count: SUMMARIES.length, runs: SUMMARIES };

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const detailMatch = url.match(/\/discovery-runs\/([^/?]+)/);
    if (detailMatch) {
      const detail = DETAILS[decodeURIComponent(detailMatch[1])];
      return detail
        ? Response.json(detail)
        : Response.json({ error: "discovery run not found" }, { status: 404 });
    }
    if (url.includes("/discovery-runs")) {
      return Response.json(listPayload);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
}

interface CapturedDownload {
  filename: string;
  blob: Blob;
}
const downloads: CapturedDownload[] = [];
let pendingBlob: Blob | null = null;

function stubDownloads() {
  downloads.length = 0;
  pendingBlob = null;
  (URL as any).createObjectURL = vi.fn((blob: Blob) => {
    pendingBlob = blob;
    return "blob:mock-export";
  });
  (URL as any).revokeObjectURL = vi.fn(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (pendingBlob) downloads.push({ filename: this.download, blob: pendingBlob });
    pendingBlob = null;
  });
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<DiscoveryRunsPanel activeEnv="PROD" userLogin="tester" />);
  });
  await flush();
}

function runItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".discovery-run-item"));
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    (b.textContent || "").includes(text),
  );
}

beforeEach(() => {
  listPayload = { count: SUMMARIES.length, runs: SUMMARIES };
  stubFetch();
  stubDownloads();
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

// Component ------------------------------------------------------------------

describe("DiscoveryRunsPanel run list (#126 PR-F)", () => {
  it("renders every persisted run with provenance, input model, status, symbols and counts", async () => {
    await renderPanel();
    const items = runItems();
    expect(items).toHaveLength(3);

    const partial = items[0].textContent || "";
    expect(partial).toContain(new Date(RUN_PARTIAL.createdAt).toLocaleString());
    expect(partial).toContain("Scheduled · schedule sched-abc");
    expect(partial).toContain("Saved requests");
    expect(partial).toContain("Partial");
    expect(partial).toContain("NVDA, MSFT");
    expect(partial).toContain("1 of 2 requests completed");
    expect(partial).toContain("1 failed");

    const completed = items[1].textContent || "";
    expect(completed).toContain("Completed");
    expect(completed).toContain("AAPL");
    expect(completed).toContain("1 of 1 requests completed");

    const failed = items[2].textContent || "";
    expect(failed).toContain("Manual trigger");
    expect(failed).toContain("Failed");
    expect(failed).toContain("TSLA");
    expect(failed).toContain("0 of 1 requests completed");
  });

  it("defaults to the latest run and renders its per-symbol outcomes read-only", async () => {
    await renderPanel();
    const items = runItems();
    expect(items[0].getAttribute("aria-pressed")).toBe("true");
    expect(items[0].textContent).toContain("Viewing");

    const text = container.textContent || "";
    // The saved view the NVDA request ran with.
    expect(text).toContain("Saved view: bullish");
    expect(text).toContain("target $200.00 by 2027-12-18");
    expect(text).toContain("max planned loss $500.00");
    // Provenance of the underlying chain snapshot.
    expect(text).toContain("Live broker chain");
    expect(text).toContain("1,200 contracts evaluated");
    // Ranked candidates with the panel's headline metrics.
    expect(text).toContain("NVDA Long Call");
    expect(text).toContain("Composite 87.5");
    expect(text).toContain("POP 42%");
    expect(text).toContain("Max loss $425.00");
    expect(text).toContain("NVDA Bull Call Spread");
    expect(text).toContain("Composite 71.3"); // 71.25 renders at 1dp like the panel
    // Best trade highlighted.
    expect(text).toContain("★ Best trade");
    expect(text).toContain("confidence HIGH");
    // Screened-out / excluded counts.
    expect(text).toContain("Screened out: 1");
    expect(text).toContain("Excluded: 3");
    expect(text).toContain("insufficient liquidity ×3");
    // The failed symbol is named with its reason, in the detail header too.
    expect(text).toContain("Failed: MSFT");
    expect(text).toContain("E*TRADE chain unavailable: session expired");
    // Total ranked count across the run.
    expect(text).toContain("2 ranked candidates");
  });

  it("selecting the failed run renders its reasons — and JSON only, no candidate CSV", async () => {
    await renderPanel();
    const items = runItems();
    await act(async () => {
      items[2].click();
    });
    await flush();

    const text = container.textContent || "";
    expect(text).toContain("This run failed");
    expect(text).toContain("consumer credentials are not configured");
    expect(buttonByText("Candidates CSV")).toBeUndefined();
    expect(buttonByText("Run JSON")).toBeDefined();
    expect(items[2].getAttribute("aria-pressed")).toBe("true");
  });

  it("selecting the completed run renders its no-trade best pick honestly", async () => {
    await renderPanel();
    const items = runItems();
    await act(async () => {
      items[1].click();
    });
    await flush();

    const text = container.textContent || "";
    expect(text).toContain("AAPL Long Call");
    expect(text).toContain("No trade — No AAPL strategy satisfied the bullish thesis");
    expect(buttonByText("Candidates CSV")).toBeDefined();
    expect(buttonByText("Run JSON")).toBeDefined();
  });
});

describe("DiscoveryRunsPanel downloads (#126 PR-F)", () => {
  it("CSV targets the viewed run: filename carries its timestamp, content names its failures", async () => {
    await renderPanel();
    await act(async () => {
      buttonByText("Candidates CSV")?.click();
    });
    await flush(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("discovery-20261020-135500.csv");
    const csv = await blobText(downloads[0].blob);
    expect(csv).toContain("# FAILED: MSFT — E*TRADE chain unavailable: session expired");
    expect(csv).toContain("NVDA Long Call");
  });

  it("JSON download is the viewed run's full record (round-trips, no scoping stamp)", async () => {
    await renderPanel();
    const items = runItems();
    await act(async () => {
      items[2].click();
    });
    await flush();
    await act(async () => {
      buttonByText("Run JSON")?.click();
    });
    await flush(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("discovery-20261020-134500.json");
    const parsed = JSON.parse(await blobText(downloads[0].blob));
    expect(parsed.id).toBe("run-failed");
    expect(parsed.outcomes[0].error).toBe("consumer credentials are not configured");
    expect("userLogin" in parsed).toBe(false);
  });
});

describe("DiscoveryRunsPanel empty state (#126 PR-F)", () => {
  it("no runs → an honest empty state, no fabricated rows", async () => {
    listPayload = { count: 0, runs: [] };
    await renderPanel();
    expect(runItems()).toHaveLength(0);
    expect(container.textContent).toContain("No discovery runs yet");
    expect(container.textContent).not.toContain("NVDA");
  });
});
