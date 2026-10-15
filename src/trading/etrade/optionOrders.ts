import type { TradingOrderLeg } from "../interfaces";

export type ETradeOrderKind = "EQ" | "OPTN" | "SPREADS" | "BUY_WRITES";

export function validateTradingOrderLegs(legs: TradingOrderLeg[], fallbackSymbol: string): string | null {
  if (legs.length === 0) return null;
  if (legs.length > 4) return "E*TRADE supports up to four legs in a complex options order.";
  for (const [index, leg] of legs.entries()) {
    if (leg.securityType !== "EQ" && leg.securityType !== "OPTN") return `Leg ${index + 1} must be an equity or listed option.`;
    if (leg.side !== "BUY" && leg.side !== "SELL") return `Leg ${index + 1} side must be BUY or SELL.`;
    if (typeof leg.underlyingSymbol !== "string" || leg.underlyingSymbol.toUpperCase() !== fallbackSymbol.toUpperCase()) return `Leg ${index + 1} uses a different underlying symbol.`;
    if (!Number.isInteger(leg.quantity) || leg.quantity < 1) return `Leg ${index + 1} quantity must be a positive whole number.`;
    if (leg.securityType === "OPTN") {
      const date = leg.expirationDate || "";
      const parsedDate = new Date(`${date}T00:00:00.000Z`);
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;
      if ((leg.optionType !== "CALL" && leg.optionType !== "PUT") || !Number.isFinite(leg.strike) || Number(leg.strike) <= 0 || !validDate) {
        return `Option leg ${index + 1} must include call/put, strike, and an ISO expiration date.`;
      }
    }
  }
  const stockLegs = legs.filter((leg) => leg.securityType === "EQ");
  const optionLegs = legs.filter((leg) => leg.securityType === "OPTN");
  if (stockLegs.length && optionLegs.length) {
    const supportedBuyWrite = legs.length === 2
      && stockLegs.length === 1 && optionLegs.length === 1
      && stockLegs[0].side === "BUY" && stockLegs[0].quantity === 100
      && optionLegs[0].side === "SELL" && optionLegs[0].optionType === "CALL"
      && optionLegs[0].quantity === 1;
    if (!supportedBuyWrite) return "This stock/option combination cannot be routed as one atomic E*TRADE order. Use a broker-supported covered call or trade the legs separately after reviewing legging risk.";
  }
  return null;
}

export function etradeOrderKind(legs: TradingOrderLeg[]): ETradeOrderKind {
  if (legs.length === 0 || legs.every((leg) => leg.securityType === "EQ")) return "EQ";
  if (legs.length === 1 && legs[0].securityType === "OPTN") return "OPTN";
  if (legs.some((leg) => leg.securityType === "EQ")) return "BUY_WRITES";
  return "SPREADS";
}

export function toETradeInstruments(legs: TradingOrderLeg[]) {
  return legs.map((leg) => {
    const Product = leg.securityType === "EQ"
      ? { securityType: "EQ", symbol: leg.underlyingSymbol.toUpperCase() }
      : {
          securityType: "OPTN",
          symbol: leg.underlyingSymbol.toUpperCase(),
          callPut: leg.optionType,
          expiryYear: leg.expirationDate!.slice(0, 4),
          expiryMonth: leg.expirationDate!.slice(5, 7),
          expiryDay: leg.expirationDate!.slice(8, 10),
          strikePrice: String(leg.strike),
        };
    const orderAction = leg.securityType === "EQ"
      ? (leg.side === "BUY" ? "BUY" : "SELL_SHORT")
      : `${leg.side}_OPEN`;
    return { Product, orderAction, quantityType: "QUANTITY", orderedQuantity: leg.quantity, quantity: leg.quantity };
  });
}

export function etradeNetPriceType(netDebit: number): "NET_DEBIT" | "NET_CREDIT" {
  return netDebit < 0 ? "NET_CREDIT" : "NET_DEBIT";
}
