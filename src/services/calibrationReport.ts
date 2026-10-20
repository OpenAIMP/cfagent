/**
 * Calibration reporting (issue #17).
 *
 * Backtests inference rules against persisted run history: per thesis/rule,
 * how often the inferred direction matched the subsequent realized move.
 *
 * Calibration is measurement, never marketing: it reports hit rates and
 * sample sizes, and never silently changes thresholds.
 */

export interface EvaluatedIdea {
  thesis: string;
  /** The inferred direction at idea time. */
  predictedDirection: "up" | "down" | "flat";
  /** The realized direction over the setup horizon (null = not yet known). */
  realizedDirection: "up" | "down" | "flat" | null;
}

export interface ThesisCalibration {
  thesis: string;
  /** Ideas with a known realized direction. */
  evaluated: number;
  /** Of evaluated, how many matched. */
  hits: number;
  /** hits / evaluated, null when evaluated is 0. */
  hitRate: number | null;
}

export interface CalibrationReport {
  generatedAt: string;
  totalEvaluated: number;
  byThesis: ThesisCalibration[];
  /** Theses with fewer than this many evaluated ideas are flagged low-sample. */
  lowSampleThreshold: number;
  lowSampleTheses: string[];
}

const LOW_SAMPLE_THRESHOLD = 20;

export function buildCalibrationReport(ideas: EvaluatedIdea[]): CalibrationReport {
  const byThesis = new Map<string, { evaluated: number; hits: number }>();
  for (const idea of ideas) {
    if (!idea.realizedDirection) continue;
    const entry = byThesis.get(idea.thesis) ?? { evaluated: 0, hits: 0 };
    entry.evaluated += 1;
    if (idea.predictedDirection === idea.realizedDirection) entry.hits += 1;
    byThesis.set(idea.thesis, entry);
  }

  const calibrations: ThesisCalibration[] = [...byThesis.entries()].map(
    ([thesis, { evaluated, hits }]) => ({
      thesis,
      evaluated,
      hits,
      hitRate: evaluated > 0 ? hits / evaluated : null,
    })
  );
  calibrations.sort((a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1));

  const lowSampleTheses = calibrations
    .filter((c) => c.evaluated < LOW_SAMPLE_THRESHOLD)
    .map((c) => c.thesis);

  return {
    generatedAt: new Date().toISOString(),
    totalEvaluated: calibrations.reduce((n, c) => n + c.evaluated, 0),
    byThesis: calibrations,
    lowSampleThreshold: LOW_SAMPLE_THRESHOLD,
    lowSampleTheses,
  };
}
