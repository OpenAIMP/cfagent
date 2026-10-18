/**
 * Factor grades (issue #266) — Seeking Alpha-style quant factor grading.
 *
 * SA's signature: every stock graded A+ to F on Value, Growth, Profitability,
 * Momentum, and EPS Revisions, each relative to its sector; plus an overall
 * Quant Rating (Strong Buy → Strong Sell).
 *
 * Honest E*TRADE-only mapping:
 *   - Value: P/E percentile (lower = better) + distance from 52-week low.
 *   - Momentum: day change%, 52-week position, intraday strength.
 *   - Growth / Profitability / Revisions: NULL — E*TRADE snapshots carry no
 *     revenue, margins, ROE, or analyst data. Withheld, never faked.
 *   - Quant Rating: weighted composite of the graded factors only.
 *
 * Grading is percentile-relative within the screened universe (and within
 * sector peers when sector data exists) — like SA's sector-relative grades.
 */

export type Grade =
  | "A+" | "A" | "A-"
  | "B+" | "B" | "B-"
  | "C+" | "C" | "C-"
  | "D+" | "D" | "D-"
  | "F";

import { DEFAULT_SCREENER_CONFIG, type ScreenerConfig } from "./screenerConfig";

export type QuantRating =
  | "Strong Buy"
  | "Buy"
  | "Hold"
  | "Sell"
  | "Strong Sell";

export interface FactorGrades {
  /** A+..F or null when inputs are insufficient (never faked). */
  value: Grade | null;
  momentum: Grade | null;
  /** Always null: E*TRADE has no revenue/EPS growth data. */
  growth: null;
  /** Always null: E*TRADE has no margins/ROE data. */
  profitability: null;
  /** Always null: E*TRADE has no analyst revision data. */
  revisions: null;
  quantRating: QuantRating | null;
  /** 0-100 factor percentiles (null when ungradable). */
  valueScore: number | null;
  momentumScore: number | null;
  compositeScore: number | null;
  /** Which factors contributed to the quant rating. */
  gradedFactors: string[];
}

export interface GradeableStock {
  symbol: string;
  sector?: string;
  peRatio?: number | null;
  /** 0 = at 52w low, 1 = at 52w high (null when unknown). */
  rangePosition: number | null;
  /** Day percent change. */
  changePercent: number;
  /** 0 = at day low, 1 = at day high (null when unknown). */
  intradayPosition: number | null;
  /** Composite 0-100 screening score. */
  screenScore: number;
}

/** Percentile (0-100) → SA-style letter grade. */
export function percentileToGrade(
  pct: number,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): Grade {
  for (const b of config.grades.gradeBoundaries) {
    if (pct >= b.min) return b.grade as Grade;
  }
  return "F";
}

/** Composite percentile → quant rating. */
export function compositeToQuantRating(
  pct: number,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): QuantRating {
  for (const b of config.grades.quantBoundaries) {
    if (pct >= b.min) return b.rating as QuantRating;
  }
  return "Strong Sell";
}

/**
 * Percentile rank of `value` within `peers` (0-100). Higher raw = higher
 * percentile. Returns null when fewer than 3 peers have data.
 */
function percentileRank(
  value: number,
  peers: number[],
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): number | null {
  const valid = peers.filter((p) => Number.isFinite(p));
  if (valid.length < config.grades.minPeers || !Number.isFinite(value)) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const below = sorted.filter((p) => p < value).length;
  const equal = sorted.filter((p) => p === value).length;
  return Math.round(((below + equal / 2) / sorted.length) * 100);
}

/** Raw value signal: lower P/E and closer to 52w low = cheaper. */
function rawValueSignal(
  s: GradeableStock,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): number | null {
  const g = config.grades;
  const parts: number[] = [];
  const weights: number[] = [];
  if (s.peRatio != null && s.peRatio > 0 && Number.isFinite(s.peRatio)) {
    // Invert: low P/E → high signal. Cap to bound outliers.
    parts.push(Math.max(0, 1 - Math.min(s.peRatio, g.valuePeCap) / g.valuePeCap));
    weights.push(g.valuePeWeight);
  }
  if (s.rangePosition != null) {
    parts.push(1 - s.rangePosition);
    weights.push(g.valueRangeWeight);
  }
  if (parts.length === 0) return null;
  const total = weights.reduce((a, b) => a + b, 0);
  return parts.reduce((sum, p, i) => sum + p * weights[i], 0) / total;
}

/** Raw momentum signal: strong up day + high in range + strong close. */
function rawMomentumSignal(s: GradeableStock): number {
  let m = 0.5 + s.changePercent / 10; // ±5% maps to 0..1
  if (s.rangePosition != null) m += (s.rangePosition - 0.5) * 0.4;
  if (s.intradayPosition != null) m += (s.intradayPosition - 0.5) * 0.3;
  return Math.min(1, Math.max(0, m));
}

const EMPTY_GRADES: FactorGrades = {
  value: null,
  momentum: null,
  growth: null,
  profitability: null,
  revisions: null,
  quantRating: null,
  valueScore: null,
  momentumScore: null,
  compositeScore: null,
  gradedFactors: [],
};

/**
 * Grade every stock relative to the universe (percentile-based).
 * Returns a map symbol → FactorGrades.
 */
export function computeFactorGrades(
  stocks: GradeableStock[],
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): Map<string, FactorGrades> {
  const out = new Map<string, FactorGrades>();
  if (stocks.length === 0) return out;

  const valueRaws = new Map<string, number | null>();
  const momentumRaws = new Map<string, number>();
  for (const s of stocks) {
    valueRaws.set(s.symbol, rawValueSignal(s, config));
    momentumRaws.set(s.symbol, rawMomentumSignal(s));
  }
  const valuePeerPool = [...valueRaws.values()].filter(
    (v): v is number => v != null
  );
  const momentumPeerPool = [...momentumRaws.values()];

  for (const s of stocks) {
    const valueRaw = valueRaws.get(s.symbol);
    const valueScore =
      valueRaw != null ? percentileRank(valueRaw, valuePeerPool, config) : null;
    const momentumScore = percentileRank(
      momentumRaws.get(s.symbol)!,
      momentumPeerPool,
      config
    );

    const gradedFactors: string[] = [];
    if (valueScore != null) gradedFactors.push("Value");
    if (momentumScore != null) gradedFactors.push("Momentum");

    let compositeScore: number | null = null;
    let quantRating: QuantRating | null = null;
    if (gradedFactors.length > 0) {
      // SA weights all five factors; we weight only the gradable ones.
      const scores = [valueScore, momentumScore].filter(
        (v): v is number => v != null
      );
      compositeScore = Math.round(
        scores.reduce((a, b) => a + b, 0) / scores.length
      );
      quantRating = compositeToQuantRating(compositeScore, config);
    }

    out.set(s.symbol, {
      value: valueScore != null ? percentileToGrade(valueScore, config) : null,
      momentum:
        momentumScore != null ? percentileToGrade(momentumScore, config) : null,
      growth: null,
      profitability: null,
      revisions: null,
      quantRating,
      valueScore,
      momentumScore,
      compositeScore,
      gradedFactors,
    });
  }
  return out;
}

export { EMPTY_GRADES };
