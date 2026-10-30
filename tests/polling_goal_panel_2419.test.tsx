/** @vitest-environment jsdom */
/**
 * Issue #2419 — GoalScreenPanel staged-run tracking loop.
 *
 * The loop is bounded (2s cadence, 10-minute absolute deadline, stops
 * on terminal state), so it does not fit usePolling's indefinite
 * shape; instead it takes the shared treatment's material properties:
 * no status fetch while the tab is hidden, and cadence + deadline
 * from the externalized polling config. Harness follows
 * tests/goal_screen_panel_persist_2129.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  GoalScreenPanel,
  GOAL_TRACKING_KEY,
  persistGoalTracking,
} from "../src/client/GoalScreenPanel";
import {
  resetAutoRefreshCacheForTests,
  setAutoRefresh,
} from "../src/client/autoRefresh";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS_URL = "/api/jobs/history?chainId=job-1";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("GoalScreenPanel tracking loop (#2419)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let statusCalls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
    statusCalls = [];
    sessionStorage.clear();
    // Issue #2481: the tracking loop is gated by the global
    // auto-refresh switch; this #2419 pin covers ON behaviour.
    resetAutoRefreshCacheForTests();
    setAutoRefresh(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/jobs/history")) {
          statusCalls.push(url);
          // Running, never terminal: the loop keeps polling.
          return {
            ok: true,
            status: 200,
            json: async () => ({
              chainId: "job-1",
              jobs: [{ stage: "analysis", status: "running", detail: "", updatedAtMs: 1000 }],
            }),
          };
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
    vi.unstubAllGlobals();
    sessionStorage.clear();
    resetAutoRefreshCacheForTests();
    setVisibility("visible");
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("skips status fetches while hidden and resumes on visible", async () => {
    persistGoalTracking({ jobId: "job-1", statusUrl: STATUS_URL, startedAtMs: Date.now() });
    expect(sessionStorage.getItem(GOAL_TRACKING_KEY)).not.toBeNull();
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(statusCalls.length).toBe(1);
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(statusCalls.length).toBe(1);
    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(statusCalls.length).toBe(2);
  });
});
