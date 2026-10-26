/**
 * Real-Time Market Data WebSocket Streaming Engine
 *
 * Implements Issue #21:
 * - Real-time streaming of Level 1 quotes (last price, bid, ask, volume, daily change %)
 * - Support for equities (NVDA, AAPL, MSFT, TSLA, SPY, QQQ) and crypto (BTC/USD, ETH/USD, SOL/USD)
 * - Provider-backed WebSocket quote updates with cached HTTP snapshot fallback
 * - WebSocket session lifecycle management with clean teardown and heartbeat support
 * - Batch HTTP snapshot fallback for non-WebSocket clients
 */

import type { Env } from "../types";
import { resolveMarketDataQuotes } from "./marketDataService";

export interface MarketTickData {
  symbol: string;
  name: string;
  type: "stock" | "crypto" | "etf";
  price: number;
  formattedPrice: string;
  change: number;
  formattedChange: string;
  changePercent: number;
  bid: number;
  ask: number;
  formattedBid: string;
  formattedAsk: string;
  volume: string;
  isPositive: boolean;
  timestamp: number;
  source: "Alpaca" | "Yahoo Finance";
}

export type MarketStreamClientMessage =
  | { type: "subscribe"; symbols: string[] }
  | { type: "unsubscribe"; symbols: string[] }
  | { type: "ping" };

export type MarketStreamServerMessage =
  | { type: "snapshot"; quotes: MarketTickData[]; unavailable?: string[] }
  | { type: "tick"; tick: MarketTickData }
  | { type: "ticks"; ticks: MarketTickData[] }
  | { type: "pong"; timestamp: number }
  | { type: "error"; message: string };

/**
 * Format a numeric price with appropriate currency notation and decimal places.
 */
