/** @vitest-environment jsdom */
/**
 * Consolidation C2 (issue #1246, epic #1151 R3/R4) — one nav entry,
 * one hub:
 *
 *  - NAVIGATION_ITEMS carries exactly ONE screening entry
 *    ("screeners", labeled "Screening"); the legacy screening tab
 *    ids still read as active on it and still deep-link into the hub.
 *  - The Trading Hub's screening subtabs render the hub itself on
 *    the equivalent tab — the S8 "Screening Moved" redirect notices
 *    are gone (these pins supersede the S8 redirect pins, which the
 *    C2 acceptance criteria explicitly retire).
 *  - ScreenersHub hosts Reports, Schedules, the proposal Review
 *    inbox, and the outcome Track record as tabs.
 *  - The Review inbox drives the EXISTING adaptation endpoints
 *    (evaluate / gate / approve / decide) and the goal store's
 *    proposed-only decisions; re-selection proposals are read-only.
 *  - The Track record renders the outcome ledger honestly:
 *    Unverified stays Unverified; unknown P&L is "Not recorded".
 *  - Discovery stays server-driven: StrategyDiscoveryPanel imports
 *    from strategyDiscoveryEngine are modeling-only (allowlist pin).
 *  - One exporter module: optionsDataExporter.tsx is gone; the
 *    options-data export functions live in runExport.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { NAVIGATION_ITEMS, isTabActive } from "../src/client/components/NavigationMenu";
import { ScreenersHub } from "../src/client/ScreenersHub";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ScreeningReviewPanel } from "../src/client/ScreeningReviewPanel";
import { ScreeningOutcomesPanel } from "../src/client/ScreeningOutcomesPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.resolve(__dirname, "../src");
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const candidate = {
  id: "cand-1",
  target: "strategy:iron_condor",
  change: { action: "gate_off", description: "Gate off iron_condor below a 25% win rate" },
  hypothesis: "Iron condor underperforms in the current regime.",
  expectedEffect: { metric: "winRate", direction: "increase" },
  evidenceRefs: ["track-record"],
  provenance: { source: "track-record", id: "tr-1" },
  status: "gated",
  supersedesId: null,
  createdAt: "2026-10-23T04:00:00.000Z",
  updatedAt: "2026-10-23T04:00:00.000Z",
};

const proposedGoal = {
  id: "goal-1",
  userLogin: "alice",
  kind: "income",
  title: "Covered-call income on SPY",
  status: "proposed",
  source: "discovered",
  payload: null,
  createdAt: "2026-10-23T04:00:00.000Z",
  updatedAt: "2026-10-23T04:00:00.000Z",
  scenarios: [
    {
      id: "scen-1",
      userLogin: "alice",
      goalId: "goal-1",
      portfolioRef: { kind: "hypothetical" },
      shocks: { spotPct: -5 },
      constraints: { maxLoss: 500 },
      status: "draft",
      createdAt: "2026-10-23T04:00:00.000Z",
      updatedAt: "2026-10-23T04:00:00.000Z",
    },
  ],
};

const reselection = {
  id: "sbp-1",
  regime: "bull",
  createdAt: "2026-10-23T04:00:00.000Z",
  proposal: {
    regime: "bull",
    generatedAt: "2026-10-23T04:00:00.000Z",
    governance: "proposal_only_not_promoted",
    overallWinRate: 0.55,
    activeSet: [{ strategy: "iron_condor", score: 0.8, winRate: 0.6, avgRMultiple: 1.2, evaluated: 12 }],
    log: [],
    evaluatedCount: 12,
    costUnitsUsed: 3,
    costCapUnits: 10,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

/** A fetch stub routing the inbox/outcome endpoints to fixtures and
 *  recording every call for contract assertions. */
