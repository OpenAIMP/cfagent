/**
 * Issue #654: buildCalibrationFromTrackRecord — the #340 track record
 * mapped to the calibration dashboard shape.
 *
 * - Only a scored direction counts as evaluated; a null evaluation and
 *   a null directionCorrect both count as pending, never as misses.
 * - Thesis, strategy (structure), regime, and month buckets all count
 *   the same evaluated set; thesis/strategy/regime sort by hit rate
 *   desc, months sort chronologically.
 * - Low-sample flags use the shared threshold (20), and the overall
 *   hit rate is null when nothing is evaluated.
 */
import { describe, it, expect } from "vitest";
import { buildCalibrationFromTrackRecord } from "../src/services/calibrationReport";

const IDEA = (over: Record<string, unknown>) => ({
  thesis: "bullish",
  structure: "bull_put_spread",
  regime: "bull",
  evaluation: { directionCorrect: true, evaluatedAt: "2026-10-05T12:00:00.000Z" },
  ...over,
});

describe("Issue #654 — buildCalibrationFromTrackRecord", () => {
  it("buckets one evaluated set four ways, with hits and hit rates", () => {
    const report = buildCalibrationFromTrackRecord([
      IDEA({}),
      IDEA({ evaluation: { directionCorrect: false, evaluatedAt: "2026-10-06T12:00:00.000Z" } }),
      IDEA({ thesis: "bearish", structure: "bear_call_spread", regime: "bear" }),
    ]);
    expect(report.totalEvaluated).toBe(3);
    expect(report.pending).toBe(0);
    expect(report.overallHitRate).toBeCloseTo(2 / 3);
    expect(report.byThesis).toEqual([
      { thesis: "bearish", evaluated: 1, hits: 1, hitRate: 1 },
      { thesis: "bullish", evaluated: 2, hits: 1, hitRate: 0.5 },
    ]);
    expect(report.byStrategy).toEqual([
      { key: "bear_call_spread", evaluated: 1, hits: 1, hitRate: 1 },
      { key: "bull_put_spread", evaluated: 2, hits: 1, hitRate: 0.5 },
    ]);
    expect(report.byRegime).toEqual([
      { key: "bear", evaluated: 1, hits: 1, hitRate: 1 },
      { key: "bull", evaluated: 2, hits: 1, hitRate: 0.5 },
    ]);
    expect(report.byMonth).toEqual([
      { key: "2026-10", evaluated: 3, hits: 2, hitRate: 2 / 3 },
    ]);
  });

  it("unscored ideas are pending, never misses, and months sort chronologically", () => {
    const report = buildCalibrationFromTrackRecord([
      IDEA({ evaluation: null }),
      IDEA({ evaluation: { directionCorrect: null, evaluatedAt: "2026-09-01T12:00:00.000Z" } }),
      IDEA({ evaluation: { directionCorrect: true, evaluatedAt: "2026-10-01T12:00:00.000Z" } }),
      IDEA({ evaluation: { directionCorrect: false, evaluatedAt: "2026-09-15T12:00:00.000Z" } }),
    ]);
    expect(report.totalEvaluated).toBe(2);
    expect(report.pending).toBe(2);
    expect(report.overallHitRate).toBe(0.5);
    expect(report.byMonth.map((m) => m.key)).toEqual(["2026-09", "2026-10"]);
    expect(report.byThesis).toEqual([
      { thesis: "bullish", evaluated: 2, hits: 1, hitRate: 0.5 },
    ]);
  });

  it("low-sample flags use the shared threshold and empty input stays honest", () => {
    const report = buildCalibrationFromTrackRecord([
      IDEA({ thesis: "rare", evaluation: { directionCorrect: true, evaluatedAt: "2026-10-01T12:00:00.000Z" } }),
    ]);
    expect(report.lowSampleThreshold).toBe(20);
    expect(report.lowSampleTheses).toEqual(["rare"]);
    const empty = buildCalibrationFromTrackRecord([]);
    expect(empty.totalEvaluated).toBe(0);
    expect(empty.pending).toBe(0);
    expect(empty.overallHitRate).toBeNull();
    expect(empty.byThesis).toEqual([]);
    expect(empty.byMonth).toEqual([]);
  });
});
