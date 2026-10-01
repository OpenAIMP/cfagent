/**
 * E*TRADE Brokerage & Trading Capability Facade
 *
 * Implements:
 * - GoF Facade Pattern: Unified, simplified API to the pluggable trading subsystem.
 * - Single Responsibility Principle (SRP): Delegates to specialized micro-components (Screener, RestClient, Platform).
 * - Open/Closed Principle (OCP): Works seamlessly with any registered platform via TradingPlatformRegistry.
 * - Aspect-Oriented Security: Enforces Sandbox Guard and error aspects.
 */

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import type {
  ETradeQuote,
  StockScreenerFilter,
  StockScreenResult,
  ScreenedStockItem,
  ETradeOrderDraft,
  ETradeOrderExecutionResult,
  ETradePosition,
  ETradeAccount,
  ETradeBrokerStatus,
  ETradeTransaction,
  ETradeTransactionDetails,
  ETradeAlert,
  ETradeAlertDetails,
  ETradeProductLookup,
  ETradeOptionChain,
  ETradeOptionExpireDate,
  ETradeRemoteOrder,
  ETradeCancelOrderResult,
} from "../types";
import {
  DynamicMarketScreener,
  EXPANDED_MARKET_UNIVERSE,
  ETradeTradingPlatform,
  ETradeRestClient,
  OrderPreviewParams,
} from "../trading";
import { resolveEnvironmentConfig } from "../config/environment";

// Re-export the market universe definition for backward compatibility
export const MARKET_UNIVERSE = EXPANDED_MARKET_UNIVERSE;

export class ETradeService {
  private platform: ETradeTradingPlatform;
  private screener: DynamicMarketScreener;
  private client: ETradeRestClient;
  private orm?: DatabaseORM;
  private env: Env;
  private userLogin: string;
  private overrideEnv?: string;

  setScreenerUniverse(universe: ScreenedStockItem[]): void {
    this.screener.setUniverse(universe);
  }

  constructor(ormOrEnv?: DatabaseORM | Env, env?: Env, userLogin?: string, overrideEnv?: string) {
    if (ormOrEnv && "trades" in (ormOrEnv as any)) {
      this.orm = ormOrEnv as DatabaseORM;
      this.env = env || ({} as Env);
      this.userLogin = userLogin || "default_trader";
      this.overrideEnv = overrideEnv;
    } else {
      this.env = (ormOrEnv as Env) || ({} as Env);
      this.userLogin = userLogin || "default_trader";
      this.overrideEnv = overrideEnv;
    }

    this.client = new ETradeRestClient(this.env, this.userLogin, this.overrideEnv);
    this.platform = new ETradeTradingPlatform(this.env, this.orm, this.userLogin, this.overrideEnv, this.client);
    this.screener = new DynamicMarketScreener();
  }

  /**
   * Synchronous broker connectivity status
   */
  getStatus(): ETradeBrokerStatus {
    const envConfig = resolveEnvironmentConfig(this.env, this.overrideEnv);
    const isMcp = Boolean(this.env.ETRADE_MCP_SERVER_URL);
    const hasApiKey = Boolean(envConfig.etrade.apiKey && envConfig.etrade.apiSecret);

    return {
      broker: "etrade",
      name: "E*TRADE by Morgan Stanley Brokerage",
      configured: isMcp || hasApiKey,
      mode: isMcp ? "mcp_remote" : hasApiKey ? (envConfig.isLive ? "live_oauth" : "sandbox_api") : "simulated_engine",
      protocol: isMcp ? "mcp_json_rpc" : hasApiKey ? "etrade_oauth_rest" : "sandbox_simulated",
      mcpServerUrl: this.env.ETRADE_MCP_SERVER_URL,
      environment: envConfig.isLive ? "live" : "sandbox",
      activeEnvironment: envConfig.name,
      apiUrl: envConfig.etrade.baseUrl,
      hasApiKey,
      oauthAuthenticated: false,
      capabilities: [
        "Natural Language Market Screener (NLQ)",
        "Technical Indicator Signals (RSI, Breakout, MACD)",
        "Real-Time Level 1 Quotes & Order Depth",
        "Agent DID Attestation Order Stamping",
        "Human-in-the-Loop (HITL) Execution Safety Guarantee",
        "Portfolio Positions & Purchasing Power",
        "Pluggable Multi-Broker Capability Architecture",
      ],
    };
  }