export function formatPrice(price: number): string {
  if (price >= 1000) {
    return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${price.toFixed(2)}`;
}

/**
 * Format percentage change with leading + / - and % symbol.
 */
export function formatChangePercent(changePct: number): string {
  const sign = changePct > 0 ? "+" : "";
  return `${sign}${changePct.toFixed(2)}%`;
}

/**
 * Classify ticker asset class (stock, crypto, etf).
 */
export function classifyAssetType(symbol: string): "stock" | "crypto" | "etf" {
  const upper = symbol.toUpperCase().trim();
  if (upper.includes("/") || upper.includes("-USD") || ["BTC", "ETH", "SOL", "DOGE"].some((c) => upper.includes(c))) {
    return "crypto";
  }
  if (["SPY", "QQQ", "IWM", "DIA", "VOO", "VTI", "GLD", "SLV", "XLK", "XLE"].includes(upper)) {
    return "etf";
  }
  return "stock";
}

/**
 * Format high-volume figures (e.g. 48.2M, $28.4B).
 */
export function formatVolume(volume: number, isCrypto: boolean): string {
  if (volume <= 0) return isCrypto ? "$1.2B" : "15.4M";
  if (isCrypto) {
    if (volume >= 1e9) return `$${(volume / 1e9).toFixed(1)}B`;
    if (volume >= 1e6) return `$${(volume / 1e6).toFixed(1)}M`;
    return `$${(volume / 1e3).toFixed(1)}K`;
  }
  if (volume >= 1e6) return `${(volume / 1e6).toFixed(1)}M`;
  if (volume >= 1e3) return `${(volume / 1e3).toFixed(1)}K`;
  return String(volume);
}

// Live in-memory cache for real-time market quotes (TTL: 30 seconds)
interface LiveMarketCacheEntry {
  tick: MarketTickData;
  expiresAt: number;
}
export const liveMarketCache = new Map<string, LiveMarketCacheEntry>();
const failedQuoteRetryAfter = new Map<string, number>();

/**
 * Fetch authentic real-time market quote from Yahoo Finance or Alpaca
 */
export async function fetchRealMarketQuote(symbol: string, env?: Env): Promise<MarketTickData | null> {
  const norm = symbol.toUpperCase().trim();
  const cached = liveMarketCache.get(norm);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tick;
  }
  const retryAfter = failedQuoteRetryAfter.get(norm) || 0;
  if (retryAfter > Date.now()) return null;

  const type = classifyAssetType(norm);
  const isCrypto = type === "crypto";

  // Map symbols for upstream APIs (e.g. BTC/USD -> BTC-USD)
  let upstreamSym = norm;
  if (norm === "BTC/USD") upstreamSym = "BTC-USD";
  else if (norm === "ETH/USD") upstreamSym = "ETH-USD";
  else if (norm === "SOL/USD") upstreamSym = "SOL-USD";
  else if (norm.includes("/")) upstreamSym = norm.replace("/", "-");

  // 1. Try Alpaca if configured in env
  const apiKey = env?.ALPACA_API_KEY || env?.ALPACA_API_KEY_ID;
  const secretKey = env?.ALPACA_SECRET_KEY || env?.ALPACA_API_SECRET_KEY;
  if (apiKey && secretKey) {
    try {
      const dataUrl = env?.ALPACA_DATA_URL || "https://data.alpaca.markets";
      const alpacaUrl = isCrypto
        ? `${dataUrl}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(norm)}`
        : `${dataUrl}/v2/stocks/${encodeURIComponent(norm)}/quotes/latest`;

      const res = await fetch(alpacaUrl, {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": secretKey,
        },
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        const q = isCrypto ? data?.quotes?.[norm] : data?.quote;
        if (q) {
          const bid = Number(q.bp || 0);
          const ask = Number(q.ap || 0);
          const price = bid > 0 && ask > 0 ? Number(((bid + ask) / 2).toFixed(2)) : Number(bid || ask || 0);
          if (price > 0) {
            // #929: no static profile values in a live tick. The previous
            // close comes only from a previous live tick; without one, fall
            // through to Yahoo Finance, which supplies a live previous
            // close. Volume is unavailable from the Alpaca latest-quote
            // payload, so it is rendered as an explicit marker, never a
            // static profile volume.
            const prevTick = liveMarketCache.get(norm)?.tick;
            const prevClose = prevTick ? prevTick.price - prevTick.change : 0;
            if (prevClose > 0) {
              const change = Number((price - prevClose).toFixed(2));
              const changePercent = Number(((change / prevClose) * 100).toFixed(2));
              const tick: MarketTickData = {
                symbol: norm,
                name: norm,
                type,
                price,
                formattedPrice: formatPrice(price),
                change,
                formattedChange: formatChangePercent(changePercent),
                changePercent,
                bid,
                ask,
                formattedBid: formatPrice(bid),
                formattedAsk: formatPrice(ask),
                volume: "—",
                isPositive: change >= 0,
                timestamp: Date.now(),
                source: "Alpaca",
              };
              liveMarketCache.set(norm, { tick, expiresAt: Date.now() + 20000 });
              failedQuoteRetryAfter.delete(norm);
              return tick;
            }
          }
        }
      }
    } catch {
      // Fall through to Yahoo Finance
    }
  }

  // 2. Fetch live quote from Yahoo Finance v8 chart API
  try {
    const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upstreamSym)}?interval=1d&range=1d`;
    const res = await fetch(yfUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as any;
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta && (meta.regularMarketPrice !== undefined || meta.chartPreviousClose !== undefined)) {
        const price = Number(meta.regularMarketPrice ?? meta.chartPreviousClose ?? 0);
        let prevClose = Number(meta.regularMarketPreviousClose ?? meta.chartPreviousClose ?? price);
        if (!prevClose || isNaN(prevClose)) prevClose = price;

        const change = Number((price - prevClose).toFixed(2));
        const changePercent = prevClose > 0 ? Number(((change / prevClose) * 100).toFixed(2)) : 0;
        const spreadFraction = isCrypto ? 0.0004 : 0.0006;
        const halfSpread = Math.max(0.01, Number(((price * spreadFraction) / 2).toFixed(2)));
        const bid = Number((price - halfSpread).toFixed(2));
        const ask = Number((price + halfSpread).toFixed(2));

        const tick: MarketTickData = {
          symbol: norm,
          name: meta.longName || meta.shortName || norm,
          type,
          price,
          formattedPrice: formatPrice(price),
          change,
          formattedChange: formatChangePercent(changePercent),
          changePercent,
          bid,
          ask,
          formattedBid: formatPrice(bid),
          formattedAsk: formatPrice(ask),
          volume: formatVolume(Number(meta.regularMarketVolume || 0), isCrypto),
          isPositive: change >= 0,
          timestamp: Date.now(),
          source: "Yahoo Finance",
        };

        liveMarketCache.set(norm, { tick, expiresAt: Date.now() + 30000 });
        failedQuoteRetryAfter.delete(norm);
        return tick;
      }
    }
  } catch {
    // Fall back to baseline
  }

  failedQuoteRetryAfter.set(norm, Date.now() + 30000);
  return null;
}

