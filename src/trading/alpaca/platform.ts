/**
 * Alpaca Trading Platform Adapter
 *
 * Implements ITradingPlatform for Alpaca Trading API v2
 */

import type { Env, ETradeQuote, ETradeAccount, ETradePosition, ETradeOrderDraft, ETradeOrderExecutionResult, ETradeBrokerStatus } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { ITradingPlatform, OrderPreviewParams } from "../interfaces";
import { AlpacaMarketDataProvider } from "../../services/marketDataResearch";
import { AGENT_DIDS, createDidAttestationSync, getUserDid } from "../../agents/did";

export class AlpacaTradingPlatform implements ITradingPlatform {
  readonly platformId = "alpaca" as const;
  readonly name = "Alpaca Securities Brokerage (API v2)";
  private alpacaData: AlpacaMarketDataProvider;

  constructor(private env: Env, private orm: DatabaseORM | undefined, private userLogin: string) {
    // Issue #1185: per-user platform — an explicit login is required.
    if (!userLogin) {
      throw new Error("AlpacaTradingPlatform requires an explicit userLogin (issue #1185: no default identity).");
    }
    this.alpacaData = new AlpacaMarketDataProvider(env);
  }

  async getStatus(): Promise<ETradeBrokerStatus> {
    const hasKey = Boolean(this.env.ALPACA_API_KEY || this.env.ALPACA_API_KEY_ID);
    const hasSecret = Boolean(this.env.ALPACA_SECRET_KEY || this.env.ALPACA_API_SECRET_KEY);
    const configured = hasKey && hasSecret;
    const isLive = !this.env.ALPACA_BASE_URL?.includes("paper-api");

    return {
      broker: "alpaca",
      name: this.name,
      configured,
      mode: isLive ? "live_oauth" : "sandbox_api",
      protocol: isLive ? "etrade_oauth_rest" : "sandbox_simulated",
      environment: isLive ? "live" : "sandbox",
      activeEnvironment: isLive ? "PROD" : "TEST",
      apiUrl: this.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
      hasApiKey: configured,
      oauthAuthenticated: true,
      capabilities: [
        "Real-Time Level 1 / Level 2 Market Depth (IEX/SIP)",
        "Zero-Commission US Equity & ETF Trading",
        "Fractional Shares Execution",
        "Crypto 24/7 Trading (BTC/USD, ETH/USD)",
        "Paper Trading Simulation Sandbox",
        "W3C Agent DID Cryptographic Stamping",
      ],
    };
  }

  async getQuote(symbol: string): Promise<ETradeQuote> {
    const cleanSym = symbol.trim().toUpperCase();
    const snap = await this.alpacaData.getQuote(cleanSym);

    // Issue #1555 (parent #913): pass through, never fabricate. The
    // Alpaca snapshot carries price/bid/ask/volume/OHLC only — it has
    // no peRatio, marketCap, 52-week, or RSI. Those ETradeQuote
    // fields are OPTIONAL, so a snapshot that lacks them yields an
    // omitted field, never a hardcoded 28.0 / 50.0 / high*1.25 /
    // low*0.75 / 50.0. A real snapshot value, if a future Alpaca
    // response carries one, passes through untouched (finite and
    // positive; RSI additionally bounded 0–100). Downstream filters
    // fail closed on missing values (screener.ts: minMarketCap and
    // maxPeRatio reject unknown), which is the honest outcome — an
    // Alpaca name no longer passes those gates on fake numbers.
    const extra = snap as unknown as Record<string, unknown>;
    const positive = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v > 0;
    const rsi = extra["rsi14"];
    const rsiValue =
      typeof rsi === "number" && Number.isFinite(rsi) && rsi >= 0 && rsi <= 100
        ? rsi
        : undefined;

    return {
      symbol: cleanSym,
      companyName: `${cleanSym} (Alpaca Real-Time)`,
      lastPrice: snap.price,
      price: snap.price,
      change: snap.change,
      changePercent: snap.changePercent,
      bid: snap.bid ?? 0,
      ask: snap.ask ?? 0,
      volume: snap.volume,
      open: snap.open,
      high: snap.high,
      low: snap.low,
      ...(positive(extra["peRatio"]) ? { peRatio: extra["peRatio"] as number } : {}),
      ...(positive(extra["marketCap"]) ? { marketCap: extra["marketCap"] as number } : {}),
      ...(positive(extra["high52"])
        ? {
            week52High: extra["high52"] as number,
            high52: extra["high52"] as number,
          }
        : {}),
      ...(positive(extra["low52"])
        ? {
            week52Low: extra["low52"] as number,
            low52: extra["low52"] as number,
          }
        : {}),
      ...(rsiValue !== undefined ? { rsi: rsiValue } : {}),
      source: "Alpaca Real-Time NBBO Feed",
      timestamp: new Date().toISOString(),
    };
  }

