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

/** Gap classification (percent thresholds from config). */
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
