/**
 * Dynamic beta resolution (issue #34 correction — part of epic #32;
 * static tier removed by #927, parent #913 S9).
 *
 * Beta for the portfolio risk rollup is COMPUTED from live price history —
 * an OLS regression of the symbol's daily returns against SPY over a
 * trailing window — never read from a static table. Every resolution
 * carries its provenance so consumers can see exactly what a beta number
 * is made of: computed-live, or unavailable.
 *
 * Live-data-only rule: this module fetches real market history and treats
 * ANY fetch/parse failure as "unavailable". It never substitutes generated
 * bars, and it never consults the static market-data table. (The market-data providers'
 * async getHistoricalBars silently falls back to generated bars on
 * failure, which is why beta does not route through it.)
 */

export type BetaSource = "computed-live" | "unavailable";

export interface BetaResolution {
  beta: number | null;
  source: BetaSource;
  /** Aligned daily-return observations behind a computed beta (0 otherwise). */
  observations: number;
  asOf: string;
}

export const BETA_BENCHMARK = "SPY";
export const BETA_WINDOW = 252;
export const BETA_MIN_OBSERVATIONS = 60;

export type DailyClosesFetcher = (symbol: string) => Promise<Map<string, number> | null>;

/**
 * Fetches real daily closes from Yahoo Finance's chart API (the same public
 * endpoint the in-repo Yahoo provider uses). Returns null on any
 * failure — no synthetic substitution, ever.
 */
export async function fetchYahooDailyCloses(symbol: string): Promise<Map<string, number> | null> {
  const clean = encodeURIComponent(symbol.toUpperCase().trim());
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${clean}?interval=1d&range=2y`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${clean}?interval=1d&range=2y`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
      });
      if (!res.ok) continue;
      const data = (await res.json().catch(() => ({}))) as any;
      const result = data?.chart?.result?.[0];
      const timestamps: unknown = result?.timestamp;
      const closes: unknown = result?.indicators?.quote?.[0]?.close;
      if (!Array.isArray(timestamps) || !Array.isArray(closes)) continue;
      const map = new Map<string, number>();
      for (let i = 0; i < timestamps.length; i++) {
        const c = closes[i];
        if (typeof c === "number" && c > 0 && typeof timestamps[i] === "number") {
          map.set(new Date(timestamps[i] * 1000).toISOString().split("T")[0], c);
        }
      }
      if (map.size > 0) return map;
    } catch {
      // Try the mirror host, then give up — unavailable, never fabricated.
    }
  }
  return null;
}

/**
 * Pure beta computation: slope of asset daily returns regressed on benchmark
 * daily returns over the most recent `window` aligned observations.
 * Returns null when there are too few aligned observations or the benchmark
 * has zero variance.
 */
export function computeBetaFromCloses(
  assetCloses: Map<string, number>,
  benchmarkCloses: Map<string, number>,
  opts: { window?: number; minObservations?: number } = {},
): { beta: number; observations: number } | null {
  const window = opts.window ?? BETA_WINDOW;
  const minObservations = opts.minObservations ?? BETA_MIN_OBSERVATIONS;
  const dates = [...assetCloses.keys()].filter((d) => benchmarkCloses.has(d)).sort();
  if (dates.length < minObservations + 1) return null;

  const assetReturns: number[] = [];
  const benchReturns: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const a0 = assetCloses.get(dates[i - 1])!;
    const a1 = assetCloses.get(dates[i])!;
    const b0 = benchmarkCloses.get(dates[i - 1])!;
    const b1 = benchmarkCloses.get(dates[i])!;
    if (a0 > 0 && b0 > 0) {
      assetReturns.push(a1 / a0 - 1);
      benchReturns.push(b1 / b0 - 1);
    }
  }
  const pairs = assetReturns.slice(-window);
  const bench = benchReturns.slice(-window);
  if (pairs.length < minObservations) return null;

  const meanA = pairs.reduce((s, v) => s + v, 0) / pairs.length;
  const meanB = bench.reduce((s, v) => s + v, 0) / bench.length;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < pairs.length; i++) {
    cov += (pairs[i] - meanA) * (bench[i] - meanB);
    varB += (bench[i] - meanB) * (bench[i] - meanB);
  }
  if (varB === 0) return null;
  return { beta: Number((cov / varB).toFixed(4)), observations: pairs.length };
}

/**
 * Resolves betas with per-day caching. One instance is shared per process so
 * a portfolio with many positions fetches SPY history once.
 */
export class BetaService {
  private readonly cache = new Map<string, Promise<BetaResolution>>();
  private benchmarkCloses: Promise<Map<string, number> | null> | null = null;

  constructor(private readonly fetcher: DailyClosesFetcher = fetchYahooDailyCloses) {}

  private dayKey(symbol: string): string {
    return `${symbol.toUpperCase()}|${new Date().toISOString().split("T")[0]}`;
  }

  resolve(symbol: string): Promise<BetaResolution> {
    const key = this.dayKey(symbol);
    if (!this.cache.has(key)) {
      this.cache.set(key, this.resolveUncached(symbol.toUpperCase()));
    }
    return this.cache.get(key)!;
  }

  private async resolveUncached(symbol: string): Promise<BetaResolution> {
    const asOf = new Date().toISOString();
    if (!this.benchmarkCloses) {
      this.benchmarkCloses = symbol === BETA_BENCHMARK ? this.fetcher(symbol) : this.fetcher(BETA_BENCHMARK);
    }
    const bench = await this.benchmarkCloses;
    if (bench) {
      if (symbol === BETA_BENCHMARK) {
        return { beta: 1, source: "computed-live", observations: Math.max(0, bench.size - 1), asOf };
      }
      const asset = await this.fetcher(symbol);
      if (asset) {
        const computed = computeBetaFromCloses(asset, bench);
        if (computed) {
          return { beta: computed.beta, source: "computed-live", observations: computed.observations, asOf };
        }
      }
    }
    // No Tier 2: a live failure is unavailable, never a static-table number (#927).
    return { beta: null, source: "unavailable", observations: 0, asOf };
  }
}

/** Process-wide shared instance used by the portfolio risk resolver. */
export const sharedBetaService = new BetaService();