function stubFetch(calls: Array<{ method: string; url: string; body: any }>) {
  let approvals: any[] = [];
  return vi.fn(async (input: unknown, init?: any) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.includes("/api/adaptation/candidates") && !url.includes("?") && method === "GET") {
      return jsonResponse({ candidates: [candidate] });
    }
    if (url.includes("/api/adaptation/candidates/evaluations")) {
      return jsonResponse({
        evaluations: [
          {
            id: "eval-1",
            candidateId: "cand-1",
            method: "counterfactual-replay",
            baselineMetric: 0.41,
            candidateMetric: 0.52,
            delta: 0.11,
            sampleSize: 64,
            window: {},
            detail: {},
            createdAt: "2026-10-23T04:30:00.000Z",
          },
        ],
      });
    }
    if (url.includes("/api/adaptation/candidates/approvals")) {
      if (method === "GET") return jsonResponse({ approvals });
      return jsonResponse({}); // not routed here
    }
    if (url.includes("/api/adaptation/candidates/verdicts")) {
      return jsonResponse({
        verdicts: [
          {
            id: "gv-1",
            candidateId: "cand-1",
            passed: true,
            reasons: ["held-out edge significant"],
            heldOutEvaluationId: "eval-1",
            z: 2.4,
            pValue: 0.008,
            approvalId: null,
            createdAt: "2026-10-23T04:35:00.000Z",
          },
        ],
      });
    }
    if (url.includes("/api/adaptation/candidates/approve/decide")) {
      approvals = approvals.map((a) => ({ ...a, status: body?.decision, decidedBy: "alice" }));
      return jsonResponse({ success: true });
    }
    if (url.includes("/api/adaptation/candidates/approve")) {
      const approval = {
        id: "appr-1",
        candidateId: "cand-1",
        status: "pending",
        requestedBy: "alice",
        decidedBy: null,
        createdAt: "2026-10-23T05:00:00.000Z",
        decidedAt: null,
      };
      approvals = [approval];
      return jsonResponse({ success: true, approval });
    }
    if (url.includes("/api/adaptation/candidates/evaluate")) {
      return jsonResponse({
        success: true,
        evaluation: {
          method: "counterfactual-replay",
          baselineMetric: 0.41,
          candidateMetric: 0.52,
          delta: 0.11,
          sampleSize: 64,
          detail: {},
        },
      });
    }
    if (url.includes("/api/adaptation/candidates/gate")) {
      return jsonResponse({
        success: true,
        verdict: { id: "gv-1", candidateId: "cand-1", passed: true, reasons: ["held-out edge significant"], z: 2.4, pValue: 0.008 },
      });
    }
    if (url.includes("/api/adaptation/promotions") && method === "GET") {
      return jsonResponse({ promotions: [] });
    }
    if (url.includes("/api/adaptation/weights")) {
      return jsonResponse({
        weights: { iron_condor: 1.2, cash_secured_put: 0.8 },
        evaluation: {
          generatedAt: "2026-10-23T04:00:00.000Z",
          unweightedWinRate: 0.5,
          weightedWinRate: 0.57,
          proposals: [],
          lowSample: ["cash_secured_put"],
        },
      });
    }
    if (url.includes("/api/screening/goals/decide")) {
      return jsonResponse({ success: true, goal: { ...proposedGoal, status: body?.decision === "activate" ? "active" : "archived", scenarios: undefined } });
    }
    if (url.includes("/api/screening/goals")) {
      return jsonResponse({ goals: [proposedGoal] });
    }
    if (url.includes("/api/screening/reselection-proposals")) {
      return jsonResponse({ proposals: [reselection] });
    }
    if (url.includes("/api/screening/outcomes")) {
      return jsonResponse({
        outcomes: [
          {
            recommendationRef: "rec-verified",
            status: "expired",
            quality: "verified",
            provenance: { screenRunRef: "run-1", goalId: "goal-1", scenarioId: null, weightsVersion: 3, evalSetVersion: "v2", expiryDate: "2026-11-01" },
            pnlAfterCost: 12.5,
            trackedAt: "2026-10-20T00:00:00.000Z",
            terminalAt: "2026-10-22T00:00:00.000Z",
          },
          {
            recommendationRef: "rec-unverified",
            status: "expired",
            quality: "unverified",
            provenance: { screenRunRef: null, goalId: null, scenarioId: null, weightsVersion: null, evalSetVersion: null, expiryDate: null },
            pnlAfterCost: null,
            trackedAt: "2026-10-20T00:00:00.000Z",
            terminalAt: "2026-10-22T00:00:00.000Z",
          },
        ],
      });
    }
    return jsonResponse({}, 500);
  });
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(btn, `button containing "${text}"`).toBeTruthy();
  return btn as HTMLButtonElement;
}