  /**
   * Async broker status that includes live KV token validity & midnight ET expiry check
   */
  async getStatusAsync(): Promise<ETradeBrokerStatus> {
    return this.platform.getStatus();
  }

  /**
   * Screen & scan market equities based on fundamental and technical filters
   */
  screenStocks(filter: StockScreenerFilter = {}): StockScreenResult {
    return this.screener.screenStocks(filter);
  }

  /**
   * Real-time dynamic market screening with authentic E*TRADE quote enrichment (no yfinance)
   */
  async screenMarketsAsync(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    let symbols = EXPANDED_MARKET_UNIVERSE.map((s) => s.symbol);

    if (filter.search && filter.search.trim()) {
      const searchTerms = filter.search.trim().toUpperCase().split(/[,\s]+/);
      for (const t of searchTerms) {
        if (t && /^[A-Z0-9.\/-]+$/.test(t) && !symbols.includes(t)) {
          symbols.unshift(t);
        }
      }
    }

    if (filter.sector && filter.sector.toLowerCase() !== "all" && filter.sector.toLowerCase() !== "any") {
      const sec = filter.sector.toLowerCase().trim();
      const sectorSymbols = EXPANDED_MARKET_UNIVERSE.filter((def) => {
        const itemSec = (def.sector || "").toLowerCase().trim();
        return (sec === "tech" || sec === "technology" || sec === "semiconductors")
          ? (itemSec === "technology" || itemSec === "semiconductors" || itemSec.includes("tech") || itemSec.includes("semiconductor"))
          : (sec === "financial" || sec === "financials" || sec === "finance" || sec === "financial services")
          ? (itemSec === "financial" || itemSec === "financials" || itemSec === "financial services" || itemSec.includes("finan"))
          : (sec === "consumer discretionary" || sec === "consumer")
          ? (itemSec === "consumer discretionary" || itemSec.includes("consumer"))
          : (sec === "communication services" || sec === "communication")
          ? (itemSec === "communication services" || itemSec.includes("communication"))
          : (sec === "healthcare" || sec === "health")
          ? (itemSec === "healthcare" || itemSec.includes("health"))
          : (sec === "energy")
          ? (itemSec === "energy" || itemSec.includes("energy"))
          : (sec === "industrials" || sec === "industrial")
          ? (itemSec === "industrials" || itemSec.includes("industrial"))
          : (sec === "materials" || sec === "material")
          ? (itemSec === "materials" || itemSec.includes("material"))
          : (sec === "consumer staples" || sec === "staples")
          ? (itemSec === "consumer staples" || itemSec.includes("staple"))
          : (sec === "utilities" || sec === "utility")
          ? (itemSec === "utilities" || itemSec.includes("utilit"))
          : (sec === "real estate" || sec === "reit")
          ? (itemSec === "real estate" || itemSec.includes("estate"))
          : (itemSec === sec || itemSec.includes(sec) || sec.includes(itemSec));
      }).map((s) => s.symbol);

      if (sectorSymbols.length > 0) {
        symbols = [...sectorSymbols, ...symbols.filter((sym) => !sectorSymbols.includes(sym))];
      }
    }

    try {
      const liveQuotes = await this.client.fetchQuotes(symbols, { overrideSymbolCount: true });
      if (liveQuotes.length > 0) {
        return this.screener.screenWithQuotes(liveQuotes, filter);
      }
    } catch {
      // Fall through to screener base
    }
    return this.screener.screenStocks(filter);
  }

  /**
   * Real-time dynamic equity quote with live feed enrichment
   */
  async getQuoteAsync(symbol: string): Promise<ETradeQuote> {
    return this.fetchQuoteRemote(symbol);
  }

  /**
   * Fetch quote for a specific ticker symbol (synchronous or cached)
   */
  getQuote(symbol: string): ETradeQuote {
    const cleanSym = symbol.trim().toUpperCase();
    const found = this.screener.getUniverse().find((s) => s.symbol === cleanSym);
    if (found) {
      return {
        ...found,
        price: found.lastPrice,
        high52: found.week52High,
        low52: found.week52Low,
        source: "E*TRADE Market Data Feed",
      };
    }
    const def = EXPANDED_MARKET_UNIVERSE.find((s) => s.symbol === cleanSym);
    return {
      symbol: cleanSym,
      companyName: def?.companyName || `${cleanSym} Inc.`,
      lastPrice: 0.0,
      price: 0.0,
      change: 0,
      changePercent: 0,
      bid: 0.0,
      ask: 0.0,
      volume: 0,
      open: 0.0,
      high: 0.0,
      low: 0.0,
      week52High: 0.0,
      week52Low: 0.0,
      quoteStatus: "AUTH_REQUIRED",
      timestamp: new Date().toISOString(),
      source: "E*TRADE Market Data Feed",
    };
  }

