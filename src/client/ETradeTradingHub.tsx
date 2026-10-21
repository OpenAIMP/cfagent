import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { apiFetch as fetch } from "./apiFetch";
import { Card, Badge, TextInput, Button, EmptyState } from "./components/ui";
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
import { OptionsResearchPanel } from "./OptionsResearchPanel";
// Issue #319 — autonomous options-research runs (read-only; separate surface
// from the per-symbol research panel above).
import { ResearchRunsPanel } from "./options/ResearchRunsPanel";
import type { TradeAssetClass, TradeOrderContext } from "./trading/tradeOrderContext";
import { PortfolioRiskPanel } from "./PortfolioRiskPanel";
import { AccountPanels } from "./AccountPanels";
import { ScannerPanel } from "./ScannerPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { ScreenersHub } from "./ScreenersHub";
import { ReportsPanel } from "./ReportsPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { IvHistoryPanel } from "./IvHistoryPanel";
import { ETradeDynamicMenu, type ETradeDynamicMenuProps } from "./ETradeDynamicMenu";
import { EtapiConfigModal } from "./options/EtapiConfigModal";
import { RiskAnalysisModal } from "./options/RiskAnalysisModal";
import type { RiskSubject } from "./options/riskManagementEngine";

function OptionsResearchPanelHost({ hidden, children }: { hidden: boolean; children: React.ReactNode }) {
  return <div hidden={hidden}>{children}</div>;
}
import { ResearchReportActions } from "./ResearchReportActions";
import { AutopilotControlCenter } from "./components/AutopilotControlCenter";

export interface User {
  login: string;
  name?: string;
  avatar?: string;
}

export type TradingSubTab =
  | "autopilot"
  | "scanner"
  | "screeners"
  | "reports"
  | "schedules"
  | "iv-history"
  | "options"
  | "llm-ideas"
  | "order"
  | "portfolio"
  | "ledger"
  | "nlq"
  | "omnichannel"
  | "voice";

export interface ETradeTradingHubProps {
  user?: User;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  activeSubTab?: TradingSubTab;
  onSelectSubTab?: (tab: TradingSubTab) => void;
  onBrokerPropsChange?: (props: ETradeDynamicMenuProps) => void;
  /** Issue #69: unread broker-alert count, reported up for the nav badge. */
  onUnreadAlertsChange?: (count: number) => void;
}

const NLQ_ROW_RENDER_LIMIT = 500;

function formatNlqColumn(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.replace(/\bOi\b/g, "OI").replace(/\bIv\b/g, "IV").replace(/\bDte\b/g, "DTE").toUpperCase();
}

