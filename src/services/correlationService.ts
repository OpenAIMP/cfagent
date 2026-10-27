/**
 * Correlation service (issue #35, gap G2) — pairwise correlation between
 * held and candidate names, computed from LIVE price history.
 *
 * Provenance discipline, same as betaService:
 *  - "measured": Pearson correlation of daily returns over aligned live
 *    closes (trailing window, minimum observation floor). The only tier
 *    that carries a numeric value from data.
 *  - "proxy-sector": live history was insufficient, but both symbols carry
 *    the same sector classification — relatedness is asserted, magnitude
 *    is NOT invented (value stays null). Sector labels come from the
 *    in-repo universe table; a classification is metadata, not a risk
 *    number, so a static label source is acceptable here and only here.
 *  - "unknown": neither measured nor proxy. NEVER treated as zero
 *    correlation by consumers.
 *
 * History is fetched through betaService's live-only Yahoo fetcher — the
 * market-data providers' silent synthetic fallback must never feed correlation
 * either.
 */

import { fetchYahooDailyCloses } from "./betaService";
import { MARKET_DATA_RESEARCH_UNIVERSE } from "./marketDataResearch";

export type CorrelationSource = "measured" | "proxy-sector" | "unknown";

export interface CorrelationEstimate {
  value: number | null;
  source: CorrelationSource;
  /** Aligned daily-return observations behind a measured value (0 otherwise). */
  observations: number;
  /** Shared sector, present when source is "proxy-sector". */
  sector?: string;
}

export const CORRELATION_WINDOW = 252;
export const CORRELATION_MIN_OBSERVATIONS = 60;

type ClosesFetcher = (symbol: string) => Promise<Map<string, number> | null>;

export function sectorOf(symbol: string): string | null {
  const profile = MARKET_DATA_RESEARCH_UNIVERSE[symbol.toUpperCase()];
  return profile?.sector ?? null;
}

/**
 * Pearson correlation of daily simple returns over the aligned close
 * series. Pure and deterministic. Returns null when there are too few
 * aligned observations or either series has zero variance.
 */
export function computeCorrelationFromCloses(
  aCloses: Map<string, number>,
  bCloses: Map<string, number>,
  opts: { window?: number; minObservations?: number } = {},
): { correlation: number; observations: number } | null {
  const window = opts.window ?? CORRELATION_WINDOW;
  const minObservations = opts.minObservations ?? CORRELATION_MIN_OBSERVATIONS;
  const dates = [...aCloses.keys()].filter((d) => bCloses.has(d)).sort();
  if (dates.length < minObservations + 1) return null;

  const aReturns: number[] = [];
  const bReturns: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const aPrev = aCloses.get(dates[i - 1])!;
    const bPrev = bCloses.get(dates[i - 1])!;
    if (aPrev <= 0 || bPrev <= 0) continue;
    aReturns.push(aCloses.get(dates[i])! / aPrev - 1);
    bReturns.push(bCloses.get(dates[i])! / bPrev - 1);
  }
  const pairs = Math.min(aReturns.length, bReturns.length, window);
  if (pairs < minObservations) return null;
  const a = aReturns.slice(-pairs);
  const b = bReturns.slice(-pairs);

  const meanA = a.reduce((s, v) => s + v, 0) / pairs;
  const meanB = b.reduce((s, v) => s + v, 0) / pairs;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < pairs; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return null;
  const correlation = cov / Math.sqrt(varA * varB);
  return { correlation: Math.round(correlation * 10000) / 10000, observations: pairs };
}

export class CorrelationService {
  private readonly closesCache = new Map<string, Promise<Map<string, number> | null>>();

  constructor(private readonly fetcher: ClosesFetcher = fetchYahooDailyCloses) {}

  private closes(symbol: string): Promise<Map<string, number> | null> {
    const key = `${symbol.toUpperCase()}|${new Date().toISOString().split("T")[0]}`;
    if (!this.closesCache.has(key)) {
      this.closesCache.set(key, this.fetcher(symbol.toUpperCase()).catch(() => null));
    }
    return this.closesCache.get(key)!;
  }

  async estimate(symbolA: string, symbolB: string): Promise<CorrelationEstimate> {
    const a = symbolA.toUpperCase();
    const b = symbolB.toUpperCase();
    if (a === b) return { value: 1, source: "measured", observations: 0 };

    const [aCloses, bCloses] = await Promise.all([this.closes(a), this.closes(b)]);
    if (aCloses && bCloses) {
      const measured = computeCorrelationFromCloses(aCloses, bCloses);
      if (measured) return { value: measured.correlation, source: "measured", observations: measured.observations };
    }

    const sectorA = sectorOf(a);
    const sectorB = sectorOf(b);
    if (sectorA && sectorB && sectorA === sectorB) {
      return { value: null, source: "proxy-sector", observations: 0, sector: sectorA };
    }
    return { value: null, source: "unknown", observations: 0 };
  }
}

export const sharedCorrelationService = new CorrelationService();
