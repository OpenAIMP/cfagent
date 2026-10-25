import { describe, it, expect } from "vitest";
import { buildCalibrationReport } from "../src/services/calibrationReport";

/**
 * #17: calibration reporting.
 */

describe("#17 calibration report", () => {
  it("computes per-thesis hit rates", () => {
    const report = buildCalibrationReport([
      { thesis: "bullish", predictedDirection: "up", realizedDirection: "up" },
      { thesis: "bullish", predictedDirection: "up", realizedDirection: "down" },
      { thesis: "bearish", predictedDirection: "down", realizedDirection: "down" },
      { thesis: "bearish", predictedDirection: "down", realizedDirection: null },
    ]);
    expect(report.totalEvaluated).toBe(3);
    const bullish = report.byThesis.find((c) => c.thesis === "bullish")!;
    expect(bullish.hitRate).toBe(0.5);
    const bearish = report.byThesis.find((c) => c.thesis === "bearish")!;
    expect(bearish.hitRate).toBe(1);
  });

  it("skips ideas without a realized direction", () => {
    const report = buildCalibrationReport([
      { thesis: "bullish", predictedDirection: "up", realizedDirection: null },
    ]);
    expect(report.totalEvaluated).toBe(0);
    expect(report.byThesis).toEqual([]);
  });

  it("flags low-sample theses", () => {
    const report = buildCalibrationReport([
      { thesis: "bullish", predictedDirection: "up", realizedDirection: "up" },
    ]);
    expect(report.lowSampleTheses).toContain("bullish");
  });
});