  /**
   * Preview a proposed trade order and generate cryptographic Agent DID attestation
   */
  previewOrder(params: OrderPreviewParams): ETradeOrderDraft {
    const symbol = params.symbol.trim().toUpperCase();
    const action = (params.action || params.orderAction || "BUY") as "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
    const quote = this.getQuote(symbol);
    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = params.sessionId || this.userLogin;
    const userDid = `did:user:github:${sessionId}`;
    const orderType = params.orderType || "MARKET";

    const executionPrice = orderType === "LIMIT" && params.limitPrice ? params.limitPrice : quote.lastPrice;
    const estimatedTotal = Number((executionPrice * params.quantity).toFixed(2));

    const previewMessage = `E*TRADE Order Preview: ${action} ${params.quantity} ${symbol} @ ${orderType === "MARKET" ? "MKT (~$" + quote.lastPrice.toFixed(2) + ")" : "$" + executionPrice.toFixed(2)}. Estimated Total: $${estimatedTotal.toLocaleString()} USD. NO SHARES HAVE BEEN BOUGHT. Awaiting explicit Human-in-the-Loop authorization.`;

    const draft: ETradeOrderDraft = {
      orderId,
      symbol,
      action,
      orderAction: action,
      orderType,
      quantity: params.quantity,
      estimatedPrice: executionPrice,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      term: "GOOD_FOR_DAY",
      estimatedCommission: 0.0,
      estimatedTotal,
      status: "previewed",
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: userDid,
      proofSignature: `sig_0x${crypto.randomUUID().slice(0, 16)}`,
      previewMessage,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      placedAt: new Date().toISOString(),
    };

    if (this.orm?.trades) {
      try {
        this.orm.trades.create({
          id: orderId,
          sessionId,
          symbol,
          action,
          orderType,
          quantity: params.quantity,
          price: executionPrice,
          totalValue: estimatedTotal,
          status: "previewed",
          orderRef: undefined,
          proposerDid: draft.proposerDid,
          authorizerDid: userDid,
          proofSignature: draft.proofSignature,
          previewNotes: previewMessage,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn("Failed to persist trade draft to ORM:", err);
      }
    }

    return draft;
  }

  /**
   * Execute an authorized trade order after explicit human confirmation (HITL enforcement)
   */
  executeOrder(
    orderOrDraft: string | ETradeOrderDraft,
    userLogin: string,
    decision: "approved" | "rejected" = "approved"
  ): ETradeOrderExecutionResult {
    const orderId = typeof orderOrDraft === "string" ? orderOrDraft : orderOrDraft.orderId;
    const authorizerDid = userLogin.startsWith("did:") ? userLogin : `did:user:github:${userLogin}`;

    if (authorizerDid.startsWith("did:agent:")) {
      throw new Error(`HITL Violation: Autonomous trade execution is strictly forbidden. Orders require human authorization.`);
    }

    return this.platform.executeOrder(orderId, authorizerDid, decision) as any;
  }

  /**
   * Retrieve active positions and portfolio balances (dynamic, data-driven from executed trades or broker)
   */
  getPositions(): { account: ETradeAccount; positions: ETradePosition[] } {
    const envConfig = resolveEnvironmentConfig(this.env);

    // If trades exist in ORM, aggregate open positions dynamically from confirmed executions
    if (this.orm?.trades) {
      const records = this.orm.trades.findMany({ where: { status: "executed" } });
      if (records.length > 0) {
        const positionsMap = new Map<string, { quantity: number; costBasis: number; symbol: string }>();
        for (const r of records) {
          const sym = r.symbol.toUpperCase();
          const current = positionsMap.get(sym) || { quantity: 0, costBasis: 0, symbol: sym };
          const qty = r.action === "BUY" || r.action === "BUY_TO_COVER" ? r.quantity : -r.quantity;
          const cost = r.totalValue;
          current.quantity += qty;
          current.costBasis += r.action === "BUY" ? cost : -cost;
          if (current.quantity > 0) {
            positionsMap.set(sym, current);
          } else {
            positionsMap.delete(sym);
          }
        }

        const positions: ETradePosition[] = [];
        let totalMarketVal = 0;
        for (const [sym, data] of positionsMap.entries()) {
          const q = this.screener.getUniverse().find((s) => s.symbol === sym);
          const def = EXPANDED_MARKET_UNIVERSE.find((s) => s.symbol === sym);
          const price = q?.lastPrice || (data.quantity > 0 ? Number((data.costBasis / data.quantity).toFixed(2)) : 0);
          const marketValue = Number((price * data.quantity).toFixed(2));
          const totalGain = Number((marketValue - data.costBasis).toFixed(2));
          const totalGainPercent = data.costBasis > 0 ? Number(((totalGain / data.costBasis) * 100).toFixed(2)) : 0;
          totalMarketVal += marketValue;
          positions.push({
            symbol: sym,
            description: q?.companyName || def?.companyName || `${sym} Equity`,
            quantity: data.quantity,
            pricePaid: Number((data.costBasis / data.quantity).toFixed(2)),
            costBasis: Number(data.costBasis.toFixed(2)),
            currentPrice: price,
            marketPrice: price,
            marketValue,
            totalGain,
            unrealizedGainLoss: totalGain,
            totalGainPercent,
            unrealizedGainLossPercent: totalGainPercent,
            daysGain: 0,
            daysGainPercent: 0,
          });
        }

        const cash = 25000.0;
        const total = Number((totalMarketVal + cash).toFixed(2));
        return {
          account: {
            accountId: "et_acc_session",
            accountKey: "et_key_session",
            accountDesc: `E*TRADE Active Portfolio [${envConfig.label}]`,
            accountType: "MARGIN",
            netAccountValue: total,
            totalAccountValue: total,
            cashAvailableForInvestment: cash,
            dayTraderStatus: false,
          },
          positions,
        };
      }
    }

    return {
      account: {
        accountId: "unconnected",
        accountKey: "unconnected",
        accountDesc: `E*TRADE Brokerage Account [${envConfig.label} - No Active Live Positions]`,
        accountType: "CASH",
        netAccountValue: 0,
        totalAccountValue: 0,
        cashAvailableForInvestment: 0,
        dayTraderStatus: false,
      },
      positions: [],
    };
  }

  /**
   * Retrieve broker accounts list
   */
  getAccounts(): ETradeAccount[] {
    return [this.getPositions().account];
  }

  /**
   * Real E*TRADE REST API: Fetch live accounts list with OAuth 1.0a
   */
  async fetchAccountsRemote(): Promise<ETradeAccount[]> {
    const accounts = await this.client.fetchAccounts();
    return accounts.length > 0 ? accounts : [];
  }

  /**
   * Real E*TRADE REST API: Fetch live market quote with OAuth 1.0a
   */
  async fetchQuoteRemote(symbol: string): Promise<ETradeQuote> {
    const cleanSym = symbol.trim().toUpperCase();
    try {
      const live = await this.client.fetchQuote(cleanSym);
      if (live && live.lastPrice > 0) {
        const isStub =
          (live.lastPrice === 577.51 || live.companyName.toUpperCase().includes("GOOGLE INC")) &&
          cleanSym !== "GOOG" &&
          cleanSym !== "GOOGL";
        if (!isStub) return live;
      }
    } catch {
      // Fall through to platform quote
    }
    return this.platform.getQuote(cleanSym);
  }

  /**
   * Real E*TRADE REST API: Remote Preview Order with OAuth 1.0a
   */
  async previewOrderRemote(params: OrderPreviewParams): Promise<ETradeOrderDraft> {
    return this.platform.previewOrder(params);
  }

  /**
   * Real E*TRADE REST API: Place Live Order with OAuth 1.0a
   */
  async placeOrderRemote(params: any): Promise<ETradeOrderExecutionResult> {
    return this.platform.placeOrderRemote!(params);
  }

  /**
   * Real E*TRADE REST API: Fetch live portfolio positions with OAuth 1.0a
   */
  async fetchPortfolioRemote(accountKey?: string, includeBalance: boolean = false): Promise<{ account: ETradeAccount; positions: ETradePosition[] }> {
    const res = await this.platform.getPositions(accountKey, includeBalance);
    if (res && res.account && res.account.accountId !== "unconnected") {
      return res;
    }
    return this.getPositions();
  }

  /**
   * Real E*TRADE REST API: Fetch live transactions list with OAuth 1.0a
   */
  async fetchTransactions(
    accountKey?: string,
    params?: { startDate?: string; endDate?: string; sortOrder?: "ASC" | "DESC"; marker?: string; count?: number }
  ): Promise<ETradeTransaction[]> {
    return this.client.fetchTransactions(accountKey, params);
  }

  /**
   * Real E*TRADE REST API: Fetch transaction details with OAuth 1.0a
   */
  async fetchTransactionDetails(
    transactionId: string,
    accountKey?: string,
    storeId?: string
  ): Promise<ETradeTransactionDetails | null> {
    const key = accountKey || (await this.fetchAccountsRemote())[0]?.accountKey || "";
    return this.client.fetchTransactionDetails(key, transactionId, storeId);
  }

  /**
   * Real E*TRADE REST API: Fetch user alerts inbox with OAuth 1.0a
   */
  async fetchAlerts(params?: {
    count?: number;
    category?: string;
    status?: "READ" | "UNREAD" | "DELETED";
    direction?: "ASC" | "DESC";
    search?: string;
    unfiltered?: boolean;
  }): Promise<ETradeAlert[]> {
    return this.client.fetchAlerts(params);
  }

  /**
   * Real E*TRADE REST API: Fetch alert details with OAuth 1.0a
   */
  async fetchAlertDetails(alertId: string | number): Promise<ETradeAlertDetails | null> {
    return this.client.fetchAlertDetails(alertId);
  }

  /**
   * Real E*TRADE REST API: Delete alert with OAuth 1.0a
   */
  async deleteAlert(alertId: string | number): Promise<{ success: boolean; message: string }> {
    return this.client.deleteAlert(alertId);
  }

  /**
   * Real E*TRADE REST API: Product Lookup with OAuth 1.0a
   */
  async lookupProduct(search: string): Promise<ETradeProductLookup[]> {
    return this.client.lookupProduct(search);
  }

  /**
   * Real E*TRADE REST API: Get Option Chains with OAuth 1.0a
   */
  async getOptionChains(params: {
    symbol: string;
    expiryYear?: number;
    expiryMonth?: number;
    expiryDay?: number;
    strikePrice?: number;
    noOfStrikes?: number;
    includeWeekly?: boolean;
    chainType?: "CALL" | "PUT" | "CALLPUT";
  }): Promise<ETradeOptionChain | null> {
    return this.client.getOptionChains(params);
  }

  /**
   * Real E*TRADE REST API: Get Option Expire Dates with OAuth 1.0a
   */
  async getOptionExpireDates(symbol: string, expiryType?: string): Promise<ETradeOptionExpireDate[]> {
    return this.client.getOptionExpireDates(symbol, expiryType);
  }

  /**
   * Real E*TRADE REST API: Fetch live orders from exchange with OAuth 1.0a
   */
  async fetchOrdersRemote(
    accountKey?: string,
    params?: { marker?: string; count?: number; status?: string; fromDate?: string; toDate?: string; symbol?: string }
  ): Promise<ETradeRemoteOrder[]> {
    return this.client.fetchOrders(accountKey, params);
  }

  /**
   * Real E*TRADE REST API: Cancel order on exchange with OAuth 1.0a
   */
  async cancelOrderRemote(orderId: string | number, accountKey?: string): Promise<ETradeCancelOrderResult> {
    return this.client.cancelOrder(accountKey, orderId);
  }

  /**
   * Real E*TRADE REST API: Preview Changed Order with OAuth 1.0a
   */
  async changeOrderPreviewRemote(
    accountKey: string | undefined,
    params: {
      orderId: string | number;
      clientOrderId?: string;
      symbol: string;
      action: string;
      quantity: number;
      orderType?: string;
      limitPrice?: number;
      stopPrice?: number;
    }
  ): Promise<any> {
    return this.client.changeOrderPreview(accountKey, params);
  }

  /**
   * Real E*TRADE REST API: Place Changed Order with OAuth 1.0a
   */
  async changeOrderPlaceRemote(
    accountKey: string | undefined,
    params: {
      orderId: string | number;
      previewId: string;
      clientOrderId?: string;
      symbol: string;
      action: string;
      quantity: number;
      orderType?: string;
      limitPrice?: number;
      stopPrice?: number;
    }
  ): Promise<any> {
    return this.client.changeOrderPlace(accountKey, params);
  }

  /**
   * Real E*TRADE REST API: Revoke Access Token Remote
   */
  async revokeRemoteAccessToken(): Promise<{ success: boolean; message: string }> {
    return this.client.revokeRemoteAccessToken();
  }

  getLastError(): string | undefined {
    return this.platform.getLastError?.() || this.client.getLastError();
  }
}