export function ETradeTradingHub({
  user,
  onSendPrompt,
  activeSubTab,
  onSelectSubTab,
  onBrokerPropsChange, onUnreadAlertsChange,
}: ETradeTradingHubProps) {
  // Navigation subtabs: synchronized directly with activeSubTab prop from Chat navigation
  const [subTab, setSubTab] = useState<TradingSubTab>(activeSubTab || "autopilot");
  const effectiveSubTab: TradingSubTab = activeSubTab || subTab || "autopilot";

  const handleNavigateSubTab = (newSubTab: TradingSubTab) => {
    setSubTab(newSubTab);
    onSelectSubTab?.(newSubTab);
  };
  // Issue #319: toggle between per-symbol research and the autonomous runs surface.
  // Issue #387: default to "symbol" — the section landed on the per-symbol
  // panel before #319; the runs surface is an addition, not a replacement.
  const [researchRunsView, setResearchRunsView] = useState<"symbol" | "runs">("symbol");

  useEffect(() => {
    if (activeSubTab && activeSubTab !== subTab) {
      setSubTab(activeSubTab);
    }
    const current = activeSubTab || subTab;
    if (current === "portfolio") {
      fetchPositions();
    } else if (current === "ledger") {
      fetchOrders();
    }
  }, [activeSubTab]);

  // Broker status
  const [brokerStatus, setBrokerStatus] = useState<ETradeBrokerStatus | null>(null);
  const [account, setAccount] = useState<ETradeAccount | null>(null);
  const [positions, setPositions] = useState<ETradePosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);

  const handleSeedDemoPortfolio = () => {
    // #913/#921: demo holdings are fabricated data — they may never be
    // seeded into a live/PROD brokerage view. The render sites are gated
    // on !isLive as well; this guard is the defense in depth.
    if (isLive) return;
    const samplePositions: ETradePosition[] = [
      {
        symbol: "NVDA",
        description: "NVIDIA Corporation - Common Stock",
        quantity: 50,
        pricePaid: 124.50,
        costBasis: 6225.00,
        currentPrice: 138.25,
        marketPrice: 138.25,
        marketValue: 6912.50,
        totalGain: 687.50,
        unrealizedGainLoss: 687.50,
        totalGainPercent: 11.04,
        unrealizedGainLossPercent: 11.04,
        daysGain: 84.50,
        daysGainPercent: 1.24,
        positionType: "LONG",
        securityType: "EQ",
      },
      {
        symbol: "AAPL",
        description: "Apple Inc. - Common Stock",
        quantity: 40,
        pricePaid: 215.00,
        costBasis: 8600.00,
        currentPrice: 231.40,
        marketPrice: 231.40,
        marketValue: 9256.00,
        totalGain: 656.00,
        unrealizedGainLoss: 656.00,
        totalGainPercent: 7.63,
        unrealizedGainLossPercent: 7.63,
        daysGain: -22.80,
        daysGainPercent: -0.25,
        positionType: "LONG",
        securityType: "EQ",
      },
      {
        symbol: "MSFT",
        description: "Microsoft Corporation - Common Stock",
        quantity: 25,
        pricePaid: 410.00,
        costBasis: 10250.00,
        currentPrice: 428.15,
        marketPrice: 428.15,
        marketValue: 10703.75,
        totalGain: 453.75,
        unrealizedGainLoss: 453.75,
        totalGainPercent: 4.43,
        unrealizedGainLossPercent: 4.43,
        daysGain: 41.25,
        daysGainPercent: 0.39,
        positionType: "LONG",
        securityType: "EQ",
      },
      {
        symbol: "SPY",
        description: "SPDR S&P 500 ETF Trust",
        quantity: 30,
        pricePaid: 560.00,
        costBasis: 16800.00,
        currentPrice: 582.60,
        marketPrice: 582.60,
        marketValue: 17478.00,
        totalGain: 678.00,
        unrealizedGainLoss: 678.00,
        totalGainPercent: 4.04,
        unrealizedGainLossPercent: 4.04,
        daysGain: 52.20,
        daysGainPercent: 0.30,
        positionType: "LONG",
        securityType: "EQ",
      },
    ];

    setPositions(samplePositions);
    setAccount({
      accountId: "paper_sandbox_demo",
      accountKey: "paper_sandbox_key",
      accountDesc: "Paper Trading Portfolio Sandbox",
      accountType: "MARGIN",
      netAccountValue: 69350.25,
      totalAccountValue: 69350.25,
      cashAvailableForInvestment: 25000.00,
      dayTraderStatus: false,
    });
  };

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
  const [riskSubject, setRiskSubject] = useState<RiskSubject | null>(null);
  const [orderError, setOrderError] = useState("");
  const [orderContext, setOrderContext] = useState<TradeOrderContext | null>(null);
  const [orderAssetClass, setOrderAssetClass] = useState<TradeAssetClass>("equity");
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

  // Listen for open-etapi-tuning and etrade-env-changed events from SettingsMenu
  useEffect(() => {
    const handleOpenTuning = () => setConfigModalOpen(true);
    const handleEnvChange = (e: any) => {
      const target = e.detail?.env;
      if (target === "TEST" || target === "PROD") {
        if (target !== activeEnv) {
          handleSwitchEnvironment(target);
        }
      }
    };
    window.addEventListener("open-etapi-tuning", handleOpenTuning);
    window.addEventListener("etrade-env-changed", handleEnvChange);
    return () => {
      window.removeEventListener("open-etapi-tuning", handleOpenTuning);
      window.removeEventListener("etrade-env-changed", handleEnvChange);
    };
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
        // These panels make their own broker requests. Keep them off the
        // diagnostics critical path so a slow positions/status call cannot
        // leave the successful REST verification stuck in a loading state.
        void Promise.allSettled([
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

  useEffect(() => {
    const handleOpenDiag = () => {
      runDiagnostics();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("open-etrade-diagnostics", handleOpenDiag);
      return () => window.removeEventListener("open-etrade-diagnostics", handleOpenDiag);
    }
  }, [activeEnv]);

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

  const handleTradeOrder = (ctx: TradeOrderContext) => {
    const seededOptionLegs = ctx.assetClass === "options" && !ctx.optionLegs?.length
      ? [{ securityType: "OPTN" as const, side: ctx.action === "SELL" || ctx.action === "SELL_SHORT" ? "SELL" as const : "BUY" as const, quantity: 1, optionType: "CALL" as const }]
      : ctx.optionLegs;
    const preparedContext: TradeOrderContext = {
      ...ctx,
      optionLegs: seededOptionLegs,
      strategyNetDebit: ctx.strategyNetDebit ?? (ctx.assetClass === "options" ? (ctx.action === "SELL" || ctx.action === "SELL_SHORT" ? -1 : 1) : undefined),
    };
    setOrderContext(preparedContext);
    setOrderAssetClass(ctx.assetClass);
    setOrderSymbol(preparedContext.symbol);
    // Multi-leg order direction is defined by each leg. Keep the ticket's
    // generic header action neutral for option strategies; never label a long
    // put structure as a stock short order.
    setOrderAction(preparedContext.assetClass === "options" ? "BUY" : preparedContext.action);
    setOrderType(preparedContext.assetClass === "options" || preparedContext.optionLegs?.length || preparedContext.underlyingPrice ? "LIMIT" : "MARKET");
    setOrderQuantity(preparedContext.quantity);
    if (preparedContext.assetClass === "options" && preparedContext.strategyNetDebit !== undefined) {
      const unitMultiplier = preparedContext.optionLegs?.some((leg) => leg.securityType === "OPTN")
        ? 100
        : preparedContext.optionLegs?.reduce((total, leg) => total + leg.quantity, 0) || 1;
      setOrderLimitPrice((Math.abs(preparedContext.strategyNetDebit) / unitMultiplier).toFixed(2));
    } else if (preparedContext.assetClass === "options") setOrderLimitPrice("0.01");
    else if (preparedContext.underlyingPrice) setOrderLimitPrice(preparedContext.underlyingPrice.toFixed(2));
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
    setSubTab("order");
    onSelectSubTab?.("order");
  };

  const updateOptionLeg = (index: number, patch: Partial<NonNullable<TradeOrderContext["optionLegs"]>[number]>) => {
    setOrderContext((current) => {
      if (!current?.optionLegs) return current;
      const optionLegs = current.optionLegs.map((leg, legIndex) => legIndex === index ? { ...leg, ...patch } : leg);
      return { ...current, optionLegs };
    });
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  const addOptionLeg = () => {
    setOrderContext((current) => {
      if (!current?.optionLegs || current.optionLegs.length >= 4) return current;
      const firstOption = current.optionLegs.find((leg) => leg.securityType === "OPTN");
      return {
        ...current,
        optionLegs: [...current.optionLegs, {
          securityType: "OPTN",
          side: "BUY",
          quantity: 1,
          optionType: firstOption?.optionType || "CALL",
          strike: firstOption?.strike,
          expirationDate: firstOption?.expirationDate,
        }],
      };
    });
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  const removeOptionLeg = (index: number) => {
    setOrderContext((current) => current?.optionLegs
      ? { ...current, optionLegs: current.optionLegs.filter((_, legIndex) => legIndex !== index) }
      : current);
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  const setOptionNetOrderDirection = (credit: boolean) => {
    setOrderContext((current) => current ? {
      ...current,
      strategyNetDebit: (credit ? -1 : 1) * Math.abs(Number.parseFloat(orderLimitPrice) || 0) * 100,
    } : current);
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  const handleQuickTrade = (stock: ScreenedStockItem | ETradePosition | ETradeQuote, defaultAction: "BUY" | "SELL" = "BUY") => {
    setOrderContext(null);
    setOrderAssetClass("equity");
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
    onSelectSubTab?.("order");
  };

  const handleCloseOptionPosition = (position: ETradePosition) => {
    if (!position.optionType || !position.strikePrice || !position.expirationDate) return;
    const closingSide = position.positionType === "SHORT" ? "BUY" : "SELL";
    const contractPrice = Number(position.currentPrice || position.marketPrice || position.pricePaid || 0);
    handleTradeOrder({
      assetClass: "options",
      symbol: position.symbol,
      action: closingSide === "BUY" ? "BUY_TO_COVER" : "SELL",
      quantity: Math.max(1, Math.floor(Math.abs(position.quantity))),
      label: `Close ${position.positionType === "SHORT" ? "short" : "long"} ${position.optionType.toLowerCase()} position · ${position.expirationDate} $${position.strikePrice}`,
      legs: [`${closingSide} ${Math.abs(position.quantity)} ${position.optionType} ${position.symbol} $${position.strikePrice} exp ${position.expirationDate}`],
      optionLegs: [{
        securityType: "OPTN",
        side: closingSide,
        quantity: 1,
        optionType: position.optionType,
        strike: position.strikePrice,
        expirationDate: position.expirationDate,
      }],
      // Option positions are quoted per share; strategy prices are per contract.
      strategyNetDebit: (closingSide === "BUY" ? 1 : -1) * contractPrice * 100,
    });
  };

  const handlePreviewOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setOrderError("");
    setPreviewLoading(true);
    setActiveDraft(null);
    setLastExecutionResult(null);

    if (orderAssetClass === "options") {
      const optionLegs = orderContext?.optionLegs?.filter((leg) => leg.securityType === "OPTN") || [];
      const hasIncompleteLeg = optionLegs.some((leg) => !leg.optionType || !Number.isFinite(leg.strike) || Number(leg.strike) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(leg.expirationDate || ""));
      if (!optionLegs.length || hasIncompleteLeg) {
        setOrderError("Complete each option leg with a call or put, positive strike, expiration date, and contract count before requesting broker preview.");
        setPreviewLoading(false);
        return;
      }
    }

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
          assetClass: orderAssetClass,
          symbol: orderSymbol.toUpperCase(),
          orderAction,
          action: orderAction,
          quantity: Number(orderQuantity),
          orderType,
          limitPrice: orderType === "LIMIT" ? price : undefined,
          optionLegs: orderContext?.optionLegs?.map((leg) => ({ ...leg, underlyingSymbol: orderSymbol.toUpperCase(), quantity: leg.quantity * Number(orderQuantity) })),
          strategyNetDebit: orderContext?.strategyNetDebit === undefined ? undefined : orderContext.strategyNetDebit * Number(orderQuantity),
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
          assetClass: activeDraft.optionLegs?.some((leg) => leg.securityType === "OPTN") ? "options" : "equity",
          symbol: activeDraft.symbol,
          orderAction: activeDraft.action,
          action: activeDraft.action,
          quantity: activeDraft.quantity,
          orderType: activeDraft.orderType,
          limitPrice: activeDraft.limitPrice,
          optionLegs: activeDraft.optionLegs,
          strategyNetDebit: activeDraft.strategyNetDebit,
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
    const tabLabels: Record<typeof effectiveSubTab, string> = {
      autopilot: "Autopilot Control Center",
      scanner: "Strategy/Symbol Scanner",
      screeners: "Multi-Asset Screeners",
      reports: "Reports",
      schedules: "Schedules",
      "iv-history": "IV History",
      options: "Auto Options Research",
      "llm-ideas": "LLM Idea Experiment",
      order: "Order Ticket",
      portfolio: "Portfolio",
      ledger: "Order History",
      nlq: "Trading",
      omnichannel: "Email & Slack Agents",
      voice: "Voice Trading Desk",
    };
    onSendPrompt?.(cleanPrompt, `E*TRADE · ${tabLabels[effectiveSubTab]}`);
  };

  const accountValue = account?.netAccountValue;
  const isLive = activeEnv === "PROD" || brokerStatus?.environment === "live" || brokerStatus?.activeEnvironment === "PROD";

  useEffect(() => {
    onBrokerPropsChange?.({
      activeEnv,
      oauthStatus,
      account,
      brokerStatus,
      maskAccount,
      setMaskAccount,
      diagnosticsLoading,
      oauthLoading,
      oauthMsg,
      setOauthMsg,
      handleSwitchEnvironment,
      handleSwitchAndConnect,
      runDiagnostics,
      handleRenewOAuth,
      handleRevokeOAuth,
      handleStartOAuth,
      onOpenEtapiTuning: () => setConfigModalOpen(true),
      userLogin: user?.login,
      userName: user?.name,
      userAvatar: user?.avatar,
    });
  }, [
    activeEnv,
    oauthStatus,
    account,
    brokerStatus,
    maskAccount,
    diagnosticsLoading,
    oauthLoading,
    oauthMsg,
    user?.login,
  ]);

  const orderLegs = orderContext?.optionLegs ?? [];

  return (
    <div className="etrade-trading-hub">
      {/* OAuth PIN Verification Modal */}
      {showPinModal && typeof document !== "undefined" && createPortal(
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
              <p style={{ margin: "0 0 1rem 0", color: "var(--color-text-secondary)", fontSize: "0.88rem", lineHeight: "1.4" }}>
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
                {oauthMsg && <div style={{ color: "var(--color-danger)", fontSize: "0.82rem", marginBottom: "0.75rem" }}>⚠️ {oauthMsg}</div>}
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
        </div>,
        document.body
      )}


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
                <span className={`stat-value action-pill ${activeDraft.optionLegs?.length ? "strategy" : activeDraft.action.toLowerCase()}`}>
                  {activeDraft.optionLegs?.length ? "STRATEGY" : activeDraft.action}
                </span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Symbol</span>
                <span className="stat-value ticker-val">{activeDraft.symbol}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Quantity</span>
                <span className="stat-value">{activeDraft.quantity} {activeDraft.optionLegs?.length ? "strategy units" : "shares"}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Order Type</span>
                <span className="stat-value">{activeDraft.brokerOrderType && activeDraft.brokerOrderType !== "EQ" ? `${activeDraft.brokerOrderType} · ${activeDraft.orderType}` : activeDraft.orderType}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">{activeDraft.optionLegs?.length ? "Net limit / unit" : "Limit / Est Price"}</span>
                <span className="stat-value">${(activeDraft.limitPrice || activeDraft.estimatedPrice).toFixed(2)}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">{activeDraft.strategyNetDebit !== undefined && activeDraft.strategyNetDebit < 0 ? "Estimated Credit" : "Estimated Total"}</span>
                <span className="stat-value total-val">${activeDraft.estimatedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>

            {activeDraft.optionLegs?.length ? (
              <div className="options-order-context" aria-label="Exact broker order legs">
                <strong>Legs sent to E*TRADE</strong>
                <ul>{activeDraft.optionLegs.map((leg, index) => (
                  <li key={`${leg.securityType}-${leg.optionType || "stock"}-${leg.strike || 0}-${leg.expirationDate || "equity"}-${index}`}>
                    {leg.side} {leg.quantity} {leg.securityType === "EQ" ? `${leg.underlyingSymbol} shares` : `${leg.underlyingSymbol} ${leg.optionType} $${leg.strike} ${leg.expirationDate}`}
                  </li>
                ))}</ul>
              </div>
            ) : null}

            <div className="hitl-attestation-box">
              {activeDraft.previewId && (
                <div className="attest-item">
                  <span className="attest-label">E*TRADE Upstream Session:</span>
                  <code style={{ color: "var(--color-success)", fontWeight: "bold" }}>Preview #{activeDraft.previewId} (Verified)</code>
                </div>
              )}
              {activeDraft.previewNotes && (
                <div className="attest-item" style={{ gridColumn: "1 / -1", background: "var(--color-warning-subtle)", padding: "0.4rem 0.6rem", borderRadius: "6px", border: "1px solid var(--color-warning)" }}>
                  <span className="attest-label" style={{ color: "var(--color-warning)" }}>⚠️ Broker Notice:</span>
                  <span style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>{activeDraft.previewNotes}</span>
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
                <span className="zero-comm">{activeDraft.estimatedCommission > 0 ? `$${activeDraft.estimatedCommission.toFixed(2)} broker estimate` : activeDraft.optionLegs?.length ? "See E*TRADE account disclosure" : "$0.00 (E*TRADE Online)"}</span>
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
                  style={{ background: "var(--color-accent)", borderColor: "var(--color-border-focus)" }}
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
              <Button variant="primary"
                type="button"
                style={{ padding: "0.6rem 1.1rem", fontSize: "0.85rem" }}
                onClick={() => {
                  const price = activeDraft.limitPrice || activeDraft.estimatedPrice || 100;
                  setRiskSubject({
                    title: `${activeDraft.action} ${activeDraft.quantity}x ${activeDraft.symbol}`,
                    underlyingSymbol: activeDraft.symbol,
                    underlyingPrice: price,
                    strategyType: `${activeDraft.action} ${activeDraft.orderType} Order`,
                    sentiment: activeDraft.action.toLowerCase().includes("buy") ? "bullish" : "bearish",
                    quantity: activeDraft.quantity,
                    maxLoss: activeDraft.estimatedTotal,
                    breakevens: [price],
                    breakevenText: `Order Price: $${price.toFixed(2)}`,
                  });
                }}
                title="Risk Analysis — Analyze pre-trade risk profile and defense playbook"
                aria-label="Risk Analysis"
              >
                <span className="risk-shield-icon" aria-hidden="true">🛡️</span>
                <span>Risk Analysis</span>
              </Button>
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
                <Button variant="trade"
                  type="button"
                  disabled={executingDraft}
                  onClick={handleRefreshAndExecuteDraft}
                >
                  {executingDraft ? "Refreshing & Executing…" : "⚡ Re-preview & Submit Fresh Order to E*TRADE"}
                </Button>
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

      {/* SUBTAB 0: AUTOPILOT CONTROL CENTER */}
      {effectiveSubTab === "autopilot" && (
        <AutopilotControlCenter
          user={user}
          isLiveAccount={isLive}
          onSendPrompt={onSendPrompt}
          onNavigateOrder={(sym) => {
            setOrderSymbol(sym);
            handleNavigateSubTab("order");
          }}
        />
      )}

      {effectiveSubTab === "iv-history" && <IvHistoryPanel />}

      {effectiveSubTab === "screeners" && (
        <ScreenersHub
          activeEnv={activeEnv}
          userLogin={user?.login}
          onStocksLoaded={setScreenerStocks}
        />
      )}

      {effectiveSubTab === "reports" && (
        <ReportsPanel />
      )}

      {effectiveSubTab === "schedules" && (
        <SchedulesPanel activeEnv={activeEnv} userLogin={user?.login} />
      )}

      {/* SUBTAB 1: MARKET SCREENER & SCANNER */}
      {effectiveSubTab === "scanner" && (
        <ErrorBoundary label="Strategy/Symbol Scanner panel">
          <ScannerPanel activeEnv={activeEnv} userLogin={user?.login} onPreviewTrade={handleTradeOrder} />
        </ErrorBoundary>
      )}

      <OptionsResearchPanelHost hidden={effectiveSubTab !== "options"}>
        {/* Issue #319: one research-run surface for manual + scheduled runs. */}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button
            onClick={() => setResearchRunsView("symbol")}
            style={{ fontWeight: researchRunsView === "symbol" ? 700 : 400 }}
          >
            Symbol research
          </button>
          <button
            onClick={() => setResearchRunsView("runs")}
            style={{ fontWeight: researchRunsView === "runs" ? 700 : 400 }}
          >
            Autonomous runs
          </button>
        </div>
        {researchRunsView === "runs" ? (
          <ResearchRunsPanel userLogin={user?.login} onSendPrompt={onSendPrompt} />
        ) : (
          <OptionsResearchPanel
            activeEnv={activeEnv}
            userLogin={user?.login}
            onPreviewTrade={handleTradeOrder}
            onJobStateChange={setOptionsJob}
            onSendPrompt={onSendPrompt}
          />
        )}
      </OptionsResearchPanelHost>

      {/* SUBTAB 2: ORDER TICKET & HITL PREVIEW */}
      {effectiveSubTab === "order" && (
        <div className="trading-section order-ticket-section">
          <div className="order-ticket-layout">
            {/* Left: Interactive Order Ticket Form */}
            <div className="order-form-card">
              <div className="card-header-styled" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
                <div>
                  <h4>⚡ {orderAssetClass === "options" ? "Options Order Ticket" : "Equity / ETF Order Ticket"}</h4>
                  <span className="header-subtitle">
                    {orderAssetClass === "options"
                      ? "Broker-priced options strategy preview with human approval required"
                      : orderContext?.optionLegs?.length
                        ? "Stock strategy preview with human approval required"
                        : "Zero-commission equity trading with agentic DID stamping"}
                  </span>
                </div>
                {orderSymbol && (
                  <button
                    type="button"
                    className="btn-options-refresh"
                    onClick={() => fetchSymbolQuote(orderSymbol)}
                    disabled={quoteLoading}
                    title={`Refresh live quote for ${orderSymbol}`}
                  >
                    <span className={quoteLoading ? "strat-spin" : ""}>↻</span>
                    <span>{quoteLoading ? "Refreshing…" : "Refresh Quote"}</span>
                  </button>
                )}
              </div>

              {orderError && (orderAssetClass === "options" ? (
                <div className="options-preview-error" role="alert">
                  <strong>Options preview failed. No order was created or submitted.</strong>
                  <span>{/unapproved options position|options approval levels/i.test(orderError)
                    ? "E*TRADE says this strategy is not approved for the account, or conflicts with current positions or open orders. Review the account’s options approval and open orders with E*TRADE."
                    : "Review the contract details and correct the issue before requesting another broker preview."}</span>
                  <details>
                    <summary>Broker response</summary>
                    <p>{orderError}</p>
                  </details>
                </div>
              ) : <div className="form-error-alert" role="alert">⚠️ {orderError}</div>)}
              {orderContext && (
                <div className="options-order-context">
                  <strong>{orderContext.assetClass === "options" ? "Options strategy" : "From Strategy Research"}</strong>
                  <span>{orderContext.label}</span>
                  {orderContext.assetClass === "options" ? (
                    <div className="options-leg-editor" aria-label="Edit option strategy legs">
                      <div className="options-leg-editor-heading">
                        <div>
                          <strong>Build your order</strong>
                          <span>Review and edit every contract before requesting E*TRADE’s preview.</span>
                        </div>
                        <button type="button" className="options-leg-add" onClick={addOptionLeg} disabled={orderLegs.length >= 4 || orderLegs.some((leg) => leg.securityType === "EQ")}>
                          + Add leg
                        </button>
                      </div>
                      {orderLegs.map((leg, index) => (
                        <div className="options-leg-row" key={`option-leg-${index}`}>
                          <div className="options-leg-title"><strong>Leg {index + 1}</strong><span>{leg.securityType === "OPTN" ? "OPTION" : "STOCK"}</span></div>
                          <label>Side
                            <select value={leg.side} onChange={(event) => updateOptionLeg(index, { side: event.target.value as "BUY" | "SELL" })}>
                              <option value="BUY">Buy</option><option value="SELL">Sell</option>
                            </select>
                          </label>
                          {leg.securityType === "OPTN" && <>
                            <label>Type
                              <select value={leg.optionType || "CALL"} onChange={(event) => updateOptionLeg(index, { optionType: event.target.value as "CALL" | "PUT" })}>
                                <option value="CALL">Call</option><option value="PUT">Put</option>
                              </select>
                            </label>
                            <label>Strike ($)
                              <input type="number" min="0.01" step="0.5" value={leg.strike ?? ""} onChange={(event) => updateOptionLeg(index, { strike: Number(event.target.value) })} />
                            </label>
                            <label>Expiration
                              <input type="date" value={leg.expirationDate || ""} onChange={(event) => updateOptionLeg(index, { expirationDate: event.target.value })} />
                            </label>
                          </>}
                          <label>{leg.securityType === "OPTN" ? "Contracts" : "Shares"}
                            <input type="number" min="1" step="1" value={leg.quantity} onChange={(event) => updateOptionLeg(index, { quantity: Math.max(1, Number.parseInt(event.target.value, 10) || 1) })} />
                          </label>
                          <button type="button" className="options-leg-remove" onClick={() => removeOptionLeg(index)} aria-label={`Remove leg ${index + 1}`} disabled={(orderContext.optionLegs?.length ?? 0) <= 1}>Remove</button>
                        </div>
                      ))}
                      <p className="options-leg-editor-help">1. Edit the contracts and net limit. 2. Request E*TRADE’s preview. 3. Review and approve only if the broker accepts it. Nothing is submitted before your approval; E*TRADE still validates account approval, buying power, and existing positions.</p>
                    </div>
                  ) : (
                    <ul>{orderContext.legs.map((leg) => <li key={leg}>{leg}</li>)}</ul>
                  )}
                </div>
              )}

              <form onSubmit={handlePreviewOrder} className="order-ticket-form">
                {/* Symbol and Instant Quote */}
                <div className="form-group">
                  <label>{orderAssetClass === "options" ? "Underlying Symbol" : "Ticker Symbol"}</label>
                  <div className="symbol-input-row">
                    <input
                      type="text"
                      className="ticker-input"
                      placeholder="e.g. NVDA, AAPL"
                      value={orderSymbol}
                      readOnly={orderAssetClass === "options"}
                      onChange={(e) => {
                        const s = e.target.value.toUpperCase();
                        setOrderSymbol(s);
                        setOrderContext(null);
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
                          <span className={`pill-badge ${orderQuote.quoteStatus === "REALTIME" ? "positive" : "neutral"}`}>
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
                        <span className="pill-badge" style={{ background: "var(--color-accent-subtle)", color: "var(--color-accent)", borderColor: "var(--color-border-focus)" }}>
                          ✓ {orderQuote.source}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Action Toggle (BUY / SELL) */}
                {!orderContext?.optionLegs?.length && <div className="form-group">
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
                </div>}

                {/* Order Type and Pricing */}
                {(orderContext?.optionLegs?.filter((leg) => leg.securityType === "OPTN").length ?? 0) > 1 && (
                  <div className="options-net-order-control" role="group" aria-label="Net order direction">
                    <span>Net order</span>
                    <button type="button" className={(orderContext?.strategyNetDebit ?? 0) >= 0 ? "active" : ""} onClick={() => setOptionNetOrderDirection(false)}>Debit</button>
                    <button type="button" className={(orderContext?.strategyNetDebit ?? 0) < 0 ? "active" : ""} onClick={() => setOptionNetOrderDirection(true)}>Credit</button>
                  </div>
                )}
                <div className="form-row-2">
                  <div className="form-group">
                    <label>Order Type</label>
                    <select
                      value={orderType}
                      disabled={Boolean(orderContext?.optionLegs?.length)}
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
                    <label>{orderContext?.optionLegs?.length ? "Net Limit Price per Strategy Unit ($)" : orderType === "LIMIT" ? "Limit Price ($)" : "Stop Price ($)"}</label>
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
                        setOrderError("");
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
                      <div className="limit-warning-box" role="alert" style={{ background: "var(--color-warning-subtle)", color: "var(--color-warning)", padding: "0.5rem 0.75rem", borderRadius: "6px", fontSize: "0.8rem", marginTop: "-0.5rem", marginBottom: "0.75rem", border: "1px solid var(--color-warning)" }}>
                        ⚠️ <strong>Limit Price Alert:</strong> Proposed Buy Limit (${parsedLimit.toFixed(2)}) is &gt;5% above current ask (${askPrice.toFixed(2)}). As a buy limit, this order may execute immediately at prevailing market prices.
                      </div>
                    );
                  }
                  if ((orderAction === "BUY" || orderAction === "BUY_TO_COVER") && askPrice > 0 && parsedLimit < askPrice * 0.7) {
                    return (
                      <div className="limit-warning-box" role="alert" style={{ background: "var(--color-danger-subtle)", color: "var(--color-danger)", padding: "0.5rem 0.75rem", borderRadius: "6px", fontSize: "0.8rem", marginTop: "-0.5rem", marginBottom: "0.75rem", border: "1px solid var(--color-danger)" }}>
                        ⚠️ <strong>Pricing Collar Alert:</strong> Proposed Buy Limit (${parsedLimit.toFixed(2)}) is {Math.round((1 - parsedLimit / askPrice) * 100)}% below current ask (${askPrice.toFixed(2)}). Broker collar rules may reject orders that diverge excessively from prevailing NBBO quotes.
                      </div>
                    );
                  }
                  if ((orderAction === "SELL" || orderAction === "SELL_SHORT") && bidPrice > 0 && parsedLimit < bidPrice * 0.95) {
                    return (
                      <div className="limit-warning-box" role="alert" style={{ background: "var(--color-warning-subtle)", color: "var(--color-warning)", padding: "0.5rem 0.75rem", borderRadius: "6px", fontSize: "0.8rem", marginTop: "-0.5rem", marginBottom: "0.75rem", border: "1px solid var(--color-warning)" }}>
                        ⚠️ <strong>Limit Price Alert:</strong> Proposed Sell Limit (${parsedLimit.toFixed(2)}) is &gt;5% below current bid (${bidPrice.toFixed(2)}). As a sell limit, this order may execute immediately below prevailing value.
                      </div>
                    );
                  }
                  if ((orderAction === "SELL" || orderAction === "SELL_SHORT") && bidPrice > 0 && parsedLimit > bidPrice * 1.3) {
                    return (
                      <div className="limit-warning-box" role="alert" style={{ background: "var(--color-danger-subtle)", color: "var(--color-danger)", padding: "0.5rem 0.75rem", borderRadius: "6px", fontSize: "0.8rem", marginTop: "-0.5rem", marginBottom: "0.75rem", border: "1px solid var(--color-danger)" }}>
                        ⚠️ <strong>Pricing Collar Alert:</strong> Proposed Sell Limit (${parsedLimit.toFixed(2)}) is {Math.round((parsedLimit / bidPrice - 1) * 100)}% above current bid (${bidPrice.toFixed(2)}). Broker collar rules may reject orders that diverge excessively from prevailing NBBO quotes.
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Quantity and Quick Stepper */}
                <div className="form-group">
                  <label>{orderContext?.optionLegs?.length ? "Strategy Units" : "Quantity (Shares)"}</label>
                  <div className="quantity-stepper-row">
                    <button
                      type="button"
                      className="qty-btn"
                      onClick={() => {
                        setOrderQuantity(Math.max(1, orderQuantity - (orderContext?.optionLegs?.some((leg) => leg.securityType === "OPTN") ? 1 : 5)));
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                      }}
                    >
                      {orderContext?.optionLegs?.some((leg) => leg.securityType === "OPTN") ? "−1" : "−5"}
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
                        setOrderQuantity(orderQuantity + (orderContext?.optionLegs?.some((leg) => leg.securityType === "OPTN") ? 1 : 5));
                        setActiveDraft(null);
                        setLastExecutionResult(null);
                      }}
                    >
                      {orderContext?.optionLegs?.some((leg) => leg.securityType === "OPTN") ? "+1" : "+5"}
                    </button>
                  </div>
                  <div className="qty-preset-chips">
                    {(orderAssetClass === "options" ? [1, 2, 5, 10, 25] : [5, 10, 25, 50, 100]).map((q) => (
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
                        {q} {orderContext?.optionLegs?.length ? "units" : "shs"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Pricing Summary */}
                <div className="order-calc-card">
                  <div className="calc-row">
                    <span>{orderContext?.optionLegs?.length ? `Net ${orderContext.strategyNetDebit !== undefined && orderContext.strategyNetDebit < 0 ? "Credit" : "Debit"} per strategy unit` : "Estimated Price per Share:"}</span>
                    <span>${orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0").toFixed(2) : (orderQuote?.lastPrice || 0).toFixed(2)}</span>
                  </div>
                  <div className="calc-row">
                    <span>Online Commission:</span>
                    <span className="zero-comm">{orderContext?.optionLegs?.length ? (activeDraft ? `$${activeDraft.estimatedCommission.toFixed(2)} broker estimate` : "Broker estimate in preview") : "$0.00 USD"}</span>
                  </div>
                  <div className="calc-row total">
                    <span>Estimated {orderContext?.optionLegs?.length && (orderContext.strategyNetDebit ?? 0) < 0 ? "Credit" : "Total Order Value"}:</span>
                    <span className="calc-total-val">
                      ${(
                        orderQuantity *
                        (orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0") : orderQuote?.lastPrice || 0) *
                        (orderAssetClass === "options"
                          ? 100
                          : orderContext?.optionLegs?.reduce((total, leg) => total + leg.quantity, 0) || 1)
                      ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                {/* Submit Preview and Pre-Trade Risk Analysis Buttons */}
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="submit"
                    className="btn-submit-preview"
                    style={{ flex: 1 }}
                    disabled={previewLoading || !orderSymbol.trim()}
                    title="Generate cryptographic order preview with Trading Agent DID"
                    aria-label={orderAssetClass === "options" ? "Preview Options Order" : "Preview Equity Order"}
                  >
                    {previewLoading ? (
                      "Creating Cryptographic Preview…"
                    ) : (
                      <>
                        <span className="btn-preview-icon" aria-hidden="true" style={{ marginRight: "0.4rem" }}>📋</span>
                        {orderAssetClass === "options" ? "Preview Options Order" : "Preview Equity Order"}
                      </>
                    )}
                  </button>
                  <Button variant="primary"
                    type="button"
                    style={{ padding: "0.75rem 1rem", fontSize: "0.85rem" }}
                    disabled={!orderSymbol.trim()}
                    onClick={() => {
                      const estPrice = orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0") : (orderQuote?.lastPrice || 100);
                      const totalVal = orderQuantity * estPrice;
                      setRiskSubject({
                        title: orderAssetClass === "options"
                          ? `${orderContext?.label || "Options strategy"} · ${orderQuantity} unit(s)`
                          : `${orderAction} ${orderQuantity}x ${orderSymbol.toUpperCase()} (${orderType})`,
                        underlyingSymbol: orderSymbol.toUpperCase(),
                        underlyingPrice: estPrice,
                        strategyType: orderAssetClass === "options" ? orderContext?.label || "Options Order Ticket" : `${orderAction} Order Ticket`,
                        sentiment: orderAction.includes("BUY") ? "bullish" : "bearish",
                        quantity: orderQuantity,
                        positionType: orderAssetClass === "options" ? "MULTI_LEG" : "EQUITY",
                        maxLoss: orderAssetClass === "options" ? undefined : totalVal,
                        netDebit: orderAssetClass === "options" ? orderContext?.strategyNetDebit : undefined,
                        legsText: orderContext?.legs.join(" / "),
                        legs: orderContext?.optionLegs?.map((leg) => ({
                          side: leg.side,
                          quantity: leg.quantity * orderQuantity,
                          optionType: leg.optionType,
                          strike: leg.strike,
                          expirationDate: leg.expirationDate,
                        })),
                        breakevens: [estPrice],
                        breakevenText: `Execution/Limit: $${estPrice.toFixed(2)}`,
                      });
                    }}
                    title="Risk Analysis — Run pre-trade institutional risk analysis"
                    aria-label="Risk Analysis"
                  >
                    <span className="risk-shield-icon" aria-hidden="true">🛡️</span>
                    <span>Risk Analysis</span>
                  </Button>
                </div>
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
      {effectiveSubTab === "portfolio" && (
        <div className="trading-section portfolio-section">
          {/* Universal Hero Header */}
          <div className="tab-hero-header portfolio-hero-header">
            <div className="hero-text-block">
              <div className="hero-badge-row">
                <span className="hero-badge">💼 PORTFOLIO &amp; HOLDINGS</span>
                <span className={`hero-badge ${isLive ? "badge-live" : "badge-paper"}`}>
                  {isLive ? "LIVE BROKERAGE" : "PAPER TRADING SANDBOX"}
                </span>
                <span className="hero-badge badge-pro">HITL ATTESTED</span>
              </div>
              <h3>Portfolio Holdings &amp; Open Positions</h3>
              <p>
                Inspect real-time equity &amp; options holdings, cost basis, unrealized gain/loss, asset allocations, and portfolio Greeks across your connected brokerage desk.
              </p>
            </div>
            <div className="hero-actions-row">
              <button
                type="button"
                className="btn-options-refresh"
                onClick={() => fetchPositions()}
                disabled={positionsLoading}
                title="Refresh live portfolio positions from broker"
              >
                <span className={positionsLoading ? "strat-spin" : ""}>↻</span>
                <span>{positionsLoading ? "Refreshing…" : "Refresh Positions"}</span>
              </button>
              <Button variant="trade"
                type="button"
                onClick={() => handleNavigateSubTab("order")}
                title="Open Fast Order Ticket to execute a trade"
              >
                ⚡ Fast Order Ticket
              </Button>
              {!isLive && (
                <Button variant="secondary"
                  type="button"
                  onClick={handleSeedDemoPortfolio}
                  title="Load curated paper trading positions (NVDA, AAPL, MSFT, SPY) to explore"
                >
                  🌱 {positions.length === 0 ? "Load Demo Holdings" : "Reset Demo Holdings"}
                </Button>
              )}
            </div>
          </div>

          <div className="portfolio-summary-row">
            {(() => {
              const totalUnrealizedGain = positions.reduce((sum, p) => sum + (Number(p.unrealizedGainLoss ?? p.totalGain ?? 0)), 0);
              const totalVal = account?.totalAccountValue || positions.reduce((sum, p) => sum + Number(p.marketValue ?? 0), 0);
              const cashVal = account?.cashAvailableForInvestment ?? 0;
              const isGain = totalUnrealizedGain >= 0;

              return (
                <>
                  <div className="port-summary-card">
                    <span className="summary-title">Portfolio Equity</span>
                    <span className="summary-amount">
                      ${Number(totalVal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className={`summary-change ${isGain ? "positive" : "negative"}`}>
                      {isGain ? "+" : ""}${Math.abs(totalUnrealizedGain).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (Unrealized {isGain ? "Gains" : "Losses"})
                    </span>
                  </div>
                  <div className="port-summary-card">
                    <span className="summary-title">Available Cash</span>
                    <span className="summary-amount">
                      ${Number(cashVal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className="summary-change">{isLive ? "Broker Purchasing Power" : "Paper Capital Ready"}</span>
                  </div>
                </>
              );
            })()}
            <div className="port-summary-card">
              <span className="summary-title">Active Positions</span>
              <span className="summary-amount">{positions.length}</span>
              <span className="summary-change">
                {positions.filter((position) => position.securityType === "OPTN").length} options · {positions.filter((position) => position.securityType !== "OPTN").length} equities &amp; ETFs
              </span>
            </div>
          </div>

          <div className="portfolio-table-wrap" id="section-positions" style={{ scrollMarginTop: 80 }}>
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
                    <td colSpan={8}>
                      <EmptyState
                        icon="💼"
                        title={positionsLoading ? "Loading portfolio positions from broker…" : "No Active Holdings Found"}
                        description={
                          positionsLoading
                            ? "Connecting to brokerage upstream and calculating portfolio equity balances…"
                            : isLive
                            ? "No active positions found in your connected live brokerage account. Use the Fast Order Ticket to build and preview an order."
                            : "Your paper trading sandbox has no open positions. Place a paper trade or load curated demo holdings (NVDA, AAPL, MSFT, SPY) to explore portfolio analytics, charts, and Greeks."
                        }
                        action={
                          !positionsLoading ? (
                            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
                              <Button variant="trade" onClick={() => handleNavigateSubTab("order")}>
                                ⚡ Build Order Ticket
                              </Button>
                              {!isLive && (
                                <Button variant="secondary" onClick={handleSeedDemoPortfolio}>
                                  🌱 Load Curated Demo Positions
                                </Button>
                              )}
                            </div>
                          ) : undefined
                        }
                      />
                    </td>
                  </tr>
                ) : (
                  positions.map((pos) => {
                    const unrealizedGain = Number(pos.unrealizedGainLoss ?? pos.totalGain ?? 0);
                    const unrealizedGainPct = Number(pos.unrealizedGainLossPercent ?? pos.totalGainPercent ?? 0);
                    const dayGain = Number(pos.daysGain ?? 0);
                    const dayGainPct = Number(pos.daysGainPercent ?? 0);
                    const isTotalPos = unrealizedGain >= 0;
                    const isDayPos = dayGain >= 0;
                    const costBasis = Number(pos.costBasis ?? pos.pricePaid ?? 0);
                    const curPrice = Number(pos.currentPrice ?? pos.marketPrice ?? 0);
                    const mktVal = Number(pos.marketValue ?? (curPrice * Number(pos.quantity ?? 0)));

                    return (
                      <tr key={pos.symbol}>
                        <td>
                          <div className="ticker-company">
                            <span className="ticker-badge">{pos.symbol}</span>
                            <span className="company-title">
                              {pos.securityType === "OPTN"
                                ? `${pos.optionType || "Option"} $${Number(pos.strikePrice || 0).toFixed(2)} · ${pos.expirationDate || "Expiry unavailable"}`
                                : pos.description}
                            </span>
                          </div>
                          {pos.securityType === "OPTN" && <span className="position-type-badge">{pos.positionType === "SHORT" ? "Short option" : "Long option"}</span>}
                        </td>
                        <td>
                          <span className="qty-val">{pos.quantity} {pos.securityType === "OPTN" ? "contracts" : "shares"}</span>
                        </td>
                        <td>
                          <span>${costBasis.toFixed(2)}</span>
                        </td>
                        <td>
                          <span className="price-tag">${curPrice.toFixed(2)}</span>
                        </td>
                        <td>
                          <span className="mkt-val">${mktVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </td>
                        <td>
                          <span className={`change-pill ${isTotalPos ? "positive" : "negative"}`}>
                            {isTotalPos ? "+" : ""}${unrealizedGain.toFixed(2)} ({isTotalPos ? "+" : ""}{unrealizedGainPct.toFixed(2)}%)
                          </span>
                        </td>
                        <td>
                          <span className={`change-pill ${isDayPos ? "positive" : "negative"}`}>
                            {isDayPos ? "+" : ""}${dayGain.toFixed(2)} ({isDayPos ? "+" : ""}{dayGainPct.toFixed(2)}%)
                          </span>
                        </td>
                        <td>
                          <div className="table-actions-cell">
                            {pos.securityType === "OPTN" && pos.optionType && pos.strikePrice && pos.expirationDate ? (
                              <Button variant="danger" tone="subtle" size="sm"
                                type="button"
                                onClick={() => handleCloseOptionPosition(pos)}
                                title="Build a broker-priced closing order for this option position"
                              >
                                - Close Option
                              </Button>
                            ) : pos.securityType === "OPTN" ? (
                              <span className="position-action-unavailable" title="The broker did not return enough contract details to build a closing order.">Contract details unavailable</span>
                            ) : <>
                              <Button variant="trade" tone="subtle" size="sm"
                                type="button"
                                onClick={() => handleQuickTrade(pos, "BUY")}
                                title="Add more shares"
                              >
                                + Buy
                              </Button>
                              <Button variant="danger" tone="subtle" size="sm"
                                type="button"
                                onClick={() => handleQuickTrade(pos, "SELL")}
                                title="Sell to close position"
                              >
                                - Close
                              </Button>
                            </>}
                            <Button variant="warning" tone="subtle" size="sm"
                              type="button"
                              onClick={() => {
                                setRiskSubject({
                                  title: `${pos.quantity}x ${pos.symbol} (${pos.description || "Long Equity"})`,
                                  underlyingSymbol: pos.symbol,
                                  underlyingPrice: curPrice,
                                  strategyType: "Long Equity Position",
                                  sentiment: "bullish",
                                  quantity: pos.quantity,
                                  positionType: "EQUITY",
                                  costBasis: costBasis,
                                  unrealizedPnL: unrealizedGain,
                                  maxLoss: mktVal,
                                  maxProfit: null,
                                  breakevens: [costBasis],
                                  breakevenText: `Cost basis: $${costBasis.toFixed(2)}/share`,
                                });
                              }}
                              title="Analyze position risk profile and hedging strategies"
                            >
                              🛡️ Risk
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Portfolio Risk (issue #63): surfaces the #34/#35/#36/#54 backends —
              aggregates, hedge drafts with HITL preview hand-off, correlation
              flags, and portfolio-aware sizing. */}
          {/* Section nav (issue #69) */}
          <nav className="portfolio-section-nav" style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginTop: "1.25rem" }}>
            {[
              ["Positions", "section-positions"],
              ["Alerts", "section-alerts"],
              ["Transactions", "section-transactions"],
              ["Watchlists", "section-watchlists"],
              ["Orders", "section-orders"],
              ["Portfolio Risk", "section-portfolio-risk"],
            ].map(([label, id]) => (
              <button
                key={id}
                type="button"
                style={{ padding: "0.35rem 0.75rem", borderRadius: 999, border: "1px solid var(--color-border-medium)", background: "var(--color-muted)", color: "inherit", cursor: "pointer", fontSize: "0.82rem" }}
                onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                {label}
              </button>
            ))}
          </nav>

          <ErrorBoundary label="Account panels (alerts, transactions, watchlists, orders)">
            <AccountPanels activeEnv={activeEnv} onUnreadAlertsChange={onUnreadAlertsChange} />
          </ErrorBoundary>

          <ErrorBoundary label="Portfolio Risk panel">
            <PortfolioRiskPanel activeEnv={activeEnv} onPreviewHedge={handleTradeOrder} />
          </ErrorBoundary>
        </div>
      )}

      {/* SUBTAB 4: ORDER HISTORY LEDGER */}
      {effectiveSubTab === "ledger" && (
        <Card className="trading-section">
          <div className="ledger-header-row">
            <h4>📜 E*TRADE Orders Ledger (SQLite mas_trades)</h4>
            <Button
              variant="secondary"
              disabled={ordersLoading}
              onClick={fetchOrders}
            >
              {ordersLoading ? "Refreshing…" : "🔄 Refresh Ledger"}
            </Button>
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
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={11}>
                      <EmptyState title={ordersLoading ? "Loading orders ledger…" : "No trade orders recorded yet."} />
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
                      <td>
                        <Button variant="warning" tone="subtle" size="sm"
                          type="button"
                          onClick={() => {
                            setRiskSubject({
                              title: `${ord.action} ${ord.quantity}x ${ord.symbol}`,
                              underlyingSymbol: ord.symbol,
                              underlyingPrice: ord.price,
                              strategyType: `${ord.action} Trade`,
                              sentiment: ord.action.toLowerCase().includes("buy") ? "bullish" : "bearish",
                              quantity: ord.quantity,
                              positionType: "EQUITY",
                              maxLoss: ord.totalValue,
                              breakevens: [ord.price],
                              breakevenText: `Price: $${ord.price.toFixed(2)}`,
                            });
                          }}
                          title="Analyze risk profile for this ledger trade"
                        >
                          🛡️ Risk
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* SUBTAB 5: NLQ RESULTS */}
      {effectiveSubTab === "nlq" && (
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
                    <Badge size="md" tone="accent">Domain: {nlqResult.plan.domain}</Badge>
                    <Badge size="md" tone="success">Intent: {nlqResult.plan.tradingData?.intent || "market_query"}</Badge>
                    {nlqResult.plan.sql && (
                      <Badge size="md" tone="warning">Deterministic SQL</Badge>
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
                  <div className="nlq-unverified-warning-banner" role="alert" style={{ background: "var(--color-danger-subtle)", borderColor: "var(--color-danger)" }}>
                    <div className="warning-title" style={{ color: "var(--color-danger)" }}>
                      🚨 SCAN INVALID — DATA MISMATCH: FILTER CONTRADICTION DETECTED
                    </div>
                    <p className="warning-desc" style={{ color: "var(--color-text-secondary)" }}>
                      {nlqResult.summary || nlqResult.result?.summary}
                    </p>
                    <div style={{ fontSize: "0.85rem", color: "var(--color-danger)", marginTop: "0.4rem" }}>
                      Trading order shortcuts disabled because one or more candidates failed validation.
                    </div>
                  </div>
                )}

                {/* Scan Audit Ledger Box */}
                {(nlqResult.scanLedger || nlqResult.result?.scanLedger) && (
                  <div className="scan-audit-ledger-box" style={{ background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-md)", padding: "1rem", margin: "1rem 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
                      <h5 style={{ margin: 0, fontSize: "0.95rem", color: "var(--color-accent)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span>🛡️</span> Market Universe Scan Audit Ledger
                      </h5>
                      <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                        Evaluated: <strong style={{ color: "var(--color-text-primary)" }}>{(nlqResult.scanLedger || nlqResult.result?.scanLedger).totalEvaluated}</strong> | 
                        Passed: <strong style={{ color: "var(--color-success)" }}>{(nlqResult.scanLedger || nlqResult.result?.scanLedger).passedCount}</strong> | 
                        Rejected: <strong style={{ color: "var(--color-danger)" }}>{(nlqResult.scanLedger || nlqResult.result?.scanLedger).rejectedCount}</strong>
                      </div>
                    </div>

                    {/* Rejection Details */}
                    {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).length > 0 && (
                      <details style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", marginTop: "0.5rem" }}>
                        <summary style={{ cursor: "pointer", color: "var(--color-danger)" }}>
                          View {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).length} Rejection Details (showing first 200)
                        </summary>
                        <table className="trading-table" style={{ marginTop: "0.5rem" }}>
                          <thead>
                            <tr><th>SYMBOL</th><th>REASON</th></tr>
                          </thead>
                          <tbody>
                            {((nlqResult.scanLedger || nlqResult.result?.scanLedger).rejections || []).slice(0, 200).map((rej: any, rIdx: number) => (
                              <tr key={rIdx}>
                                <td><strong style={{ color: "var(--color-danger)" }}>{rej.symbol}</strong></td>
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
                                      <span style={{ color: "var(--color-danger)", fontSize: "0.75rem", fontWeight: "bold" }}>
                                        ⛔ {String(val)}
                                      </span>
                                    ) : (
                                      <Button variant="secondary" size="sm"
                                        type="button"
                                        onClick={() => {
                                          if (row.symbol) handleOpenInspectQuote(row.symbol);
                                        }}
                                      >
                                        ⚡ {String(val)}
                                      </Button>
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
                              <Button variant="secondary" size="sm" type="button" onClick={() => handleOpenInspectQuote(stock.symbol, stock)}>Quote</Button>{" "}
                              <Button variant="trade" size="sm" type="button" onClick={() => handleQuickTrade(stock, "BUY")}>⚡ Trade</Button>
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
      {/* Omnichannel Trading Agents (Cloudflare Email & Slack Agents) */}
      {effectiveSubTab === "omnichannel" && (
        <div className="tab-pane active omnichannel-pane">
          {/* Header Card */}
          <div className="omnichannel-header-card">
            <div className="omnichannel-header-top">
              <div>
                <span className="omnichannel-header-badge">
                  Cloudflare Agents SDK
                </span>
                <h3 className="omnichannel-header-title">
                  💬 Omnichannel Trading Agents (Email &amp; Slack)
                </h3>
                <p className="omnichannel-header-desc">
                  Autonomous market research, quoting, and Human-in-the-Loop order drafting via Inbound Email and Slack Bot communication channels. All orders require explicit human authorization before live E*TRADE execution.
                </p>
              </div>
              <div className="omnichannel-header-status">
                <span className="omnichannel-live-badge">
                  ✓ Direct REST API Live
                </span>
              </div>
            </div>
          </div>

          <div className="omnichannel-grid">
            {/* Channel 1: Cloudflare Email Trading Agent */}
            <div className="omnichannel-card">
              <div className="omnichannel-card-header">
                <h4 className="omnichannel-card-title email">
                  <span>✉️</span> Cloudflare Email Trading Agent
                </h4>
                <span className="omnichannel-badge-subtle cyan">
                  send_email &amp; PostalMime
                </span>
              </div>

              <div className="omnichannel-meta-box">
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Inbound Address:</strong> <code>trade@agent.openaimp.com</code>
                </div>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Security Guarantee:</strong> Stamped with Trading DID (<code>did:agent:openaimp:trading</code>).
                </div>
                <div>
                  <strong>Commands:</strong> <code>Quote &lt;SYMBOL&gt;</code>, <code>Screen stocks priced between $20 and $200</code>, <code>Preview Buy 10 NVDA limit 125</code>, <code>APPROVE &lt;orderId&gt;</code>.
                </div>
              </div>

              {/* Email Simulator Form */}
              <div className="omnichannel-simulator-card">
                <h5 className="omnichannel-simulator-title">
                  🧪 Interactive Email Simulator
                </h5>
                <div className="omnichannel-form-group">
                  <div>
                    <label htmlFor="omni-email-from" className="omnichannel-form-label">From (Sender Email):</label>
                    <TextInput id="omni-email-from"
                      type="email"
                      value={emailFrom}
                      onChange={(e) => setEmailFrom(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="omni-email-subject" className="omnichannel-form-label">Subject:</label>
                    <TextInput id="omni-email-subject"
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="omni-email-body" className="omnichannel-form-label">Email Body:</label>
                    <TextInput id="omni-email-body"
                      multiline
                      rows={2}
                      value={emailBody}
                      onChange={(e) => setEmailBody(e.target.value)}
                    />
                  </div>

                  {/* Preset Quick Chips */}
                  <div className="omnichannel-chip-row">
                    <button
                      type="button"
                      onClick={() => { setEmailSubject("Quote NVDA"); setEmailBody("What is the current price and technicals?"); }}
                      className="omnichannel-chip"
                    >
                      📈 Quote NVDA
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEmailSubject("Screen stock price range"); setEmailBody("Show stocks priced between $20 and $200"); }}
                      className="omnichannel-chip"
                    >
                      🔍 Screen Price Range
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEmailSubject("Order Preview"); setEmailBody("Buy 10 shares of NVDA limit 125.00"); }}
                      className="omnichannel-chip"
                    >
                      🛡️ Buy 10 NVDA
                    </button>
                    {activeDraft && (
                      <button
                        type="button"
                        onClick={() => { setEmailSubject("Order Approval"); setEmailBody(`APPROVE ${activeDraft.orderId}`); }}
                        className="omnichannel-chip approve"
                      >
                        ✓ APPROVE {activeDraft.orderId}
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={emailLoading}
                    onClick={handleSimulateEmail}
                    className="omnichannel-btn-submit email"
                  >
                    {emailLoading ? "Processing Inbound Email…" : "⚡ Send Test Email to Agent"}
                  </button>
                </div>
              </div>

              {/* Email Result Output */}
              {emailResult && (
                <div className="omnichannel-result-box">
                  <div className="omnichannel-result-header">
                    <span className="omnichannel-result-title">Agent Email Reply:</span>
                    <span className="omnichannel-result-action">
                      {emailResult.actionType || "reply"}
                    </span>
                  </div>
                  <h6 className="omnichannel-result-subject">
                    Subject: {emailResult.responseSubject}
                  </h6>
                  {emailResult.responseHtml ? (
                    <div
                      className="omnichannel-result-html"
                      dangerouslySetInnerHTML={{ __html: emailResult.responseHtml }}
                    />
                  ) : (
                    <pre className="omnichannel-result-pre">
                      {emailResult.responseText}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {/* Channel 2: Cloudflare Slack Trading Agent */}
            <div className="omnichannel-card">
              <div className="omnichannel-card-header">
                <h4 className="omnichannel-card-title slack">
                  <span>🤖</span> Cloudflare Slack Trading Agent
                </h4>
                <span className="omnichannel-badge-subtle purple">
                  Events &amp; Block Kit
                </span>
              </div>

              <div className="omnichannel-meta-box">
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Event Request URL:</strong> <code className="slack-url">https://agent.openaimp.com/slack/events</code>
                </div>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Interactivity URL:</strong> <code className="slack-url">https://agent.openaimp.com/slack/interactions</code>
                </div>
                <div>
                  <strong>OAuth App Install:</strong> <a href="/slack/install" target="_blank" rel="noreferrer" className="slack-install-link">Install to Workspace</a>
                </div>
              </div>

              {/* Slack Simulator Form */}
              <div className="omnichannel-simulator-card">
                <h5 className="omnichannel-simulator-title">
                  🧪 Interactive Slack Bot Simulator
                </h5>
                <div className="omnichannel-form-group">
                  <div>
                    <label htmlFor="omni-slack-message" className="omnichannel-form-label">Slack Message / Mention:</label>
                    <TextInput id="omni-slack-message"
                      type="text"
                      value={slackPrompt}
                      onChange={(e) => setSlackPrompt(e.target.value)}
                    />
                  </div>

                  {/* Preset Quick Chips */}
                  <div className="omnichannel-chip-row">
                    <button
                      type="button"
                      onClick={() => handleSimulateSlack("@ETradeAgent quote NVDA")}
                      className="omnichannel-chip"
                    >
                      📈 Quote NVDA
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSimulateSlack("@ETradeAgent screen stocks priced between $20 and $200")}
                      className="omnichannel-chip"
                    >
                      🔍 Screen Price Range
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSimulateSlack("@ETradeAgent preview buy 10 NVDA limit 125.00")}
                      className="omnichannel-chip"
                    >
                      ⚡ Buy 10 NVDA Ticket
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSimulateSlack("@ETradeAgent show my portfolio positions")}
                      className="omnichannel-chip"
                    >
                      💼 Portfolio
                    </button>
                  </div>

                  <button
                    type="button"
                    disabled={slackLoading}
                    onClick={() => handleSimulateSlack()}
                    className="omnichannel-btn-submit slack"
                  >
                    {slackLoading ? "Simulating Slack Agent…" : "⚡ Simulate Slack Message"}
                  </button>
                </div>
              </div>

              {/* Slack Block Kit Card Viewer */}
              {slackResult?.response && (
                <div className="omnichannel-slack-viewer">
                  <div className="omnichannel-slack-user-header">
                    <span style={{ fontSize: "1.2rem" }}>🤖</span>
                    <div>
                      <strong className="slack-bot-name">ETradeAgent</strong>{" "}
                      <span className="slack-app-tag">APP</span>
                      <span className="slack-time">Just now</span>
                    </div>
                  </div>

                  <div className="omnichannel-slack-body">
                    {slackResult.response.blocks?.map((block: any, bIdx: number) => {
                      if (block.type === "header") {
                        return <h5 key={bIdx} className="slack-block-heading">{block.text?.text}</h5>;
                      }
                      if (block.type === "section" && block.fields) {
                        return (
                          <div key={bIdx} className="slack-block-fields">
                            {block.fields.map((f: any, fIdx: number) => (
                              <div key={fIdx} className="omnichannel-slack-field">
                                {f.text?.split("\n").map((line: string, lIdx: number) => (
                                  <div key={lIdx}>{line.replace(/\*/g, "")}</div>
                                ))}
                              </div>
                            ))}
                          </div>
                        );
                      }
                      if (block.type === "section" && block.text) {
                        return <p key={bIdx} className="slack-block-text">{block.text.text?.replace(/\*/g, "")}</p>;
                      }
                      if (block.type === "actions") {
                        return (
                          <div key={bIdx} className="slack-actions-row">
                            {block.elements?.map((btn: any, btnIdx: number) => (
                              <button
                                key={btnIdx}
                                type="button"
                                disabled={slackActionLoading}
                                onClick={() => handleSlackActionButton(btn.action_id, btn.value)}
                                style={{
                                  background: btn.style === "primary" ? "var(--color-success)" : "var(--color-danger)",
                                  color: "var(--color-text-inverse)",
                                  border: "none",
                                  borderRadius: "var(--radius-xs, 4px)",
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
                          <div key={bIdx} className="slack-context-row">
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
      {effectiveSubTab === "voice" && (
        <div className="tab-pane active voice-pane">
          {/* Header Card */}
          <div className="voice-header-card">
            <div className="voice-header-top">
              <div>
                <span className="voice-header-badge">
                  Cloudflare Agents Voice SDK
                </span>
                <h3 className="voice-header-title">
                  <span>🎙️</span> E*TRADE Voice Trading Desk
                </h3>
                <p className="voice-header-desc">
                  Real-time conversational voice trading powered by Cloudflare Workers AI STT &amp; TTS. Verbal quote inquiries, technical screening, and strict two-stage verbal Human-in-the-Loop order drafting.
                </p>
              </div>
              <div className="voice-header-status">
                <span className={`voice-status-pill ${voiceStatus}`}>
                  <span className={`voice-status-dot ${voiceStatus}`} />
                  {voiceStatus.toUpperCase()}
                </span>
              </div>
            </div>
          </div>

          <div className="voice-main-grid">
            {/* Visualizer & Mic Control Bar */}
            <div className="voice-control-card">
              <div className="voice-control-actions">
                <button
                  type="button"
                  onClick={handleToggleVoiceRecording}
                  className={`btn-voice-toggle ${speechRecognitionActive ? "listening" : "idle"}`}
                >
                  <span>{speechRecognitionActive ? "🛑 Stop Listening" : "🎙️ Push to Talk / Speak"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setVoiceIsMuted(!voiceIsMuted)}
                  className={`btn-voice-mute ${voiceIsMuted ? "muted" : "unmuted"}`}
                >
                  {voiceIsMuted ? "🔇 Voice Muted" : "🔊 Audio On"}
                </button>
              </div>

              {/* Animated Audio Visualizer Bars */}
              <div className="voice-visualizer-bars">
                {[12, 24, 38, 20, 32, 16, 28, 36, 18, 26, 34, 14].map((h, i) => (
                  <div
                    key={i}
                    className={`voice-vbar ${voiceStatus}`}
                    style={{
                      height: voiceStatus === "speaking" || voiceStatus === "listening" ? `${Math.max(8, (h * (voiceStatus === "listening" ? 1.2 : 0.9)))}px` : "6px",
                    }}
                  />
                ))}
              </div>

              {/* Interim Real-Time Transcript Display */}
              {voiceInterim && (
                <div className="voice-interim-box">
                  🎙️ <em>{voiceInterim}…</em>
                </div>
              )}

              {/* Quick Spoken Chips */}
              <div className="voice-chips-row">
                <button
                  type="button"
                  onClick={() => handleVoiceTurn("What is Nvidia trading at?")}
                  className="voice-chip"
                >
                  📈 "What is Nvidia trading at?"
                </button>
                <button
                  type="button"
                  onClick={() => handleVoiceTurn("Screen stocks priced between $20 and $200")}
                  className="voice-chip"
                >
                  🔍 "Screen price range"
                </button>
                <button
                  type="button"
                  onClick={() => handleVoiceTurn("What is my portfolio balance?")}
                  className="voice-chip"
                >
                  💼 "Check portfolio balance"
                </button>
                <button
                  type="button"
                  onClick={() => handleVoiceTurn("Buy 10 shares of NVDA at market")}
                  className="voice-chip buy-action"
                >
                  ⚡ "Buy 10 NVDA at market"
                </button>
                {activeDraft && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleVoiceTurn(`Confirm order ${activeDraft.orderId}`)}
                      className="voice-chip confirm-action"
                    >
                      ✓ "Confirm order {activeDraft.orderId}"
                    </button>
                    <button
                      type="button"
                      onClick={() => handleVoiceTurn(`Cancel order ${activeDraft.orderId}`)}
                      className="voice-chip cancel-action"
                    >
                      ✕ "Cancel order {activeDraft.orderId}"
                    </button>
                  </>
                )}
              </div>

              {/* Text Fallback Input Box */}
              <form
                onSubmit={(e) => { e.preventDefault(); handleVoiceTurn(); }}
                className="voice-input-form"
              >
                <input
                  type="text"
                  placeholder="Or type a spoken command: e.g. 'What is Apple trading at?' or 'Buy 10 NVDA at market'"
                  value={voiceInputText}
                  onChange={(e) => setVoiceInputText(e.target.value)}
                  className="voice-text-input"
                />
                <button
                  type="submit"
                  disabled={voiceLoading || !voiceInputText.trim()}
                  className="btn-voice-send"
                >
                  {voiceLoading ? "Processing…" : "Send Voice Turn"}
                </button>
              </form>
            </div>

            {/* Conversation Feed */}
            <div className="voice-feed-card">
              <h5 className="voice-feed-title">
                <span>💬</span> Live Voice Conversation History
              </h5>

              <div className="voice-feed-scroll">
                {voiceTranscript.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`voice-turn ${msg.role === "user" ? "user-turn" : "bot-turn"}`}
                  >
                    <div className="voice-turn-meta">
                      <span>{msg.role === "user" ? "👤 Trader (Voice)" : "🤖 E*TRADE Voice Desk"}</span>
                      <span>• {msg.timestamp}</span>
                    </div>

                    <div className={`voice-bubble ${msg.role === "user" ? "user-bubble" : "bot-bubble"}`}>
                      <div>{msg.text}</div>

                      {/* Embedded HITL Order Preview Card in Voice Feed */}
                      {msg.actionType === "preview" && msg.orderDraft && (
                        <div className="voice-order-preview-box">
                          <div className="voice-order-preview-title">
                            🛡️ Order Preview Staged (HITL Required)
                          </div>
                          <div className="voice-order-preview-details">
                            <div><strong>Order ID:</strong> <code>{msg.orderDraft.orderId}</code></div>
                            <div><strong>Action:</strong> {msg.orderDraft.action} {msg.orderDraft.quantity} {msg.orderDraft.quantity === 1 ? "share" : "shares"} of {msg.orderDraft.symbol} {msg.orderDraft.orderType === "LIMIT" ? `(LIMIT @ $${(msg.orderDraft.limitPrice || msg.orderDraft.estimatedPrice)?.toFixed(2)})` : "(MARKET)"}</div>
                            <div><strong>Estimated Total:</strong> ${msg.orderDraft.estimatedTotal?.toFixed(2)} USD</div>
                          </div>
                          <div className="voice-order-preview-actions">
                            <button
                              type="button"
                              onClick={() => handleVoiceOrderAction("approve", msg.orderDraft.orderId)}
                              className="btn-voice-order approve"
                            >
                              ✓ Voice Approve &amp; Execute
                            </button>
                            <button
                              type="button"
                              onClick={() => handleVoiceOrderAction("cancel", msg.orderDraft.orderId)}
                              className="btn-voice-order cancel"
                            >
                              ✕ Cancel Draft
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Embedded Execution Receipt */}
                      {msg.actionType === "approval" && msg.brokerOrderRef && (
                        <div className="voice-receipt-box">
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
                    <span className="val">{inspectQuote.week52High !== undefined ? `$${inspectQuote.week52High.toFixed(2)}` : "—"}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">52-Week Low</span>
                    <span className="val">{inspectQuote.week52Low !== undefined ? `$${inspectQuote.week52Low.toFixed(2)}` : "—"}</span>
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
      {showDiagnosticsModal && typeof document !== "undefined" && createPortal(
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
                  <div className="diag-header-row">
                    <span className={`status-pill status-${diagnostics.status || "unknown"}`}>
                      {diagnostics.status === "healthy" ? "🟢 Live REST Upstream Connected & Verified" : (diagnostics.status === "auth_required" ? "🟡 OAuth 1.0a Session Required" : "🔴 Upstream Gateway Error")}
                    </span>
                    <span className="diag-gateway-text">
                      Gateway: <code>{diagnostics.apiUrl}</code>
                    </span>
                  </div>

                  {diagnostics.lastError && (
                    <div className="diag-error-box">
                      <strong className="diag-error-title">Upstream Message / Error:</strong>
                      <div className="diag-error-msg">
                        {diagnostics.lastError}
                      </div>
                      {diagnostics.lastError.includes("only in SANDBOX environment") && (
                        <div className="diag-sandbox-switch">
                          <span className="diag-sandbox-hint">
                            💡 This Consumer Key belongs to E*TRADE Sandbox (apisb.etrade.com). Switch to TEST to test with this key!
                          </span>
                          <button
                            type="button"
                            className="btn-env-toggle active-env"
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

                  <div className="diag-grid">
                    <div className="diag-card">
                      <div className="diag-label">Consumer Key</div>
                      <div className="diag-val">
                        {diagnostics.credentials?.apiKeyMasked || (diagnostics.credentials?.apiKeyConfigured ? "✓ Configured" : "MISSING")}
                      </div>
                    </div>
                    <div className="diag-card">
                      <div className="diag-label">Consumer Secret</div>
                      <div className="diag-val">
                        {diagnostics.credentials?.apiSecretConfigured ? "✓ Configured in Cloudflare" : "MISSING"}
                      </div>
                    </div>
                    <div className="diag-card">
                      <div className="diag-label">Session Token in KV</div>
                      <div className={`diag-val ${diagnostics.oauthToken?.present ? "token-active" : "token-inactive"}`}>
                        {diagnostics.oauthToken?.present ? "✓ Present & Active" : "No Active Token"}
                      </div>
                    </div>
                    <div className="diag-card">
                      <div className="diag-label">Upstream Accounts</div>
                      <div className="diag-val">
                        {diagnostics.upstreamAccounts?.count ?? 0} account(s) detected
                      </div>
                    </div>
                  </div>

                  {diagnostics.upstreamAccounts?.accounts && diagnostics.upstreamAccounts.accounts.length > 0 && (
                    <div className="diag-account-details">
                      <strong className="diag-account-title">
                        Live Account Details:
                      </strong>
                      {diagnostics.upstreamAccounts.accounts.map((acct: any, idx: number) => (
                        <div key={idx} className="diag-account-row">
                          • ID: <code>{acct.accountId}</code> | Key: <code>{acct.accountKey}</code> | Type: <strong>{acct.accountType || acct.accountDesc}</strong>
                        </div>
                      ))}
                      {diagnostics.upstreamBalance && (
                        <div className="diag-balance-row">
                          • Live Balance Fetched: Net Value: <strong>${Number(diagnostics.upstreamBalance.netAccountValue || diagnostics.upstreamBalance.computed?.realTimeValues?.totalAccountValue || 0).toFixed(2)}</strong> | Cash: <strong>${Number(diagnostics.upstreamBalance.cashAvailableForInvestment || diagnostics.upstreamBalance.computed?.cashAvailableForInvestment || 0).toFixed(2)}</strong>
                        </div>
                      )}
                    </div>
                  )}

                  <details className="diag-raw-box">
                    <summary className="diag-raw-summary">
                      🔍 View Raw Upstream Diagnostic Payload (JSON)
                    </summary>
                    <pre className="diag-raw-pre">
                      {JSON.stringify(diagnostics, null, 2)}
                    </pre>
                  </details>

                  <details className="diagnostics-drawer">
                    <summary className="diagnostics-summary">
                      ⚙️ Technical Diagnostics &amp; Audit Metadata (Agent DID &amp; Microservice Provenance)
                    </summary>
                    <div className="diagnostics-content">
                      <div><strong>Trading Agent DID:</strong> <code>{tradingAgentDid}</code></div>
                      <div><strong>Microservice Architecture:</strong> Model Context Protocol (MCP) &amp; OAuth 1.0a REST Client</div>
                      <div><strong>Attestation Mechanism:</strong> Internal W3C DID cryptographic stamping for microservice audit logs (not a third-party brokerage guarantee)</div>
                      <div><strong>Edge Database:</strong> Cloudflare Durable Objects + SQLite (tables: <code>mas_trades</code>, <code>mas_events</code>)</div>
                    </div>
                  </details>

                  <div className="diag-modal-actions">
                    {(!diagnostics.oauthToken?.present || diagnostics.status === "auth_required") && (
                      <button
                        type="button"
                        className="btn-oauth-connect"
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
                    >
                      {diagnosticsLoading ? "⏳ Testing..." : "🔄 Re-run Diagnostics"}
                    </button>
                    <button
                      type="button"
                      className="btn-cancel-modal"
                      onClick={() => setShowDiagnosticsModal(false)}
                    >
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                  Running diagnostics against E*TRADE upstream API...
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Dynamic ETAPI Engine Tuning & Configuration Modal */}
      <EtapiConfigModal
        isOpen={configModalOpen}
        onClose={() => setConfigModalOpen(false)}
        activeEnv={activeEnv}
        userLogin={user?.login}
      />

      {/* Institutional Risk Analysis & Defense Playbook Modal */}
      <RiskAnalysisModal
        isOpen={Boolean(riskSubject)}
        onClose={() => setRiskSubject(null)}
        subject={riskSubject}
        onSendPrompt={onSendPrompt}
      />
    </div>
  );
}
