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

/**
 * Issue #654: a track-record idea as the dashboard sees it — only the
 * fields calibration needs, so the mapper stays decoupled from the
 * #340 record shape. An idea counts as evaluated only when its latest
 * evaluation scored a direction (directionCorrect non-null); published
 * but unscored ideas count as pending, never as misses.
 */
export interface TrackRecordIdeaLike {
  thesis: string;
  structure: string;
  regime: string;
  evaluation: {
    directionCorrect: boolean | null;
    evaluatedAt: string;
  } | null;
}

export interface CalibrationSlice {
  key: string;
  evaluated: number;
  hits: number;
  hitRate: number | null;
}

export interface CalibrationDashboard extends CalibrationReport {
  /** Per-structure (strategy) direction accuracy. */
  byStrategy: CalibrationSlice[];
  /** Per-regime direction accuracy (recorded context, not a modifier). */
  byRegime: CalibrationSlice[];
  /** Hit rate by evaluation month (YYYY-MM), chronological — the curve. */
  byMonth: CalibrationSlice[];
  /** Published ideas with no scored direction yet. */
  pending: number;
  /** Overall hit rate across all evaluated ideas (null when none). */
  overallHitRate: number | null;
}

function toSlice(
  entries: Map<string, { evaluated: number; hits: number }>
): CalibrationSlice[] {
  return [...entries.entries()].map(([key, { evaluated, hits }]) => ({
    key,
    evaluated,
    hits,
    hitRate: evaluated > 0 ? hits / evaluated : null,
  }));
}

export function buildCalibrationFromTrackRecord(
  ideas: TrackRecordIdeaLike[]
): CalibrationDashboard {
  const byThesis = new Map<string, { evaluated: number; hits: number }>();
  const byStrategy = new Map<string, { evaluated: number; hits: number }>();
  const byRegime = new Map<string, { evaluated: number; hits: number }>();
  const byMonth = new Map<string, { evaluated: number; hits: number }>();
  let pending = 0;
  let totalHits = 0;
  let totalEvaluated = 0;

  const bucket = (
    map: Map<string, { evaluated: number; hits: number }>,
    key: string,
    hit: boolean
  ) => {
    const entry = map.get(key) ?? { evaluated: 0, hits: 0 };
    entry.evaluated += 1;
    if (hit) entry.hits += 1;
    map.set(key, entry);
  };

  for (const idea of ideas) {
    const scored = idea.evaluation?.directionCorrect;
    if (scored == null) {
      pending += 1;
      continue;
    }
    totalEvaluated += 1;
    if (scored) totalHits += 1;
    bucket(byThesis, idea.thesis, scored);
    bucket(byStrategy, idea.structure, scored);
    bucket(byRegime, idea.regime, scored);
    bucket(byMonth, idea.evaluation!.evaluatedAt.slice(0, 7), scored);
  }

  const thesisSlices = toSlice(byThesis).sort(
    (a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1)
  );
  const strategySlices = toSlice(byStrategy).sort(
    (a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1)
  );
  const regimeSlices = toSlice(byRegime).sort(
    (a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1)
  );
  const monthSlices = toSlice(byMonth).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  );

  return {
    generatedAt: new Date().toISOString(),
    totalEvaluated,
    byThesis: thesisSlices.map(({ key, evaluated, hits, hitRate }) => ({
      thesis: key,
      evaluated,
      hits,
      hitRate,
    })),
    lowSampleThreshold: LOW_SAMPLE_THRESHOLD,
    lowSampleTheses: thesisSlices
      .filter((s) => s.evaluated < LOW_SAMPLE_THRESHOLD)
      .map((s) => s.key),
    byStrategy: strategySlices,
    byRegime: regimeSlices,
    byMonth: monthSlices,
    pending,
    overallHitRate: totalEvaluated > 0 ? totalHits / totalEvaluated : null,
  };
}

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
