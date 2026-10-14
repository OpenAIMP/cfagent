/**
 * Real-Time Market Data WebSocket Streaming Engine
 *
 * Implements Issue #21:
 * - Real-time streaming of Level 1 quotes (last price, bid, ask, volume, daily change %)
 * - Support for equities (NVDA, AAPL, MSFT, TSLA, SPY, QQQ) and crypto (BTC/USD, ETH/USD, SOL/USD)
 * - Tick update generator with realistic volatility modeling and NBBO spread maintenance
 * - WebSocket session lifecycle management with clean teardown and heartbeat support
 * - Batch HTTP snapshot fallback for non-WebSocket clients
 */

import { FOSS_MARKET_UNIVERSE, StockMarketProfile } from "./fossResearch";
import type { Env } from "../types";

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
}

export type MarketStreamClientMessage =
  | { type: "subscribe"; symbols: string[] }
  | { type: "unsubscribe"; symbols: string[] }
  | { type: "ping" };

export type MarketStreamServerMessage =
  | { type: "snapshot"; quotes: MarketTickData[] }
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

/**
 * Resolves or deterministically calculates a baseline market quote.
 */
export function getBaselineMarketTick(symbol: string): MarketTickData {
  const norm = symbol.toUpperCase().trim();
  const profile = FOSS_MARKET_UNIVERSE[norm];
  const type = classifyAssetType(norm);
  const isCrypto = type === "crypto";

  if (profile) {
    return {
      symbol: norm,
      name: profile.name,
      type,
      price: profile.price,
      formattedPrice: formatPrice(profile.price),
      change: profile.change,
      formattedChange: formatChangePercent(profile.changePercent),
      changePercent: profile.changePercent,
      bid: profile.bid,
      ask: profile.ask,
      formattedBid: formatPrice(profile.bid),
      formattedAsk: formatPrice(profile.ask),
      volume: formatVolume(profile.volume, isCrypto),
      isPositive: profile.change >= 0,
      timestamp: Date.now(),
    };
  }

  // Deterministic fallback for unknown symbols
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = (hash << 5) - hash + norm.charCodeAt(i);
    hash |= 0;
  }
  const pos = Math.abs(hash);
  const price = 50 + (pos % 250) + ((pos % 100) / 100);
  const changePct = ((pos % 600) - 250) / 100;
  const change = Number(((price * changePct) / 100).toFixed(2));
  const spread = Math.max(0.02, Number((price * 0.0008).toFixed(2)));
  const bid = Number((price - spread / 2).toFixed(2));
  const ask = Number((price + spread / 2).toFixed(2));

  return {
    symbol: norm,
    name: `${norm} Corporation`,
    type,
    price,
    formattedPrice: formatPrice(price),
    change,
    formattedChange: formatChangePercent(changePct),
    changePercent: changePct,
    bid,
    ask,
    formattedBid: formatPrice(bid),
    formattedAsk: formatPrice(ask),
    volume: formatVolume(1200000 + (pos % 10000000), isCrypto),
    isPositive: change >= 0,
    timestamp: Date.now(),
  };
}

/**
 * Generates the next realistic price tick from the previous tick.
 */
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
 */
export function getBatchMarketQuotes(symbols: string[]): MarketTickData[] {
  return symbols.map((sym) => getBaselineMarketTick(sym));
}

/**
 * HTTP handler for GET /api/market/quotes?symbols=NVDA,AAPL,BTC/USD
 */
export function handleMarketQuotesHttp(symbols: string[]): Response {
  const quotes = getBatchMarketQuotes(symbols);
  return Response.json(
    { quotes, timestamp: Date.now() },
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
export async function handleMarketQuotesWebSocket(ws: WebSocket, _env?: Env): Promise<void> {
  const subscribed = new Set<string>();
  const liveStates = new Map<string, MarketTickData>();

  // Interval timer for pushing realistic price ticks
  const tickInterval = setInterval(() => {
    try {
      if (subscribed.size === 0) return;

      const subArray = Array.from(subscribed);
      // Select 1 to 2 random symbols to generate ticks
      const sampleCount = Math.min(subArray.length, Math.random() > 0.6 ? 2 : 1);
      const chosenSymbols = new Set<string>();

      for (let i = 0; i < sampleCount; i++) {
        const randIdx = Math.floor(Math.random() * subArray.length);
        chosenSymbols.add(subArray[randIdx]);
      }

      for (const sym of chosenSymbols) {
        let current = liveStates.get(sym);
        if (!current) {
          current = getBaselineMarketTick(sym);
        }
        const nextTick = generateNextTick(current);
        liveStates.set(sym, nextTick);

        ws.send(
          JSON.stringify({
            type: "tick",
            tick: nextTick,
          })
        );
      }
    } catch (_err) {
      // In case WebSocket is closed or faulted, clear interval
      clearInterval(tickInterval);
    }
  }, 1600);

  const cleanup = () => {
    clearInterval(tickInterval);
    subscribed.clear();
    liveStates.clear();
  };

  ws.addEventListener("close", cleanup);
  ws.addEventListener("error", cleanup);

  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      if (typeof event.data !== "string") return;
      const msg = JSON.parse(event.data) as MarketStreamClientMessage;

      if (msg.type === "subscribe" && Array.isArray(msg.symbols)) {
        const newSnapshots: MarketTickData[] = [];
        for (const sym of msg.symbols) {
          const upper = sym.toUpperCase().trim();
          if (!upper) continue;
          subscribed.add(upper);
          if (!liveStates.has(upper)) {
            const baseline = getBaselineMarketTick(upper);
            liveStates.set(upper, baseline);
            newSnapshots.push(baseline);
          } else {
            newSnapshots.push(liveStates.get(upper)!);
          }
        }
        ws.send(
          JSON.stringify({
            type: "snapshot",
            quotes: newSnapshots,
          })
        );
      } else if (msg.type === "unsubscribe" && Array.isArray(msg.symbols)) {
        for (const sym of msg.symbols) {
          const upper = sym.toUpperCase().trim();
          subscribed.delete(upper);
          liveStates.delete(upper);
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
