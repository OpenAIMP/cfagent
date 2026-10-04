import React, { useState, useEffect } from "react";
import { apiFetch as fetch } from "./apiFetch";
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
import { OptionsResearchPanel, type OptionsTradeContext } from "./OptionsResearchPanel";
import { LlmOptionsIdeasPanel } from "./LlmOptionsIdeasPanel";
import { ScreenersHub } from "./ScreenersHub";

function OptionsResearchPanelHost({ hidden, children }: { hidden: boolean; children: React.ReactNode }) {
  return <div hidden={hidden}>{children}</div>;
}
import { ResearchReportActions } from "./ResearchReportActions";

export interface User {
  login: string;
  name?: string;
  avatar?: string;
}

export interface ETradeTradingHubProps {
  user?: User;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

const NLQ_ROW_RENDER_LIMIT = 500;

function formatNlqColumn(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.replace(/\bOi\b/g, "OI").replace(/\bIv\b/g, "IV").replace(/\bDte\b/g, "DTE").toUpperCase();
}

export function ETradeTradingHub({ user, onSendPrompt }: ETradeTradingHubProps) {
  // Navigation subtabs
  const [subTab, setSubTab] = useState<"scanner" | "screeners" | "options" | "llm-ideas" | "order" | "portfolio" | "ledger" | "nlq" | "omnichannel" | "voice">("screeners");

  // Broker status
  const [brokerStatus, setBrokerStatus] = useState<ETradeBrokerStatus | null>(null);
  const [account, setAccount] = useState<ETradeAccount | null>(null);
  const [positions, setPositions] = useState<ETradePosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);

  // Screener state
  const [exchangeFilter, setExchangeFilter] = useState<"ALL" | "NASDAQ" | "NYSE" | "AMEX">("ALL");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [stockResultLimit, setStockResultLimit] = useState("");
  const [marketCapPreset, setMarketCapPreset] = useState<string>("all");
  const [perfFilter, setPerfFilter] = useState<"all" | "gainers" | "losers">("all");
  const [screenerSearch, setScreenerSearch] = useState("");
  const [screenerStocks, setScreenerStocks] = useState<ScreenedStockItem[]>([]);
  const [screenerLoading, setScreenerLoading] = useState(false);
  const [scannedAt, setScannedAt] = useState<string>("");

  // Order Ticket state
  const [orderSymbol, setOrderSymbol] = useState("");
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
  const [orderContext, setOrderContext] = useState<OptionsTradeContext | null>(null);
  const [autoPreview, setAutoPreview] = useState(false);
  const [optionsJob, setOptionsJob] = useState<"idle" | "running" | "ready">("idle");

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
  const [scanUniverseCount, setScanUniverseCount] = useState(0);
  const [scanStatus, setScanStatus] = useState<"not_run" | "no_universe" | "data_unavailable" | "scan_failed" | "no_matches" | "matches_found">("not_run");
  const [scanMessage, setScanMessage] = useState("");

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

