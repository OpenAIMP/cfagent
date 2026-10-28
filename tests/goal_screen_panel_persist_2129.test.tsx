/** @vitest-environment jsdom */
/**
 * Issue #2129 — a staged goal run that vanishes (parent died before
 * announce) left the panel with nothing: no persistence, no resume,
 * no latest result on mount. The panel must persist its tracking
 * handle in sessionStorage, resume it on mount (with the ORIGINAL
 * submit deadline), and otherwise show the newest stored goal run
 * as the previous result.
 *
 * Harness follows consolidation_c1_goal_screen_panel.test.tsx:
 * the REAL apiFetch / global fetch is driven against a stubbed
 * global fetch, and the component renders with react-dom/client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  GoalScreenPanel,
  GOAL_TRACKING_KEY,
  loadGoalTracking,
  persistGoalTracking,
  clearGoalTracking,
} from "../src/client/GoalScreenPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const goalResult = {
  goalKind: "income",
  outlook: "bullish",
  status: "complete",
  hits: [
    { assetClass: "stocks", providerId: "etrade-yahoo-stocks", symbol: "AAPL" },
  ],
  counts: { stocksScanned: 100, stocksMatched: 1, optionsUnderlyingsScanned: 0, optionsContractsMatched: 0, hits: 1 },
  completedAt: "2026-10-28T12:00:00.000Z",
};

const STATUS_URL = "/api/jobs/history?chainId=job-1";

function shardRow(reportId: string) {
  return {
    stage: "analysis",
    status: "completed",
    detail: "Goal screen stored",
    updatedAtMs: 1000,
    resultJson: JSON.stringify({ shardJobIds: ["job-1"], result: { stored: true, reportId } }),
  };
}

describe("GoalScreenPanel persistence + resume (#2129)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/api/jobs/history")) {
          return { ok: true, status: 200, json: async () => ({ chainId: "job-1", jobs: [shardRow("rep-1")] }) };
        }
        if (url.includes("/api/reports/rep-1")) {
          return { ok: true, status: 200, json: async () => ({ body: { result: goalResult } }) };
        }
        if (url.includes("/api/runs")) {
          return { ok: true, status: 200, json: async () => ({ runs: [] }) };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );
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
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it("persists, loads, and clears a tracking handle (helpers)", () => {
    expect(loadGoalTracking()).toBeNull();
    persistGoalTracking({ jobId: "job-1", statusUrl: STATUS_URL, startedAtMs: 123 });
    expect(loadGoalTracking()).toEqual({ jobId: "job-1", statusUrl: STATUS_URL, startedAtMs: 123 });
    // Clearing another job's handle must not remove this one.
    clearGoalTracking("job-2");
    expect(loadGoalTracking()).not.toBeNull();
    clearGoalTracking("job-1");
    expect(loadGoalTracking()).toBeNull();
  });

  it("resumes a seeded handle on mount, shows the stored result, and clears the handle", async () => {
    vi.useFakeTimers();
    persistGoalTracking({ jobId: "job-1", statusUrl: STATUS_URL, startedAtMs: Date.now() });
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(calls).toContain(STATUS_URL);
    expect(calls).not.toContain("/api/runs?kind=all&limit=100");
    expect(container.textContent).toContain("Complete — income (bullish)");
    expect(sessionStorage.getItem(GOAL_TRACKING_KEY)).toBeNull();
  });

  it("a stale handle past its deadline never polls and is cleared", async () => {
    vi.useFakeTimers();
    persistGoalTracking({ jobId: "job-1", statusUrl: STATUS_URL, startedAtMs: Date.now() - 11 * 60 * 1000 });
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).not.toContain(STATUS_URL);
    expect(sessionStorage.getItem(GOAL_TRACKING_KEY)).toBeNull();
  });

  it("with no handle, shows the newest stored goal run as the previous result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/api/runs")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              runs: [
                { id: "rep-1", runId: "goal-screen:manual:x:income:2026-10-28T12:00:00.000Z", source: "goal_screen", title: "Goal screen", summary: "", createdAt: "2026-10-28T12:00:00.000Z" },
                { id: "opt-1", runId: "options:1", source: "options_scanner", title: "Options", summary: "", createdAt: "2026-10-28T11:00:00.000Z" },
              ],
            }),
          };
        }
        if (url.includes("/api/reports/rep-1")) {
          return { ok: true, status: 200, json: async () => ({ body: { result: goalResult } }) };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(calls).toContain("/api/runs?kind=all&limit=100");
    expect(calls).toContain("/api/reports/rep-1");
    expect(calls).not.toContain("/api/reports/opt-1");
    expect(container.textContent).toContain("Complete — income (bullish)");
  });

  it("with no handle and no stored goal runs, renders a bare form with no error", async () => {
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.textContent).not.toContain("Complete —");
  });
});
