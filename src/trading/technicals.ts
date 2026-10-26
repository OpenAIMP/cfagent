/**
 * Technicals from daily bars — pure functions + bar shapes.
 *
 * Issue #1331: moved verbatim from yahooHistory.ts (whose fetch
 * runtime is deleted — its consumers now fetch through the platform
 * historicalBars route; see platformHistory.ts). Nothing here
 * fetches: these functions compute from bars supplied by the caller.
 *
 * Yahoo Finance history complement (issue #269):
 *   - Daily price history → REAL RSI(14), MACD(12,26,9)
 *   - Previous close + open → overnight gap %
 *
 * Every value carries its source. Yahoo never overrides an E*TRADE
 * quote — it only fills the history-shaped hole.
 */

import { computeRsi14, computeMacd } from "../services/fossResearch";
import type { FossHistoricalBar } from "../types";
import { DEFAULT_SCREENER_CONFIG, type ScreenerConfig } from "./screenerConfig";

export interface YahooDailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface YahooTechnicals {
  symbol: string;
  /** Real RSI(14) from daily closes, or null when history insufficient. */
  rsi14: number | null;
  macdLine: number | null;
  macdSignalLine: number | null;
  macdHistogram: number | null;
  macdSignal: string | null;
  /** Overnight gap % = (open − prevClose) / prevClose * 100. */
  gapPercent: number | null;
  gapDirection: "up" | "down" | "flat" | null;
  /** Number of daily bars used. */
  barsUsed: number;
  source: "Yahoo Finance";
}

/**
 * Issue #1331: map platform FOSS bars to daily bars — but ONLY when
 * every bar is live. The FOSS provider falls back to a generated
 * (synthetic) series when the live fetch fails; the old path
 * returned null on failure ("indicator unavailable, never zero"),
 * so a generated bar anywhere rejects the whole series. A partial
 * live series would corrupt RSI/MACD just as surely as a synthetic
 * one, so there is no partial path: live-all or null.
 */
