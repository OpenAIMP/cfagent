/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — TDD red-first.
 *
 * Pins the pure projector rules: the (symbol, structure)
 * join, the falsifiability rule (unscored and
 * non-directional ideas are never misses), the direction
 * rule (realized = predicted when correct, else opposite),
 * and the timestamp rule (unparseable times skip the row).
 * Also pins the calibration dashboard regression: the
 * dashboard's outputs for fixed inputs are unchanged by
 * this slice (it is never modified here).
 */
import { describe, it, expect } from "vitest";
import {
  projectEvaluationRealizations,
  realizationsFromEvaluation,
  realizationsFromTrackRecord,
} from "../src/telemetry/telemetryProjection";
import { InMemoryTelemetryAdapter } from "../src/telemetry/inMemoryTelemetryAdapter";
import { buildCalibrationFromTrackRecord } from "../src/services/calibrationReport";

describe("telemetry projection (#1742)", () => {
  it("joins evaluation ideas to report ideas on (symbol, structure)", () => {
    const rows = realizationsFromEvaluation(
      {
        runId: "run-9",
        regime: "high-iv",
        ideas: [
          { symbol: "NVDA", structure: "iron-condor", thesis: "condor-bias", outlook: "bullish", economics: { maxLoss: 100 } },
          { symbol: "AAPL", structure: "spread", thesis: "spread-bias", outlook: "bearish" },
        ],
      },
      {
        evaluatedAt: "2025-10-10T00:00:00.000Z",
        ideas: [
          { symbol: "NVDA", structure: "iron-condor", directionCorrect: false, pnlEstimatePerUnit: -50 },
          { symbol: "AAPL", structure: "spread", directionCorrect: true, pnlEstimatePerUnit: 80 },
          { symbol: "MSFT", structure: "spread", directionCorrect: false },
        ],
      },
      "primary",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      outcomeId: "run-9:NVDA:iron-condor",
      thesis: "condor-bias",
      predictedDirection: "up",
      realizedDirection: "down",
      directionCorrect: false,
      falsified: true,
      regime: "high-iv",
      rMultiple: -0.5,
    });
    expect(rows[1]).toMatchObject({
      outcomeId: "run-9:AAPL:spread",
      predictedDirection: "down",
      realizedDirection: "down",
      directionCorrect: true,
      falsified: false,
    });
  });

  it("skips unscored, non-directional, unmatched, and unparseable-time ideas — never as misses", () => {
    const rows = realizationsFromEvaluation(
      {
        runId: "run-10",
        ideas: [
          { symbol: "NVDA", structure: "iron-condor", thesis: "t1", outlook: "bullish" },
          { symbol: "AAPL", structure: "spread", thesis: "t2", outlook: "neutral" },
          { symbol: "MSFT", structure: "spread", thesis: "t3", outlook: "bearish" },
        ],
      },
      {
        evaluatedAt: "2025-10-10T00:00:00.000Z",
        ideas: [
          { symbol: "NVDA", structure: "iron-condor", directionCorrect: null },
          { symbol: "AAPL", structure: "spread", directionCorrect: false },
        ],
      },
      "primary",
    );
    // NVDA unscored → skipped; AAPL non-directional → skipped; MSFT unmatched → skipped.
    expect(rows).toEqual([]);
    // Unparseable evaluatedAt skips everything.
    expect(
      realizationsFromEvaluation(
        { runId: "run-11", ideas: [{ symbol: "NVDA", structure: "iron-condor", thesis: "t1", outlook: "bullish" }] },
        { evaluatedAt: "not-a-date", ideas: [{ symbol: "NVDA", structure: "iron-condor", directionCorrect: true }] },
        "primary",
      ),
    ).toEqual([]);
  });

  it("maps track-record ideas directly (reconcile import path)", () => {
    const rows = realizationsFromTrackRecord(
      [
        {
          runId: "run-1",
          symbol: "NVDA",
          structure: "iron-condor",
          thesis: "condor-bias",
          outlook: "bullish",
          regime: "high-iv",
          evaluation: { directionCorrect: false, evaluatedAt: "2025-10-10T00:00:00.000Z", pnlEstimatePerUnit: -40, rMultiple: -0.4 },
        },
        {
          runId: "run-2",
          symbol: "AAPL",
          structure: "spread",
          thesis: "spread-bias",
          outlook: "bearish",
          regime: "low-iv",
          evaluation: null,
        },
      ],
      "primary",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcomeId: "run-1:NVDA:iron-condor",
      predictedDirection: "up",
      realizedDirection: "down",
      falsified: true,
      rMultiple: -0.4,
    });
  });

  it("projectEvaluationRealizations records idempotently through a store", async () => {
    const store = new InMemoryTelemetryAdapter();
    const report = {
      runId: "run-9",
      regime: "high-iv",
      ideas: [
        { symbol: "NVDA", structure: "iron-condor", thesis: "condor-bias", outlook: "bullish" },
      ],
    };
    const evaluation = {
      evaluatedAt: "2025-10-10T00:00:00.000Z",
      ideas: [{ symbol: "NVDA", structure: "iron-condor", directionCorrect: false }],
    };
    expect(await projectEvaluationRealizations(store, report, evaluation, "primary")).toEqual({
      recorded: 1,
      duplicates: 0,
    });
    expect(await projectEvaluationRealizations(store, report, evaluation, "primary")).toEqual({
      recorded: 0,
      duplicates: 1,
    });
    expect((await store.queryRealizations("primary", {}))[0]).toMatchObject({
      outcomeId: "run-9:NVDA:iron-condor",
      falsified: true,
    });
  });

  it("dashboard regression: fixed inputs produce the same dashboard outputs", () => {
    const dashboard = buildCalibrationFromTrackRecord([
      {
        thesis: "condor-bias",
        structure: "iron-condor",
        regime: "high-iv",
        evaluation: { directionCorrect: true, evaluatedAt: "2025-10-05T00:00:00.000Z" },
      },
      {
        thesis: "condor-bias",
        structure: "iron-condor",
        regime: "high-iv",
        evaluation: { directionCorrect: false, evaluatedAt: "2025-10-06T00:00:00.000Z" },
      },
      {
        thesis: "spread-bias",
        structure: "spread",
        regime: "low-iv",
        evaluation: null,
      },
    ]);
    expect(dashboard.totalEvaluated).toBe(2);
    expect(dashboard.pending).toBe(1);
    expect(dashboard.overallHitRate).toBe(0.5);
    expect(dashboard.byThesis).toEqual([
      { thesis: "condor-bias", evaluated: 2, hits: 1, hitRate: 0.5 },
    ]);
    expect(dashboard.lowSampleThreshold).toBe(20);
    expect(dashboard.lowSampleTheses).toEqual(["condor-bias"]);
  });
});
