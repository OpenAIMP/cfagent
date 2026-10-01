import React, { useState, useEffect } from "react";
import {
  ETradeQuote,
  ScreenedStockItem,
  ETradeOrderDraft,
  ETradeOrderExecutionResult,
  ETradePosition,
  ETradeAccount,
  ETradeBrokerStatus,
  TradeRecord,
} from "../types";

export interface User {
  login: string;
  name?: string;
  avatar?: string;
}

export interface ETradeTradingHubProps {
  user?: User;
  onSendPrompt?: (prompt: string) => void;
}

export function ETradeTradingHub({ user, onSendPrompt }: ETradeTradingHubProps) {
  // Navigation subtabs
  const [subTab, setSubTab] = useState<"scanner" | "order" | "portfolio" | "ledger" | "nlq">("scanner");

  // Broker status
  const [brokerStatus, setBrokerStatus] = useState<ETradeBrokerStatus | null>(null);
  const [account, setAccount] = useState<ETradeAccount | null>(null);
  const [positions, setPositions] = useState<ETradePosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);

  // Screener state
  const [sectorFilter, setSectorFilter] = useState<string>("All");
  const [rsiFilterPreset, setRsiFilterPreset] = useState<"all" | "oversold" | "neutral" | "overbought">("all");
  const [marketCapPreset, setMarketCapPreset] = useState<string>("all");
  const [perfFilter, setPerfFilter] = useState<"all" | "gainers" | "losers">("all");
  const [screenerSearch, setScreenerSearch] = useState("");
  const [screenerStocks, setScreenerStocks] = useState<ScreenedStockItem[]>([]);
  const [screenerLoading, setScreenerLoading] = useState(false);
  const [scannedAt, setScannedAt] = useState<string>("");

  // Order Ticket state
  const [orderSymbol, setOrderSymbol] = useState("NVDA");
  const [orderAction, setOrderAction] = useState<"BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT">("LIMIT");
  const [orderQuantity, setOrderQuantity] = useState(10);
  const [orderLimitPrice, setOrderLimitPrice] = useState<string>("125.50");
  const [orderQuote, setOrderQuote] = useState<ETradeQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [activeDraft, setActiveDraft] = useState<ETradeOrderDraft | null>(null);
  const [executingDraft, setExecutingDraft] = useState(false);
  const [lastExecutionResult, setLastExecutionResult] = useState<ETradeOrderExecutionResult | null>(null);
  const [orderError, setOrderError] = useState("");

  // Orders Ledger state
  const [orders, setOrders] = useState<TradeRecord[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  // Quote Inspection Modal state
  const [inspectSymbol, setInspectSymbol] = useState<string | null>(null);
  const [inspectQuote, setInspectQuote] = useState<ETradeQuote | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);

  // In-tab NLQ state
  const [nlqQuery, setNlqQuery] = useState("");
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqResult, setNlqResult] = useState<any>(null);

  // DID Copy feedback
  const [copiedDid, setCopiedDid] = useState(false);

  // Trust, Reconciliation & Privacy state
  const [maskAccount, setMaskAccount] = useState(true);
  const [showDiscrepancyModal, setShowDiscrepancyModal] = useState(false);
  const [scanUniverseCount, setScanUniverseCount] = useState(12);
  const [scanStatus, setScanStatus] = useState<"not_run" | "no_universe" | "data_unavailable" | "scan_failed" | "no_matches" | "matches_found">("matches_found");
  const [lastSyncTime, setLastSyncTime] = useState<string>("");

  // E*TRADE Live Diagnostics state
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false);

  // E*TRADE 3-Legged OAuth 1.0a state
  const [oauthStatus, setOauthStatus] = useState<{
    authenticated: boolean;
    environment?: string;
    storedAt?: string;
    renewable?: boolean;
    expired?: boolean;
  } | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [oauthPin, setOauthPin] = useState("");
  const [requestTokenInfo, setRequestTokenInfo] = useState<{ requestToken: string; authorizeUrl: string } | null>(null);
  const [oauthSubmitting, setOauthSubmitting] = useState(false);
  const [oauthMsg, setOauthMsg] = useState("");

  // Active environment (Sandbox TEST vs Live PROD)
  const [activeEnv, setActiveEnv] = useState<"TEST" | "PROD">(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("cfagent_env");
      if (stored === "TEST" || stored === "PROD") return stored;
    }
    return "PROD";
  });

  const handleSwitchEnvironment = async (target: "TEST" | "PROD") => {
    setActiveEnv(target);
    if (typeof window !== "undefined") {
      localStorage.setItem("cfagent_env", target);
    }
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOauthMsg(`Switched to ${target === "PROD" ? "Production (Live)" : "Sandbox (TEST)"} mode.`);
    try {
      await fetch("/api/environment/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": target },
        body: JSON.stringify({ environment: target }),
      });
    } catch {
      // Ignore
    }
    await Promise.all([
      fetchOAuthStatus(target),
      fetchBrokerStatus(target),
      fetchPositions(target),
    ]);
    runScreener(target);
    fetchSymbolQuote(orderSymbol, target);
  };

  // Fetch initial broker status, OAuth status, positions, and screener
  useEffect(() => {
    fetchOAuthStatus(activeEnv);
    fetchBrokerStatus(activeEnv);
    fetchPositions(activeEnv);
    runScreener();
    fetchOrders();
    fetchSymbolQuote(orderSymbol);

    // Check if redirected back from E*TRADE OAuth
    const params = new URLSearchParams(window.location.search);
    if (params.get("etrade_auth") === "success") {
      setOauthMsg("E*TRADE OAuth 1.0a connection established! Real broker access enabled.");
      fetchOAuthStatus(activeEnv);
      fetchBrokerStatus(activeEnv);
      fetchPositions(activeEnv);
    }
  }, [activeEnv]);

  const fetchOAuthStatus = async (override?: string) => {
    const envToUse = override || activeEnv;
    setOauthLoading(true);
    try {
      const resp = await fetch("/api/etrade/oauth/status", {
        headers: { "x-environment": envToUse },
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        setOauthStatus(data);
      }
    } catch {
      // Ignore
    } finally {
      setOauthLoading(false);
    }
  };

  const handleStartOAuth = async (override?: unknown) => {
    const envToUse = typeof override === "string" && (override === "TEST" || override === "PROD") ? override : activeEnv;
    setOauthLoading(true);
    setOauthMsg("");
    try {
      const resp = await fetch("/api/etrade/oauth/start", {
        headers: { "x-environment": envToUse },
      });
      const data = (await resp.json()) as any;
      if (resp.ok && data.authorizeUrl) {
        setRequestTokenInfo(data);
        setShowPinModal(true);
        // Open E*TRADE login & authorization in a new tab
        window.open(data.authorizeUrl, "_blank", "noopener,noreferrer");
      } else {
        setOauthMsg(data.error || "Failed to start E*TRADE OAuth session");
      }
    } catch (err: any) {
      setOauthMsg(err.message || "Failed to initiate OAuth request");
    } finally {
      setOauthLoading(false);
    }
  };

  const handleSwitchAndConnect = async (target: "TEST" | "PROD") => {
    await handleSwitchEnvironment(target);
    await handleStartOAuth(target);
  };

  const handleSubmitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oauthPin.trim()) return;
    setOauthSubmitting(true);
    setOauthMsg("");
    try {
      const resp = await fetch("/api/etrade/oauth/verifier", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          verifier: oauthPin.trim(),
          requestToken: requestTokenInfo?.requestToken,
          requestTokenSecret: (requestTokenInfo as any)?.requestTokenSecret,
        }),
      });
      const data = (await resp.json()) as any;
      if (resp.ok && data.success) {
        setShowPinModal(false);
        setOauthPin("");
        await fetchOAuthStatus(activeEnv);
        await fetchBrokerStatus(activeEnv);
        await fetchPositions(activeEnv);
        await fetchSymbolQuote(orderSymbol);
        setOauthMsg("E*TRADE Account Connected! Access token active until midnight Eastern Time.");
      } else {
        setOauthMsg(data.error || "Failed to exchange verification code with E*TRADE");
      }
    } catch (err: any) {
      setOauthMsg(err.message || "Failed to submit verification code");
    } finally {
      setOauthSubmitting(false);
    }
  };

  const handleRenewOAuth = async () => {
    setOauthLoading(true);
    setOauthMsg("");
    try {
      const resp = await fetch("/api/etrade/oauth/renew", {
        method: "POST",
        headers: { "x-environment": activeEnv },
      });
      const data = (await resp.json()) as any;
      if (resp.ok && data.success) {
        await fetchOAuthStatus(activeEnv);
        setOauthMsg("Token renewed successfully for today!");
      } else {
        setOauthMsg(data.error || "Failed to renew token. Please re-authenticate.");
      }
    } catch (err: any) {
      setOauthMsg(err.message || "Failed to renew token");
    } finally {
      setOauthLoading(false);
    }
  };

  const handleRevokeOAuth = async () => {
    if (!confirm("Are you sure you want to disconnect your E*TRADE account?")) return;
    setOauthLoading(true);
    try {
      await fetch("/api/etrade/oauth/revoke", {
        method: "POST",
        headers: { "x-environment": activeEnv },
      });
      setOauthStatus({
        authenticated: false,
        environment: activeEnv,
        storedAt: undefined,
        renewable: false,
      });
      setBrokerStatus((prev) => (prev ? { ...prev, oauthAuthenticated: false } : prev));
      setAccount(null);
      setPositions([]);
      setOauthMsg("E*TRADE account disconnected.");
      await fetchOAuthStatus(activeEnv);
      await fetchBrokerStatus(activeEnv);
    } catch {
      // Ignore
    } finally {
      setOauthLoading(false);
    }
  };

  const fetchBrokerStatus = async (override?: string) => {
    const envToUse = override || activeEnv;
    try {
      const resp = await fetch("/api/etrade/status", {
        headers: { "x-environment": envToUse },
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        setBrokerStatus(data.status || data);
        if (data.account) setAccount(data.account);
        if (data.oauthAuthenticated !== undefined) {
          setOauthStatus((prev) => ({
            authenticated: data.oauthAuthenticated,
            environment: data.activeEnvironment || envToUse,
            storedAt: data.oauthExpiresAtEt || prev?.storedAt,
            renewable: data.oauthRenewable !== undefined ? data.oauthRenewable : prev?.renewable,
          }));
        }
      }
    } catch {
      // Ignore
    }
  };

  const fetchPositions = async (override?: string) => {
    const envToUse = override || activeEnv;
    setPositionsLoading(true);
    try {
      const resp = await fetch("/api/etrade/positions", {
        headers: { "x-environment": envToUse },
      });
      if (resp.ok) {
        const data = await resp.json() as { account: ETradeAccount; positions: ETradePosition[]; error?: string };
        if (data.account) setAccount(data.account);
        if (data.positions) setPositions(data.positions);
        if (data.error && (!data.account || data.account.accountId === "unconnected")) {
          setOauthMsg(data.error);
        }
        setLastSyncTime(new Date().toLocaleTimeString());
      }
    } catch {
      // Ignore
    } finally {
      setPositionsLoading(false);
    }
  };

  const runDiagnostics = async (override?: string) => {
    const envToUse = override || activeEnv;
    setDiagnosticsLoading(true);
    try {
      const resp = await fetch("/api/etrade/diagnostics", {
        headers: { "x-environment": envToUse },
      });
      const data = (await resp.json()) as any;
      setDiagnostics(data);
      setShowDiagnosticsModal(true);
      if (data?.upstreamAccounts?.count > 0 || (data?.upstreamAccounts?.accounts && data.upstreamAccounts.accounts.length > 0)) {
        await Promise.all([
          fetchBrokerStatus(envToUse),
          fetchPositions(envToUse),
          fetchOAuthStatus(envToUse),
        ]);
      }
    } catch (err: any) {
      setDiagnostics({ error: err.message || "Failed to run diagnostics" });
      setShowDiagnosticsModal(true);
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const fetchOrders = async () => {
    setOrdersLoading(true);
    try {
      const resp = await fetch("/api/etrade/orders");
      if (resp.ok) {
        const data = await resp.json() as { total: number; orders: TradeRecord[] };
        if (data.orders) setOrders(data.orders);
      }
    } catch {
      // Ignore
    } finally {
      setOrdersLoading(false);
    }
  };

  const runScreener = async (envOverride?: unknown) => {
    const envToUse = typeof envOverride === "string" ? envOverride : activeEnv;
    setScreenerLoading(true);
    try {
      const body: Record<string, any> = { limit: 12 };
      if (sectorFilter !== "All") body.sector = sectorFilter;
      if (rsiFilterPreset === "oversold") body.maxRsi = 35;
      if (rsiFilterPreset === "overbought") body.minRsi = 70;
      if (rsiFilterPreset === "neutral") {
        body.minRsi = 35;
        body.maxRsi = 70;
      }
      if (marketCapPreset === "mega") body.minMarketCap = 200;
      if (marketCapPreset === "large") body.minMarketCap = 50;
      if (perfFilter === "gainers") body.onlyGainers = true;
      if (perfFilter === "losers") body.onlyLosers = true;
      if (screenerSearch.trim()) body.search = screenerSearch.trim();

      const resp = await fetch("/api/etrade/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": envToUse },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        const data = (await resp.json()) as any;
        const list = Array.isArray(data.stocks) ? data.stocks : Array.isArray(data.results) ? data.results : [];
        setScreenerStocks(list);
        const total = typeof data.totalScreened === "number" ? data.totalScreened : list.length;
        setScanUniverseCount(total);
        if (total === 0) {
          setScanStatus("no_universe");
        } else if (list.length === 0) {
          setScanStatus("no_matches");
        } else {
          setScanStatus("matches_found");
        }
        setScannedAt(data.scannedAt || new Date().toLocaleTimeString());
      } else {
        setScanStatus("scan_failed");
      }
    } catch {
      setScanStatus("scan_failed");
    } finally {
      setScreenerLoading(false);
    }
  };

  const fetchSymbolQuote = async (sym: string, envOverride?: unknown) => {
    if (!sym) return;
    const envToUse = typeof envOverride === "string" ? envOverride : activeEnv;
    setQuoteLoading(true);
    try {
      const resp = await fetch(`/api/etrade/quote?symbol=${encodeURIComponent(sym)}`, {
        headers: { "x-environment": envToUse },
      });
      if (resp.ok) {
        const data = (await resp.json()) as ETradeQuote;
        if (data && data.symbol === sym) {
          setOrderQuote(data);
          if (orderType === "LIMIT") {
            // Align limit price with order direction: Buy -> Ask; Sell -> Bid
            if ((orderAction === "BUY" || orderAction === "BUY_TO_COVER") && data.ask > 0) {
              setOrderLimitPrice(data.ask.toFixed(2));
            } else if ((orderAction === "SELL" || orderAction === "SELL_SHORT") && data.bid > 0) {
              setOrderLimitPrice(data.bid.toFixed(2));
            } else if (data.lastPrice > 0) {
              setOrderLimitPrice(data.lastPrice.toFixed(2));
            }
          }
        }
      }
    } catch {
      // Ignore
    } finally {
      setQuoteLoading(false);
    }
  };

  const handleOpenInspectQuote = async (sym: string, existingStock?: ScreenedStockItem) => {
    setInspectSymbol(sym);
    setInspectLoading(true);
    const initialStock = existingStock || screenerStocks.find((s) => s.symbol === sym);
    if (initialStock) {
      setInspectQuote(initialStock as any);
    } else {
      setInspectQuote(null);
    }
    try {
      const resp = await fetch(`/api/etrade/quote?symbol=${encodeURIComponent(sym)}`, {
        headers: { "x-environment": activeEnv },
      });
      if (resp.ok) {
        const data = (await resp.json()) as ETradeQuote;
        if (data && data.symbol === sym) {
          setInspectQuote(data);
        }
      }
    } catch {
      // Ignore
    } finally {
      setInspectLoading(false);
    }
  };

  const handleQuickTrade = (stock: ScreenedStockItem | ETradePosition | ETradeQuote, defaultAction: "BUY" | "SELL" = "BUY") => {
    setOrderSymbol(stock.symbol);
    setOrderAction(defaultAction);
    const quoteBid = (stock as any).bid;
    const quoteAsk = (stock as any).ask;
    let p = (stock as any).lastPrice || (stock as any).currentPrice || (stock as any).price || 100;
    if (defaultAction === "SELL" && quoteBid > 0) {
      p = quoteBid;
    } else if (defaultAction === "BUY" && quoteAsk > 0) {
      p = quoteAsk;
    }
    setOrderLimitPrice(Number(p).toFixed(2));
    setOrderQuote(stock as any);
    setActiveDraft(null); // Invalidate any previous approval
    setLastExecutionResult(null);
    setSubTab("order");
  };

  const handlePreviewOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setOrderError("");
    setPreviewLoading(true);
    setActiveDraft(null);
    setLastExecutionResult(null);

    const price = parseFloat(orderLimitPrice);
    if (orderType === "LIMIT" && (isNaN(price) || price <= 0)) {
      setOrderError("Please specify a valid limit price");
      setPreviewLoading(false);
      return;
    }

    try {
      const resp = await fetch("/api/etrade/order/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          symbol: orderSymbol.toUpperCase(),
          orderAction,
          action: orderAction,
          quantity: Number(orderQuantity),
          orderType,
          limitPrice: orderType === "LIMIT" ? price : undefined,
        }),
      });

      const data = await resp.json() as any;
      if (resp.ok && data.orderId) {
        setActiveDraft(data);
        fetchOrders();
      } else {
        setOrderError(data.error || "Failed to preview order on E*TRADE");
      }
    } catch (err: any) {
      setOrderError(err.message || "Failed to preview order");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleExecuteDraft = async (
    draftId: string,
    decision: "approved" | "rejected",
    draftOverride?: any
  ) => {
    const draft = draftOverride || activeDraft;
    setExecutingDraft(true);
    setOrderError("");
    try {
      const resp = await fetch("/api/etrade/order/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          orderId: draftId,
          draftId,
          decision,
          symbol: draft?.symbol,
          action: draft?.orderAction || draft?.action,
          quantity: draft?.quantity,
          orderType: draft?.orderType,
          limitPrice: draft?.limitPrice,
          previewId: draft?.previewId && !isNaN(Number(draft.previewId)) ? String(draft.previewId) : undefined,
        }),
      });

      const data = await resp.json() as ETradeOrderExecutionResult;
      setLastExecutionResult(data);
      if (data.success || decision === "rejected") {
        setActiveDraft(null);
        setOrderError("");
        fetchOrders();
        fetchPositions();
      } else {
        setOrderError(data.message || "Order execution failed");
      }
    } catch (err: any) {
      setOrderError(err.message || "Execution request failed");
    } finally {
      setExecutingDraft(false);
    }
  };

  const handleRefreshAndExecuteDraft = async () => {
    if (!activeDraft) return;
    setExecutingDraft(true);
    setOrderError("");
    try {
      const previewResp = await fetch("/api/etrade/order/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          symbol: activeDraft.symbol,
          orderAction: activeDraft.action,
          action: activeDraft.action,
          quantity: activeDraft.quantity,
          orderType: activeDraft.orderType,
          limitPrice: activeDraft.limitPrice,
        }),
      });
      const freshDraft = await previewResp.json() as any;
      if (previewResp.ok && freshDraft.orderId) {
        setActiveDraft(freshDraft);
        await handleExecuteDraft(freshDraft.orderId, "approved", freshDraft);
      } else {
        setOrderError(freshDraft.error || "Failed to generate fresh preview on E*TRADE");
      }
    } catch (err: any) {
      setOrderError(err.message || "Failed to refresh and submit order");
    } finally {
      setExecutingDraft(false);
    }
  };

  const handleRunNlq = async (e?: React.FormEvent, customQuery?: string) => {
    if (e) e.preventDefault();
    const q = customQuery || nlqQuery;
    if (!q.trim() || nlqLoading) return;

    setNlqLoading(true);
    setNlqResult(null);
    try {
      const resp = await fetch("/api/nlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const data = (await resp.json()) as any;
      setNlqResult(data);

      // If NLQ generated an order preview draft, sync it to active draft
      if (data?.result?.orderPreview?.orderId) {
        setActiveDraft(data.result.orderPreview);
      }
      // If NLQ screened stocks, update list
      if (Array.isArray(data?.result?.screener?.stocks)) {
        setScreenerStocks(data.result.screener.stocks);
      }
    } catch {
      setNlqResult({ error: "Failed to execute NLQ query" });
    } finally {
      setNlqLoading(false);
    }
  };

  const copyDidToClipboard = (did: string) => {
    navigator.clipboard.writeText(did);
    setCopiedDid(true);
    setTimeout(() => setCopiedDid(false), 2000);
  };

  const tradingAgentDid = "did:agent:openaimp:trading";
  const userDid = user?.login ? `did:user:github:${user.login}` : "did:user:github:authorized_trader";

  const getRsiBadgeClass = (rsi: number) => {
    if (rsi <= 35) return "rsi-oversold";
    if (rsi >= 70) return "rsi-overbought";
    return "rsi-neutral";
  };

  const getRsiLabel = (rsi: number) => {
    if (rsi <= 35) return "Oversold";
    if (rsi >= 70) return "Overbought";
    return "Neutral";
  };

  const positionsSum = positions.reduce((sum, p) => sum + (p.marketValue || 0), 0);
  const cashPower = account?.cashAvailableForInvestment || 0;
  const calculatedPortfolioTotal = Number((positionsSum + cashPower).toFixed(2));
  const statedNav = Number((account?.netAccountValue || calculatedPortfolioTotal).toFixed(2));
  const balanceDiscrepancy = Math.abs(Number((statedNav - calculatedPortfolioTotal).toFixed(2)));
  const isReconciled = balanceDiscrepancy <= 1.00;
  const isLive = activeEnv === "PROD" || brokerStatus?.environment === "live" || brokerStatus?.activeEnvironment === "PROD";

  return (
    <div className="etrade-trading-hub">
      {/* High-Contrast Persistent Environment & Trust Banner */}
      <div className={`env-trust-banner ${isLive ? "env-live" : "env-sandbox"}`} role="status" aria-live="polite">
        <div className="env-trust-left">
          <span className="env-trust-badge">
            {isLive
              ? "🔴 LIVE PRODUCTION — REAL ORDERS & REAL CAPITAL (HITL REQUIRED)"
              : "⚠️ SANDBOX — SIMULATED DATA — NO REAL ORDERS (HITL REQUIRED)"}
          </span>
          <span className="env-trust-item">
            <strong>Account:</strong>{" "}
            <code>
              {account?.accountId && account.accountId !== "unconnected"
                ? (maskAccount ? `••••${account.accountId.slice(-4)}` : account.accountId)
                : (isLive ? "Awaiting PROD Sync" : "Awaiting Sandbox Sync")}
            </code>
            <button
              type="button"
              className="btn-mask-toggle"
              onClick={() => setMaskAccount(!maskAccount)}
              aria-label={maskAccount ? "Reveal account number" : "Mask account number"}
              title={maskAccount ? "Reveal account number" : "Mask account number"}
            >
              {maskAccount ? "👁️ Show" : "🙈 Hide"}
            </button>
          </span>
          <span className="env-trust-item env-trust-switch-item">
            <strong>Environment:</strong>{" "}
            <span className={`env-status-badge ${isLive ? "badge-prod" : "badge-test"}`}>
              {isLive ? "PROD (Live)" : "TEST (Sandbox)"}
            </span>
            <span className="env-switch-toggles">
              <button
                type="button"
                className={`btn-env-toggle ${!isLive ? "active-env" : ""}`}
                onClick={() => handleSwitchEnvironment("TEST")}
                title="Switch to E*TRADE Developer Sandbox"
              >
                🧪 TEST
              </button>
              <button
                type="button"
                className={`btn-env-toggle ${isLive ? "active-env" : ""}`}
                onClick={() => handleSwitchEnvironment("PROD")}
                title="Switch to E*TRADE Live Production"
              >
                🔴 PROD
              </button>
            </span>
          </span>
        </div>
        <div className="env-trust-right">
          <span className="env-trust-item">
            <strong>Data Source:</strong> {oauthStatus?.authenticated ? (isLive ? "E*TRADE Live REST API" : "E*TRADE Sandbox REST API") : (isLive ? "E*TRADE Live (Awaiting OAuth Authentication)" : "E*TRADE Sandbox (Awaiting OAuth)")}
          </span>
          <span className="env-trust-item">
            <strong>Prices As Of:</strong> {lastSyncTime || "Real-time"} ET
          </span>
          <button
            type="button"
            className="btn-sync-diagnostics"
            disabled={diagnosticsLoading}
            onClick={() => runDiagnostics()}
            title="Inspect upstream E*TRADE API connectivity, credentials, and live account sync"
          >
            {diagnosticsLoading ? "⏳ Testing..." : "⚡ Test & Sync"}
          </button>
        </div>
      </div>

      {/* Fail-Closed Portfolio Discrepancy Alert */}
      {!isReconciled && (
        <div className="reconciliation-alert-banner" role="alert">
          <div className="reconciliation-alert-content">
            <span style={{ fontSize: "1.4rem" }}>⚠️</span>
            <div>
              <strong>UNVERIFIED / POSSIBLE DEMO DATA</strong>
              <p>
                Portfolio cannot be reconciled: Stated total (${statedNav.toFixed(2)}) differs from holdings sum (${positionsSum.toFixed(2)}) + cash (${cashPower.toFixed(2)}) by ${balanceDiscrepancy.toFixed(2)}. No aggregate conclusion shown until reconciled.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn-view-discrepancy"
            onClick={() => setShowDiscrepancyModal(true)}
          >
            View Discrepancy Breakdown
          </button>
        </div>
      )}

      {/* Top Brokerage Status Header */}
      <div className="trading-header-banner">
        <div className="broker-brand-cluster">
          <div className="broker-logo-box">
            <span className="broker-logo-icon">📈</span>
            <div className="broker-brand-names">
              <h3>E*TRADE Securities</h3>
              <span className="broker-subbrand">
                by Morgan Stanley • {isLive ? "Developer Production API" : "Developer Sandbox API"}
              </span>
            </div>
          </div>
          <div className="broker-status-chips">
            <span className="mode-badge live-pulse">
              <span className="pulse-dot" />
              {isLive ? "LIVE DIRECT API" : "SANDBOX SIMULATION"}
            </span>
            <span className="protocol-badge">
              OAuth 1.0a REST
            </span>
          </div>
        </div>

        {/* Account Financials & Purchasing Power */}
        {(() => {
          const totalDayGain = positions.reduce((sum, p) => sum + (p.daysGain || 0), 0);
          const totalVal = statedNav;
          const dayGainPct = totalVal > 0 ? (totalDayGain / totalVal) * 100 : 0;
          const marginPower = cashPower * 2;
          const isGain = totalDayGain >= 0;

          return (
            <div className="account-metric-strip">
              <div className="metric-box">
                <span className="metric-label">Net Account Value</span>
                <span className="metric-val highlight">
                  ${totalVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className={`metric-sub ${isGain ? "positive" : "negative"}`}>
                  {isGain ? "+" : ""}${totalDayGain.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({isGain ? "+" : ""}{dayGainPct.toFixed(2)}%) today
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-label">Cash Purchasing Power</span>
                <span className="metric-val">
                  ${cashPower.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="metric-sub">Margin: ${marginPower.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <div className="metric-box status-metric-box">
                <span className="metric-label">Ledger Reconciliation</span>
                <span className={`reconciliation-tag ${isReconciled ? "reconciled" : "unreconciled"}`}>
                  {isReconciled ? "✓ Reconciled Balance" : `⚠️ $${balanceDiscrepancy.toFixed(2)} Discrepancy`}
                </span>
                <span className="metric-sub">
                  {positions.length} holdings • {isReconciled ? "0.00 variance" : "Fail-Closed Active"}
                </span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* E*TRADE OAuth 1.0a Authentication Lifecycle Banner */}
      {oauthStatus?.authenticated ? (
        <div className="etrade-oauth-banner connected">
          <div className="oauth-status-info">
            <span className="oauth-icon">🛡️</span>
            <div>
              <strong>E*TRADE Brokerage Account Connected [{brokerStatus?.activeEnvironment || "TEST"}]</strong>
              <span className="oauth-meta">
                OAuth 1.0a Active Session • Token valid until Midnight US Eastern Time • Monitored Session
              </span>
            </div>
          </div>
          <div className="oauth-actions">
            <button
              type="button"
              className="btn-oauth-test"
              disabled={diagnosticsLoading}
              onClick={() => runDiagnostics()}
              title="Inspect upstream E*TRADE live connection and raw account data"
            >
              {diagnosticsLoading ? "⏳ Testing..." : "⚡ Test Connection"}
            </button>
            {oauthStatus.renewable && (
              <button
                type="button"
                className="btn-oauth-renew"
                disabled={oauthLoading}
                onClick={handleRenewOAuth}
                title="Renew OAuth Access Token proactively before midnight ET"
              >
                🔄 Renew Token
              </button>
            )}
            <button
              type="button"
              className="btn-oauth-revoke"
              disabled={oauthLoading}
              onClick={handleRevokeOAuth}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="etrade-oauth-banner unauthenticated">
          <div className="oauth-status-info">
            <span className="oauth-icon">⚠️</span>
            <div>
              <strong>Authentication Required for Real E*TRADE Broker API [{brokerStatus?.activeEnvironment || "TEST"}]</strong>
              <span className="oauth-meta">
                E*TRADE requires 3-legged OAuth 1.0a. Connect your account to fetch live quotes directly and route orders to the exchange.
              </span>
            </div>
          </div>
          <div className="oauth-actions">
            <button
              type="button"
              className="btn-oauth-test"
              disabled={diagnosticsLoading}
              onClick={() => runDiagnostics()}
              title="Test API credentials and connectivity"
            >
              {diagnosticsLoading ? "⏳ Testing..." : "🔍 Check Status"}
            </button>
            <button
              type="button"
              className="btn-oauth-connect"
              disabled={oauthLoading}
              onClick={handleStartOAuth}
            >
              {oauthLoading ? "Connecting…" : "⚡ Connect E*TRADE Account"}
            </button>
          </div>
        </div>
      )}

      {/* OAuth Banner Notification Message */}
      {oauthMsg && (
        <div
          style={{
            background:
              oauthMsg.includes("SANDBOX") || oauthMsg.includes("switch environment to TEST")
                ? "rgba(245, 158, 11, 0.15)"
                : "rgba(56, 189, 248, 0.15)",
            border:
              oauthMsg.includes("SANDBOX") || oauthMsg.includes("switch environment to TEST")
                ? "1px solid rgba(245, 158, 11, 0.4)"
                : "1px solid rgba(56, 189, 248, 0.3)",
            borderRadius: "8px",
            padding: "0.75rem 1rem",
            color:
              oauthMsg.includes("SANDBOX") || oauthMsg.includes("switch environment to TEST")
                ? "#fbbf24"
                : "#38bdf8",
            fontSize: "0.85rem",
            marginTop: "0.75rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
            <span>ℹ️ {oauthMsg}</span>
            <button
              type="button"
              onClick={() => setOauthMsg("")}
              style={{
                background: "none",
                border: "none",
                color: "#94a3b8",
                cursor: "pointer",
                fontSize: "0.9rem",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
          {(oauthMsg.includes("SANDBOX") || oauthMsg.includes("switch environment to TEST")) && (
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.25rem" }}>
              <button
                type="button"
                onClick={() => handleSwitchAndConnect("TEST")}
                style={{
                  background: "linear-gradient(135deg, #f59e0b, #d97706)",
                  border: "none",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "0.78rem",
                  padding: "0.4rem 0.85rem",
                  borderRadius: "6px",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  boxShadow: "0 2px 8px rgba(245, 158, 11, 0.3)",
                }}
              >
                🧪 Switch to TEST & Connect Now
              </button>
              <span style={{ fontSize: "0.75rem", color: "#d1d5db" }}>
                Or configure a Morgan Stanley Production Key &amp; Secret in Cloudflare / GitHub secrets for Live PROD.
              </span>
            </div>
          )}
        </div>
      )}

      {/* OAuth PIN Verification Modal */}
      {showPinModal && (
        <div className="modal-backdrop">
          <div className="etrade-pin-modal">
            <div className="modal-header">
              <h3>Authorize E*TRADE Application</h3>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setShowPinModal(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: "0 0 1rem 0", color: "#cbd5e1", fontSize: "0.88rem", lineHeight: "1.4" }}>
                An E*TRADE authorization window has opened in a new tab. Log in, authorize application access, and enter the verification PIN provided by E*TRADE.
              </p>
              <div className="step-instruction">
                <span className="step-number">1</span>
                <span>If the tab did not open, click the button below:</span>
              </div>
              {requestTokenInfo?.authorizeUrl && (
                <a
                  href={requestTokenInfo.authorizeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-open-etrade"
                >
                  ↗ Open E*TRADE Login &amp; Authorization
                </a>
              )}
              <div className="step-instruction">
                <span className="step-number">2</span>
                <span>Copy the verification code (PIN) displayed by E*TRADE and paste it here:</span>
              </div>
              <form onSubmit={handleSubmitPin} className="pin-form">
                <input
                  type="text"
                  className="pin-input"
                  placeholder="Enter E*TRADE Verification Code (e.g. ABC1234)"
                  value={oauthPin}
                  onChange={(e) => setOauthPin(e.target.value)}
                  autoFocus
                />
                {oauthMsg && <div style={{ color: "#f87171", fontSize: "0.82rem", marginBottom: "0.75rem" }}>⚠️ {oauthMsg}</div>}
                <div className="modal-btn-row">
                  <button
                    type="submit"
                    className="btn-submit-pin"
                    disabled={oauthSubmitting || !oauthPin.trim()}
                  >
                    {oauthSubmitting ? "Verifying…" : "✓ Complete Authorization & Store Token"}
                  </button>
                  <button
                    type="button"
                    className="btn-cancel-modal"
                    onClick={() => setShowPinModal(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* NLQ Natural Language Trading Prompt Bar */}
      <div className="nlq-quick-bar">
        <div className="nlq-bar-input-wrap">
          <span className="nlq-bar-icon">🤖</span>
          <input
            type="text"
            className="nlq-bar-input"
            placeholder="Ask about account or screen markets: e.g. 'Show my portfolio positions and P&L', 'Screen tech stocks with RSI < 35'..."
            value={nlqQuery}
            onChange={(e) => setNlqQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setSubTab("nlq");
                handleRunNlq();
              }
            }}
          />
          <button
            type="button"
            className="btn-nlq-submit"
            disabled={nlqLoading || !nlqQuery.trim()}
            onClick={() => {
              setSubTab("nlq");
              handleRunNlq();
            }}
          >
            {nlqLoading ? "Analyzing…" : "🔍 Ask About Account"}
          </button>
          {onSendPrompt && (
            <button
              type="button"
              className="btn-nlq-chat"
              title="Send to Multi-Agent Chat"
              onClick={() => onSendPrompt(nlqQuery || "Show my portfolio positions and P&L")}
            >
              💬 In Chat
            </button>
          )}
        </div>

        {/* Suggestion Chips */}
        <div className="nlq-chips-carousel">
          <span className="chips-label">Research &amp; Account Shortcuts:</span>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Screen Tech stocks with RSI < 40");
              setSubTab("nlq");
              handleRunNlq(undefined, "Screen Tech stocks with RSI < 40");
            }}
          >
            🚀 Tech RSI &lt; 40
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Find oversold stocks with RSI under 35");
              setSubTab("nlq");
              handleRunNlq(undefined, "Find oversold stocks with RSI under 35");
            }}
          >
            📉 Oversold Stocks (RSI &lt; 35)
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Show top momentum gainers");
              setSubTab("nlq");
              handleRunNlq(undefined, "Show top momentum gainers");
            }}
          >
            🟢 Top Momentum Gainers
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Quote NVDA");
              setSubTab("nlq");
              handleRunNlq(undefined, "Quote NVDA");
            }}
          >
            🔍 Quote NVDA
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Preview buy 10 shares of NVDA limit 125.50");
              setSubTab("nlq");
              handleRunNlq(undefined, "Preview buy 10 shares of NVDA limit 125.50");
            }}
          >
            📝 Build Order Preview (Buy 10 NVDA)
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Show my portfolio positions and P&L");
              setSubTab("nlq");
              handleRunNlq(undefined, "Show my portfolio positions and P&L");
            }}
          >
            💼 Portfolio Holdings
          </button>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="trading-subnav-bar">
        <button
          className={`subnav-btn ${subTab === "scanner" ? "active" : ""}`}
          onClick={() => setSubTab("scanner")}
        >
          🔍 Market Screener &amp; Scanner
        </button>
        <button
          className={`subnav-btn ${subTab === "order" ? "active" : ""}`}
          onClick={() => setSubTab("order")}
        >
          ⚡ Fast Order Ticket &amp; Preview
          {activeDraft && <span className="preview-indicator-badge">1 PREVIEW</span>}
        </button>
        <button
          className={`subnav-btn ${subTab === "portfolio" ? "active" : ""}`}
          onClick={() => {
            setSubTab("portfolio");
            fetchPositions();
          }}
        >
          💼 Portfolio &amp; Holdings ({positions.length})
        </button>
        <button
          className={`subnav-btn ${subTab === "ledger" ? "active" : ""}`}
          onClick={() => {
            setSubTab("ledger");
            fetchOrders();
          }}
        >
          📜 Order History Ledger ({orders.length})
        </button>
        <button
          className={`subnav-btn ${subTab === "nlq" ? "active" : ""}`}
          onClick={() => setSubTab("nlq")}
        >
          🤖 NLQ Results
        </button>
      </div>

      {/* Active HITL Safety Preview Banner (Always visible when a draft is active) */}
      {activeDraft && (
        <div className="hitl-floating-preview-card">
          <div className="hitl-card-header">
            <div className="hitl-badge-group">
              <span className="hitl-shield-icon">🛡️</span>
              <h4>HUMAN-IN-THE-LOOP ORDER PREVIEW AWAITING APPROVAL</h4>
            </div>
            <span className="order-id-tag">ID: <code>{activeDraft.orderId}</code></span>
          </div>

          <div className="hitl-card-body">
            <div className="hitl-order-details-grid">
              <div className="hitl-stat">
                <span className="stat-label">Action</span>
                <span className={`stat-value action-pill ${activeDraft.action.toLowerCase()}`}>
                  {activeDraft.action}
                </span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Symbol</span>
                <span className="stat-value ticker-val">{activeDraft.symbol}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Quantity</span>
                <span className="stat-value">{activeDraft.quantity} shares</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Order Type</span>
                <span className="stat-value">{activeDraft.orderType}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Limit / Est Price</span>
                <span className="stat-value">${(activeDraft.limitPrice || activeDraft.estimatedPrice).toFixed(2)}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Estimated Total</span>
                <span className="stat-value total-val">${activeDraft.estimatedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>

            <div className="hitl-attestation-box">
              {activeDraft.previewId && (
                <div className="attest-item">
                  <span className="attest-label">E*TRADE Upstream Session:</span>
                  <code style={{ color: "#10b981", fontWeight: "bold" }}>Preview #{activeDraft.previewId} (Verified)</code>
                </div>
              )}
              <div className="attest-item">
                <span className="attest-label">Proposer DID:</span>
                <code>{activeDraft.proposerDid}</code>
              </div>
              <div className="attest-item">
                <span className="attest-label">Cryptographic Stamp:</span>
                <code className="sig-snippet">{activeDraft.proofSignature.slice(0, 32)}…</code>
              </div>
              <div className="attest-item">
                <span className="attest-label">Commission:</span>
                <span className="zero-comm">$0.00 (E*TRADE Online)</span>
              </div>
            </div>

            <div className="hitl-safety-notice">
              🛡️ <strong>Safety Guarantee:</strong> No trade will be executed without your explicit authorization. Funds remain untouched until you approve.
            </div>

            <div className="hitl-action-buttons">
              {(orderError.includes("timed out") || orderError.includes("resubmit") || lastExecutionResult?.message?.includes("timed out") || lastExecutionResult?.message?.includes("resubmit")) ? (
                <button
                  type="button"
                  className="btn-approve-order"
                  style={{ background: "#2563eb", borderColor: "#3b82f6" }}
                  disabled={executingDraft}
                  onClick={handleRefreshAndExecuteDraft}
                >
                  {executingDraft ? "Refreshing & Executing…" : "⚡ Re-preview & Resubmit Now"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-approve-order"
                  disabled={executingDraft}
                  onClick={() => handleExecuteDraft(activeDraft.orderId, "approved")}
                >
                  {executingDraft ? "Executing on E*TRADE…" : "✅ Approve & Submit Trade to E*TRADE"}
                </button>
              )}
              <button
                type="button"
                className="btn-reject-order"
                disabled={executingDraft}
                onClick={() => handleExecuteDraft(activeDraft.orderId, "rejected")}
              >
                ❌ Cancel Draft
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Execution Confirmation Alert */}
      {lastExecutionResult && (
        <div className={`execution-result-banner ${lastExecutionResult.success ? "success" : "rejected"}`}>
          <div className="exec-icon">{lastExecutionResult.success ? "🎉" : "🚫"}</div>
          <div className="exec-text">
            <strong>{lastExecutionResult.message}</strong>
            <div className="exec-sub">
              Ref: <code>{lastExecutionResult.brokerOrderRef}</code> •
              Status: <strong>{lastExecutionResult.status.toUpperCase()}</strong> •
              Authorizer: <code>{lastExecutionResult.authorizerDid || userDid}</code>
            </div>
            {(!lastExecutionResult.success && (lastExecutionResult.message?.includes("timed out") || lastExecutionResult.message?.includes("resubmit"))) && activeDraft && (
              <div style={{ marginTop: "8px" }}>
                <button
                  type="button"
                  style={{ background: "#2563eb", color: "#fff", fontWeight: 700, padding: "6px 14px", borderRadius: "6px", border: "none", cursor: "pointer" }}
                  disabled={executingDraft}
                  onClick={handleRefreshAndExecuteDraft}
                >
                  {executingDraft ? "Refreshing & Executing…" : "⚡ Re-preview & Submit Fresh Order to E*TRADE"}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn-dismiss-exec"
            onClick={() => setLastExecutionResult(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* SUBTAB 1: MARKET SCREENER & SCANNER */}
      {subTab === "scanner" && (
        <div className="trading-section screener-section">
          {/* Controls Bar */}
          <div className="screener-controls-bar">
            <div className="control-item">
              <label>Sector</label>
              <select
                value={sectorFilter}
                onChange={(e) => setSectorFilter(e.target.value)}
              >
                <option value="All">All Sectors</option>
                <option value="Technology">Technology</option>
                <option value="Financial">Financial</option>
                <option value="Consumer Discretionary">Consumer Discretionary</option>
                <option value="Communication Services">Communication Services</option>
                <option value="Healthcare">Healthcare</option>
                <option value="Energy">Energy</option>
              </select>
            </div>

            <div className="control-item">
              <label>RSI-14 Strategy</label>
              <select
                value={rsiFilterPreset}
                onChange={(e) => setRsiFilterPreset(e.target.value as any)}
              >
                <option value="all">Any RSI</option>
                <option value="oversold">Oversold (RSI &lt; 35)</option>
                <option value="neutral">Neutral Range (35 - 70)</option>
                <option value="overbought">Overbought (RSI &gt; 70)</option>
              </select>
            </div>

            <div className="control-item">
              <label>Market Cap</label>
              <select
                value={marketCapPreset}
                onChange={(e) => setMarketCapPreset(e.target.value)}
              >
                <option value="all">Any Market Cap</option>
                <option value="mega">Mega-Cap (&gt; $200B)</option>
                <option value="large">Large-Cap (&gt; $50B)</option>
              </select>
            </div>

            <div className="control-item">
              <label>Trend</label>
              <select
                value={perfFilter}
                onChange={(e) => setPerfFilter(e.target.value as any)}
              >
                <option value="all">All Trends</option>
                <option value="gainers">Gainers Only (&gt; 0%)</option>
                <option value="losers">Losers Only (&lt; 0%)</option>
              </select>
            </div>

            <div className="control-item search-item">
              <label>Search Ticker</label>
              <input
                type="text"
                placeholder="NVDA, Apple, AI..."
                value={screenerSearch}
                onChange={(e) => setScreenerSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runScreener();
                }}
              />
            </div>

            <div className="control-item btn-item">
              <label>&nbsp;</label>
              <button
                type="button"
                className="btn-run-scan"
                disabled={screenerLoading}
                onClick={runScreener}
              >
                {screenerLoading ? "Scanning…" : "⚡ Run Market Scan"}
              </button>
            </div>
          </div>

          {/* Screener Results Meta */}
          <div className="screener-results-header">
            <span className="results-count">
              Universe: <strong>{scanUniverseCount}</strong> equities • Matches: <strong>{screenerStocks.length}</strong> • Lookback: 14-period Daily RSI • Delay: Level 1 Quotes
            </span>
            <span className="results-timestamp">Last Scan: {scannedAt || "Just now"}</span>
          </div>

          {/* Screener Cards / Table Grid */}
          <div className="screener-table-wrap">
            <table className="trading-table">
              <thead>
                <tr>
                  <th>Symbol &amp; Company</th>
                  <th>Sector</th>
                  <th>Price</th>
                  <th>24h Change</th>
                  <th>RSI (14)</th>
                  <th>Technical Signal</th>
                  <th>Market Cap</th>
                  <th>Volume</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {screenerStocks.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="empty-state" role="status" aria-live="polite">
                      {screenerLoading ? (
                        "Scanning equity universe…"
                      ) : scanStatus === "not_run" ? (
                        "Scanner has not been run. Select your filters and click 'Run Technical Screen'."
                      ) : scanStatus === "no_universe" || scanUniverseCount === 0 ? (
                        "⚠️ No universe processed: 0 symbols retrieved in selected sector. Data unavailable."
                      ) : scanStatus === "scan_failed" ? (
                        "⚠️ Technical scan failed: Data provider returned an error or timeout. Please retry."
                      ) : (
                        `Scanned ${scanUniverseCount} equities across ${sectorFilter}; 0 matched the selected criteria (RSI, Market Cap, Performance).`
                      )}
                    </td>
                  </tr>
                ) : (
                  screenerStocks.map((stock) => {
                    const rsi = stock.rsi14 || stock.rsi || 50;
                    const isPositive = stock.change >= 0;
                    return (
                      <tr key={stock.symbol} className="stock-row">
                        <td>
                          <div className="ticker-company">
                            <span className="ticker-badge">{stock.symbol}</span>
                            <span className="company-title">{stock.companyName}</span>
                          </div>
                        </td>
                        <td>
                          <span className="sector-tag">{stock.sector || "Equities"}</span>
                        </td>
                        <td>
                          <span className="price-tag">${(stock.lastPrice || stock.price || 0).toFixed(2)}</span>
                        </td>
                        <td>
                          <span className={`change-pill ${isPositive ? "positive" : "negative"}`}>
                            {isPositive ? "+" : ""}{stock.change.toFixed(2)} ({isPositive ? "+" : ""}{stock.changePercent.toFixed(2)}%)
                          </span>
                        </td>
                        <td>
                          <div className="rsi-cell">
                            <span className={`rsi-badge ${getRsiBadgeClass(rsi)}`}>
                              {rsi.toFixed(1)} • {getRsiLabel(rsi)}
                            </span>
                            <div className="rsi-meter-bar">
                              <div
                                className={`rsi-fill ${getRsiBadgeClass(rsi)}`}
                                style={{ width: `${Math.min(100, Math.max(0, rsi))}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="tech-signal-pill" title={stock.highlightReason}>
                            {stock.technicalSignal || stock.signal || "ACTIVE"}
                          </span>
                        </td>
                        <td>
                          <span className="mcap-tag">
                            {stock.marketCap
                              ? `$${(stock.marketCap > 1e11 ? stock.marketCap / 1e12 : stock.marketCap / 1e9).toFixed(2)}${stock.marketCap > 1e11 ? "T" : "B"}`
                              : "N/A"}
                          </span>
                        </td>
                        <td>
                          <span className="vol-tag">
                            {stock.volume ? `${(stock.volume / 1e6).toFixed(1)}M` : "N/A"}
                          </span>
                        </td>
                        <td>
                          <div className="table-actions-cell">
                            <button
                              type="button"
                              className="btn-act-quote"
                              title="Inspect full Level 1 quote"
                              onClick={() => handleOpenInspectQuote(stock.symbol, stock)}
                            >
                              📊 Quote
                            </button>
                            <button
                              type="button"
                              className="btn-act-buy"
                              title="Populate Order Ticket (BUY)"
                              onClick={() => handleQuickTrade(stock, "BUY")}
                            >
                              ⚡ Buy
                            </button>
                            <button
                              type="button"
                              className="btn-act-sell"
                              title="Populate Order Ticket (SELL)"
                              onClick={() => handleQuickTrade(stock, "SELL")}
                            >
                              Sell
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 2: ORDER TICKET & HITL PREVIEW */}
      {subTab === "order" && (
        <div className="trading-section order-ticket-section">
          <div className="order-ticket-layout">
            {/* Left: Interactive Order Ticket Form */}
            <div className="order-form-card">
              <div className="card-header-styled">
                <h4>⚡ E*TRADE Fast Order Ticket</h4>
                <span className="header-subtitle">Zero-commission equity trading with agentic DID stamping</span>
              </div>

              {orderError && <div className="form-error-alert">⚠️ {orderError}</div>}

              <form onSubmit={handlePreviewOrder} className="order-ticket-form">
                {/* Symbol and Instant Quote */}
                <div className="form-group">
                  <label>Ticker Symbol</label>
                  <div className="symbol-input-row">
                    <input
                      type="text"
                      className="ticker-input"
                      placeholder="e.g. NVDA, AAPL"
                      value={orderSymbol}
                      onChange={(e) => {
                        const s = e.target.value.toUpperCase();
                        setOrderSymbol(s);
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                      }}
                      onBlur={() => fetchSymbolQuote(orderSymbol)}
                    />
                    <button
                      type="button"
                      className="btn-peek-quote"
                      disabled={quoteLoading}
                      onClick={() => fetchSymbolQuote(orderSymbol)}
                      title="Fetch live quote from E*TRADE"
                    >
                      {quoteLoading ? "Fetching…" : "🔍 Get Live Quote"}
                    </button>
                  </div>
                  {!oauthStatus?.authenticated && (
                    <div className="order-auth-notice">
                      <span>🔒 Connect your E*TRADE account to fetch authenticated live market quotes.</span>
                      <button type="button" onClick={handleStartOAuth}>
                        Connect E*TRADE →
                      </button>
                    </div>
                  )}
                  {orderQuote && (
                    <div className="order-quote-peek">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
                        <span className="quote-company">{orderQuote.companyName}</span>
                        {orderQuote.quoteStatus && (
                          <span style={{ fontSize: "0.68rem", fontWeight: 600, padding: "0.1rem 0.4rem", borderRadius: "4px", background: orderQuote.quoteStatus === "REALTIME" ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)", color: orderQuote.quoteStatus === "REALTIME" ? "#10b981" : "#f59e0b", border: "1px solid currentColor" }}>
                            ● {orderQuote.quoteStatus}
                          </span>
                        )}
                      </div>
                      <span className="quote-price">${orderQuote.lastPrice.toFixed(2)}</span>
                      <span className={`quote-change ${orderQuote.change >= 0 ? "positive" : "negative"}`}>
                        {orderQuote.change >= 0 ? "+" : ""}{orderQuote.change.toFixed(2)} ({orderQuote.changePercent.toFixed(2)}%)
                      </span>
                      <span className="quote-bidask">Bid: ${orderQuote.bid.toFixed(2)} / Ask: ${orderQuote.ask.toFixed(2)}</span>
                      {orderQuote.source && (
                        <span style={{ fontSize: "0.72rem", color: "#38bdf8", background: "rgba(56, 189, 248, 0.12)", padding: "0.15rem 0.45rem", borderRadius: "4px", border: "1px solid rgba(56, 189, 248, 0.25)" }}>
                          ✓ {orderQuote.source}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Action Toggle (BUY / SELL) */}
                <div className="form-group">
                  <label>Order Action</label>
                  <div className="action-toggle-grid">
                    <button
                      type="button"
                      className={`action-btn buy ${orderAction === "BUY" ? "active" : ""}`}
                      onClick={() => {
                        setOrderAction("BUY");
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                        if (orderQuote && orderType === "LIMIT") {
                          const askP = orderQuote.ask > 0 ? orderQuote.ask : orderQuote.lastPrice;
                          if (askP > 0) setOrderLimitPrice(askP.toFixed(2));
                        }
                      }}
                    >
                      BUY
                    </button>
                    <button
                      type="button"
                      className={`action-btn sell ${orderAction === "SELL" ? "active" : ""}`}
                      onClick={() => {
                        setOrderAction("SELL");
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                        if (orderQuote && orderType === "LIMIT") {
                          const bidP = orderQuote.bid > 0 ? orderQuote.bid : orderQuote.lastPrice;
                          if (bidP > 0) setOrderLimitPrice(bidP.toFixed(2));
                        }
                      }}
                    >
                      SELL
                    </button>
                    <button
                      type="button"
                      className={`action-btn short ${orderAction === "SELL_SHORT" ? "active" : ""}`}
                      onClick={() => {
                        setOrderAction("SELL_SHORT");
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                        if (orderQuote && orderType === "LIMIT") {
                          const bidP = orderQuote.bid > 0 ? orderQuote.bid : orderQuote.lastPrice;
                          if (bidP > 0) setOrderLimitPrice(bidP.toFixed(2));
                        }
                      }}
                    >
                      SHORT
                    </button>
                    <button
                      type="button"
                      className={`action-btn cover ${orderAction === "BUY_TO_COVER" ? "active" : ""}`}
                      onClick={() => {
                        setOrderAction("BUY_TO_COVER");
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                        if (orderQuote && orderType === "LIMIT") {
                          const askP = orderQuote.ask > 0 ? orderQuote.ask : orderQuote.lastPrice;
                          if (askP > 0) setOrderLimitPrice(askP.toFixed(2));
                        }
                      }}
                    >
                      COVER
                    </button>
                  </div>
                </div>

                {/* Order Type and Pricing */}
                <div className="form-row-2">
                  <div className="form-group">
                    <label>Order Type</label>
                    <select
                      value={orderType}
                      onChange={(e) => {
                        setOrderType(e.target.value as any);
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                      }}
                    >
                      <option value="MARKET">Market</option>
                      <option value="LIMIT">Limit</option>
                      <option value="STOP">Stop</option>
                      <option value="STOP_LIMIT">Stop Limit</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>{orderType === "LIMIT" ? "Limit Price ($)" : "Stop Price ($)"}</label>
                    <input
                      type="number"
                      step="0.01"
                      disabled={orderType === "MARKET"}
                      placeholder={orderQuote?.lastPrice ? orderQuote.lastPrice.toFixed(2) : "125.50"}
                      value={orderLimitPrice}
                      onChange={(e) => {
                        setOrderLimitPrice(e.target.value);
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                      }}
                    />
                  </div>
                </div>

                {/* Limit Price Sanity / Market Divergence Notice */}
                {(() => {
                  const parsedLimit = parseFloat(orderLimitPrice);
                  if (orderType !== "LIMIT" || isNaN(parsedLimit) || parsedLimit <= 0 || !orderQuote) return null;
                  const askPrice = orderQuote.ask > 0 ? orderQuote.ask : orderQuote.lastPrice;
                  const bidPrice = orderQuote.bid > 0 ? orderQuote.bid : orderQuote.lastPrice;
                  if ((orderAction === "BUY" || orderAction === "BUY_TO_COVER") && askPrice > 0 && parsedLimit > askPrice * 1.05) {
                    return (
                      <div className="limit-warning-box" role="alert" style={{ background: "#fef3c7", color: "#92400e", padding: "0.5rem 0.75rem", borderRadius: "6px", fontSize: "0.8rem", marginTop: "-0.5rem", marginBottom: "0.75rem", border: "1px solid #fde68a" }}>
                        ⚠️ <strong>Limit Price Alert:</strong> Proposed Buy Limit (${parsedLimit.toFixed(2)}) is &gt;5% above current ask (${askPrice.toFixed(2)}). As a buy limit, this order may execute immediately at prevailing market prices.
                      </div>
                    );
                  }
                  if ((orderAction === "BUY" || orderAction === "BUY_TO_COVER") && askPrice > 0 && parsedLimit < askPrice * 0.7) {
                    return (
                      <div className="limit-warning-box" role="alert" style={{ background: "#fee2e2", color: "#991b1b", padding: "0.5rem 0.75rem", borderRadius: "6px", fontSize: "0.8rem", marginTop: "-0.5rem", marginBottom: "0.75rem", border: "1px solid #fca5a5" }}>
                        ⚠️ <strong>Pricing Collar Alert:</strong> Proposed Buy Limit (${parsedLimit.toFixed(2)}) is {Math.round((1 - parsedLimit / askPrice) * 100)}% below current ask (${askPrice.toFixed(2)}). Broker collar rules may reject orders that diverge excessively from prevailing NBBO quotes.
                      </div>
                    );
                  }
                  if ((orderAction === "SELL" || orderAction === "SELL_SHORT") && bidPrice > 0 && parsedLimit < bidPrice * 0.95) {
                    return (
                      <div className="limit-warning-box" role="alert" style={{ background: "#fef3c7", color: "#92400e", padding: "0.5rem 0.75rem", borderRadius: "6px", fontSize: "0.8rem", marginTop: "-0.5rem", marginBottom: "0.75rem", border: "1px solid #fde68a" }}>
                        ⚠️ <strong>Limit Price Alert:</strong> Proposed Sell Limit (${parsedLimit.toFixed(2)}) is &gt;5% below current bid (${bidPrice.toFixed(2)}). As a sell limit, this order may execute immediately below prevailing value.
                      </div>
                    );
                  }
                  if ((orderAction === "SELL" || orderAction === "SELL_SHORT") && bidPrice > 0 && parsedLimit > bidPrice * 1.3) {
                    return (
                      <div className="limit-warning-box" role="alert" style={{ background: "#fee2e2", color: "#991b1b", padding: "0.5rem 0.75rem", borderRadius: "6px", fontSize: "0.8rem", marginTop: "-0.5rem", marginBottom: "0.75rem", border: "1px solid #fca5a5" }}>
                        ⚠️ <strong>Pricing Collar Alert:</strong> Proposed Sell Limit (${parsedLimit.toFixed(2)}) is {Math.round((parsedLimit / bidPrice - 1) * 100)}% above current bid (${bidPrice.toFixed(2)}). Broker collar rules may reject orders that diverge excessively from prevailing NBBO quotes.
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Quantity and Quick Stepper */}
                <div className="form-group">
                  <label>Quantity (Shares)</label>
                  <div className="quantity-stepper-row">
                    <button
                      type="button"
                      className="qty-btn"
                      onClick={() => {
                        setOrderQuantity(Math.max(1, orderQuantity - 5));
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                      }}
                    >
                      -5
                    </button>
                    <input
                      type="number"
                      min="1"
                      className="qty-input"
                      value={orderQuantity}
                      onChange={(e) => {
                        setOrderQuantity(Math.max(1, parseInt(e.target.value) || 1));
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                      }}
                    />
                    <button
                      type="button"
                      className="qty-btn"
                      onClick={() => {
                        setOrderQuantity(orderQuantity + 5);
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                      }}
                    >
                      +5
                    </button>
                  </div>
                  <div className="qty-preset-chips">
                    {[5, 10, 25, 50, 100].map((q) => (
                      <button
                        key={q}
                        type="button"
                        className={`qty-chip ${orderQuantity === q ? "selected" : ""}`}
                        onClick={() => {
                          setOrderQuantity(q);
                          setActiveDraft(null);
                          setLastExecutionResult(null);
                        }}
                      >
                        {q} shs
                      </button>
                    ))}
                  </div>
                </div>

                {/* Pricing Summary */}
                <div className="order-calc-card">
                  <div className="calc-row">
                    <span>Estimated Price per Share:</span>
                    <span>${orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0").toFixed(2) : (orderQuote?.lastPrice || 0).toFixed(2)}</span>
                  </div>
                  <div className="calc-row">
                    <span>Online Commission:</span>
                    <span className="zero-comm">$0.00 USD</span>
                  </div>
                  <div className="calc-row total">
                    <span>Estimated Total Order Value:</span>
                    <span className="calc-total-val">
                      ${(
                        orderQuantity *
                        (orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0") : orderQuote?.lastPrice || 0)
                      ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                {/* Submit Preview Button */}
                <button
                  type="submit"
                  className="btn-submit-preview"
                  disabled={previewLoading || !orderSymbol.trim()}
                >
                  {previewLoading ? "Creating Cryptographic Preview…" : "🛡️ Preview Order with Agent DID"}
                </button>
              </form>
            </div>

            {/* Right: Security & Architecture Specs */}
            <div className="order-side-info">
              <div className="info-card">
                <h5>🛡️ Agentic HITL Safety Guarantee</h5>
                <p>
                  Every trade initiated by the Multi-Agent System is saved to the SQLite ledger in <code>previewed</code> status.
                  No funds are moved, and no order is routed to E*TRADE until you review the order details and click <strong>Approve &amp; Submit</strong>.
                </p>
                <div className="safety-bullets">
                  <div className="bullet-item">
                    <span className="bullet-icon">🔒</span>
                    <div>
                      <strong>Cryptographic DID Attestation:</strong> All orders are stamped with Trading Agent DID (<code>did:agent:openaimp:trading</code>) and reviewer user DID.
                    </div>
                  </div>
                  <div className="bullet-item">
                    <span className="bullet-icon">⚖️</span>
                    <div>
                      <strong>GoF &amp; SOLID Enforcement:</strong> Executes via the Command &amp; Strategy pattern with protected variations over live OAuth and simulated endpoints.
                    </div>
                  </div>
                  <div className="bullet-item">
                    <span className="bullet-icon">⚡</span>
                    <div>
                      <strong>Instant Broker Cancellation:</strong> You can reject or cancel draft orders with one click at any time before execution.
                    </div>
                  </div>
                </div>
              </div>

              {/* Sample Quick Action Box */}
              <div className="info-card">
                <h5>💬 NLQ Voice &amp; Text Prompts</h5>
                <p>You can also place trades effortlessly through conversational natural language:</p>
                <div className="nlq-example-links">
                  <button
                    type="button"
                    className="example-link"
                    onClick={() => {
                      setSubTab("nlq");
                      setNlqQuery("Preview buy 10 shares of NVDA limit 125.50");
                      handleRunNlq(undefined, "Preview buy 10 shares of NVDA limit 125.50");
                    }}
                  >
                    👉 "Preview buy 10 shares of NVDA limit 125.50"
                  </button>
                  <button
                    type="button"
                    className="example-link"
                    onClick={() => {
                      setSubTab("nlq");
                      setNlqQuery("Screen oversold tech stocks");
                      handleRunNlq(undefined, "Screen oversold tech stocks");
                    }}
                  >
                    👉 "Screen oversold tech stocks"
                  </button>
                  <button
                    type="button"
                    className="example-link"
                    onClick={() => {
                      setSubTab("nlq");
                      setNlqQuery("Show my portfolio positions");
                      handleRunNlq(undefined, "Show my portfolio positions");
                    }}
                  >
                    👉 "Show my portfolio positions"
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 3: PORTFOLIO & POSITIONS */}
      {subTab === "portfolio" && (
        <div className="trading-section portfolio-section">
          <div className="portfolio-summary-row">
            {(() => {
              const totalUnrealizedGain = positions.reduce((sum, p) => sum + (p.unrealizedGainLoss || p.totalGain || 0), 0);
              const totalVal = account?.totalAccountValue || positions.reduce((sum, p) => sum + p.marketValue, 0);
              const cashVal = account?.cashAvailableForInvestment ?? 0;
              const isGain = totalUnrealizedGain >= 0;

              return (
                <>
                  <div className="port-summary-card">
                    <span className="summary-title">Portfolio Equity</span>
                    <span className="summary-amount">
                      ${totalVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className={`summary-change ${isGain ? "positive" : "negative"}`}>
                      {isGain ? "+" : ""}${totalUnrealizedGain.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (Unrealized {isGain ? "Gains" : "Losses"})
                    </span>
                  </div>
                  <div className="port-summary-card">
                    <span className="summary-title">Available Cash</span>
                    <span className="summary-amount">
                      ${cashVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className="summary-change">Ready to deploy</span>
                  </div>
                </>
              );
            })()}
            <div className="port-summary-card">
              <span className="summary-title">Total Active Positions</span>
              <span className="summary-amount">{positions.length} Stocks</span>
              <span className="summary-change">Equities &amp; ETFs</span>
            </div>
          </div>

          <div className="portfolio-table-wrap">
            <table className="trading-table">
              <thead>
                <tr>
                  <th>Symbol &amp; Company</th>
                  <th>Quantity</th>
                  <th>Avg Cost Basis</th>
                  <th>Current Price</th>
                  <th>Total Market Value</th>
                  <th>Unrealized Gain / Loss</th>
                  <th>Day's Gain</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="empty-state">
                      {positionsLoading ? "Loading portfolio positions from E*TRADE…" : "No active positions found in brokerage account."}
                    </td>
                  </tr>
                ) : (
                  positions.map((pos) => {
                    const isTotalPos = pos.unrealizedGainLoss >= 0;
                    const isDayPos = pos.daysGain >= 0;
                    return (
                      <tr key={pos.symbol}>
                        <td>
                          <div className="ticker-company">
                            <span className="ticker-badge">{pos.symbol}</span>
                            <span className="company-title">{pos.description}</span>
                          </div>
                        </td>
                        <td>
                          <span className="qty-val">{pos.quantity} shares</span>
                        </td>
                        <td>
                          <span>${pos.costBasis.toFixed(2)}</span>
                        </td>
                        <td>
                          <span className="price-tag">${pos.currentPrice.toFixed(2)}</span>
                        </td>
                        <td>
                          <span className="mkt-val">${pos.marketValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </td>
                        <td>
                          <span className={`change-pill ${isTotalPos ? "positive" : "negative"}`}>
                            {isTotalPos ? "+" : ""}${pos.unrealizedGainLoss.toFixed(2)} ({isTotalPos ? "+" : ""}{pos.unrealizedGainLossPercent.toFixed(2)}%)
                          </span>
                        </td>
                        <td>
                          <span className={`change-pill ${isDayPos ? "positive" : "negative"}`}>
                            {isDayPos ? "+" : ""}${pos.daysGain.toFixed(2)} ({isDayPos ? "+" : ""}{pos.daysGainPercent.toFixed(2)}%)
                          </span>
                        </td>
                        <td>
                          <div className="table-actions-cell">
                            <button
                              type="button"
                              className="btn-act-buy"
                              onClick={() => handleQuickTrade(pos, "BUY")}
                              title="Add more shares"
                            >
                              + Buy
                            </button>
                            <button
                              type="button"
                              className="btn-act-sell"
                              onClick={() => handleQuickTrade(pos, "SELL")}
                              title="Sell to close position"
                            >
                              - Close
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 4: ORDER HISTORY LEDGER */}
      {subTab === "ledger" && (
        <div className="trading-section ledger-section">
          <div className="ledger-header-row">
            <h4>📜 E*TRADE Orders Ledger (SQLite mas_trades)</h4>
            <button
              type="button"
              className="btn-refresh-orders"
              disabled={ordersLoading}
              onClick={fetchOrders}
            >
              {ordersLoading ? "Refreshing…" : "🔄 Refresh Ledger"}
            </button>
          </div>

          <div className="ledger-table-wrap">
            <table className="trading-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Symbol</th>
                  <th>Action</th>
                  <th>Shares</th>
                  <th>Price</th>
                  <th>Total Value</th>
                  <th>Status</th>
                  <th>Broker Ref</th>
                  <th>Proposer DID</th>
                  <th>Date &amp; Time</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="empty-state">
                      {ordersLoading ? "Loading orders ledger…" : "No trade orders recorded yet."}
                    </td>
                  </tr>
                ) : (
                  orders.map((ord) => (
                    <tr key={ord.id}>
                      <td>
                        <code>{ord.id}</code>
                      </td>
                      <td>
                        <span className="ticker-badge">{ord.symbol}</span>
                      </td>
                      <td>
                        <span className={`action-pill ${ord.action.toLowerCase()}`}>{ord.action}</span>
                      </td>
                      <td>{ord.quantity}</td>
                      <td>${ord.price.toFixed(2)}</td>
                      <td>${ord.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td>
                        <span className={`tx-status-pill ${ord.status}`}>
                          {ord.status.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <code className="broker-ref-snippet">{ord.orderRef || "—"}</code>
                      </td>
                      <td>
                        <code className="did-snippet" title={ord.proposerDid}>
                          {ord.proposerDid.replace("did:agent:openaimp:", "")}
                        </code>
                      </td>
                      <td>
                        <span className="time-snippet">{new Date(ord.createdAt).toLocaleString()}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 5: NLQ RESULTS */}
      {subTab === "nlq" && (
        <div className="trading-section nlq-section">
          <div className="nlq-results-wrapper">
            <div className="nlq-query-recap">
              <span className="nlq-icon-big">🤖</span>
              <div className="nlq-query-meta">
                <h4>Natural Language Trading Query</h4>
                <p>"{nlqQuery || "Show top momentum gainers"}"</p>
              </div>
            </div>

            {nlqLoading && (
              <div className="nlq-loading-state">
                <span className="spinner-large" />
                <p>Analyzing trading intent, scanning E*TRADE markets, and synthesizing response…</p>
              </div>
            )}

            {!nlqLoading && nlqResult && (
              <div className="nlq-response-card">
                {/* Plan Overview */}
                {nlqResult.plan && (
                  <div className="nlq-plan-pill-group">
                    <span className="plan-badge domain">Domain: {nlqResult.plan.domain}</span>
                    <span className="plan-badge intent">Intent: {nlqResult.plan.tradingData?.intent || "market_query"}</span>
                    {nlqResult.plan.sql && (
                      <span className="plan-badge sql">Deterministic SQL</span>
                    )}
                  </div>
                )}

                {/* Provenance Strip */}
                {(nlqResult.provenance || nlqResult.result?.provenance) && (
                  <div className="provenance-strip">
                    <span className="provenance-pill">
                      <strong>Data Source:</strong> {(nlqResult.provenance || nlqResult.result?.provenance)?.dataSource || "E*TRADE Sandbox REST API"}
                    </span>
                    <span className="provenance-pill">
                      <strong>Observed:</strong> {(nlqResult.provenance || nlqResult.result?.provenance)?.pricesObservedAt ? new Date((nlqResult.provenance || nlqResult.result?.provenance).pricesObservedAt).toLocaleTimeString() : "Just now"}
                    </span>
                    <span className="provenance-pill">
                      <strong>Reconciliation:</strong> {(nlqResult.provenance || nlqResult.result?.provenance)?.reconciliationStatus || "VERIFIED"}
                    </span>
                  </div>
                )}

                {/* Fail-Closed Reconcile Alert */}
                {(nlqResult.reconciled === false || nlqResult.status === "RECONCILIATION_FAILED" || nlqResult.result?.reconciled === false) && (
                  <div className="nlq-unverified-warning-banner" role="alert">
                    <div className="warning-title">
                      ⚠️ UNVERIFIED / POSSIBLE DEMO DATA — NO ACCOUNT CONCLUSION SHOWN
                    </div>
                    <p className="warning-desc">
                      {nlqResult.summary || nlqResult.result?.summary}
                    </p>
                    {(nlqResult.discrepancy || nlqResult.result?.discrepancy) && (
                      <div className="discrepancy-breakdown-box">
                        <h5>Discrepancy Breakdown:</h5>
                        <div className="discrepancy-grid">
                          <div><strong>Stated Total:</strong> {(nlqResult.discrepancy || nlqResult.result?.discrepancy).statedAccountTotal || (nlqResult.discrepancy || nlqResult.result?.discrepancy).statedTotal}</div>
                          <div><strong>Holdings Sum:</strong> {(nlqResult.discrepancy || nlqResult.result?.discrepancy).positionsMarketValue || (nlqResult.discrepancy || nlqResult.result?.discrepancy).positionsSum}</div>
                          <div><strong>Stated Cash:</strong> {(nlqResult.discrepancy || nlqResult.result?.discrepancy).statedCash}</div>
                          <div className="variance-highlight"><strong>Unexplained Variance:</strong> {(nlqResult.discrepancy || nlqResult.result?.discrepancy).unexplainedVariance}</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Fail-Closed Scan Mismatch Alert */}
                {(nlqResult.status === "SCAN_INVALID_DATA_MISMATCH" || nlqResult.result?.status === "SCAN_INVALID_DATA_MISMATCH") && (
                  <div className="nlq-unverified-warning-banner" role="alert" style={{ background: "rgba(185, 28, 28, 0.2)", borderColor: "#ef4444" }}>
                    <div className="warning-title" style={{ color: "#fca5a5" }}>
                      🚨 SCAN INVALID — DATA MISMATCH: FILTER CONTRADICTION DETECTED
                    </div>
                    <p className="warning-desc" style={{ color: "#fee2e2" }}>
                      {nlqResult.summary || nlqResult.result?.summary}
                    </p>
                    <div style={{ fontSize: "0.85rem", color: "#fca5a5", marginTop: "0.4rem" }}>
                      Trading order shortcuts disabled because one or more candidates failed validation.
                    </div>
                  </div>
                )}

                {/* Scan Audit Ledger Box */}
                {(nlqResult.scanLedger || nlqResult.result?.scanLedger) && (
                  <div className="scan-audit-ledger-box" style={{ background: "rgba(15, 23, 42, 0.7)", border: "1px solid #334155", borderRadius: "8px", padding: "1rem", margin: "1rem 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
                      <h5 style={{ margin: 0, fontSize: "0.95rem", color: "#93c5fd", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span>🛡️</span> Market Universe Scan Audit Ledger
                      </h5>
                      <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                        Evaluated: <strong style={{ color: "#f8fafc" }}>{(nlqResult.scanLedger || nlqResult.result?.scanLedger).totalEvaluated}</strong> | 
                        Passed: <strong style={{ color: "#4ade80" }}>{(nlqResult.scanLedger || nlqResult.result?.scanLedger).passedCount}</strong> | 
                        Rejected: <strong style={{ color: "#f87171" }}>{(nlqResult.scanLedger || nlqResult.result?.scanLedger).rejectedCount}</strong>
                      </div>
                    </div>

                    {/* Universe Evaluated Badges */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.75rem" }}>
                      <span style={{ fontSize: "0.8rem", color: "#94a3b8", alignSelf: "center", marginRight: "0.25rem" }}>Universe:</span>
                      {((nlqResult.scanLedger || nlqResult.result?.scanLedger).universeSymbols || []).map((sym: string) => {
                        const isRejected = ((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).some((r: any) => r.symbol === sym);
                        return (
                          <span key={sym} style={{
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontSize: "0.75rem",
                            fontFamily: "monospace",
                            background: !isRejected ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                            color: !isRejected ? "#4ade80" : "#fca5a5",
                            border: `1px solid ${!isRejected ? "#16a34a" : "#dc2626"}`
                          }}>
                            {sym} {!isRejected ? "✓" : "✗"}
                          </span>
                        );
                      })}
                    </div>

                    {/* Rejection Details */}
                    {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).length > 0 && (
                      <details style={{ fontSize: "0.8rem", color: "#cbd5e1", marginTop: "0.5rem" }}>
                        <summary style={{ cursor: "pointer", color: "#f87171" }}>
                          View {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).length} Rejection Details (Filter Enforcement)
                        </summary>
                        <ul style={{ margin: "0.5rem 0 0 1rem", padding: 0 }}>
                          {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).map((rej: any, rIdx: number) => (
                            <li key={rIdx} style={{ margin: "0.25rem 0", color: "#94a3b8" }}>
                              <strong style={{ color: "#f87171" }}>{rej.symbol}</strong>: {rej.reason}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}

                {/* Text Summary */}
                {(nlqResult.summary || nlqResult.result?.summary) && (nlqResult.reconciled !== false && nlqResult.result?.reconciled !== false && nlqResult.status !== "RECONCILIATION_FAILED") && (
                  <div className="nlq-summary-text" role="status" aria-live="polite">
                    {nlqResult.summary || nlqResult.result?.summary}
                  </div>
                )}

                {/* Portfolio / Query Rows Table */}
                {Array.isArray(nlqResult.rows || nlqResult.result?.rows) && (nlqResult.rows || nlqResult.result?.rows).length > 0 && (
                  <div className="nlq-rows-table-wrap" style={{ margin: "1rem 0", overflowX: "auto" }}>
                    <table className="trading-table">
                      <thead>
                        <tr>
                          {Object.keys((nlqResult.rows || nlqResult.result?.rows)[0]).map((col) => (
                            <th key={col}>{col.toUpperCase()}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(nlqResult.rows || nlqResult.result?.rows).map((row: any, idx: number) => (
                          <tr key={idx}>
                            {Object.entries(row).map(([key, val]: [string, any], cidx: number) => {
                              if (key === "actionAvailable") {
                                const isDisabled = String(val).includes("DISABLED");
                                return (
                                  <td key={cidx}>
                                    {isDisabled ? (
                                      <span style={{ color: "#ef4444", fontSize: "0.75rem", fontWeight: "bold" }}>
                                        ⛔ {String(val)}
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        className="btn-card-quote"
                                        style={{ fontSize: "0.75rem", padding: "2px 8px" }}
                                        onClick={() => {
                                          if (row.symbol) handleOpenInspectQuote(row.symbol);
                                        }}
                                      >
                                        ⚡ {String(val)}
                                      </button>
                                    )}
                                  </td>
                                );
                              }
                              return <td key={cidx}>{String(val)}</td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Stock Screener Results */}
                {nlqResult.result?.screener?.stocks && (
                  <div className="nlq-screener-cards-grid">
                    {nlqResult.result.screener.stocks.map((stock: ScreenedStockItem) => (
                      <div key={stock.symbol} className="nlq-stock-card">
                        <div className="card-top">
                          <span className="ticker-badge">{stock.symbol}</span>
                          <span className="price">${stock.price.toFixed(2)}</span>
                        </div>
                        <div className="card-company">{stock.companyName}</div>
                        <div className="card-technicals">
                          <span className={`rsi-badge ${getRsiBadgeClass(stock.rsi14)}`}>
                            RSI: {stock.rsi14.toFixed(1)}
                          </span>
                          <span className="signal-badge">{stock.technicalSignal}</span>
                        </div>
                        <div className="card-reason">{stock.highlightReason}</div>
                        <div className="card-actions">
                          <button
                            type="button"
                            className="btn-card-quote"
                            onClick={() => handleOpenInspectQuote(stock.symbol, stock)}
                          >
                            Quote
                          </button>
                          <button
                            type="button"
                            className="btn-card-trade"
                            onClick={() => handleQuickTrade(stock, "BUY")}
                          >
                            ⚡ Trade
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Raw Result Inspector */}
                <details className="nlq-raw-details">
                  <summary>View Complete NLQ JSON Execution Trace</summary>
                  <pre>{JSON.stringify(nlqResult, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quote Inspection Modal */}
      {inspectSymbol && (
        <div className="quote-modal-backdrop" onClick={() => setInspectSymbol(null)}>
          <div className="quote-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="ticker-group">
                <span className="modal-ticker">{inspectSymbol}</span>
                <span className="modal-company">{inspectQuote?.companyName || "Loading…"}</span>
              </div>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setInspectSymbol(null)}
              >
                ✕
              </button>
            </div>

            {inspectLoading ? (
              <div className="modal-loading">Fetching real-time Level 1 Quote…</div>
            ) : inspectQuote ? (
              <div className="modal-body">
                <div className="price-big-row">
                  <span className="big-price">${inspectQuote.lastPrice.toFixed(2)}</span>
                  <span className={`big-change ${inspectQuote.change >= 0 ? "positive" : "negative"}`}>
                    {inspectQuote.change >= 0 ? "+" : ""}{inspectQuote.change.toFixed(2)} ({inspectQuote.changePercent.toFixed(2)}%)
                  </span>
                </div>

                <div className="quote-grid-3">
                  <div className="grid-item">
                    <span className="label">Bid</span>
                    <span className="val">${inspectQuote.bid.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Ask</span>
                    <span className="val">${inspectQuote.ask.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Spread</span>
                    <span className="val">${(inspectQuote.ask - inspectQuote.bid).toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Open</span>
                    <span className="val">${inspectQuote.open.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Day High</span>
                    <span className="val">${inspectQuote.high.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Day Low</span>
                    <span className="val">${inspectQuote.low.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">52-Week High</span>
                    <span className="val">${inspectQuote.week52High.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">52-Week Low</span>
                    <span className="val">${inspectQuote.week52Low.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Volume</span>
                    <span className="val">{(inspectQuote.volume / 1e6).toFixed(2)}M</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">P/E Ratio</span>
                    <span className="val">{inspectQuote.peRatio || "N/A"}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Market Cap</span>
                    <span className="val">
                      {inspectQuote.marketCap ? `$${(inspectQuote.marketCap / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="grid-item">
                    <span className="label">RSI (14)</span>
                    <span className={`val ${getRsiBadgeClass(inspectQuote.rsi || 50)}`}>
                      {inspectQuote.rsi?.toFixed(1) || "50.0"}
                    </span>
                  </div>
                </div>

                <div className="modal-actions-bar">
                  <button
                    type="button"
                    className="btn-modal-buy"
                    onClick={() => {
                      handleQuickTrade(inspectQuote, "BUY");
                      setInspectSymbol(null);
                    }}
                  >
                    ⚡ Trade {inspectQuote.symbol}
                  </button>
                  <button
                    type="button"
                    className="btn-modal-dismiss"
                    onClick={() => setInspectSymbol(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <div className="modal-error">Could not retrieve quote details.</div>
            )}
          </div>
        </div>
      )}
      {/* Reconciliation Discrepancy Breakdown Modal */}
      {showDiscrepancyModal && (
        <div className="modal-backdrop" onClick={() => setShowDiscrepancyModal(false)}>
          <div className="etrade-pin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Portfolio Reconciliation Audit Failure</h3>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setShowDiscrepancyModal(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ color: "#fca5a5", fontSize: "0.88rem", margin: "0 0 1rem 0" }}>
                The portfolio ledger failed the mathematical reconciliation check. Total stated account value does not equal the sum of active stock positions plus stated cash.
              </p>
              <div className="discrepancy-grid" style={{ background: "rgba(0,0,0,0.35)", padding: "1rem", borderRadius: "8px", margin: "0.5rem 0 1rem 0" }}>
                <div><strong>Stated Net Account Value:</strong> ${statedNav.toFixed(2)}</div>
                <div><strong>Sum of Holdings Market Value:</strong> ${positionsSum.toFixed(2)} ({positions.length} holdings)</div>
                <div><strong>Stated Cash Balance:</strong> ${cashPower.toFixed(2)}</div>
                <div><strong>Calculated Portfolio Total:</strong> ${calculatedPortfolioTotal.toFixed(2)}</div>
                <div className="variance-highlight" style={{ gridColumn: "1 / -1", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "0.5rem" }}>
                  <strong>Unexplained Variance:</strong> ${balanceDiscrepancy.toFixed(2)}
                </div>
              </div>
              <p style={{ color: "#94a3b8", fontSize: "0.82rem", lineHeight: 1.4 }}>
                <strong>Fail-Closed Safety Policy:</strong> In compliance with fiduciary audit principles, aggregate portfolio conclusions and P&amp;L assertions are withheld until the data source can be reconciled.
              </p>
              <button
                type="button"
                className="btn-cancel-modal"
                onClick={() => setShowDiscrepancyModal(false)}
                style={{ width: "100%", marginTop: "1rem" }}
              >
                Close Discrepancy Panel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* E*TRADE Live REST Diagnostics Modal */}
      {showDiagnosticsModal && (
        <div className="modal-backdrop" onClick={() => setShowDiagnosticsModal(false)}>
          <div className="etrade-pin-modal diagnostics-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "680px" }}>
            <div className="modal-header">
              <h3>⚡ E*TRADE Live REST Diagnostics [{diagnostics?.environment || activeEnv}]</h3>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setShowDiagnosticsModal(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              {diagnostics ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
                    <span className={`status-pill status-${diagnostics.status || "unknown"}`} style={{
                      padding: "0.35rem 0.75rem",
                      borderRadius: "6px",
                      fontWeight: 700,
                      fontSize: "0.82rem",
                      background: diagnostics.status === "healthy" ? "rgba(16, 185, 129, 0.2)" : (diagnostics.status === "auth_required" ? "rgba(245, 158, 11, 0.2)" : "rgba(239, 68, 68, 0.2)"),
                      color: diagnostics.status === "healthy" ? "#34d399" : (diagnostics.status === "auth_required" ? "#fbbf24" : "#f87171"),
                      border: `1px solid ${diagnostics.status === "healthy" ? "rgba(16, 185, 129, 0.4)" : (diagnostics.status === "auth_required" ? "rgba(245, 158, 11, 0.4)" : "rgba(239, 68, 68, 0.4)")}`
                    }}>
                      {diagnostics.status === "healthy" ? "🟢 Live REST Upstream Connected & Verified" : (diagnostics.status === "auth_required" ? "🟡 OAuth 1.0a Session Required" : "🔴 Upstream Gateway Error")}
                    </span>
                    <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
                      Gateway: <code>{diagnostics.apiUrl}</code>
                    </span>
                  </div>

                  {diagnostics.lastError && (
                    <div style={{ background: "rgba(239, 68, 68, 0.12)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: "8px", padding: "0.75rem", marginBottom: "1rem", color: "#fca5a5", fontSize: "0.82rem" }}>
                      <strong>Upstream Message / Error:</strong>
                      <div style={{ marginTop: "0.35rem", fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
                        {diagnostics.lastError}
                      </div>
                      {diagnostics.lastError.includes("only in SANDBOX environment") && (
                        <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(239, 68, 68, 0.3)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
                          <span style={{ color: "#fbbf24", fontWeight: 600 }}>
                            💡 This Consumer Key belongs to E*TRADE Sandbox (apisb.etrade.com). Switch to TEST to test with this key!
                          </span>
                          <button
                            type="button"
                            className="btn-env-toggle active-env"
                            style={{ background: "#0ea5e9", color: "#fff", padding: "0.4rem 0.8rem", borderRadius: "6px", border: "none", cursor: "pointer", fontWeight: 700 }}
                            onClick={async () => {
                              setShowDiagnosticsModal(false);
                              await handleSwitchEnvironment("TEST");
                              await runDiagnostics("TEST");
                            }}
                          >
                            🧪 Switch to TEST &amp; Re-run
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
                    <div style={{ background: "rgba(0,0,0,0.3)", padding: "0.75rem", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontSize: "0.72rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Consumer Key</div>
                      <div style={{ fontSize: "0.88rem", fontWeight: 600, color: "#f8fafc", marginTop: "0.25rem" }}>
                        {diagnostics.credentials?.apiKeyMasked || (diagnostics.credentials?.apiKeyConfigured ? "✓ Configured" : "MISSING")}
                      </div>
                    </div>
                    <div style={{ background: "rgba(0,0,0,0.3)", padding: "0.75rem", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontSize: "0.72rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Consumer Secret</div>
                      <div style={{ fontSize: "0.88rem", fontWeight: 600, color: "#f8fafc", marginTop: "0.25rem" }}>
                        {diagnostics.credentials?.apiSecretConfigured ? "✓ Configured in Cloudflare" : "MISSING"}
                      </div>
                    </div>
                    <div style={{ background: "rgba(0,0,0,0.3)", padding: "0.75rem", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontSize: "0.72rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Session Token in KV</div>
                      <div style={{ fontSize: "0.88rem", fontWeight: 600, color: diagnostics.oauthToken?.present ? "#34d399" : "#fbbf24", marginTop: "0.25rem" }}>
                        {diagnostics.oauthToken?.present ? "✓ Present & Active" : "No Active Token"}
                      </div>
                    </div>
                    <div style={{ background: "rgba(0,0,0,0.3)", padding: "0.75rem", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontSize: "0.72rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>Upstream Accounts</div>
                      <div style={{ fontSize: "0.88rem", fontWeight: 600, color: "#f8fafc", marginTop: "0.25rem" }}>
                        {diagnostics.upstreamAccounts?.count ?? 0} account(s) detected
                      </div>
                    </div>
                  </div>

                  {diagnostics.upstreamAccounts?.accounts && diagnostics.upstreamAccounts.accounts.length > 0 && (
                    <div style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.25)", borderRadius: "8px", padding: "0.75rem", marginBottom: "1rem" }}>
                      <strong style={{ color: "#34d399", fontSize: "0.82rem", display: "block", marginBottom: "0.35rem" }}>
                        Live Account Details:
                      </strong>
                      {diagnostics.upstreamAccounts.accounts.map((acct: any, idx: number) => (
                        <div key={idx} style={{ fontSize: "0.82rem", color: "#cbd5e1" }}>
                          • ID: <code>{acct.accountId}</code> | Key: <code>{acct.accountKey}</code> | Type: <strong>{acct.accountType || acct.accountDesc}</strong>
                        </div>
                      ))}
                      {diagnostics.upstreamBalance && (
                        <div style={{ marginTop: "0.5rem", paddingTop: "0.5rem", borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: "0.82rem", color: "#e2e8f0" }}>
                          • Live Balance Fetched: Net Value: <strong>${Number(diagnostics.upstreamBalance.netAccountValue || diagnostics.upstreamBalance.computed?.realTimeValues?.totalAccountValue || 0).toFixed(2)}</strong> | Cash: <strong>${Number(diagnostics.upstreamBalance.cashAvailableForInvestment || diagnostics.upstreamBalance.computed?.cashAvailableForInvestment || 0).toFixed(2)}</strong>
                        </div>
                      )}
                    </div>
                  )}

                  <details style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", padding: "0.5rem 0.75rem", marginBottom: "1rem" }}>
                    <summary style={{ cursor: "pointer", color: "#94a3b8", fontSize: "0.78rem", fontWeight: 600 }}>
                      🔍 View Raw Upstream Diagnostic Payload (JSON)
                    </summary>
                    <pre style={{ margin: "0.5rem 0 0 0", fontSize: "0.75rem", color: "#38bdf8", overflowX: "auto", maxHeight: "200px" }}>
                      {JSON.stringify(diagnostics, null, 2)}
                    </pre>
                  </details>

                  <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
                    {(!diagnostics.oauthToken?.present || diagnostics.status === "auth_required") && (
                      <button
                        type="button"
                        className="btn-oauth-connect"
                        style={{ padding: "0.55rem 1rem", fontSize: "0.82rem" }}
                        onClick={() => {
                          setShowDiagnosticsModal(false);
                          handleStartOAuth();
                        }}
                      >
                        ⚡ Connect E*TRADE Account
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-sync-diagnostics"
                      disabled={diagnosticsLoading}
                      onClick={() => runDiagnostics()}
                      style={{ padding: "0.55rem 1rem", fontSize: "0.82rem" }}
                    >
                      {diagnosticsLoading ? "⏳ Testing..." : "🔄 Re-run Diagnostics"}
                    </button>
                    <button
                      type="button"
                      className="btn-cancel-modal"
                      onClick={() => setShowDiagnosticsModal(false)}
                      style={{ padding: "0.55rem 1rem", fontSize: "0.82rem" }}
                    >
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ padding: "2rem", textAlign: "center", color: "#94a3b8" }}>
                  Running diagnostics against E*TRADE upstream API...
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Technical Diagnostics & Provenance Drawer (De-emphasized metadata) */}
      <details className="diagnostics-drawer" style={{ background: "rgba(15, 23, 42, 0.6)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: "10px", padding: "0.85rem 1.25rem", marginTop: "1.5rem" }}>
        <summary style={{ cursor: "pointer", color: "#94a3b8", fontSize: "0.85rem", fontWeight: 600 }}>
          ⚙️ Technical Diagnostics &amp; Audit Metadata (Agent DID &amp; Microservice Provenance)
        </summary>
        <div style={{ marginTop: "1rem", fontSize: "0.82rem", color: "#cbd5e1", display: "grid", gap: "0.5rem" }}>
          <div><strong>Trading Agent DID:</strong> <code>{tradingAgentDid}</code></div>
          <div><strong>Microservice Architecture:</strong> Model Context Protocol (MCP) &amp; OAuth 1.0a REST Client</div>
          <div><strong>Attestation Mechanism:</strong> Internal W3C DID cryptographic stamping for microservice audit logs (not a third-party brokerage guarantee)</div>
          <div><strong>Edge Database:</strong> Cloudflare Durable Objects + SQLite (tables: <code>mas_trades</code>, <code>mas_events</code>)</div>
        </div>
      </details>
    </div>
  );
}
