/**
 * Issue #1745 — Decorator over IFossMarketDataProvider.
 *
 * Protected Variations: the strategy interface is unchanged — the
 * wrapper only adds breaker + fallback behavior around the inner
 * provider's calls. Batch/snapshot methods exist on the wrapper
 * exactly when the inner provider offers them (the pipeline's
 * optional-dep check, yahooDepsFromProvider, relies on that shape:
 * the dep exists only when the provider offers getQuotes).
 * Sync cache reads pass through unwrapped: they make no provider
 * call, so no breaker gate applies to them.
 *
 * Fallbacks are caller-supplied per method. The FossResearchService
 * wiring supplies the Yahoo quote-cache fallback (5-minute
 * in-memory cache, stamped cached with its age — the #930 rule);
 * every other method defaults to no fallback, so provider errors
 * propagate unchanged and the service's multi-provider chains
 * (yfinance → alpaca for bars) keep working.
 */

import type {
  BreakerExecuteOptions,
  CircuitBreaker,
} from "./breakerPorts";
import { BreakerFallbackError } from "./breakerPorts";
import { withBreaker } from "./breakerDecorator";
import { getCachedQuoteWithAge } from "../services/quoteCache";
import type { IFossMarketDataProvider } from "../patterns/interfaces";
import type {
  AlpacaMarketSnapshot,
  Env,
  FossCompanyFundamentals,
  FossHistoricalBar,
  FossQuote,
} from "../types";

export interface FossBreakerFallbacks {
  getQuote?: (symbol: string) => Promise<FossQuote>;
  getQuotes?: (symbols: string[]) => Promise<FossQuote[]>;
  getFundamentals?: (symbol: string) => Promise<FossCompanyFundamentals>;
  getHistoricalBars?: (
    symbol: string,
    timeframe?: string,
    limit?: number
  ) => Promise<FossHistoricalBar[]>;
  getMarketSnapshot?: (symbol: string) => Promise<AlpacaMarketSnapshot>;
}

/**
 * Yahoo quote-cache fallback (the stale-but-labeled fallback for
 * the Yahoo strategy): the same 5-minute in-memory cache the live
 * path reads, stamped cached with its age (the #930 rule). Throws
 * BreakerFallbackError when no cached quote exists — never invents
 * a price. Shared by the FossResearchService wiring and the
 * data-provider factory wiring so both serve the same fallback.
 */
export function yahooQuoteCacheFallback(symbol: string): FossQuote {
  const cached = getCachedQuoteWithAge<FossQuote>(
    `yahoo:${symbol.toUpperCase().trim()}`
  );
  if (!cached) {
    throw new BreakerFallbackError(
      "yahoo",
      `no cached Yahoo quote for ${symbol}`
    );
  }
  return {
    ...cached.value,
    provenance: "cached",
    fromCache: true,
    cacheAgeMs: cached.ageMs,
  };
}

export interface FossBreakerWrapperOptions {
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  retryPolicy?: BreakerExecuteOptions<unknown>["retryPolicy"];
}

type InnerWithOptionals = IFossMarketDataProvider & {
  getQuotes?: (symbols: string[]) => Promise<FossQuote[]>;
  getMarketSnapshot?: (symbol: string) => Promise<AlpacaMarketSnapshot>;
  getMarketSnapshotSync?: (symbol: string) => AlpacaMarketSnapshot;
  getQuoteSync?: (symbol: string) => FossQuote;
  getFundamentalsSync?: (symbol: string) => FossCompanyFundamentals;
  getHistoricalBarsSync?: (
    symbol: string,
    timeframe?: string,
    limit?: number
  ) => FossHistoricalBar[];
};