export function fossBarsToDailyBars(
  bars: readonly FossHistoricalBar[] | null | undefined
): YahooDailyBar[] | null {
  if (!bars || bars.length === 0) return null;
  if (bars.some((b) => b.provenance !== "live")) return null;
  return bars.map((b) => ({
    date: b.timestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

/**
 * Bollinger Bands (issue #1654 slice 1/7; docs/architecture/business/
 * screener-rules.md §1.1). Pure function over closes supplied by the
 * caller — nothing here fetches.
 *
 * Convention, documented because the repo has no prior sigma helper:
 * sigma is the POPULATION standard deviation (divide by N), the
 * canonical Bollinger construction — Middle is the SMA over the same
 * window, so the band is symmetric around the mean of exactly the
 * closes it summarizes. Sample sigma (divide by N−1) would deviate
 * from every reference Bollinger implementation and from the doc
 * formula (sigma_20).
 *
 * Returns null when the window cannot be built honestly: fewer than
 * `period` closes, a non-positive period, a negative stdDev, or a
 * non-finite close in the window. P is the last close in the window.
 * Flat series (sigma = 0): upper == lower == middle, percentB is 0.5
 * (price at the middle by construction) and bandwidth is 0 — never
 * NaN from a 0/0 division.
 */
export interface BollingerBands {
  middle: number;
  upper: number;
  lower: number;
  /** %B = (P − Lower) / (Upper − Lower); 0.5 on a flat series. */
  percentB: number;
  /** Bandwidth = (Upper − Lower) / Middle; 0 when Middle is 0. */
  bandwidth: number;
}

export function computeBollingerBands(
  closes: readonly number[],
  period = 20,
  stdDev = 2.0
): BollingerBands | null {
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(stdDev) || stdDev < 0) return null;
  if (!closes || closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  if (window.some((c) => !Number.isFinite(c))) return null;
  const middle = window.reduce((sum, c) => sum + c, 0) / period;
  const variance = window.reduce((sum, c) => sum + (c - middle) * (c - middle), 0) / period;
  const sigma = Math.sqrt(variance);
  const upper = middle + stdDev * sigma;
  const lower = middle - stdDev * sigma;
  const price = window[window.length - 1];
  const percentB = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  const bandwidth = middle === 0 ? 0 : (upper - lower) / middle;
  return { middle, upper, lower, percentB, bandwidth };
}

/**
 * Squeeze gate (issue #1654 slice 1/7): bandwidth at its lookback
 * minimum. `bandwidthMin` is the minimum bandwidth over the trailing
 * `lookback` bandwidth values (each from a `period`-close window).
 * `isSqueeze` is true only when the current bandwidth IS that minimum
 * (within float epsilon) — the doc's literal "at N-day minimum".
 *
 * History floor, stated not silent: a true 125-day minimum needs
 * lookback + period − 1 closes (144 at the defaults). With fewer
 * closes the minimum is over the available bandwidth values and
 * `barsUsed` reports it — but below `period + 1` closes there is only
 * ONE bandwidth value, and a "minimum" over one point would be
 * trivially true, so the gate returns null instead of silently
 * weakening to "current bandwidth is low". Callers must treat null
 * as "gate cannot be evaluated", never as a pass.
 */
export interface BollingerSqueezeGate {
  bandwidth: number;
  bandwidthMin: number;
  /** Closes supplied; the minimum covers at most `lookback` values. */
  barsUsed: number;
  isSqueeze: boolean;
}

export function computeBollingerSqueezeGate(
  closes: readonly number[],
  period = 20,
  stdDev = 2.0,
  lookback = 125
): BollingerSqueezeGate | null {
  if (!closes || closes.length < period + 1) return null;
  if (!Number.isInteger(lookback) || lookback < 1) return null;
  const bandwidths: number[] = [];
  for (let end = period; end <= closes.length; end++) {
    const bands = computeBollingerBands(closes.slice(0, end), period, stdDev);
    if (bands === null) return null;
    bandwidths.push(bands.bandwidth);
  }
  const window = bandwidths.slice(Math.max(0, bandwidths.length - lookback));
  const bandwidth = window[window.length - 1];
  const bandwidthMin = Math.min(...window);
  return {
    bandwidth,
    bandwidthMin,
    barsUsed: closes.length,
    isSqueeze: bandwidth <= bandwidthMin + 1e-12,
  };
}
export function classifyGap(
  gapPercent: number | null,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): "up" | "down" | "flat" | null {
  if (gapPercent == null || !Number.isFinite(gapPercent)) return null;
  if (gapPercent >= config.yahoo.gapUpPct) return "up";
  if (gapPercent <= config.yahoo.gapDownPct) return "down";
  return "flat";
}

/**
 * Compute technicals from daily bars. RSI needs 14+ bars, MACD 26+;
 * below that the respective field is null (honest, not estimated).
 */
export function computeTechnicals(
  symbol: string,
  bars: YahooDailyBar[] | null,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): YahooTechnicals {
  const base: YahooTechnicals = {
    symbol,
    rsi14: null,
    macdLine: null,
    macdSignalLine: null,
    macdHistogram: null,
    macdSignal: null,
    gapPercent: null,
    gapDirection: null,
    barsUsed: bars?.length ?? 0,
    source: "Yahoo Finance",
  };
  if (!bars || bars.length < 2) return base;

  const closes = bars.map((b) => b.close);

  // Gap: most recent open vs previous close.
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (prev.close > 0) {
    const gap = ((last.open - prev.close) / prev.close) * 100;
    base.gapPercent = Number(gap.toFixed(2));
    base.gapDirection = classifyGap(base.gapPercent, config);
  }

  if (closes.length >= config.yahoo.rsiMinBars) {
    base.rsi14 = computeRsi14(closes);
  }
  if (closes.length >= config.yahoo.macdMinBars) {
    const macd = computeMacd(closes);
    base.macdLine = Number(macd.macdLine.toFixed(3));
    base.macdSignalLine = Number(macd.signalLine.toFixed(3));
    base.macdHistogram = Number(macd.histogram.toFixed(3));
    base.macdSignal = macd.macdSignal;
  }
  return base;
}
