/**
 * Screening indicators (issue #261) — E*TRADE-honest technical screening.
 *
 * Every indicator here is computed SOLELY from a single E*TRADE snapshot
 * quote (lastPrice, day OHLC, change%, volume, 52-week range, P/E).
 * Methodology is labeled on each result — range-based proxies are NEVER
 * presented as RSI/MACD.
 *
 * What E*TRADE CANNOT provide (no history endpoint):
 *   - RSI(14), MACD(12,26,9), any multi-day indicator — these need 26+
 *     daily closes. They are reported as unavailable, not faked.
 */

export type Sentiment =
  | "very_bullish"
  | "bullish"
  | "neutral"
  | "bearish"
  | "very_bearish";

export type RangeZone = "overbought" | "neutral" | "oversold";
export type ValueZone = "undervalued" | "fair" | "overvalued";

export interface ScreeningIndicators {
  /** Day momentum: the session's percent change. */
  momentum: number;
  /** Intraday trend position: 0 = at day low, 1 = at day high. */
  intradayPosition: number | null;
  /** 6-level sentiment from day action. */
  sentiment: Sentiment;
  /** Strong directional move (|change%| >= 2%), either direction. */
  directional: boolean;
  /** Position in 52-week range: 0 = at 52w low, 1 = at 52w high. */
  rangePosition: number | null;
  /** Range-based overbought/oversold (NOT RSI — labeled as range-based). */
  rangeZone: RangeZone;
  /** Heuristic value zone from P/E + 52-week position. */
  valueZone: ValueZone;
  /** Composite 0-100 screening score (higher = stronger bullish setup). */
  screenScore: number;
  /** Human-readable one-line summary. */
  summary: string;
}

export interface QuoteSnapshot {
  lastPrice: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  week52High: number;
  week52Low: number;
  peRatio?: number;
  volume: number;
  averageVolume?: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function classifySentiment(changePercent: number): Sentiment {
  if (changePercent >= 3) return "very_bullish";
  if (changePercent >= 0.5) return "bullish";
  if (changePercent <= -3) return "very_bearish";
  if (changePercent <= -0.5) return "bearish";
  return "neutral";
}

export function classifyRangeZone(rangePosition: number | null): RangeZone {
  if (rangePosition == null) return "neutral";
  if (rangePosition >= 0.9) return "overbought";
  if (rangePosition <= 0.1) return "oversold";
  return "neutral";
}

export function classifyValueZone(
  peRatio: number | undefined,
  rangePosition: number | null
): ValueZone {
  // P/E-led when available; 52-week position as the secondary read.
  if (peRatio !== undefined && Number.isFinite(peRatio) && peRatio > 0) {
    if (peRatio < 15) return "undervalued";
    if (peRatio > 30) return "overvalued";
  }
  if (rangePosition != null) {
    if (rangePosition <= 0.15) return "undervalued";
    if (rangePosition >= 0.85) return "overvalued";
  }
  return "fair";
}

export function computeScreeningIndicators(q: QuoteSnapshot): ScreeningIndicators {
  const intradayPosition =
    q.high > q.low
      ? clamp01((q.lastPrice - q.low) / (q.high - q.low))
      : null;
  const rangePosition =
    q.week52High > q.week52Low
      ? clamp01((q.lastPrice - q.week52Low) / (q.week52High - q.week52Low))
      : null;

  const sentiment = classifySentiment(q.changePercent);
  const directional = Math.abs(q.changePercent) >= 2;
  const rangeZone = classifyRangeZone(rangePosition);
  const valueZone = classifyValueZone(q.peRatio, rangePosition);

  // Composite 0-100: day momentum (40) + intraday strength (20) +
  // 52w position (20) + value (20). Heuristic, labeled as such.
  let score = 50 + q.changePercent * 5;
  if (intradayPosition != null) score += (intradayPosition - 0.5) * 40;
  if (rangePosition != null) score += (rangePosition - 0.5) * 40;
  if (valueZone === "undervalued") score += 10;
  if (valueZone === "overvalued") score -= 10;
  const screenScore = Math.round(Math.min(100, Math.max(0, score)));

  const sentimentLabel = sentiment.replace("_", " ");
  const parts = [sentimentLabel];
  if (directional) parts.push("directional");
  if (rangeZone !== "neutral") parts.push(`range-${rangeZone}`);
  if (valueZone !== "fair") parts.push(valueZone);

  return {
    momentum: Number(q.changePercent.toFixed(2)),
    intradayPosition:
      intradayPosition != null ? Number(intradayPosition.toFixed(2)) : null,
    sentiment,
    directional,
    rangePosition:
      rangePosition != null ? Number(rangePosition.toFixed(2)) : null,
    rangeZone,
    valueZone,
    screenScore,
    summary: parts.join(" · "),
  };
}
