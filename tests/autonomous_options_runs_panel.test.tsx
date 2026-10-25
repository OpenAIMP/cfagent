/** @vitest-environment jsdom */
/**
 * Issue #223: the Options Research panel's schedules view surfaces the
 * autonomous options runs persisted by the scheduler (GET /api/options/latest):
 * what ran, when, whether it succeeded, and its top opportunities — with an
 * honest empty state before the first run lands.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { AutonomousOptionsRuns } from "../src/client/options/AutonomousOptionsRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RUNS = [
  {
    timestamp: "2026-10-20T17:00:00.000Z",
    success: true,
    trigger: "scheduled",
    thesis: "bullish",
    symbols: ["AAPL", "NVDA"],
    withTrades: 1,
    summary: "1 of 2 symbols produced trade candidates.",
    opportunities: [
      { symbol: "NVDA", pick: { best: { candidate: { type: "long_call" } } }, directionTags: ["bullish"] },
    ],
  },
  {
    timestamp: "2026-10-20T16:00:00.000Z",
    success: false,
    trigger: "manual",
    thesis: "bearish",
    symbols: ["ZZZZ"],
    withTrades: 0,
    summary: "",
    opportunities: [],
    error: "Chain load failed for ZZZZ",
  },
];

function stubFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }))
  );
}

async function renderRuns() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AutonomousOptionsRuns />);
  });
  return { container, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("AutonomousOptionsRuns (#223)", () => {
  it("renders persisted runs: status, trigger, thesis, summary, opportunities", async () => {
    stubFetch({ count: 2, runs: RUNS, timestamp: "2026-10-20T17:05:00.000Z" });
    const { container, root } = await renderRuns();
    const text = container.textContent || "";
    expect(text).toContain("Autonomous Options Runs");
    expect(text).toContain("Completed");
    expect(text).toContain("Failed");
    expect(text).toContain("Scheduled");
    expect(text).toContain("Manual");
    expect(text).toContain("1 of 2 symbols produced trade candidates.");
    expect(text).toContain("NVDA");
    expect(text).toContain("long_call");
    expect(text).toContain("Chain load failed for ZZZZ");
    await act(async () => root.unmount());
  });

  it("shows an honest empty state when no runs are persisted yet", async () => {
    stubFetch({ count: 0, runs: [], timestamp: "2026-10-20T17:05:00.000Z" });
    const { container, root } = await renderRuns();
    expect(container.textContent).toContain("No autonomous options runs yet");
    await act(async () => root.unmount());
  });
});
