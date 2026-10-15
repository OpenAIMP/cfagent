import { describe, expect, it } from "vitest";
import { etradeNetPriceType, etradeOrderKind, etradePriceType, toETradeInstruments, validateTradingOrderLegs } from "../src/trading/etrade/optionOrders";
import type { TradingOrderLeg } from "../src/trading/interfaces";

const vertical: TradingOrderLeg[] = [
  { underlyingSymbol: "CRWV", securityType: "OPTN", side: "SELL", quantity: 1, optionType: "PUT", strike: 30, expirationDate: "2026-11-20" },
  { underlyingSymbol: "CRWV", securityType: "OPTN", side: "BUY", quantity: 1, optionType: "PUT", strike: 25, expirationDate: "2026-11-20" },
];

describe("E*TRADE strategy order mapping", () => {
  it("maps a vertical to one native spread with exact option contracts and open actions", () => {
    expect(etradeOrderKind(vertical)).toBe("SPREADS");
    expect(toETradeInstruments(vertical)).toEqual([
      { Product: { securityType: "OPTN", symbol: "CRWV", callPut: "PUT", expiryYear: "2026", expiryMonth: "11", expiryDay: "20", strikePrice: "30" }, orderAction: "SELL_OPEN", quantityType: "QUANTITY", orderedQuantity: 1, quantity: 1 },
      { Product: { securityType: "OPTN", symbol: "CRWV", callPut: "PUT", expiryYear: "2026", expiryMonth: "11", expiryDay: "20", strikePrice: "25" }, orderAction: "BUY_OPEN", quantityType: "QUANTITY", orderedQuantity: 1, quantity: 1 },
    ]);
  });

  it("uses option and equity order kinds for single-contract and stock orders", () => {
    expect(etradeOrderKind([vertical[0]])).toBe("OPTN");
    expect(etradeOrderKind([{ underlyingSymbol: "CRWV", securityType: "EQ", side: "BUY", quantity: 10 }])).toBe("EQ");
    expect(etradeNetPriceType(125)).toBe("NET_DEBIT");
    expect(etradeNetPriceType(-40)).toBe("NET_CREDIT");
    expect(etradePriceType([vertical[0]], "LIMIT", -40)).toBe("LIMIT");
    expect(etradePriceType(vertical, "LIMIT", -40)).toBe("NET_CREDIT");
  });

  it("accepts native covered calls and rejects unsafe or malformed combinations", () => {
    const buyWrite: TradingOrderLeg[] = [
      { underlyingSymbol: "CRWV", securityType: "EQ", side: "BUY", quantity: 100 },
      { ...vertical[0], side: "SELL", optionType: "CALL", quantity: 1 },
    ];
    expect(validateTradingOrderLegs(buyWrite, "CRWV")).toBeNull();
    expect(validateTradingOrderLegs([
      { underlyingSymbol: "CRWV", securityType: "EQ", side: "SELL", quantity: 100 },
      { ...vertical[0], side: "BUY" },
    ], "CRWV")).toMatch(/cannot be routed as one atomic/);
    expect(validateTradingOrderLegs([{ ...vertical[0], strike: 0 }], "CRWV")).toMatch(/strike/);
    expect(validateTradingOrderLegs(vertical, "NVDA")).toMatch(/different underlying/);
  });
});