  async getAccounts(): Promise<ETradeAccount[]> {
    return [
      {
        accountId: "alpaca_paper_01",
        accountKey: "alpaca_paper_01",
        accountDesc: "Alpaca Margin Trading Account",
        accountType: "MARGIN",
        netAccountValue: 100000.0,
        totalAccountValue: 100000.0,
        cashAvailableForInvestment: 100000.0,
        dayTraderStatus: false,
      },
    ];
  }

  async getPositions(): Promise<{ account: ETradeAccount; positions: ETradePosition[] }> {
    return {
      account: {
        accountId: "alpaca_paper_01",
        accountKey: "alpaca_paper_01",
        accountDesc: "Alpaca Margin Trading Account",
        accountType: "MARGIN",
        netAccountValue: 100000.0,
        totalAccountValue: 100000.0,
        cashAvailableForInvestment: 100000.0,
        dayTraderStatus: false,
      },
      positions: [],
    };
  }

  async previewOrder(params: OrderPreviewParams): Promise<ETradeOrderDraft> {
    if (params.assetClass === "options" || params.optionLegs?.some((leg) => leg.securityType === "OPTN")) {
      throw new Error("This broker adapter currently supports equity orders only. Options orders require a broker adapter with native options preview support.");
    }
    const quote = await this.getQuote(params.symbol);
    const orderId = `alp_ord_${crypto.randomUUID().slice(0, 8)}`;
    const userDid = getUserDid(params.sessionId || this.userLogin);
    const action = params.action || params.orderAction || "BUY";
    const estimatedTotal = Number((quote.lastPrice * params.quantity).toFixed(2));

    const didProof = createDidAttestationSync({
      draftId: orderId,
      action: action.toLowerCase(),
      amount: estimatedTotal,
      currency: "USD",
      customer: `Alpaca:${params.symbol}`,
      gateway: "sandbox",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: userDid,
    });

    return {
      orderId,
      symbol: params.symbol.toUpperCase(),
      action,
      orderAction: action,
      orderType: params.orderType || "MARKET",
      quantity: params.quantity,
      estimatedPrice: quote.lastPrice,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      term: "GOOD_FOR_DAY",
      estimatedCommission: 0.0,
      estimatedTotal,
      status: "previewed",
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
      proofSignature: didProof.signature,
      previewMessage: `Alpaca Order Preview: ${action} ${params.quantity} ${params.symbol} @ ~$${quote.lastPrice.toFixed(2)}. Estimated Total: $${estimatedTotal.toLocaleString()} USD.`,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      placedAt: new Date().toISOString(),
    };
  }

  async executeOrder(orderId: string, authorizerDid: string, decision: "approved" | "rejected"): Promise<ETradeOrderExecutionResult> {
    const now = new Date().toISOString();
    // #2389: this adapter has no order-placement client (market data
    // only), so it can never execute. The previous implementation
    // returned a hardcoded "executed" NVDA result on approval —
    // fabricated terms, fabricated references, fabricated signature.
    // Approval now returns an honest not-executed failure; rejection
    // still rejects the stored draft. Nothing here mints a reference
    // or claims a fill the broker never made.
    const record = this.orm?.trades?.findById(orderId);
    const symbol = record?.symbol ?? "";
    const action = record?.action ?? "BUY";
    const quantity = record?.quantity ?? 0;
    const proofSignature = record?.proofSignature ?? "";

    if (decision === "rejected") {
      if (record && this.orm?.trades) {
        this.orm.trades.update(orderId, {
          status: "rejected",
          authorizerDid,
          updatedAt: now,
        });
      }
      return {
        success: false,
        orderId,
        executionId: "",
        brokerOrderRef: "",
        authorizerDid,
        status: "rejected",
        symbol,
        action,
        quantity,
        executionPrice: 0,
        totalSettled: 0,
        didAttestation: {
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          signature: proofSignature,
        },
        message: `Alpaca order ${orderId} rejected by human authorizer (${authorizerDid}).`,
        timestamp: now,
      };
    }

    return {
      success: false,
      orderId,
      executionId: "",
      brokerOrderRef: "",
      authorizerDid,
      status: "failed",
      symbol,
      action,
      quantity,
      executionPrice: 0,
      totalSettled: 0,
      didAttestation: {
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        signature: proofSignature,
      },
      message: `Alpaca execution is not wired on this adapter: no Alpaca order-placement client is connected, so order ${orderId} was NOT executed. No funds were moved.`,
      timestamp: now,
    };
  }
}
