import type { TradeAssetClass } from "../../trading/interfaces";

/** Asset-aware handoff from research and portfolio tools to the shared order ticket.
 * Add a new asset class here together with its ticket fields and broker adapter;
 * unsupported classes must not be routed through the equity/options payload.
 */
export type { TradeAssetClass };

export interface TradeOrderLeg {
  securityType: "EQ" | "OPTN";
  side: "BUY" | "SELL";
  quantity: number;
  optionType?: "CALL" | "PUT";
  strike?: number;
  expirationDate?: string;
}

export interface TradeOrderContext {
  assetClass: TradeAssetClass;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  underlyingPrice?: number;
  label: string;
  legs: string[];
  optionLegs?: TradeOrderLeg[];
  /** Positive is net debit; negative is net credit. */
  strategyNetDebit?: number;
}

