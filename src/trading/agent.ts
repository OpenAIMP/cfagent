/**
 * Trading Micro-Agent
 *
 * Implements:
 * - Autonomous stock scanning, risk management, and order drafting.
 * - Human-in-the-Loop (HITL) safety boundary: strictly proposals until user confirms.
 * - W3C Agent DID attestation stamping.
 */

import type { Env, StockScreenerFilter, StockScreenResult, ETradeOrderDraft, ETradeOrderExecutionResult } from "../types";
import type { DatabaseORM } from "../orm";
import type { ITradingPlatform, OrderPreviewParams } from "./interfaces";
import { TradingPlatformRegistry } from "./registry";
import { DynamicMarketScreener } from "./screener";
import { AGENT_DIDS } from "../agents/did";

export class TradingMicroAgent {
  private platform: ITradingPlatform;
  private screener: DynamicMarketScreener;

  constructor(
    private env: Env,
    private orm?: DatabaseORM,
    private userLogin: string = "default_trader",
    platformId: "etrade" | "alpaca" | "foss" | "sandbox" = "etrade"
  ) {
    this.platform = TradingPlatformRegistry.getPlatform(platformId, env, orm, userLogin);
    this.screener = new DynamicMarketScreener();
  }

  /**
   * Autonomously screens market for investment opportunities
   */
  async screenOpportunities(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    if (this.platform.screenMarkets) return this.platform.screenMarkets(filter);
    return this.screener.screenStocks(filter);
  }

  /**
   * Evaluates equity thesis and drafts proposed order with DID attestation
   */
  async proposeTrade(params: OrderPreviewParams): Promise<ETradeOrderDraft> {
    // Risk Management boundary: cap single order size if unreasonable
    if (params.quantity > 10000) {
      throw new Error(`Risk violation: Order quantity [${params.quantity}] exceeds single-transaction risk ceiling.`);
    }

    return this.platform.previewOrder(params);
  }

  /**
   * Confirms human decision and routes order to exchange
   */
  async executeConfirmedOrder(
    orderId: string,
    authorizerDid: string,
    decision: "approved" | "rejected"
  ): Promise<ETradeOrderExecutionResult> {
    return this.platform.executeOrder(orderId, authorizerDid, decision);
  }
}
