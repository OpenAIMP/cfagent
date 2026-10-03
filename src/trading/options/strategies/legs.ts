import type { ScreenedOptionContractItem } from "../../../types";
import type { StrategyLeg } from "../strategyEngine";

export const MULTIPLIER = 100;

export function contractKey(contract: { osiKey?: string; symbol: string; optionType: string; strikePrice: number; expirationDate?: string }): string {
  return contract.osiKey || `${contract.symbol}|${contract.expirationDate ?? ""}|${contract.optionType}|${contract.strikePrice}`;
}

export function toLeg(contract: ScreenedOptionContractItem, side: "BUY" | "SELL", quantity = 1): StrategyLeg {
  const entryPrice = side === "BUY" ? contract.ask : contract.bid;
  return {
    symbol: contractKey(contract),
    optionType: contract.optionType,
    side,
    quantity,
    strike: contract.strikePrice,
    expirationDate: contract.expirationDate,
    daysToExpiration: contract.daysToExpiration,
    entryPrice,
    bid: contract.bid,
    ask: contract.ask,
    impliedVolatility: contract.impliedVolatility ?? 0,
    delta: contract.delta ?? 0,
    gamma: contract.gamma ?? 0,
    theta: contract.theta ?? 0,
    vega: contract.vega ?? 0,
    openInterest: contract.openInterest ?? 0,
    volume: contract.volume ?? 0,
    spreadPct: contract.spreadPct,
    quoteTimestamp: contract.quoteTimestamp || "",
    quoteAgeSeconds: contract.quoteAgeSeconds,
    quoteFreshness: contract.quoteFreshness || "UNKNOWN",
    multiplier: MULTIPLIER,
  };
}

/** Stock leg for stock-plus-option structures; quantity is a share count (one unit per share). */
export function toStockLeg(symbol: string, price: number, side: "BUY" | "SELL", shares: number, expirationDate: string): StrategyLeg {
  return {
    symbol: `${symbol.toUpperCase()}:STOCK`,
    optionType: "STOCK",
    side,
    quantity: shares,
    strike: 0,
    expirationDate,
    entryPrice: price,
    bid: price,
    ask: price,
    impliedVolatility: 0,
    delta: 1,
    gamma: 0,
    theta: 0,
    vega: 0,
    openInterest: 0,
    volume: 0,
    spreadPct: 0,
    quoteTimestamp: "",
    quoteFreshness: "UNKNOWN",
    multiplier: 1,
  };
}
