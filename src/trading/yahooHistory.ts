/**
 * Yahoo Finance history complement (issue #269).
 *
 * E*TRADE is the primary quote source (live snapshots). Yahoo complements it
 * with what E*TRADE cannot provide:
 *   - Daily price history → REAL RSI(14), MACD(12,26,9)
 *   - Previous close + open → overnight gap %
 *
 * Every value carries its source. Yahoo never overrides an E*TRADE quote —
 * it only fills the history-shaped hole.
 */

import { computeRsi14, computeMacd } from "../services/fossResearch";
import { DEFAULT_SCREENER_CONFIG, type ScreenerConfig } from "./screenerConfig";
import { getCachedQuote, setCachedQuote } from "../services/quoteCache";

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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Fetch ~3 months of daily bars (need 26+ for MACD). Returns null on failure —
 * the caller treats missing history as "indicator unavailable", never as zero.
 */
export async function fetchYahooDailyHistory(
  symbol: string,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): Promise<YahooDailyBar[] | null> {
  const clean = symbol.toUpperCase().trim();
  const cacheKey = `yahoo:bars:${clean}`;
  const cached = getCachedQuote<YahooDailyBar[]>(cacheKey);
  if (cached && cached.length >= 5) return cached;

  const range = config.yahoo.historyRange;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?interval=1d&range=${range}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?interval=1d&range=${range}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(config.yahoo.requestTimeoutMs),
      });
      if (!res.ok) {
        // Issue #295: Log non-OK responses for diagnostics (was silent).
        console.warn(`[YahooHistory] ${clean}: HTTP ${res.status} from ${url.includes('query1') ? 'query1' : 'query2'}`);
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as any;
      const result = data?.chart?.result?.[0];
      if (!result) {
        console.warn(`[YahooHistory] ${clean}: No chart result in response`);
        continue;
      }
      const timestamps: number[] = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const bars: YahooDailyBar[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = quote.close?.[i];
        const open = quote.open?.[i];
        if (typeof close !== "number" || isNaN(close)) continue;
        bars.push({
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open: typeof open === "number" && !isNaN(open) ? open : close,
          high: quote.high?.[i] ?? close,
          low: quote.low?.[i] ?? close,
          close,
          volume: quote.volume?.[i] ?? 0,
        });
      }
      if (bars.length >= 5) {
        setCachedQuote(cacheKey, bars);
        return bars;
      }
      console.warn(`[YahooHistory] ${clean}: Only ${bars.length} bars (need 5+)`);
    } catch (err) {
      // Issue #295: Log fetch errors for diagnostics (was silent).
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[YahooHistory] ${clean}: Fetch failed: ${msg}`);
      // Try the next URL.
    }
  }
  return null;
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

/**
 * Fetch history + compute technicals for many symbols (concurrency-limited).
 * Failures are per-symbol; the rest still resolve.
 */
export async function fetchTechnicalsBatch(
  symbols: string[],
  concurrency?: number,
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG,
  onBatch?: (completed: number, total: number) => void | Promise<void>
): Promise<Map<string, YahooTechnicals>> {
  const out = new Map<string, YahooTechnicals>();
  const conc = concurrency ?? config.yahoo.fetchConcurrency;
  for (let i = 0; i < symbols.length; i += conc) {
    const batch = symbols.slice(i, i + conc);
    const results = await Promise.all(
      batch.map(async (sym) => {
        const bars = await fetchYahooDailyHistory(sym, config);
        return computeTechnicals(sym, bars, config);
      })
    );
    for (const t of results) out.set(t.symbol, t);
    // Issue #624: optional progress hook (e.g. task heartbeats during
    // long batches); absent for existing callers.
    if (onBatch) await onBatch(Math.min(i + conc, symbols.length), symbols.length);
    if (i + conc < symbols.length) {
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  return out;
}
