/**
 * Issue #340: track-record builder — published ideas joined to their
 * latest evaluations, with hit rate, R multiples, and by-strategy /
 * by-period slices. No retrospective edits: unevaluated ideas stay
 * visible with a null outcome.
 */
import { describe, it, expect } from "vitest";
import { buildTrackRecord } from "../src/services/researchTrackRecord";

const REPORT = {
  runId: "run-1",
  createdAt: "2026-09-15T12:00:00.000Z",
  rulesVersion: "v3",
  ideas: [
    {
      symbol: "AAPL", structure: "bull call spread", outlook: "bullish",
      thesis: "t1", invalidation: "inv1", entrySpot: 247,
      economics: { maxLoss: 5 },
    },
    {
      symbol: "MSFT", structure: "bull call spread", outlook: "bullish",
      thesis: "t2", invalidation: "inv2", entrySpot: 495,
      economics: { maxLoss: 4 },
    },
    {
      symbol: "NVDA", structure: "long call", outlook: "bullish",
      thesis: "t3", invalidation: "inv3", entrySpot: 180,
      economics: { maxLoss: 10 },
    },
  ],
};

const EVAL_OLD = {
  runId: "run-1",
  evaluatedAt: "2026-09-20T12:00:00.000Z",
  ideas: [
    { symbol: "AAPL", structure: "bull call spread", invalidated: false, pnlEstimatePerUnit: 2.5, evalSpot: 255, directionCorrect: true, notes: [] },
  ],
};

const EVAL_NEW = {
  runId: "run-1",
  evaluatedAt: "2026-10-01T12:00:00.000Z",
  ideas: [
    { symbol: "AAPL", structure: "bull call spread", invalidated: false, pnlEstimatePerUnit: 5, evalSpot: 260, directionCorrect: true, notes: ["held"] },
    { symbol: "MSFT", structure: "bull call spread", invalidated: true, pnlEstimatePerUnit: -4, evalSpot: 470, directionCorrect: false, notes: ["invalidated"] },
  ],
};

describe("buildTrackRecord", () => {
  it("joins published ideas to the LATEST evaluation and computes aggregates", () => {
    const tr = buildTrackRecord([REPORT], [EVAL_OLD, EVAL_NEW]);
    expect(tr.published).toBe(3);
    expect(tr.evaluated).toBe(2);
    expect(tr.invalidated).toBe(1);
    // AAPL: latest pnl 5 (not the older 2.5) → R = 5/5 = 1; MSFT: -4/4 = -1
    const aapl = tr.ideas.find((i) => i.symbol === "AAPL")!;
    expect(aapl.evaluation?.pnlEstimatePerUnit).toBe(5);
    expect(aapl.evaluation?.rMultiple).toBe(1);
    const msft = tr.ideas.find((i) => i.symbol === "MSFT")!;
    expect(msft.evaluation?.rMultiple).toBe(-1);
    expect(tr.winRate).toBe(0.5);
    expect(tr.directionAccuracy).toBe(0.5);
    expect(tr.avgPnlPerUnit).toBe(0.5);
    expect(tr.avgRMultiple).toBe(0);
  });

  it("keeps unevaluated ideas visible with a null outcome", () => {
    const tr = buildTrackRecord([REPORT], [EVAL_NEW]);
    const nvda = tr.ideas.find((i) => i.symbol === "NVDA")!;
    expect(nvda.evaluation).toBeNull();
    expect(tr.published).toBe(3);
  });

  it("slices by strategy and by period", () => {
    const tr = buildTrackRecord([REPORT], [EVAL_NEW]);
    const spreads = tr.byStrategy.find((s) => s.key === "bull call spread")!;
    expect(spreads.published).toBe(2);
    expect(spreads.evaluated).toBe(2);
    expect(spreads.winRate).toBe(0.5);
    const sept = tr.byPeriod.find((s) => s.key === "2026-09")!;
    expect(sept.published).toBe(3);
  });

  it("tolerates malformed inputs", () => {
    const tr = buildTrackRecord([null, { runId: "x" }, REPORT], [null, { ideas: [] }]);
    expect(tr.published).toBe(3);
    expect(tr.evaluated).toBe(0);
    expect(tr.winRate).toBeNull();
  });
});
