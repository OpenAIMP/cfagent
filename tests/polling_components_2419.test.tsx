/** @vitest-environment jsdom */
/**
 * Issue #2419 — component polling migration.
 *
 * AutonomousOptionsRuns gets a runtime test (render + fake timers +
 * visibility flips). The fetch-heavy hubs (OptionsFlowsHub,
 * ScheduledOptionsManager, Chat) are pinned at the source level, the
 * same way tests/options_flows_tab_wiring_2027.test.ts pins wiring
 * for a hub that is too fetch-heavy for a cheap render test.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { AutonomousOptionsRuns } from "../src/client/options/AutonomousOptionsRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("AutonomousOptionsRuns polling migration (#2419)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchCalls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        fetchCalls.push(String(input));
        return {
          ok: true,
          status: 200,
          json: async () => ({ runs: [] }),
          text: async () => JSON.stringify({ runs: [] }),
        };
      }),
    );
    (window as any).__POLLING_CONFIG__ = { optionsLatestPollMs: 1000 };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    delete (window as any).__POLLING_CONFIG__;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("polls at the injected cadence and pauses while hidden", async () => {
    await act(async () => {
      root.render(<AutonomousOptionsRuns />);
    });
    expect(fetchCalls.length).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchCalls.length).toBe(2);
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchCalls.length).toBe(2);
    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchCalls.length).toBe(3);
  });
});

describe("heavy-hub polling wiring (#2419)", () => {
  it("OptionsFlowsHub polls through usePolling with an externalized cadence", () => {
    const src = readFileSync("src/client/options/flows/OptionsFlowsHub.tsx", "utf8");
    expect(src).toContain('from "../../usePolling"');
    expect(src).toContain("usePolling(() => fetchLiveFlows(filterConfig)");
    expect(src).toContain("getPollingConfig().optionsFlowsPollMs");
    expect(src).not.toContain("setInterval(");
  });

  it("ScheduledOptionsManager polls through usePolling with an externalized cadence", () => {
    const src = readFileSync("src/client/ScheduledOptionsManager.tsx", "utf8");
    expect(src).toContain('from "./usePolling"');
    expect(src).toContain("usePolling(fetchLatestRuns");
    expect(src).toContain("getPollingConfig().optionsLatestPollMs");
    expect(src).not.toContain("setInterval(fetchLatestRuns");
  });

  it("Chat auto-refresh uses the shared treatment with an externalized floor", () => {
    const src = readFileSync("src/client/Chat.tsx", "utf8");
    expect(src).toContain('from "./polling"');
    expect(src).toContain("startPolling(handleGlobalRefresh");
    expect(src).toContain("getPollingConfig().chatAutoRefreshFloorS");
    expect(src).not.toContain("Math.max(5, autoRefreshInterval)");
  });
});