async function click(container: HTMLElement, text: string) {
  const btn = buttonByText(container, text);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

/* ------------------------------------------------------------------ */
/* Nav collapse                                                        */
/* ------------------------------------------------------------------ */

describe("C2 nav collapse", () => {
  it("NAVIGATION_ITEMS carries exactly one screening entry — the Screening hub", () => {
    const screeningIds = ["screeners", "scanner", "options", "reports", "schedules"];
    const present = NAVIGATION_ITEMS.filter((i) => screeningIds.includes(i.id)).map((i) => i.id);
    expect(present).toEqual(["screeners"]);
    const entry = NAVIGATION_ITEMS.find((i) => i.id === "screeners")!;
    expect(entry.label).toBe("Screening");
  });

  it("legacy screening tab ids still read as active on the one entry (deep links)", () => {
    for (const legacy of ["scanner", "options", "reports", "schedules", "screeners"] as const) {
      expect(isTabActive("screeners", legacy)).toBe(true);
    }
    expect(isTabActive("screeners", "portfolio")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Source pins                                                         */
/* ------------------------------------------------------------------ */

describe("C2 source pins", () => {
  it("the Trading Hub renders the hub directly for its screening subtabs — no moved notices", () => {
    const tradingHub = readSrc("client/ETradeTradingHub.tsx");
    expect(tradingHub).not.toContain("ScreeningMovedNotice");
    expect(tradingHub).not.toContain("Screening Moved to the Screeners Hub");
    for (const tab of ["options", "scanner", "iv-history", "reports", "schedules"]) {
      expect(tradingHub).toContain(`renderScreenersHub("${tab}")`);
    }
    // Reports/Schedules are hosted by the hub now, not mounted here.
    expect(tradingHub).not.toContain("<ReportsPanel");
    expect(tradingHub).not.toContain("<SchedulesPanel");
  });

  it("the hub hosts reports, schedules, the review inbox, and the track record", () => {
    const hub = readSrc("client/ScreenersHub.tsx");
    expect(hub).toContain("<ReportsPanel");
    expect(hub).toContain("<SchedulesPanel");
    expect(hub).toContain("<ScreeningReviewPanel");
    expect(hub).toContain("<ScreeningOutcomesPanel");
    for (const tab of ['"reports"', '"schedules"', '"review"', '"track-record"']) {
      expect(hub).toContain(tab);
    }
  });

  it("discovery stays server-driven: panel imports from the local engine are modeling-only", () => {
    const panel = readSrc("client/options/StrategyDiscoveryPanel.tsx");
    expect(panel).toContain("fetchServerDiscovery");
    const importBlock = panel.match(/import\s*\{([\s\S]*?)\}\s*from\s*"\.\/strategyDiscoveryEngine"/);
    expect(importBlock, "the panel imports the modeling engine").toBeTruthy();
    const names = importBlock![1]
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    const modelingOnly = new Set([
      // Builder modeling (payoff / greeks / strike & expiry editing)
      "generateExpirations",
      "generateStrikeLadder",
      "evaluateStrategyPnL",
      "getOptimizationFactors",
      "updateLegStrike",
      "updateLegsExpiration",
      "analyzeStrategy",
      "calculateNetGreeks",
      "calculateRealizedAndUnrealizedPnl",
      "evaluate2dPayoffMatrix",
      "shiftAllStrikes",
      "shiftSymmetricStrikes",
      // Types
      "DiscoveredStrategy",
      "ExpirationOption",
      "SentimentType",
      "StrategyLegItem",
      "StrategyDiscoveryConfig",
      "NetOptionGreeks",
      "RealizedUnrealizedPnl",
    ]);
    for (const name of names) {
      expect(modelingOnly.has(name), `"${name}" must be a modeling-only import`).toBe(true);
    }
  });

  it("one exporter module: optionsDataExporter.tsx is gone, its functions live in runExport.ts", () => {
    expect(fs.existsSync(path.join(SRC, "client/options/optionsDataExporter.tsx"))).toBe(false);
    const runExport = readSrc("client/runExport.ts");
    expect(runExport).toContain("export async function fetchOptionsDataForExport");
    expect(runExport).toContain("export function buildExportInput");
    expect(runExport).toContain("export async function downloadRawOptionsData");
    expect(runExport).toContain("export async function downloadNormalizedOptionsData");
    expect(runExport).toContain("export async function downloadBothOptionsData");
    const dropdown = readSrc("client/options/OptionsDataDownloadDropdown.tsx");
    expect(dropdown).toContain("OptionsDataDownloadDropdown");
    expect(dropdown).toContain('from "../runExport"');
    for (const importer of [
      "client/ETradeDynamicMenu.tsx",
      "client/options/OptionsResearchPanel.tsx",
      "client/options/RawContractsScreener.tsx",
      "client/options/StrategyDiscoveryPanel.tsx",
    ]) {
      expect(readSrc(importer)).not.toContain("optionsDataExporter");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Render pins                                                         */
/* ------------------------------------------------------------------ */

describe("C2 hub + panels (render)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<{ method: string; url: string; body: any }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", stubFetch(calls));
    Element.prototype.scrollIntoView = vi.fn() as any;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("the hub's tab bar carries Reports, Schedules, Review, and Track Record", async () => {
    await act(async () => {
      root.render(<ScreenersHub activeEnv="PROD" userLogin="alice" />);
    });
    await flush();
    for (const label of ["Reports", "Schedules", "Review", "Track Record"]) {
      expect(container.textContent).toContain(label);
    }
  });

  it("the Trading Hub renders the hub itself for the folded options subtab — no notice", async () => {
    await act(async () => {
      root.render(<ETradeTradingHub activeSubTab="options" user={{ login: "alice" }} />);
    });
    await flush();
    expect(container.textContent).not.toContain("Screening Moved to the Screeners Hub");
    expect(container.textContent).toContain("Strategy Discovery & Payoff Analyzer");
  });

  it("the hub opens on the Review tab via initialTab", async () => {
    await act(async () => {
      root.render(<ScreenersHub activeEnv="PROD" userLogin="alice" initialTab="review" />);
    });
    await flush();
    expect(container.textContent).toContain("Proposal Review");
    expect(container.textContent).toContain("Covered-call income on SPY");
  });

  it("the review inbox shows candidates, goals, read-only re-selections, and weights", async () => {
    await act(async () => {
      root.render(<ScreeningReviewPanel userLogin="alice" />);
    });
    await flush();
    // Adaptation candidate with its hypothesis.
    expect(container.textContent).toContain("Gate off iron_condor below a 25% win rate");
    expect(container.textContent).toContain("Iron condor underperforms in the current regime.");
    // Goal proposal with its scenario.
    expect(container.textContent).toContain("Covered-call income on SPY");
    expect(container.textContent).toContain("Activate goal");
    // Re-selection proposal: rendered, labeled proposal-only, no action buttons in its section.
    expect(container.textContent).toContain("proposal only");
    const reselectionSection = [...container.querySelectorAll("section, div")].find((el) =>
      el.textContent?.includes("Strategy-bank re-selection"),
    );
    expect(reselectionSection!.textContent).toContain("iron_condor");
    // Weights summary.
    expect(container.textContent).toContain("iron_condor");
  });

  it("the candidate flow drives the existing endpoints: request approval → decide", async () => {
    await act(async () => {
      root.render(<ScreeningReviewPanel userLogin="alice" />);
    });
    await flush();
    await click(container, "Review candidate");
    // The gate verdict (frozen evidence) is visible beside the decision controls.
    expect(container.textContent).toContain("held-out edge significant");
    await click(container, "Request approval");
    const approveCall = calls.find((c) => c.url.includes("/api/adaptation/candidates/approve") && !c.url.includes("decide"));
    expect(approveCall?.method).toBe("POST");
    expect(approveCall?.body).toEqual({ candidateId: "cand-1" });
    await click(container, "Approve");
    const decideCall = calls.find((c) => c.url.includes("/api/adaptation/candidates/approve/decide"));
    expect(decideCall?.method).toBe("POST");
    expect(decideCall?.body).toEqual({ approvalId: "appr-1", decision: "approved" });
  });

  it("a goal decision posts to the goal decide route", async () => {
    await act(async () => {
      root.render(<ScreeningReviewPanel userLogin="alice" />);
    });
    await flush();
    await click(container, "Activate goal");
    const decide = calls.find((c) => c.url.includes("/api/screening/goals/decide"));
    expect(decide?.method).toBe("POST");
    expect(decide?.body).toEqual({ id: "goal-1", decision: "activate" });
  });

  it("the track record renders verified and Unverified outcomes honestly", async () => {
    await act(async () => {
      root.render(<ScreeningOutcomesPanel userLogin="alice" />);
    });
    await flush();
    expect(container.textContent).toContain("Recommendation Track Record");
    expect(container.textContent).toContain("rec-verified");
    expect(container.textContent).toContain("12.50");
    expect(container.textContent).toContain("rec-unverified");
    expect(container.textContent).toContain("Unverified");
    expect(container.textContent).toContain("Not recorded");
  });
});