  // Omnichannel Email & Slack Simulator states
  const [emailFrom, setEmailFrom] = useState("trader@example.com");
  const [emailSubject, setEmailSubject] = useState("E*TRADE market update");
  const [emailBody, setEmailBody] = useState("What is the current market price and technical signal?");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailResult, setEmailResult] = useState<any>(null);

  const [slackPrompt, setSlackPrompt] = useState("@ETradeAgent preview buy <quantity> <symbol> limit <price>");
  const [slackLoading, setSlackLoading] = useState(false);
  const [slackResult, setSlackResult] = useState<any>(null);
  const [slackActionLoading, setSlackActionLoading] = useState(false);

  const handleSimulateEmail = async () => {
    setEmailLoading(true);
    setEmailResult(null);
    try {
      const resp = await fetch("/api/trading/email/inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          from: emailFrom,
          to: "trade@agent.openaimp.com",
          subject: emailSubject,
          text: emailBody,
        }),
      });
      const data = (await resp.json()) as any;
      setEmailResult(data);
      if (data.actionType === "preview" || data.actionType === "approval") {
        fetchOrders();
      }
    } catch (err: any) {
      setEmailResult({ success: false, responseSubject: "Error", responseText: err.message, responseHtml: `<p style="color:red">${err.message}</p>` });
    } finally {
      setEmailLoading(false);
    }
  };

  const handleSimulateSlack = async (customPrompt?: string) => {
    const textToRun = customPrompt || slackPrompt;
    setSlackLoading(true);
    setSlackResult(null);
    try {
      const resp = await fetch("/api/trading/slack/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          type: "event_callback",
          event: {
            type: "app_mention",
            text: textToRun,
            channel: "C_TRADING_FLOOR",
            user: "U_TRADER_DEV",
            ts: `${Date.now() / 1000}`,
          },
        }),
      });
      const data = (await resp.json()) as any;
      setSlackResult(data);
      if (data.actionType === "preview") {
        fetchOrders();
      }
    } catch (err: any) {
      setSlackResult({ handled: false, error: err.message });
    } finally {
      setSlackLoading(false);
    }
  };

  const handleSlackActionButton = async (actionId: string, orderId: string) => {
    setSlackActionLoading(true);
    try {
      const resp = await fetch("/slack/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-environment": activeEnv },
        body: new URLSearchParams({
          payload: JSON.stringify({
            type: "block_actions",
            user: { id: "U_TRADER_DEV", username: "trader_openaimp" },
            actions: [{ action_id: actionId, value: orderId }],
          }),
        }),
      });
      const data = await resp.json() as any;
      if (slackResult?.response) {
        setSlackResult({
          ...slackResult,
          response: {
            ...slackResult.response,
            blocks: data.replacementBlocks || slackResult.response.blocks,
          },
        });
      }
      fetchOrders();
      fetchPositions();
    } catch (err: any) {
      console.warn("Slack button action failed:", err);
    } finally {
      setSlackActionLoading(false);
    }
  };

  // Cloudflare Voice Trading Agent state
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [voiceTranscript, setVoiceTranscript] = useState<Array<{
    role: "user" | "assistant";
    text: string;
    actionType?: string;
    orderId?: string;
    orderDraft?: any;
    brokerOrderRef?: string;
    marketQuote?: any;
    screenedStocks?: any[];
    timestamp: string;
  }>>([
    {
      role: "assistant",
      text: "Welcome to the E*TRADE Voice Trading Desk. You can ask for real-time market quotes, technical screening, portfolio status, or draft order tickets. How can I assist your portfolio today?",
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [voiceInterim, setVoiceInterim] = useState<string | null>(null);
  const [voiceInputText, setVoiceInputText] = useState("");
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceIsMuted, setVoiceIsMuted] = useState(false);
  const [speechRecognitionActive, setSpeechRecognitionActive] = useState(false);

  const speakText = (text: string) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window && !voiceIsMuted) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.onstart = () => setVoiceStatus("speaking");
      utterance.onend = () => setVoiceStatus("idle");
      utterance.onerror = () => setVoiceStatus("idle");
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleVoiceTurn = async (textToSubmit?: string) => {
    const prompt = (textToSubmit || voiceInputText).trim();
    if (!prompt) return;

    setVoiceLoading(true);
    setVoiceStatus("thinking");
    setVoiceInputText("");
    setVoiceInterim(null);

    const userMessageTime = new Date().toLocaleTimeString();
    setVoiceTranscript((prev) => [
      ...prev,
      { role: "user", text: prompt, timestamp: userMessageTime },
    ]);

    try {
      const resp = await fetch("/api/trading/voice/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({ transcript: prompt }),
      });
      const data = (await resp.json()) as any;

      const assistantMsg = {
        role: "assistant" as const,
        text: data.spokenText || data.displayMarkdown || "Request processed.",
        actionType: data.actionType,
        orderId: data.orderId,
        orderDraft: data.orderDraft,
        brokerOrderRef: data.brokerOrderRef,
        marketQuote: data.marketQuote,
        screenedStocks: data.screenedStocks,
        timestamp: new Date().toLocaleTimeString(),
      };

      setVoiceTranscript((prev) => [...prev, assistantMsg]);
      setVoiceStatus("speaking");
      speakText(data.spokenText || "");

      if (data.actionType === "preview" || data.actionType === "approval") {
        fetchOrders();
        fetchPositions();
      }
    } catch (err: any) {
      setVoiceTranscript((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Voice Agent Error: ${err.message || "Could not process voice turn."}`,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
      setVoiceStatus("idle");
    } finally {
      setVoiceLoading(false);
    }
  };

  const handleToggleVoiceRecording = () => {
    if (typeof window === "undefined") return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Web Speech API is not supported in this browser. You can type in the prompt box or use the quick chips.");
      return;
    }

    if (speechRecognitionActive) {
      setSpeechRecognitionActive(false);
      setVoiceStatus("idle");
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onstart = () => {
        setSpeechRecognitionActive(true);
        setVoiceStatus("listening");
      };

      recognition.onresult = (event: any) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        if (interim) setVoiceInterim(interim);
        if (final) {
          setVoiceInterim(null);
          setSpeechRecognitionActive(false);
          handleVoiceTurn(final);
        }
      };

      recognition.onerror = () => {
        setSpeechRecognitionActive(false);
        setVoiceStatus("idle");
      };

      recognition.onend = () => {
        setSpeechRecognitionActive(false);
      };

      recognition.start();
    } catch (e) {
      console.warn("Speech recognition error:", e);
      setSpeechRecognitionActive(false);
      setVoiceStatus("idle");
    }
  };

  const handleVoiceOrderAction = async (action: "approve" | "cancel", orderId: string) => {
    const textPrompt = action === "approve" ? `Confirm order ${orderId}` : `Cancel order ${orderId}`;
    await handleVoiceTurn(textPrompt);
  };

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
    fetchSymbolQuote(orderSymbol, target);
  };

  // Fetch initial broker status, OAuth status, positions, and screener
  useEffect(() => {
    fetchOAuthStatus(activeEnv);
    fetchBrokerStatus(activeEnv);
    fetchPositions(activeEnv);
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
    setScanMessage("");
    try {
      const body: Record<string, any> = {};
      if (stockResultLimit.trim()) body.limit = Number(stockResultLimit);
      body.exchange = exchangeFilter;
      if (minPrice.trim()) body.minPrice = Number(minPrice);
      if (maxPrice.trim()) body.maxPrice = Number(maxPrice);
      if (marketCapPreset === "mega") body.minMarketCap = 200;
      if (marketCapPreset === "large") body.minMarketCap = 50;
      if (perfFilter === "gainers") body.gainersOnly = true;
      if (perfFilter === "losers") body.losersOnly = true;
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
        const candidateCount = typeof data.discovery?.candidateCount === "number" ? data.discovery.candidateCount : total;
        const listingCount = typeof data.discovery?.listingCount === "number" ? data.discovery.listingCount : total;
        setScanUniverseCount(candidateCount);
        setScanMessage(data.validationError || data.discovery?.message || "");
        if (data.validationError) {
          setScanStatus("data_unavailable");
        } else if (candidateCount === 0) {
          setScanStatus("no_universe");
        } else if (listingCount === 0) {
          setScanStatus("data_unavailable");
        } else if (list.length === 0) {
          setScanStatus("no_matches");
        } else {
          setScanStatus("matches_found");
        }
        setScannedAt(data.scannedAt || new Date().toLocaleTimeString());
      } else {
        const data = await resp.json().catch(() => ({})) as any;
        setScanMessage(data.error || `E*TRADE screening request failed [HTTP ${resp.status}].`);
        setScanStatus("scan_failed");
      }
    } catch (error) {
      setScanMessage(error instanceof Error ? error.message : "Unable to reach the E*TRADE screening API.");
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

  const handleOptionsTrade = (ctx: OptionsTradeContext) => {
    setOrderContext(ctx);
    setOrderSymbol(ctx.symbol);
    setOrderAction(ctx.action);
    setOrderType(ctx.underlyingPrice ? "LIMIT" : "MARKET");
    setOrderQuantity(ctx.quantity);
    if (ctx.underlyingPrice) setOrderLimitPrice(ctx.underlyingPrice.toFixed(2));
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
    setSubTab("order");
    setAutoPreview(true);
  };

  useEffect(() => {
    if (!autoPreview) return;
    setAutoPreview(false);
    void handlePreviewOrder({ preventDefault() {} } as React.FormEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreview]);

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
          previewId: draft?.previewId ? String(draft.previewId) : undefined,
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

  const copyDidToClipboard = (did: string) => {
    navigator.clipboard.writeText(did);
    setCopiedDid(true);
    setTimeout(() => setCopiedDid(false), 2000);
  };

  const tradingAgentDid = "did:agent:openaimp:trading";
  const userDid = user?.login ? `did:user:github:${user.login}` : "did:user:github:authorized_trader";

  const getRsiBadgeClass = (rsi?: number) => {
    if (rsi === undefined) return "rsi-neutral";
    if (rsi <= 35) return "rsi-oversold";
    if (rsi >= 70) return "rsi-overbought";
    return "rsi-neutral";
  };

  const getRsiLabel = (rsi?: number) => {
    if (rsi === undefined) return "Unavailable";
    if (rsi <= 35) return "Oversold";
    if (rsi >= 70) return "Overbought";
    return "Neutral";
  };

  const sendNlqToChat = (prompt = nlqQuery) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    const tabLabels: Record<typeof subTab, string> = {
      scanner: "Equity Universe Scan",
      screeners: "Multi-Asset Screeners",
      options: "Auto Options Research",
      "llm-ideas": "LLM Idea Experiment",
      order: "Order Ticket",
      portfolio: "Portfolio",
      ledger: "Order History",
      nlq: "Trading",
      omnichannel: "Email & Slack Agents",
      voice: "Voice Trading Desk",
    };
    onSendPrompt?.(cleanPrompt, `E*TRADE · ${tabLabels[subTab]}`);
  };

  const accountValue = account?.netAccountValue;
  const isLive = activeEnv === "PROD" || brokerStatus?.environment === "live" || brokerStatus?.activeEnvironment === "PROD";

  return (
    <div className="etrade-trading-hub">
      <section className={`etrade-account-banner ${isLive ? "prod" : "test"}`} aria-label="E*TRADE account and connection controls">
        <div className="etrade-banner-identity">
          <strong>E*TRADE</strong>
          <span className={`etrade-environment ${isLive ? "prod" : "test"}`}>{isLive ? "PROD" : "TEST"}</span>
          <div className="etrade-banner-account">
            <span><small>Account value</small><b>{maskAccount ? "••••••" : accountValue === undefined ? "Unavailable" : `$${accountValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</b></span>
            <span><small>A/C #</small><b>{account?.accountId && account.accountId !== "unconnected" ? (maskAccount ? `••••${account.accountId.slice(-4)}` : account.accountId) : "Unavailable"}</b></span>
            <button
              type="button"
              className="btn-mask-toggle"
              onClick={() => setMaskAccount(!maskAccount)}
              aria-label={maskAccount ? "Reveal account value and account number" : "Mask account value and account number"}
              title={maskAccount ? "Reveal account value and account number" : "Mask account value and account number"}
            >
              {maskAccount ? "Show" : "Hide"}
            </button>
          </div>
        </div>
        <div className="etrade-banner-controls">
          <div className="etrade-environment-controls" aria-label="E*TRADE environment">
            <button type="button" className={!isLive ? "active" : ""} onClick={() => handleSwitchEnvironment("TEST")}>TEST</button>
            <button type="button" className={isLive ? "active" : ""} onClick={() => handleSwitchEnvironment("PROD")}>PROD</button>
          </div>
          <span className={`etrade-connection-state ${oauthStatus?.authenticated ? "connected" : "disconnected"}`}>
            {oauthStatus?.authenticated ? "Connected" : "Not connected"}
          </span>
          <button type="button" className="btn-sync-diagnostics" disabled={diagnosticsLoading} onClick={() => runDiagnostics()}>
            {diagnosticsLoading ? "Testing…" : "Test & Sync"}
          </button>
          {oauthStatus?.authenticated ? (
            <>
              {oauthStatus.renewable && <button type="button" className="btn-oauth-renew" disabled={oauthLoading} onClick={handleRenewOAuth}>Renew Token</button>}
              <button type="button" className="btn-oauth-revoke" disabled={oauthLoading} onClick={handleRevokeOAuth}>Disconnect</button>
            </>
          ) : (
            <button type="button" className="btn-oauth-connect" disabled={oauthLoading} onClick={handleStartOAuth}>
              {oauthLoading ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
        {oauthMsg && (
          <div className="etrade-banner-message" role="status">
            <span>{oauthMsg}</span>
            {oauthMsg.includes("SANDBOX") || oauthMsg.includes("switch environment to TEST")
              ? <button type="button" onClick={() => handleSwitchAndConnect("TEST")}>Switch to TEST &amp; Connect</button>
              : null}
            <button type="button" aria-label="Dismiss message" onClick={() => setOauthMsg("")}>×</button>
          </div>
        )}
      </section>

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

      {/* Navigation Sub-Tabs */}
      <div className="trading-subnav-bar">
        <button
          className={`subnav-btn ${subTab === "screeners" ? "active" : ""}`}
          onClick={() => setSubTab("screeners")}
        >
          🔎 Multi-Asset Screeners
        </button>
        <button
          className={`subnav-btn ${subTab === "scanner" ? "active" : ""}`}
          onClick={() => setSubTab("scanner")}
        >
          📈 Equity Universe Scan
        </button>
        <button
          className={`subnav-btn ${subTab === "options" ? "active" : ""}`}
          onClick={() => setSubTab("options")}
        >
          🤖 Auto Options Research
          {optionsJob !== "idle" && <span className={`options-job-badge ${optionsJob}`}>{optionsJob === "running" ? "running…" : "results ready"}</span>}
        </button>
        <button
          className={`subnav-btn ${subTab === "llm-ideas" ? "active" : ""}`}
          onClick={() => setSubTab("llm-ideas")}
        >
          ✨ LLM Idea Experiment
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
          className={`subnav-btn ${subTab === "omnichannel" ? "active" : ""}`}
          onClick={() => setSubTab("omnichannel")}
        >
          💬 Email &amp; Slack Agents
        </button>
        <button
          className={`subnav-btn ${subTab === "voice" ? "active" : ""}`}
          onClick={() => setSubTab("voice")}
        >
          🎙️ Voice Trading Desk
        </button>
      </div>

      {subTab !== "options" && subTab !== "llm-ideas" && <div className="nlq-quick-bar trading-context-chat">
        <div className="nlq-bar-input-wrap">
          <span className="nlq-bar-icon">💬</span>
          <input
            type="text"
            className="nlq-bar-input"
            placeholder={`Ask Chat about ${subTab.replace("-", " ")}…`}
            value={nlqQuery}
            onChange={(event) => setNlqQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendNlqToChat();
            }}
          />
          <button type="button" className="btn-nlq-submit" disabled={!nlqQuery.trim()} onClick={() => sendNlqToChat()}>
            Ask in Chat
          </button>
        </div>
        <div className="nlq-chips-carousel">
          <span className="chips-label">Ask from this tab:</span>
          <button type="button" className="nlq-chip" onClick={() => sendNlqToChat("Find stocks priced between $20 and $200")}>Price Range $20–$200</button>
          <button type="button" className="nlq-chip" onClick={() => sendNlqToChat("Find stocks with market cap above $200B")}>Large Market Cap</button>
          <button type="button" className="nlq-chip" onClick={() => sendNlqToChat("Show top momentum gainers")}>Top Momentum Gainers</button>
          <button type="button" className="nlq-chip" onClick={() => sendNlqToChat("Quote NVDA")}>Quote NVDA</button>
          <button type="button" className="nlq-chip" onClick={() => sendNlqToChat("Preview buy 10 shares of NVDA limit 125.50")}>Build Order Preview</button>
          <button type="button" className="nlq-chip" onClick={() => sendNlqToChat("Show my portfolio positions and P&L")}>Portfolio Holdings</button>
        </div>
      </div>}

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
              {activeDraft.previewNotes && (
                <div className="attest-item" style={{ gridColumn: "1 / -1", background: "rgba(245, 158, 11, 0.12)", padding: "0.4rem 0.6rem", borderRadius: "6px", border: "1px solid rgba(245, 158, 11, 0.25)" }}>
                  <span className="attest-label" style={{ color: "#f59e0b" }}>⚠️ Broker Notice:</span>
                  <span style={{ fontSize: "0.8rem", color: "#fef3c7" }}>{activeDraft.previewNotes}</span>
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

      {subTab === "screeners" && (
        <ScreenersHub
          activeEnv={activeEnv}
          userLogin={user?.login}
          onStocksLoaded={setScreenerStocks}
        />
      )}

      {/* SUBTAB 1: MARKET SCREENER & SCANNER */}
      {subTab === "scanner" && (
        <div className="trading-section screener-section">
          {/* Controls Bar */}
          <div className="screener-controls-bar">
            <div className="control-item">
              <label>Exchange</label>
              <select
                value={exchangeFilter}
                onChange={(e) => setExchangeFilter(e.target.value as typeof exchangeFilter)}
              >
                <option value="ALL">All U.S. listings</option>
                <option value="NASDAQ">Nasdaq</option>
                <option value="NYSE">NYSE</option>
                <option value="AMEX">AMEX</option>
              </select>
            </div>

            <div className="control-item">
              <label>Minimum price ($)</label>
              <input type="number" min="0" step="0.01" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} />
            </div>

            <div className="control-item">
              <label>Maximum price ($)</label>
              <input type="number" min="0" step="0.01" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} />
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

            <div className="control-item">
              <label>Maximum results (blank = all matches)</label>
              <input
                type="number"
                min="1"
                step="1"
                value={stockResultLimit}
                onChange={(event) => setStockResultLimit(event.target.value)}
              />
            </div>

            <div className="control-item search-item">
              <label>Search ticker or company</label>
              <input
                type="text"
                placeholder="Ticker or company name"
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
              Live listings: <strong>{scanUniverseCount.toLocaleString()}</strong> • Matches: <strong>{screenerStocks.length}</strong> • Source: Nasdaq / NYSE / AMEX listings
            </span>
            <span className="results-timestamp">Last Scan: {scannedAt || "Just now"}</span>
          </div>
          {scanMessage && <div className="stock-screener-source-note" role="status">{scanMessage}</div>}
          <ResearchReportActions
            title="E-TRADE stock research"
            query={nlqQuery || `Screen E*TRADE stocks using the current filters`}
            userLogin={user?.login}
            sheets={[
              { name: "Stock data", rows: screenerStocks as unknown as Array<Record<string, unknown>> },
              { name: "Screen evaluation", rows: [{
                scannedAt, status: scanStatus, message: scanMessage, universeCount: scanUniverseCount,
                matchedCount: screenerStocks.length, exchange: exchangeFilter, minPrice, maxPrice,
                marketCapPreset, performance: perfFilter, search: screenerSearch,
              }] },
            ]}
          />

          {/* Screener Cards / Table Grid */}
          <div className="screener-table-wrap">
            <table className="trading-table">
              <thead>
                <tr>
                  <th>Symbol &amp; Company</th>
                  <th>Exchange</th>
                  <th>Last sale</th>
                  <th>Daily change</th>
                  <th>Market Cap</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {screenerStocks.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty-state" role="status" aria-live="polite">
                      {screenerLoading ? (
                        "Scanning equity universe…"
                      ) : scanStatus === "not_run" ? (
                        "Scanner has not been run. Select your filters and click '⚡ Run Market Scan'. Nothing is scanned until you do."
                      ) : scanStatus === "no_universe" ? (
                        scanMessage || "The all-exchange listings request returned no securities. Retry the listing source or search a ticker."
                      ) : scanStatus === "data_unavailable" ? (
                        scanMessage || "One or more selected criteria are unavailable from the dynamic listing feed."
                      ) : scanStatus === "scan_failed" ? (
                        scanMessage || "E*TRADE screening request failed. Check OAuth/API access and retry."
                      ) : (
                        `Scanned ${scanUniverseCount.toLocaleString()} live listings; 0 matched the selected filters.`
                      )}
                    </td>
                  </tr>
                ) : (
                  screenerStocks.map((stock) => {
                    const isPositive = stock.change >= 0;
                    return (
                      <tr key={stock.symbol} className="stock-row">
                        <td>
                          <div className="ticker-company">
                            <span className="ticker-badge">{stock.symbol}</span>
                            <span className="company-title">{stock.companyName}</span>
                          </div>
                        </td>
                        <td><span className="sector-tag">{stock.listingExchange || "N/A"}</span></td>
                        <td>
                          <span className="price-tag">${(stock.lastPrice || stock.price || 0).toFixed(2)}</span>
                        </td>
                        <td>
                          <span className={`change-pill ${isPositive ? "positive" : "negative"}`}>
                            {isPositive ? "+" : ""}{stock.change.toFixed(2)} ({isPositive ? "+" : ""}{stock.changePercent.toFixed(2)}%)
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

      <OptionsResearchPanelHost hidden={subTab !== "options"}>
        <OptionsResearchPanel
          activeEnv={activeEnv}
          userLogin={user?.login}
          onPreviewTrade={handleOptionsTrade}
          onJobStateChange={setOptionsJob}
          onSendPrompt={onSendPrompt}
        />
      </OptionsResearchPanelHost>
      <OptionsResearchPanelHost hidden={subTab !== "llm-ideas"}>
        <LlmOptionsIdeasPanel activeEnv={activeEnv} userLogin={user?.login} />
      </OptionsResearchPanelHost>

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
              {orderContext && (
                <div className="options-order-context">
                  <strong>From Auto Options Research:</strong> {orderContext.label}
                  <ul>{orderContext.legs.map((leg) => <li key={leg}>{leg}</li>)}</ul>
                  <em>The ticket previews the underlying stock position; option legs are shown for reference. Nothing is placed until you approve.</em>
                </div>
              )}

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
                    onClick={() => sendNlqToChat("Preview buy 10 shares of NVDA limit 125.50")}
                  >
                    👉 "Preview buy 10 shares of NVDA limit 125.50"
                  </button>
                  <button
                    type="button"
                    className="example-link"
                    onClick={() => sendNlqToChat("Screen oversold tech stocks")}
                  >
                    👉 "Screen oversold tech stocks"
                  </button>
                  <button
                    type="button"
                    className="example-link"
                    onClick={() => sendNlqToChat("Show my portfolio positions")}
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

                    {/* Rejection Details */}
                    {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).length > 0 && (
                      <details style={{ fontSize: "0.8rem", color: "#cbd5e1", marginTop: "0.5rem" }}>
                        <summary style={{ cursor: "pointer", color: "#f87171" }}>
                          View {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).length} Rejection Details (showing first 200)
                        </summary>
                        <table className="trading-table" style={{ marginTop: "0.5rem" }}>
                          <thead>
                            <tr><th>SYMBOL</th><th>REASON</th></tr>
                          </thead>
                          <tbody>
                            {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).slice(0, 200).map((rej: any, rIdx: number) => (
                              <tr key={rIdx}>
                                <td><strong style={{ color: "#f87171" }}>{rej.symbol}</strong></td>
                                <td>{rej.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
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
                            <th key={col}>{formatNlqColumn(col)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(nlqResult.rows || nlqResult.result?.rows).slice(0, NLQ_ROW_RENDER_LIMIT).map((row: any, idx: number) => (
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
                              if (key === "candidateStrategies" && Array.isArray(val)) {
                                return (
                                  <td key={cidx}>
                                    <ul className="ledger-candidates">
                                      {val.map((candidate: any) => (
                                        <li key={candidate.id} className={`ledger-candidate ledger-${candidate.status}`}>
                                          <a href={`/strategies/${candidate.id}.html`} target="_blank" rel="noopener noreferrer" title={candidate.description || candidate.name}>
                                            {candidate.name}
                                          </a>{" "}
                                          <span className="ledger-verdict">{candidate.status === "accepted" ? "PASSED" : candidate.status === "rejected" ? "FAILED" : "SKIPPED"}</span>{" "}
                                          <span className="ledger-why">{candidate.why}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </td>
                                );
                              }
                              return <td key={cidx}>{val !== null && typeof val === "object" ? JSON.stringify(val) : String(val)}</td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {(nlqResult.rows || nlqResult.result?.rows).length > NLQ_ROW_RENDER_LIMIT && (
                      <p className="nlq-rows-truncated" role="status">
                        Showing first {NLQ_ROW_RENDER_LIMIT} of {(nlqResult.rows || nlqResult.result?.rows).length.toLocaleString()} rows. Narrow the query or use the scanner filters to see the rest.
                      </p>
                    )}
                  </div>
                )}

                {/* Stock Screener Results */}
                {nlqResult.result?.screener?.stocks && (
                  <div className="nlq-rows-table-wrap" style={{ margin: "1rem 0", overflowX: "auto" }}>
                    <table className="trading-table">
                      <thead>
                        <tr>
                          <th>SYMBOL &amp; COMPANY</th>
                          <th>PRICE</th>
                          <th>RSI</th>
                          <th>SIGNAL</th>
                          <th>REASON</th>
                          <th>ACTIONS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {nlqResult.result.screener.stocks.slice(0, NLQ_ROW_RENDER_LIMIT).map((stock: ScreenedStockItem) => (
                          <tr key={stock.symbol}>
                            <td>
                              <div className="ticker-company">
                                <span className="ticker-badge">{stock.symbol}</span>
                                <span className="company-title">{stock.companyName}</span>
                              </div>
                            </td>
                            <td>${stock.price.toFixed(2)}</td>
                            <td><span className={`rsi-badge ${getRsiBadgeClass(stock.rsi14)}`}>{stock.rsi14 === undefined ? "N/A" : stock.rsi14.toFixed(1)}</span></td>
                            <td><span className="signal-badge">{stock.technicalSignal}</span></td>
                            <td>{stock.highlightReason}</td>
                            <td>
                              <button type="button" className="btn-card-quote" onClick={() => handleOpenInspectQuote(stock.symbol, stock)}>Quote</button>{" "}
                              <button type="button" className="btn-card-trade" onClick={() => handleQuickTrade(stock, "BUY")}>⚡ Trade</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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

      {/* Omnichannel Trading Agents (Cloudflare Email & Slack Agents) */}
      {subTab === "omnichannel" && (
        <div className="tab-pane active omnichannel-pane" style={{ marginTop: "1.5rem" }}>
          {/* Header Card */}
          <div style={{ background: "linear-gradient(135deg, rgba(30, 58, 138, 0.4) 0%, rgba(15, 23, 42, 0.8) 100%)", border: "1px solid #1e3a8a", borderRadius: "12px", padding: "1.5rem", marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <span style={{ background: "#3b82f6", color: "white", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "bold", textTransform: "uppercase" }}>
                  Cloudflare Agents SDK
                </span>
                <h3 style={{ margin: "0.5rem 0 0.25rem 0", color: "#ffffff", fontSize: "1.4rem" }}>
                  💬 Omnichannel Trading Agents (Email &amp; Slack)
                </h3>
                <p style={{ color: "#94a3b8", fontSize: "0.9rem", margin: 0, maxWidth: "700px" }}>
                  Autonomous market research, quoting, and Human-in-the-Loop order drafting via Inbound Email and Slack Bot communication channels. All orders require explicit human authorization before live E*TRADE execution.
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <span style={{ background: "rgba(34, 197, 94, 0.15)", border: "1px solid #22c55e", color: "#4ade80", padding: "4px 10px", borderRadius: "6px", fontSize: "0.8rem", fontWeight: 600 }}>
                  ✓ Direct REST API Live
                </span>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "1.5rem", marginBottom: "2rem" }}>
            {/* Channel 1: Cloudflare Email Trading Agent */}
            <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: "12px", padding: "1.5rem", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h4 style={{ margin: 0, color: "#38bdf8", fontSize: "1.1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>✉️</span> Cloudflare Email Trading Agent
                </h4>
                <span style={{ background: "rgba(56, 189, 248, 0.15)", color: "#38bdf8", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "bold" }}>
                  send_email &amp; PostalMime
                </span>
              </div>

              <div style={{ background: "rgba(15, 23, 42, 0.6)", border: "1px solid #1e293b", borderRadius: "8px", padding: "0.85rem", marginBottom: "1rem", fontSize: "0.85rem", color: "#cbd5e1" }}>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Inbound Address:</strong> <code style={{ color: "#38bdf8" }}>trade@agent.openaimp.com</code>
                </div>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Security Guarantee:</strong> Stamped with Trading DID (<code>did:agent:openaimp:trading</code>).
                </div>
                <div>
                  <strong>Commands:</strong> <code>Quote &lt;SYMBOL&gt;</code>, <code>Screen stocks priced between $20 and $200</code>, <code>Preview Buy 10 NVDA limit 125</code>, <code>APPROVE &lt;orderId&gt;</code>.
                </div>
              </div>

              {/* Email Simulator Form */}
              <div style={{ background: "#1e293b", borderRadius: "8px", padding: "1rem", marginBottom: "1rem" }}>
                <h5 style={{ margin: "0 0 0.75rem 0", color: "#f8fafc", fontSize: "0.9rem" }}>
                  🧪 Interactive Email Simulator
                </h5>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                  <div>
                    <label style={{ fontSize: "0.75rem", color: "#94a3b8", display: "block", marginBottom: "2px" }}>From (Sender Email):</label>
                    <input
                      type="email"
                      value={emailFrom}
                      onChange={(e) => setEmailFrom(e.target.value)}
                      style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", color: "#f8fafc", padding: "0.4rem 0.6rem", borderRadius: "6px", fontSize: "0.85rem", boxSizing: "border-box" }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: "0.75rem", color: "#94a3b8", display: "block", marginBottom: "2px" }}>Subject:</label>
                    <input
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                      style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", color: "#f8fafc", padding: "0.4rem 0.6rem", borderRadius: "6px", fontSize: "0.85rem", boxSizing: "border-box" }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: "0.75rem", color: "#94a3b8", display: "block", marginBottom: "2px" }}>Email Body:</label>
                    <textarea
                      rows={2}
                      value={emailBody}
                      onChange={(e) => setEmailBody(e.target.value)}
                      style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", color: "#f8fafc", padding: "0.4rem 0.6rem", borderRadius: "6px", fontSize: "0.85rem", boxSizing: "border-box", resize: "vertical" }}
                    />
                  </div>

                  {/* Preset Quick Chips */}
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.2rem" }}>
                    <button
                      type="button"
                      onClick={() => { setEmailSubject("Quote NVDA"); setEmailBody("What is the current price and technicals?"); }}
                      style={{ background: "#334155", border: "none", color: "#cbd5e1", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
                    >
                      📈 Quote NVDA
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEmailSubject("Screen stock price range"); setEmailBody("Show stocks priced between $20 and $200"); }}
                      style={{ background: "#334155", border: "none", color: "#cbd5e1", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
                    >
                      🔍 Screen Price Range
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEmailSubject("Order Preview"); setEmailBody("Buy 10 shares of NVDA limit 125.00"); }}
                      style={{ background: "#334155", border: "none", color: "#cbd5e1", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
                    >
                      🛡️ Buy 10 NVDA
                    </button>
                    {activeDraft && (
                      <button
                        type="button"
                        onClick={() => { setEmailSubject("Order Approval"); setEmailBody(`APPROVE ${activeDraft.orderId}`); }}
                        style={{ background: "#166534", border: "1px solid #22c55e", color: "#86efac", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
                      >
                        ✓ APPROVE {activeDraft.orderId}
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={emailLoading}
                    onClick={handleSimulateEmail}
                    style={{ background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)", color: "#ffffff", border: "none", padding: "0.6rem 1rem", borderRadius: "6px", fontWeight: "bold", fontSize: "0.85rem", cursor: "pointer", marginTop: "0.4rem" }}
                  >
                    {emailLoading ? "Processing Inbound Email…" : "⚡ Send Test Email to Agent"}
                  </button>
                </div>
              </div>

              {/* Email Result Output */}
              {emailResult && (
                <div style={{ background: "#0b0f19", border: "1px solid #1e293b", borderRadius: "8px", padding: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                    <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Agent Email Reply:</span>
                    <span style={{ fontSize: "0.75rem", background: "rgba(56, 189, 248, 0.2)", color: "#38bdf8", padding: "2px 6px", borderRadius: "4px", textTransform: "uppercase" }}>
                      {emailResult.actionType || "reply"}
                    </span>
                  </div>
                  <h6 style={{ margin: "0 0 0.5rem 0", color: "#f8fafc", fontSize: "0.95rem" }}>
                    Subject: {emailResult.responseSubject}
                  </h6>
                  {emailResult.responseHtml ? (
                    <div
                      style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #334155", borderRadius: "6px", padding: "0.5rem", background: "#0f172a" }}
                      dangerouslySetInnerHTML={{ __html: emailResult.responseHtml }}
                    />
                  ) : (
                    <pre style={{ margin: 0, fontSize: "0.75rem", color: "#cbd5e1", whiteSpace: "pre-wrap" }}>
                      {emailResult.responseText}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {/* Channel 2: Cloudflare Slack Trading Agent */}
            <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: "12px", padding: "1.5rem", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h4 style={{ margin: 0, color: "#a855f7", fontSize: "1.1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>🤖</span> Cloudflare Slack Trading Agent
                </h4>
                <span style={{ background: "rgba(168, 85, 247, 0.15)", color: "#c084fc", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "bold" }}>
                  Events &amp; Block Kit
                </span>
              </div>

              <div style={{ background: "rgba(15, 23, 42, 0.6)", border: "1px solid #1e293b", borderRadius: "8px", padding: "0.85rem", marginBottom: "1rem", fontSize: "0.85rem", color: "#cbd5e1" }}>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Event Request URL:</strong> <code style={{ color: "#c084fc" }}>https://agent.openaimp.com/slack/events</code>
                </div>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Interactivity URL:</strong> <code style={{ color: "#c084fc" }}>https://agent.openaimp.com/slack/interactions</code>
                </div>
                <div>
                  <strong>OAuth App Install:</strong> <a href="/slack/install" target="_blank" rel="noreferrer" style={{ color: "#38bdf8", textDecoration: "underline" }}>Install to Workspace</a>
                </div>
              </div>

              {/* Slack Simulator Form */}
              <div style={{ background: "#1e293b", borderRadius: "8px", padding: "1rem", marginBottom: "1rem" }}>
                <h5 style={{ margin: "0 0 0.75rem 0", color: "#f8fafc", fontSize: "0.9rem" }}>
                  🧪 Interactive Slack Bot Simulator
                </h5>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                  <div>
                    <label style={{ fontSize: "0.75rem", color: "#94a3b8", display: "block", marginBottom: "2px" }}>Slack Message / Mention:</label>
                    <input
                      type="text"
                      value={slackPrompt}
                      onChange={(e) => setSlackPrompt(e.target.value)}
                      style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", color: "#f8fafc", padding: "0.4rem 0.6rem", borderRadius: "6px", fontSize: "0.85rem", boxSizing: "border-box" }}
                    />
                  </div>

                  {/* Preset Quick Chips */}
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.2rem" }}>
                    <button
                      type="button"
                      onClick={() => handleSimulateSlack("@ETradeAgent quote NVDA")}
                      style={{ background: "#334155", border: "none", color: "#cbd5e1", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
                    >
                      📈 Quote NVDA
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSimulateSlack("@ETradeAgent screen stocks priced between $20 and $200")}
                      style={{ background: "#334155", border: "none", color: "#cbd5e1", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
                    >
                      🔍 Screen Price Range
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSimulateSlack("@ETradeAgent preview buy 10 NVDA limit 125.00")}
                      style={{ background: "#334155", border: "none", color: "#cbd5e1", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
                    >
                      ⚡ Buy 10 NVDA Ticket
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSimulateSlack("@ETradeAgent show my portfolio positions")}
                      style={{ background: "#334155", border: "none", color: "#cbd5e1", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
                    >
                      💼 Portfolio
                    </button>
                  </div>

                  <button
                    type="button"
                    disabled={slackLoading}
                    onClick={() => handleSimulateSlack()}
                    style={{ background: "linear-gradient(135deg, #9333ea 0%, #7e22ce 100%)", color: "#ffffff", border: "none", padding: "0.6rem 1rem", borderRadius: "6px", fontWeight: "bold", fontSize: "0.85rem", cursor: "pointer", marginTop: "0.4rem" }}
                  >
                    {slackLoading ? "Simulating Slack Agent…" : "⚡ Simulate Slack Message"}
                  </button>
                </div>
              </div>

              {/* Slack Block Kit Card Viewer */}
              {slackResult?.response && (
                <div style={{ background: "#1a1d21", border: "1px solid #383f45", borderRadius: "8px", padding: "1rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                    <span style={{ fontSize: "1.2rem" }}>🤖</span>
                    <div>
                      <strong style={{ color: "#ffffff", fontSize: "0.9rem" }}>ETradeAgent</strong>{" "}
                      <span style={{ background: "#334155", color: "#94a3b8", fontSize: "0.7rem", padding: "1px 4px", borderRadius: "3px" }}>APP</span>
                      <span style={{ color: "#64748b", fontSize: "0.75rem", marginLeft: "0.5rem" }}>Just now</span>
                    </div>
                  </div>

                  <div style={{ borderLeft: "3px solid #a855f7", paddingLeft: "0.75rem", color: "#e2e8f0", fontSize: "0.88rem" }}>
                    {slackResult.response.blocks?.map((block: any, bIdx: number) => {
                      if (block.type === "header") {
                        return <h5 key={bIdx} style={{ margin: "0.25rem 0 0.5rem 0", color: "#f8fafc", fontSize: "1rem" }}>{block.text?.text}</h5>;
                      }
                      if (block.type === "section" && block.fields) {
                        return (
                          <div key={bIdx} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", margin: "0.5rem 0" }}>
                            {block.fields.map((f: any, fIdx: number) => (
                              <div key={fIdx} style={{ fontSize: "0.82rem", background: "#222529", padding: "6px 8px", borderRadius: "4px" }}>
                                {f.text?.split("\n").map((line: string, lIdx: number) => (
                                  <div key={lIdx}>{line.replace(/\*/g, "")}</div>
                                ))}
                              </div>
                            ))}
                          </div>
                        );
                      }
                      if (block.type === "section" && block.text) {
                        return <p key={bIdx} style={{ margin: "0.4rem 0", color: "#cbd5e1" }}>{block.text.text?.replace(/\*/g, "")}</p>;
                      }
                      if (block.type === "actions") {
                        return (
                          <div key={bIdx} style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                            {block.elements?.map((btn: any, btnIdx: number) => (
                              <button
                                key={btnIdx}
                                type="button"
                                disabled={slackActionLoading}
                                onClick={() => handleSlackActionButton(btn.action_id, btn.value)}
                                style={{
                                  background: btn.style === "primary" ? "#007a5a" : "#e01e5a",
                                  color: "#ffffff",
                                  border: "none",
                                  borderRadius: "4px",
                                  padding: "6px 12px",
                                  fontWeight: "bold",
                                  fontSize: "0.8rem",
                                  cursor: "pointer",
                                }}
                              >
                                {btn.text?.text}
                              </button>
                            ))}
                          </div>
                        );
                      }
                      if (block.type === "context") {
                        return (
                          <div key={bIdx} style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "0.5rem" }}>
                            {block.elements?.[0]?.text?.replace(/`/g, "")}
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cloudflare Voice Trading Agent Desk */}
      {subTab === "voice" && (
        <div className="tab-pane active voice-pane" style={{ marginTop: "1.5rem" }}>
          {/* Header Card */}
          <div style={{ background: "linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(15, 23, 42, 0.85) 100%)", border: "1px solid rgba(16, 185, 129, 0.4)", borderRadius: "12px", padding: "1.5rem", marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <span style={{ background: "#10b981", color: "white", padding: "3px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "bold", textTransform: "uppercase" }}>
                  Cloudflare Agents Voice SDK
                </span>
                <h3 style={{ margin: "0.5rem 0 0.25rem 0", color: "#ffffff", fontSize: "1.4rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>🎙️</span> E*TRADE Voice Trading Desk
                </h3>
                <p style={{ color: "#94a3b8", fontSize: "0.9rem", margin: 0, maxWidth: "720px" }}>
                  Real-time conversational voice trading powered by Cloudflare Workers AI STT &amp; TTS. Verbal quote inquiries, technical screening, and strict two-stage verbal Human-in-the-Loop order drafting.
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <span style={{
                  background: voiceStatus === "speaking" ? "rgba(56, 189, 248, 0.2)" : (voiceStatus === "listening" ? "rgba(34, 197, 94, 0.2)" : (voiceStatus === "thinking" ? "rgba(245, 158, 11, 0.2)" : "rgba(100, 116, 139, 0.2)")),
                  border: `1px solid ${voiceStatus === "speaking" ? "#38bdf8" : (voiceStatus === "listening" ? "#22c55e" : (voiceStatus === "thinking" ? "#f59e0b" : "#64748b"))}`,
                  color: voiceStatus === "speaking" ? "#38bdf8" : (voiceStatus === "listening" ? "#4ade80" : (voiceStatus === "thinking" ? "#fbbf24" : "#94a3b8")),
                  padding: "4px 12px",
                  borderRadius: "20px",
                  fontSize: "0.82rem",
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                }}>
                  <span style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: voiceStatus === "speaking" ? "#38bdf8" : (voiceStatus === "listening" ? "#22c55e" : (voiceStatus === "thinking" ? "#f59e0b" : "#64748b")),
                    animation: (voiceStatus === "listening" || voiceStatus === "speaking") ? "pulse 1.2s infinite" : "none",
                  }} />
                  {voiceStatus.toUpperCase()}
                </span>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "1.5rem", maxWidth: "900px", margin: "0 auto 2rem auto" }}>
            {/* Visualizer & Mic Control Bar */}
            <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: "12px", padding: "1.5rem", textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "1rem", marginBottom: "1.2rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={handleToggleVoiceRecording}
                  style={{
                    background: speechRecognitionActive
                      ? "linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)"
                      : "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "50px",
                    padding: "0.8rem 2rem",
                    fontSize: "1.05rem",
                    fontWeight: "bold",
                    cursor: "pointer",
                    boxShadow: speechRecognitionActive
                      ? "0 0 20px rgba(239, 68, 68, 0.5)"
                      : "0 0 20px rgba(16, 185, 129, 0.4)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.6rem",
                    transition: "all 0.2s ease",
                  }}
                >
                  <span>{speechRecognitionActive ? "🛑 Stop Listening" : "🎙️ Push to Talk / Speak"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setVoiceIsMuted(!voiceIsMuted)}
                  style={{
                    background: "#1e293b",
                    border: "1px solid #475569",
                    color: voiceIsMuted ? "#f87171" : "#cbd5e1",
                    padding: "0.75rem 1.2rem",
                    borderRadius: "8px",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                  }}
                >
                  {voiceIsMuted ? "🔇 Voice Muted" : "🔊 Audio On"}
                </button>
              </div>

              {/* Animated Audio Visualizer Bars */}
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "6px", height: "40px", margin: "1rem 0" }}>
                {[12, 24, 38, 20, 32, 16, 28, 36, 18, 26, 34, 14].map((h, i) => (
                  <div
                    key={i}
                    style={{
                      width: "6px",
                      height: voiceStatus === "speaking" || voiceStatus === "listening" ? `${Math.max(8, (h * (voiceStatus === "listening" ? 1.2 : 0.9)))}px` : "6px",
                      background: voiceStatus === "speaking" ? "#38bdf8" : (voiceStatus === "listening" ? "#22c55e" : "#475569"),
                      borderRadius: "3px",
                      transition: "height 0.15s ease",
                    }}
                  />
                ))}
              </div>

              {/* Interim Real-Time Transcript Display */}
              {voiceInterim && (
                <div style={{ background: "rgba(56, 189, 248, 0.1)", border: "1px dashed #0284c7", borderRadius: "8px", padding: "0.75rem", margin: "0.75rem 0", color: "#38bdf8", fontSize: "0.9rem", fontStyle: "italic" }}>
                  🎙️ <em>{voiceInterim}…</em>
                </div>
              )}

              {/* Quick Spoken Chips */}
              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", flexWrap: "wrap", marginTop: "1rem" }}>
                <button
                  type="button"
                  onClick={() => handleVoiceTurn("What is Nvidia trading at?")}
                  style={{ background: "#1e293b", border: "1px solid #334155", color: "#cbd5e1", padding: "5px 10px", borderRadius: "6px", fontSize: "0.78rem", cursor: "pointer" }}
                >
                  📈 "What is Nvidia trading at?"
                </button>
                <button
                  type="button"
                  onClick={() => handleVoiceTurn("Screen stocks priced between $20 and $200")}
                  style={{ background: "#1e293b", border: "1px solid #334155", color: "#cbd5e1", padding: "5px 10px", borderRadius: "6px", fontSize: "0.78rem", cursor: "pointer" }}
                >
                  🔍 "Screen price range"
                </button>
                <button
                  type="button"
                  onClick={() => handleVoiceTurn("What is my portfolio balance?")}
                  style={{ background: "#1e293b", border: "1px solid #334155", color: "#cbd5e1", padding: "5px 10px", borderRadius: "6px", fontSize: "0.78rem", cursor: "pointer" }}
                >
                  💼 "Check portfolio balance"
                </button>
                <button
                  type="button"
                  onClick={() => handleVoiceTurn("Buy 10 shares of NVDA at market")}
                  style={{ background: "#1e293b", border: "1px solid #f59e0b", color: "#fbbf24", padding: "5px 10px", borderRadius: "6px", fontSize: "0.78rem", cursor: "pointer" }}
                >
                  ⚡ "Buy 10 NVDA at market"
                </button>
                {activeDraft && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleVoiceTurn(`Confirm order ${activeDraft.orderId}`)}
                      style={{ background: "#166534", border: "1px solid #22c55e", color: "#86efac", padding: "5px 10px", borderRadius: "6px", fontSize: "0.78rem", cursor: "pointer", fontWeight: "bold" }}
                    >
                      ✓ "Confirm order {activeDraft.orderId}"
                    </button>
                    <button
                      type="button"
                      onClick={() => handleVoiceTurn(`Cancel order ${activeDraft.orderId}`)}
                      style={{ background: "#7f1d1d", border: "1px solid #ef4444", color: "#fca5a5", padding: "5px 10px", borderRadius: "6px", fontSize: "0.78rem", cursor: "pointer" }}
                    >
                      ✕ "Cancel order {activeDraft.orderId}"
                    </button>
                  </>
                )}
              </div>

              {/* Text Fallback Input Box */}
              <form
                onSubmit={(e) => { e.preventDefault(); handleVoiceTurn(); }}
                style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}
              >
                <input
                  type="text"
                  placeholder="Or type a spoken command: e.g. 'What is Apple trading at?' or 'Buy 10 NVDA at market'"
                  value={voiceInputText}
                  onChange={(e) => setVoiceInputText(e.target.value)}
                  style={{ flex: 1, background: "#0b0f19", border: "1px solid #334155", color: "#f8fafc", padding: "0.6rem 0.8rem", borderRadius: "6px", fontSize: "0.88rem" }}
                />
                <button
                  type="submit"
                  disabled={voiceLoading || !voiceInputText.trim()}
                  style={{ background: "#2563eb", color: "#ffffff", border: "none", padding: "0.6rem 1.2rem", borderRadius: "6px", fontWeight: "bold", fontSize: "0.85rem", cursor: "pointer" }}
                >
                  {voiceLoading ? "Processing…" : "Send Voice Turn"}
                </button>
              </form>
            </div>

            {/* Conversation Feed */}
            <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: "12px", padding: "1.5rem" }}>
              <h5 style={{ margin: "0 0 1rem 0", color: "#f8fafc", fontSize: "1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span>💬</span> Live Voice Conversation History
              </h5>

              <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxHeight: "480px", overflowY: "auto", paddingRight: "0.5rem" }}>
                {voiceTranscript.map((msg, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: msg.role === "user" ? "flex-end" : "flex-start",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "3px", fontSize: "0.75rem", color: "#64748b" }}>
                      <span>{msg.role === "user" ? "👤 Trader (Voice)" : "🤖 E*TRADE Voice Desk"}</span>
                      <span>• {msg.timestamp}</span>
                    </div>

                    <div
                      style={{
                        maxWidth: "85%",
                        padding: "0.85rem 1rem",
                        borderRadius: "10px",
                        background: msg.role === "user" ? "linear-gradient(135deg, #1d4ed8 0%, #1e40af 100%)" : "#1e293b",
                        color: msg.role === "user" ? "#ffffff" : "#cbd5e1",
                        border: msg.role === "user" ? "none" : "1px solid #334155",
                        fontSize: "0.9rem",
                        lineHeight: 1.5,
                      }}
                    >
                      <div>{msg.text}</div>

                      {/* Embedded HITL Order Preview Card in Voice Feed */}
                      {msg.actionType === "preview" && msg.orderDraft && (
                        <div style={{ background: "rgba(245, 158, 11, 0.1)", border: "1px solid #f59e0b", borderRadius: "8px", padding: "0.85rem", marginTop: "0.75rem" }}>
                          <div style={{ color: "#f59e0b", fontWeight: "bold", fontSize: "0.85rem", marginBottom: "0.4rem" }}>
                            🛡️ Order Preview Staged (HITL Required)
                          </div>
                          <div style={{ fontSize: "0.82rem", color: "#cbd5e1", display: "grid", gap: "0.25rem" }}>
                            <div><strong>Order ID:</strong> <code>{msg.orderDraft.orderId}</code></div>
                            <div><strong>Action:</strong> {msg.orderDraft.action} {msg.orderDraft.quantity} {msg.orderDraft.symbol}</div>
                            <div><strong>Estimated Total:</strong> ${msg.orderDraft.estimatedTotal?.toFixed(2)} USD</div>
                          </div>
                          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                            <button
                              type="button"
                              onClick={() => handleVoiceOrderAction("approve", msg.orderDraft.orderId)}
                              style={{ background: "#166534", border: "1px solid #22c55e", color: "#ffffff", padding: "5px 12px", borderRadius: "4px", fontSize: "0.8rem", fontWeight: "bold", cursor: "pointer" }}
                            >
                              ✓ Voice Approve &amp; Execute
                            </button>
                            <button
                              type="button"
                              onClick={() => handleVoiceOrderAction("cancel", msg.orderDraft.orderId)}
                              style={{ background: "#7f1d1d", border: "1px solid #ef4444", color: "#ffffff", padding: "5px 12px", borderRadius: "4px", fontSize: "0.8rem", fontWeight: "bold", cursor: "pointer" }}
                            >
                              ✕ Cancel Draft
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Embedded Execution Receipt */}
                      {msg.actionType === "approval" && msg.brokerOrderRef && (
                        <div style={{ background: "rgba(34, 197, 94, 0.1)", border: "1px solid #22c55e", borderRadius: "8px", padding: "0.75rem", marginTop: "0.75rem", color: "#86efac", fontSize: "0.82rem" }}>
                          ✓ Broker Ref: <code>{msg.brokerOrderRef}</code> • Status: <strong>EXECUTED</strong>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
                    <span className={`val ${getRsiBadgeClass(inspectQuote.rsi)}`}>
                      {inspectQuote.rsi?.toFixed(1) || "N/A"}
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