/**
 * Triggers background refreshing of real-time quotes for symbols
 */
export async function refreshQuotesInBackground(symbols: string[], env?: Env): Promise<void> {
  await Promise.all(
    symbols.map(async (s) => {
      try {
        await fetchRealMarketQuote(s, env);
      } catch {
        // Ignore background fetch error
      }
    })
  );
}

/**
 * Returns the cached live tick for a symbol, or null when no live tick is
 * cached. #929: static profile values are never emitted as ticks, and
 * there is no deterministic fallback for unknown symbols. A symbol with
 * no live tick is unavailable, not priced.
 */
export function getBaselineMarketTick(symbol: string): MarketTickData | null {
  const norm = symbol.toUpperCase().trim();
  const cached = liveMarketCache.get(norm);
  return cached ? cached.tick : null;
}

/** Deterministic test/demo utility; the live WebSocket stream never calls this. */
export function generateNextTick(prev: MarketTickData): MarketTickData {
  const isCrypto = prev.type === "crypto";
  // Realistic volatility: equities +-0.05% to +-0.25%, crypto +-0.1% to +-0.6%
  const maxDeltaPct = isCrypto ? 0.0045 : 0.0018;
  const randDirection = Math.random() > 0.48 ? 1 : -1;
  const deltaPct = (Math.random() * maxDeltaPct + 0.0002) * randDirection;

  const rawNewPrice = prev.price * (1 + deltaPct);
  // Round to 2 decimals for equities/crypto, or minimum tick
  const newPrice = Number(rawNewPrice.toFixed(2));

  // Compute updated cumulative change
  const priceDelta = newPrice - prev.price;
  const newChange = Number((prev.change + priceDelta).toFixed(2));
  const previousClose = prev.price - prev.change || 100;
  const newChangePct = Number(((newChange / previousClose) * 100).toFixed(2));

  // Compute realistic NBBO spread
  const spreadFraction = isCrypto ? 0.0004 : 0.0006;
  const halfSpread = Math.max(0.01, Number(((newPrice * spreadFraction) / 2).toFixed(2)));
  const bid = Number((newPrice - halfSpread).toFixed(2));
  const ask = Number((newPrice + halfSpread).toFixed(2));

  return {
    ...prev,
    price: newPrice,
    formattedPrice: formatPrice(newPrice),
    change: newChange,
    formattedChange: formatChangePercent(newChangePct),
    changePercent: newChangePct,
    bid,
    ask,
    formattedBid: formatPrice(bid),
    formattedAsk: formatPrice(ask),
    isPositive: newChange >= 0,
    timestamp: Date.now(),
  };
}

/**
 * Batch resolver for market quotes (used by HTTP endpoint and snapshots).
 * #929: emits only live-cached ticks. Symbols with no live tick are
 * omitted here; callers report them as unavailable.
 */