export class BreakerWrappedFossProvider implements IFossMarketDataProvider {
  readonly providerId: IFossMarketDataProvider["providerId"];
  readonly name: string;
  /** Present exactly when the inner provider offers batch quotes. */
  readonly getQuotes?: (symbols: string[]) => Promise<FossQuote[]>;
  /** Present exactly when the inner provider offers snapshots. */
  readonly getMarketSnapshot?: (symbol: string) => Promise<AlpacaMarketSnapshot>;
  readonly getMarketSnapshotSync?: (symbol: string) => AlpacaMarketSnapshot;
  /** Sync cache reads: pass-through, never breaker-gated. All three
   *  FOSS strategies carry them, so they are required here (a call
   *  on an inner without one throws exactly as a direct call would). */
  readonly getQuoteSync: (symbol: string) => FossQuote;
  readonly getFundamentalsSync: (symbol: string) => FossCompanyFundamentals;
  readonly getHistoricalBarsSync: (
    symbol: string,
    timeframe?: string,
    limit?: number
  ) => FossHistoricalBar[];

  constructor(
    private readonly inner: IFossMarketDataProvider,
    private readonly breaker: CircuitBreaker,
    private readonly fallbacks: FossBreakerFallbacks = {},
    private readonly opts: FossBreakerWrapperOptions = {}
  ) {
    this.providerId = inner.providerId;
    this.name = inner.name;
    const withOptionals = inner as InnerWithOptionals;
    if (typeof withOptionals.getQuotes === "function") {
      this.getQuotes = (symbols: string[]) =>
        this.run(() => withOptionals.getQuotes!(symbols), this.fallbacks.getQuotes
          ? () => this.fallbacks.getQuotes!(symbols)
          : undefined);
    }
    if (typeof withOptionals.getMarketSnapshot === "function") {
      this.getMarketSnapshot = (symbol: string) =>
        this.run(() => withOptionals.getMarketSnapshot!(symbol), this.fallbacks.getMarketSnapshot
          ? () => this.fallbacks.getMarketSnapshot!(symbol)
          : undefined);
    }
    if (typeof withOptionals.getMarketSnapshotSync === "function") {
      this.getMarketSnapshotSync = (symbol: string) =>
        withOptionals.getMarketSnapshotSync!(symbol);
    }
    this.getQuoteSync = (symbol: string) => withOptionals.getQuoteSync!(symbol);
    this.getFundamentalsSync = (symbol: string) =>
      withOptionals.getFundamentalsSync!(symbol);
    this.getHistoricalBarsSync = (symbol: string, timeframe?: string, limit?: number) =>
      withOptionals.getHistoricalBarsSync!(symbol, timeframe, limit);
  }

  isConfigured(env?: Env): boolean {
    return this.inner.isConfigured(env);
  }

  async getQuote(symbol: string, opts?: unknown): Promise<FossQuote> {
    return this.run(
      () => (this.inner as InnerWithOptionals & { getQuote: (s: string, o?: unknown) => Promise<FossQuote> }).getQuote(symbol, opts),
      this.fallbacks.getQuote ? () => this.fallbacks.getQuote!(symbol) : undefined
    );
  }

  async getFundamentals(symbol: string): Promise<FossCompanyFundamentals> {
    return this.run(
      () => this.inner.getFundamentals(symbol),
      this.fallbacks.getFundamentals
        ? () => this.fallbacks.getFundamentals!(symbol)
        : undefined
    );
  }

  async getHistoricalBars(
    symbol: string,
    timeframe?: string,
    limit?: number
  ): Promise<FossHistoricalBar[]> {
    return this.run(
      () => this.inner.getHistoricalBars(symbol, timeframe, limit),
      this.fallbacks.getHistoricalBars
        ? () => this.fallbacks.getHistoricalBars!(symbol, timeframe, limit)
        : undefined
    );
  }

  private async run<T>(
    fn: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    const outcome = await withBreaker(this.breaker, fn, {
      fallback,
      sleep: this.opts.sleep,
      rng: this.opts.rng,
      retryPolicy: this.opts.retryPolicy,
    });
    return outcome.value;
  }
}
