/** @vitest-environment jsdom */
/**
 * Issue #340: Track-record surface rendering — aggregates, slices, and
 * the published-vs-outcome table over the joined §9 records.
 */
import { describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TrackRecordView } from "../src/client/chat/tabs/ResearchTrackRecord";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = {
  published: 3,
  evaluated: 2,
  invalidated: 1,
  winRate: 0.5,
  directionAccuracy: 0.5,
  avgPnlPerUnit: 0.5,
  avgRMultiple: 0,
  byStrategy: [
    { key: "bull call spread", published: 2, evaluated: 2, winRate: 0.5, avgRMultiple: 0 },
    { key: "long call", published: 1, evaluated: 0, winRate: null, avgRMultiple: null },
  ],
  byPeriod: [
    { key: "2026-09", published: 3, evaluated: 2, winRate: 0.5, avgRMultiple: 0 },
  ],
  ideas: [
    {
      runId: "run-1", runCreatedAt: "2026-09-15T12:00:00.000Z", symbol: "AAPL",
      structure: "bull call spread", outlook: "bullish", thesis: "t", invalidation: "i",
      entrySpot: 247,
      evaluation: {
        evaluatedAt: "2026-10-01T12:00:00.000Z", invalidated: false,
        pnlEstimatePerUnit: 5, rMultiple: 1, evalSpot: 260, directionCorrect: true, notes: [],
      },
    },
    {
      runId: "run-1", runCreatedAt: "2026-09-15T12:00:00.000Z", symbol: "MSFT",
      structure: "bull call spread", outlook: "bullish", thesis: "t", invalidation: "i",
      entrySpot: 495,
      evaluation: {
        evaluatedAt: "2026-10-01T12:00:00.000Z", invalidated: true,
        pnlEstimatePerUnit: -4, rMultiple: -1, evalSpot: 470, directionCorrect: false, notes: [],
      },
    },
    {
      runId: "run-1", runCreatedAt: "2026-09-15T12:00:00.000Z", symbol: "NVDA",
      structure: "long call", outlook: "bullish", thesis: "t", invalidation: "i",
      entrySpot: 180, evaluation: null,
    },
  ],
};

describe("TrackRecordView", () => {
  it("renders aggregates, slices, and per-idea outcomes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<TrackRecordView data={DATA as any} />));
    const text = container.textContent || "";
    expect(text).toContain("Published: 3");
    expect(text).toContain("Win rate: 50%");
    expect(text).toContain("Direction accuracy: 50%");
    expect(text).toContain("bull call spread");
    expect(text).toContain("2026-09");
    expect(text).toContain("AAPL");
    expect(text).toContain("invalidated");
    expect(text).toContain("not evaluated");
    expect(text).toContain("+1.00R");
    act(() => root.unmount());
    container.remove();
  });
});