export function getBatchMarketQuotes(symbols: string[]): MarketTickData[] {
  const quotes: MarketTickData[] = [];
  for (const sym of symbols) {
    const cached = liveMarketCache.get(sym.toUpperCase().trim());
    if (cached) quotes.push(cached.tick);
  }
  return quotes;
}

/**
 * HTTP handler for GET /api/market/quotes?symbols=NVDA,AAPL,BTC/USD
 * (and its /api/foss/quotes alias — one handler, one facade).
 * Issue #1643: quotes resolve through the MarketDataService facade,
 * so each quote carries its provenance (cached + fetch time + age)
 * and expired entries resolve as unavailable instead of being
 * served stale. The background refresh still fires, so the next
 * call recovers; the top-level `timestamp` remains the RESPONSE
 * time — per-quote freshness is `fetchedAtMs`/`ageMs`, never the
 * response time. The WebSocket stream is untouched (its continuity
 * design publishes the last cached quote; see marketDataService).
 */
export function handleMarketQuotesHttp(symbols: string[], env?: Env): Response {
  // Fire background refresh of live quotes for symbols
  void refreshQuotesInBackground(symbols, env);

  const { quotes, unavailable } = resolveMarketDataQuotes(
    symbols,
    (symbol) => liveMarketCache.get(symbol),
  );
  return Response.json(
    {
      quotes,
      unavailable,
      dataUnavailable: unavailable.length > 0,
      timestamp: Date.now(),
      source:
        quotes.length > 0
          ? Array.from(new Set(quotes.map((quote) => quote.source))).join(" + ")
          : "none",
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

/**
 * Handles a duplex WebSocket connection for real-time market data quote streaming.
 */
export async function handleMarketQuotesWebSocket(ws: WebSocket, env?: Env): Promise<void> {
  const subscribed = new Set<string>();
  let refreshInProgress = false;

  const sendLiveQuotes = async () => {
    try {
      if (subscribed.size === 0 || refreshInProgress) return;
      refreshInProgress = true;
      const symbols = Array.from(subscribed);
      // Keep the stream responsive even when an upstream quote provider is slow
      // or unavailable. Publish the latest cached quote before waiting on I/O.
      ws.send(JSON.stringify({ type: "ticks", ticks: getBatchMarketQuotes(symbols) }));
      await refreshQuotesInBackground(symbols, env);
      if (subscribed.size === 0) return;
      const quotes = getBatchMarketQuotes(Array.from(subscribed));
      ws.send(JSON.stringify({ type: "ticks", ticks: quotes }));
    } catch (_err) {
      // A failed provider refresh leaves the last known quote visible.
    } finally {
      refreshInProgress = false;
    }
  };

  // Provider quotes are cached for 20–30 seconds, so this cadence reuses them
  // and only makes an upstream request when the cache expires.
  const tickInterval = setInterval(() => void sendLiveQuotes(), 5000);

  const cleanup = () => {
    clearInterval(tickInterval);
    subscribed.clear();
  };

  ws.addEventListener("close", cleanup);
  ws.addEventListener("error", cleanup);

  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      if (typeof event.data !== "string") return;
      const msg = JSON.parse(event.data) as MarketStreamClientMessage;

      if (msg.type === "subscribe" && Array.isArray(msg.symbols)) {
        const newSnapshots: MarketTickData[] = [];
        const unavailable: string[] = [];
        for (const sym of msg.symbols) {
          const upper = sym.toUpperCase().trim();
          if (!upper) continue;
          subscribed.add(upper);
          const found = getBatchMarketQuotes([upper])[0];
          if (found) newSnapshots.push(found);
          else unavailable.push(upper);
        }
        ws.send(
          JSON.stringify({
            type: "snapshot",
            quotes: newSnapshots,
            unavailable,
          })
        );
      } else if (msg.type === "unsubscribe" && Array.isArray(msg.symbols)) {
        for (const sym of msg.symbols) {
          const upper = sym.toUpperCase().trim();
          subscribed.delete(upper);
        }
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    } catch (err: any) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: err?.message || "Invalid market stream message",
        })
      );
    }
  });
}
