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
  ETradeOptionChain,
  ETradeOptionExpireDate,
} from "../types";

/** Optional invocation-wide limiter for outbound option API fetch attempts. */
export interface OptionRequestBudget {
  tryConsume(): boolean;
}

export type TradingPlatformId = "etrade" | "alpaca" | "sandbox";
/** Asset classes with implemented order forms and broker routing. Extend this union with a dedicated order adapter when a new market is added. */
export type TradeAssetClass = "equity" | "options";

export interface OrderPreviewParams {
  assetClass?: TradeAssetClass;
  symbol: string;
  action?: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderAction?: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  stopPrice?: number;
  sessionId?: string;
  notes?: string;
  /** Opening legs for a native multi-leg options order. */
  optionLegs?: TradingOrderLeg[];
  /** Net strategy price: positive is debit, negative is credit. */
  strategyNetDebit?: number;
}

export interface TradingOrderLeg {
  underlyingSymbol: string;
  securityType: "EQ" | "OPTN";
  side: "BUY" | "SELL";
  quantity: number;
  optionType?: "CALL" | "PUT";
  strike?: number;
  expirationDate?: string;
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
  optionLegs?: TradingOrderLeg[];
  strategyNetDebit?: number;
}

/**
 * Issue #1393 — frozen snapshot of a previewed proposal's material
 * terms, captured at approval time. When a settle caller supplies
 * these, the platform must refuse execution if the CURRENT draft
 * terms differ: a proposal edited after approval cannot execute
 * under the old approval (invariant 5). The parameter is optional
 * so existing orderId-only callers keep their current behaviour;
 * callers that carry an approval snapshot pass it through.
 */
export interface ExpectedTradeTerms {
  symbol: string;
  action: string;
  quantity: number;
  price: number;
  totalValue: number;
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
  executeOrder(orderId: string, authorizerDid: string, decision: "approved" | "rejected", expectedTerms?: ExpectedTradeTerms): ETradeOrderExecutionResult | Promise<ETradeOrderExecutionResult>;
  placeOrderRemote?(params: PlaceOrderParams): Promise<ETradeOrderExecutionResult>;
  /**
   * Options data reads (issue #291 T5b). Optional: platforms without an
   * options data plane omit them and callers get provider_unsupported.
   * Semantics are the broker client's verbatim passthroughs — no
   * caching, fallback, or provenance rewriting at this layer.
   */
  getOptionChains?(params: {
    symbol: string;
    expiryYear?: number;
    expiryMonth?: number;
    expiryDay?: number;
    strikePrice?: number;
    noOfStrikes?: number;
    includeWeekly?: boolean;
    chainType?: "CALL" | "PUT" | "CALLPUT";
    includeRawResponse?: boolean;
  }, requestBudget?: OptionRequestBudget): Promise<ETradeOptionChain | null>;
  getOptionExpireDates?(symbol: string, expiryType?: string, requestBudget?: OptionRequestBudget): Promise<ETradeOptionExpireDate[]>;
  /**
   * The broker client's last recorded error, if any (issue #155 pattern:
   * read on the SAME instance that made the call). Optional — platforms
   * without a stateful client omit it.
   */
  getLastError?(): string | undefined;
  /**
   * Quote read with the error carried alongside the result (issue #462:
   * concurrent callers must never read shared instance error state).
   * LIVE fetch only — no cache/curated fallback, no policy: the caller
   * names its failure policy (issue #291 quote unification, Q1).
   * Optional — platforms without a detailed read omit it.
   */
  getQuoteDetailed?(symbol: string): Promise<{ quote: ETradeQuote | null; error: string | null }>;
}

export interface IMarketScreener {
  screenMarkets(filter?: StockScreenerFilter): Promise<StockScreenResult>;
}
