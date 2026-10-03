/**
 * Pluggable Trading Capability Architecture: Domain Interfaces
 *
 * Implements:
 * - Strategy Pattern (GoF): ITradingPlatform abstracts individual brokerage/exchange platforms.
 * - Single Responsibility Principle (SRP): Decouples platform communication from agent reasoning and screening.
 * - Open/Closed Principle (OCP): New platforms (E*TRADE, Alpaca, Interactive Brokers) plug in without modifying existing code.
 */

import type {
  ETradeQuote,
  StockScreenerFilter,
  StockScreenResult,
  ScreenedStockItem,
  ETradeOrderDraft,
  ETradeOrderExecutionResult,
  ETradePosition,
  ETradePositionLot,
  ETradeAccount,
  ETradeBrokerStatus,
} from "../types";

export type TradingPlatformId = "etrade" | "alpaca" | "foss" | "sandbox";

export interface OrderPreviewParams {
  symbol: string;
  action?: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderAction?: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  stopPrice?: number;
  sessionId?: string;
  notes?: string;
}

export interface PlaceOrderParams {
  orderId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: string;
  limitPrice?: number;
  previewId?: string;
  userLogin: string;
}

export interface ITradingPlatform {
  readonly platformId: TradingPlatformId;
  readonly name: string;

  getStatus(): Promise<ETradeBrokerStatus>;
  getQuote(symbol: string): Promise<ETradeQuote>;
  screenMarkets?(filter?: StockScreenerFilter): Promise<StockScreenResult>;
  getAccounts(): Promise<ETradeAccount[]>;
  getPositions(accountKey?: string, includeBalance?: boolean): Promise<{ account: ETradeAccount; positions: ETradePosition[] }>;
  getPositionLots?(accountKey: string, positionId: string): Promise<ETradePositionLot[]>;
  previewOrder(params: OrderPreviewParams): Promise<ETradeOrderDraft>;
  executeOrder(orderId: string, authorizerDid: string, decision: "approved" | "rejected"): ETradeOrderExecutionResult | Promise<ETradeOrderExecutionResult>;
  placeOrderRemote?(params: PlaceOrderParams): Promise<ETradeOrderExecutionResult>;
}

export interface IMarketScreener {
  screenMarkets(filter?: StockScreenerFilter): Promise<StockScreenResult>;
}
