import React, { useState, useEffect, useRef } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { McpApiExplorer } from "./McpApiExplorer";
import { GoogleAdUnit } from "./GoogleAdUnit";
import { ETradeTradingHub } from "./ETradeTradingHub";
import { FossResearchHub } from "./FossResearchHub";
import { AsyncJobsPanel } from "./AsyncJobsPanel";
import adDisplayConfig from "./ad-display.config.json";

interface User {
  login: string;
  name: string;
  avatar: string;
}

interface AuditLogEvent {
  id: string;
  type: string;
  agent: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface MemoryItem {
  key: string;
  value: string;
  updatedAt: string;
}

interface ReferralItem {
  id: string;
  userLogin: string;
  title: string;
  url: string;
  category: string;
  rewardText: string;
  clicks: number;
  signups: number;
  createdAt: string;
}

interface AdItem {
  id: string;
  title: string;
  tagline: string;
  sponsor: string;
  badge: string;
  url: string;
  ctaText: string;
  accentColor: string;
  impressions: number;
  clicks: number;
  createdAt: string;
}

interface TransactionItem {
  id: string;
  sessionId: string;
  action: "charge" | "refund" | "invoice" | "payout";
  amount: number;
  currency: string;
  customer: string;
  gateway: "stripe" | "paypal" | "lemonsqueezy" | "sandbox";
  gatewayRef?: string;
  status: "draft" | "awaiting_confirmation" | "authorized" | "completed" | "failed" | "rejected";
  checkoutUrl?: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface GatewayInfo {
  id: "stripe" | "paypal" | "lemonsqueezy" | "sandbox";
  name: string;
  configured: boolean;
  mode: "live" | "sandbox" | "simulated";
  capabilities: string[];
}

interface CategoryItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface ExternalAdItem {
  id: string;
  name: string;
  network: "direct" | "ethicalads" | "carbon" | "adsense" | "google";
  placement: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  title: string;
  tagline: string;
  ctaText: string;
  targetUrl: string;
  bannerImageUrl?: string;
  cpmRate: number;
  cpcRate: number;
  impressions: number;
  clicks: number;
  earnings: number;
  isActive: boolean;
  createdAt: string;
}

interface RevenueSummaryData {
  grossRevenue: number;
  adNetworkRevenue: number;
  marketplaceRevenue: number;
  paymentPlatformFees: number;
  referralPayouts: number;
  netRevenue: number;
  totalImpressions: number;
  totalAdClicks: number;
  averageRPM: number;
}

interface TableMetadataItem {
  name: string;
  description: string;
  rowCount: number;
  columns: Array<{ name: string; type: string; isPrimary: boolean }>;
}

function extractText(message: any): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("") || "";
  }
  return "";
}

/**
 * Lightweight markdown formatter for bold, code blocks, inline code, and lists.
 */
function MarkdownContent({ text }: { text: string }) {
  if (!text) return null;

  // Split text by markdown code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);

  return (
    <div className="markdown-body">
      {parts.map((part, idx) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const lines = part.slice(3, -3).trim().split("\n");
          const firstLine = lines[0].trim();
          const hasLang = /^[a-zA-Z0-9_-]+$/.test(firstLine);
          const lang = hasLang ? firstLine : "";
          const code = (hasLang ? lines.slice(1) : lines).join("\n");

          return (
            <div key={idx} className="code-block-container">
              {lang && <div className="code-lang-tag">{lang}</div>}
              <pre className="code-block">
                <code>{code}</code>
              </pre>
            </div>
          );
        }

        // Inline formatting for non-code block segments
        const paragraphs = part.split(/\n\n+/);
        return (
          <React.Fragment key={idx}>
            {paragraphs.map((p, pIdx) => {
              const lines = p.split("\n");
              return (
                <p key={pIdx} className="message-p">
                  {lines.map((line, lIdx) => {
                    const isListItem = line.trim().startsWith("- ") || line.trim().startsWith("* ");
                    const content = isListItem ? line.trim().slice(2) : line;

                    return (
                      <span key={lIdx} className={isListItem ? "list-item" : "inline-line"}>
                        {isListItem && <span className="bullet">• </span>}
                        {renderInlineFormatted(content)}
                        {lIdx < lines.length - 1 && !isListItem && <br />}
                      </span>
                    );
                  })}
                </p>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function renderInlineFormatted(text: string) {
  // Split on bold (**text**) and inline code (`code`)
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, i) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      return <code key={i} className="inline-code">{token.slice(1, -1)}</code>;
    }
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      return <strong key={i} className="bold-text">{token.slice(2, -2)}</strong>;
    }
    return token;
  });
}

function ReasoningView({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  if (!reasoning || !reasoning.trim()) return null;

  return (
    <div className="reasoning-trace">
      <div className="reasoning-header" onClick={() => setOpen(!open)}>
        <span className="reasoning-icon">💭</span>
        <span className="reasoning-title">Thought Process</span>
        <span className="reasoning-preview">
          {open ? "" : `— ${reasoning.slice(0, 70).replace(/\n/g, " ")}...`}
        </span>
        <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="reasoning-body">
          <div className="reasoning-text">{reasoning}</div>
        </div>
      )}
    </div>
  );
}

function ToolResultView({
  toolType,
  data,
  onAction,
  isBusy,
}: {
  toolType: string;
  data: any;
  onAction?: (prompt: string) => void;
  isBusy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const normalizedType = (toolType || "").toLowerCase();

  // 1. Human-In-The-Loop Confirmation Execution
  if (normalizedType.includes("confirm") || data?.auditNotice || (data?.draftId && (data?.status === "authorized" || data?.status === "scheduled" || data?.status === "rejected"))) {
    const isApproved = data?.decision === "approved" || data?.status === "authorized" || data?.status === "scheduled";
    const draftId = data?.draftId || "draft";
    return (
      <div className="tool-card confirm-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">{isApproved ? "🛡️" : "🚫"}</span>
          <div className="tool-summary">
            <strong>Human Authorization:</strong> <code>{draftId}</code> ({isApproved ? "APPROVED" : "REJECTED"})
          </div>
          <span className={`tool-status-pill ${isApproved ? "success" : "priority-urgent"}`}>
            {isApproved ? "EXECUTED" : "CANCELLED"}
          </span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        <div className="confirm-details">
          {data?.auditNotice || data?.note || "Draft confirmed by human reviewer."}
        </div>
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // 2. Knowledge Base Search
  if (normalizedType.includes("search") || data?.source?.includes("Search")) {
    const query = data?.query || data?.input?.query || "knowledge base";
    const resultsFound = data?.resultsFound !== false && (data?.count > 0 || (Array.isArray(data?.chunks) && data.chunks.length > 0));
    const count = data?.count ?? (Array.isArray(data?.chunks) ? data.chunks.length : 0);

    return (
      <div className="tool-card search-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">🔍</span>
          <div className="tool-summary">
            <strong>Knowledge Search:</strong> <em>"{query}"</em>
          </div>
          <span className={`tool-status-pill ${resultsFound ? "success" : "warning"}`}>
            {resultsFound ? `RAG (${count} docs)` : "0 Docs (Fallback)"}
          </span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {!resultsFound && (
          <div className="task-deadline">
            💡 No custom index documents matched. Orchestrator synthesized answer using domain knowledge.
          </div>
        )}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data.chunks || data.results || data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // FOSS Market Data & Research Tool (Yahoo Finance & Alpaca)
  if (
    normalizedType.includes("foss") ||
    data?.provider === "Yahoo Finance" ||
    data?.provider === "Alpaca Market Data v2" ||
    data?.provider === "Hybrid (Alpaca + Yahoo Finance)" ||
    data?.analystConsensus ||
    data?.valuationMultiples ||
    data?.executiveSummary ||
    (data?.symbol && (data?.trailingPE !== undefined || data?.nbboSpread !== undefined))
  ) {
    const symbol = data?.symbol || data?.input?.symbol || "TICKER";
    const provider = data?.provider || (data?.analystConsensus ? "Yahoo Finance" : "FOSS Hybrid");
    const isReport = Boolean(data?.analystConsensus || data?.executiveSummary || data?.keyInsights);
    const isSnapshot = Boolean(data?.latestTrade && data?.latestQuote);
    const price = data?.currentPrice || data?.price || data?.lastPrice || data?.latestTrade?.price || 0;
    const change = data?.change || data?.change24h || 0;
    const changePercent = data?.changePercent || data?.changePercent24h || 0;
    const recommendation = data?.analystConsensus?.recommendation || data?.recommendation || "BUY";
    const targetPrice = data?.analystConsensus?.targetPrice || data?.targetPrice;

    return (
      <div className="tool-card foss-card research-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">{isReport ? "🔬" : "📈"}</span>
          <div className="tool-summary">
            <strong>{isReport ? "FOSS Equity Research:" : "FOSS Quote:"}</strong> {symbol} — ${Number(price).toFixed(2)}{" "}
            <span className={change >= 0 ? "change-up" : "change-down"}>
              ({change >= 0 ? "+" : ""}{Number(change).toFixed(2)} / {changePercent >= 0 ? "+" : ""}{Number(changePercent).toFixed(2)}%)
            </span>
          </div>
          <span className="tool-status-pill foss-badge">{provider}</span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>

        {isReport && (
          <div className="foss-report-preview">
            <div className="foss-metrics-row">
              <span className="metric-tag">
                🎯 <strong>Consensus:</strong> {recommendation.replace("_", " ")}
              </span>
              {targetPrice && (
                <span className="metric-tag">
                  🎯 <strong>Target:</strong> ${Number(targetPrice).toFixed(2)}
                </span>
              )}
              {data?.valuationMultiples?.trailingPE && (
                <span className="metric-tag">
                  📊 <strong>P/E:</strong> {Number(data.valuationMultiples.trailingPE).toFixed(1)}x
                </span>
              )}
              {data?.valuationMultiples?.pegRatio && (
                <span className="metric-tag">
                  ⚡ <strong>PEG:</strong> {Number(data.valuationMultiples.pegRatio).toFixed(2)}
                </span>
              )}
            </div>
            {data?.executiveSummary && (
              <div className="foss-summary-text">{data.executiveSummary}</div>
            )}
            {data?.agentAttestation && (
              <div className="foss-attestation-tag">
                🔏 Signed by: <code>{data.agentAttestation.agentDid}</code> (Alg: {data.agentAttestation.algorithm})
              </div>
            )}
          </div>
        )}

        {isSnapshot && (
          <div className="foss-snapshot-preview">
            <div className="foss-metrics-row">
              <span className="metric-tag">
                🟢 <strong>Bid:</strong> ${Number(data.latestQuote?.bidPrice || 0).toFixed(2)} ({data.latestQuote?.bidSize || 0})
              </span>
              <span className="metric-tag">
                🔴 <strong>Ask:</strong> ${Number(data.latestQuote?.askPrice || 0).toFixed(2)} ({data.latestQuote?.askSize || 0})
              </span>
              <span className="metric-tag">
                📏 <strong>Spread:</strong> ${Number(data.nbboSpread || 0).toFixed(3)}
              </span>
            </div>
          </div>
        )}

        <div className="hitl-actions">
          <button
            type="button"
            className="hitl-btn approve"
            disabled={isBusy}
            onClick={() => onAction?.(`Preview buy 10 shares of ${symbol} on ETrade`)}
          >
            ⚡ Preview Buy 10 {symbol} (E*TRADE)
          </button>
          {!isReport && (
            <button
              type="button"
              className="hitl-btn secondary"
              disabled={isBusy}
              onClick={() => onAction?.(`Run full FOSS market research on ${symbol}`)}
            >
              🔬 Full FOSS Research
            </button>
          )}
          <button
            type="button"
            className="hitl-btn secondary"
            disabled={isBusy}
            onClick={() => onAction?.(`Compare valuation of ${symbol} against peers`)}
          >
            📊 Compare Valuation
          </button>
        </div>

        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // 3. E*TRADE Trading Tool (Preview, Execution, Quote)
  if (
    normalizedType.includes("trade") ||
    normalizedType.includes("etrade") ||
    data?.orderId?.startsWith("ord_") ||
    data?.draftId?.startsWith("ord_") ||
    (data?.action && (data.action === "BUY" || data.action === "SELL" || data.action === "BUY_TO_COVER" || data.action === "SELL_SHORT")) ||
    data?.resultsFoundStocks
  ) {
    const isExecution = normalizedType.includes("execute") || data?.executionId || data?.brokerOrderRef;
    const isQuote = normalizedType.includes("quote") || (data?.symbol && data?.lastPrice && !data?.orderId && !data?.action);
    const orderId = data?.orderId || data?.draftId;
    const symbol = data?.symbol || data?.input?.symbol;
    const action = data?.action || data?.input?.action || "BUY";
    const quantity = data?.quantity || data?.input?.quantity || 1;
    const status = data?.status || "previewed";
    const price = data?.limitPrice || data?.estimatedPrice || data?.executionPrice || data?.lastPrice;

    if (isExecution) {
      return (
        <div className="tool-card confirm-card trading-card">
          <div className="tool-card-header" onClick={() => setOpen(!open)}>
            <span className="tool-icon">📈</span>
            <div className="tool-summary">
              <strong>E*TRADE Execution:</strong> {data.success !== false ? "FILLED" : "CANCELLED"} {quantity} {symbol} ({action})
            </div>
            <span className={`tool-status-pill ${data.success !== false ? "success" : "priority-urgent"}`}>
              {data.status ? String(data.status).toUpperCase() : "EXECUTED"}
            </span>
            <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
          </div>
          <div className="confirm-details">
            {data.message || `Order ${orderId} executed on E*TRADE broker. Ref: ${data.brokerOrderRef || "simulated"}`}
          </div>
          {open && (
            <div className="tool-card-body">
              <pre>{JSON.stringify(data, null, 2)}</pre>
            </div>
          )}
        </div>
      );
    }

    if (isQuote) {
      return (
        <div className="tool-card quote-card trading-card">
          <div className="tool-card-header" onClick={() => setOpen(!open)}>
            <span className="tool-icon">📊</span>
            <div className="tool-summary">
              <strong>E*TRADE Quote:</strong> {symbol} — ${(price || 0).toFixed(2)} ({data.change >= 0 ? "+" : ""}{data.change?.toFixed(2) || 0})
            </div>
            <span className="tool-status-pill info">Level 1 Live</span>
            <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
          </div>
          <div className="hitl-actions">
            <button
              type="button"
              className="hitl-btn approve"
              disabled={isBusy}
              onClick={() => onAction?.(`Preview buy 10 shares of ${symbol}`)}
            >
              ⚡ Preview Buy 10 {symbol}
            </button>
          </div>
          {open && (
            <div className="tool-card-body">
              <pre>{JSON.stringify(data, null, 2)}</pre>
            </div>
          )}
        </div>
      );
    }

    // Default: Order Draft / Preview
    return (
      <div className="tool-card trading-card order-preview-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">📈</span>
          <div className="tool-summary">
            <strong>E*TRADE Trade Intent:</strong> {action} {quantity} {symbol} {price ? `@ $${Number(price).toFixed(2)}` : ""}
          </div>
          <span className={`tool-status-pill ${status === "executed" ? "success" : "warning"}`}>
            {status === "executed" ? "EXECUTED" : "Awaiting Approval"}
          </span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        <div className="payment-notice">
          🛡️ <strong>Safety Guarantee:</strong> No trade will be executed without explicit authorization. E*TRADE Order ID <code>{orderId || "ord_preview"}</code> reserved.
        </div>
        {orderId && status !== "executed" && status !== "rejected" && (
          <div className="hitl-actions">
            <button
              type="button"
              className="hitl-btn approve"
              disabled={isBusy}
              onClick={() => onAction?.(`Approve trade draft ${orderId}`)}
            >
              ✅ Approve &amp; Execute Order
            </button>
            <button
              type="button"
              className="hitl-btn reject"
              disabled={isBusy}
              onClick={() => onAction?.(`Cancel trade draft ${orderId}`)}
            >
              ❌ Cancel Order
            </button>
          </div>
        )}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // 4. Payment Draft Tool
  if (normalizedType.includes("payment") || data?.status === "awaiting_confirmation" || data?.action) {
    const amount = data?.amount || data?.input?.amount;
    const currency = data?.currency || data?.input?.currency || "USD";
    const customer = data?.customer || data?.input?.customer;
    const action = data?.action || data?.input?.action || "transaction";
    const draftId = data?.draftId;

    return (
      <div className="tool-card payment-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">💳</span>
          <div className="tool-summary">
            <strong>Payment Intent ({String(action).toUpperCase()}):</strong> {amount ? `$${amount} ${currency}` : ""} for {customer || "customer"}
          </div>
          <span className="tool-status-pill warning">Awaiting Approval</span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        <div className="payment-notice">
          🛡️ <strong>Safety Guarantee:</strong> No money has been moved. An explicit human authorization is required before execution.
        </div>
        {draftId && data?.status === "awaiting_confirmation" && (
          <div className="hitl-actions">
            <button
              type="button"
              className="hitl-btn approve"
              disabled={isBusy}
              onClick={() => onAction?.(`Approve payment draft ${draftId}`)}
            >
              ✅ Approve Draft
            </button>
            <button
              type="button"
              className="hitl-btn reject"
              disabled={isBusy}
              onClick={() => onAction?.(`Cancel payment draft ${draftId}`)}
            >
              ❌ Cancel
            </button>
          </div>
        )}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // 4. Task Draft Tool
  if (normalizedType.includes("task") || data?.taskId || data?.status === "draft") {
    const title = data?.title || data?.input?.title;
    const priority = data?.priority || data?.input?.priority || "medium";
    const dueDate = data?.dueDate || data?.input?.dueDate;
    const taskId = data?.taskId;

    return (
      <div className="tool-card task-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">📋</span>
          <div className="tool-summary">
            <strong>Task Proposal:</strong> {title}
          </div>
          <span className={`tool-status-pill priority-${priority}`}>{String(priority).toUpperCase()}</span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {dueDate && <div className="task-deadline">📅 Target: {dueDate}</div>}
        {taskId && data?.status === "draft" && (
          <div className="hitl-actions">
            <button
              type="button"
              className="hitl-btn approve"
              disabled={isBusy}
              onClick={() => onAction?.(`Confirm task ${taskId}`)}
            >
              ✅ Confirm Task
            </button>
          </div>
        )}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // 5. Memory Fact Tool
  if (normalizedType.includes("remember") || normalizedType.includes("recall") || data?.key || data?.facts) {
    const isRecall = normalizedType.includes("recall") || Array.isArray(data?.facts);
    return (
      <div className="tool-card memory-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">🧠</span>
          <div className="tool-summary">
            {isRecall ? (
              <span><strong>Session Memory:</strong> Recalled {data?.count ?? data?.facts?.length ?? 0} facts</span>
            ) : (
              <span><strong>Session Memory:</strong> <code>{data.key}</code> = "{data.value}"</span>
            )}
          </div>
          <span className="tool-status-pill info">SQLite Stored</span>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // 6. Generic Fallback Tool (only for unrecognized custom tools)
  return (
    <details className="tool-call generic-tool">
      <summary>🔧 Tool Call: {toolType}</summary>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

export function Chat({ user }: { user: User }) {
  const [tab, setTab] = useState<"chat" | "nlq" | "audit" | "payments" | "referrals" | "ads" | "revenue" | "endpoints" | "trading" | "research">("trading");
  const [tbdMenuOpen, setTbdMenuOpen] = useState(false);
  const isTbdTab = tab === "chat" || tab === "nlq" || tab === "audit" || tab === "payments" || tab === "referrals" || tab === "ads" || tab === "revenue";
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // External Ads & Monetization state
  const [externalAds, setExternalAds] = useState<ExternalAdItem[]>([]);
  const [externalAdsLoading, setExternalAdsLoading] = useState(false);
  const [activeExtAdIndex, setActiveExtAdIndex] = useState(0);
  const [newExtTitle, setNewExtTitle] = useState("");
  const [newExtNetwork, setNewExtNetwork] = useState<"direct" | "ethicalads" | "carbon" | "adsense" | "google">("google");
  const [newExtPlacement, setNewExtPlacement] = useState<"header_leaderboard" | "in_stream" | "footer_deck" | "sidebar">("header_leaderboard");
  const [newExtTagline, setNewExtTagline] = useState("");
  const [newExtUrl, setNewExtUrl] = useState("");
  const [newExtCta, setNewExtCta] = useState("Learn More →");
  const [newExtCpm, setNewExtCpm] = useState("24.50");
  const [newExtCpc, setNewExtCpc] = useState("2.10");
  const [savingExtAd, setSavingExtAd] = useState(false);
  const [extAdSuccessMsg, setExtAdSuccessMsg] = useState("");
  const [extAdErrorMsg, setExtAdErrorMsg] = useState("");

  // Google Ads & AdSense state
  const [googleAdsEnabled, setGoogleAdsEnabled] = useState(true);
  const [googlePublisherId, setGooglePublisherId] = useState("ca-pub-9842109842109842");
  const [googleSlotId, setGoogleSlotId] = useState("7812903456");
  const [googleAdFormat, setGoogleAdFormat] = useState<"responsive" | "leaderboard" | "rectangle">("responsive");

  // Social sharing state
  const [discordCopied, setDiscordCopied] = useState(false);
  const [activeShareRefId, setActiveShareRefId] = useState<string | null>(null);
  const [copiedShareRefId, setCopiedShareRefId] = useState<string | null>(null);

  // Categories ORM state
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatIcon, setNewCatIcon] = useState("🏷️");
  const [newCatDesc, setNewCatDesc] = useState("");
  const [newCatOrder, setNewCatOrder] = useState("10");
  const [savingCat, setSavingCat] = useState(false);
  const [catSuccessMsg, setCatSuccessMsg] = useState("");
  const [catErrorMsg, setCatErrorMsg] = useState("");

  // Revenue Analytics state
  const [revenueSummary, setRevenueSummary] = useState<RevenueSummaryData | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(false);

  // Schema & Tables Explorer state
  const [tables, setTables] = useState<TableMetadataItem[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [selectedBrowseTable, setSelectedBrowseTable] = useState("mas_categories");
  const [browseSearch, setBrowseSearch] = useState("");
  const [browsedData, setBrowsedData] = useState<{ tableName: string; total: number; rows: any[] } | null>(null);
  const [browsingLoading, setBrowsingLoading] = useState(false);

  // Agent connection
  const agent = useAgent({ agent: "SearchAgent", name: user.login });
  const { messages, sendMessage, status, clearHistory } = useAgentChat({ agent });

  const isBusy = status === "streaming" || status === "submitted";
  const statusLabel = isBusy ? "Thinking…" : status === "error" ? "Error" : "Ready";
  const statusDotClass = isBusy ? "streaming" : status === "error" ? "error" : "ready";

  // NLQ state
  const [nlqInput, setNlqInput] = useState("");
  const [nlqResult] = useState<any>(null);

  // Audit state
  const [auditEvents, setAuditEvents] = useState<AuditLogEvent[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Payments & DID Management state
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [gateways, setGateways] = useState<GatewayInfo[]>([]);
  const [paymentSummary, setPaymentSummary] = useState({
    totalVolume: 0,
    completedCount: 0,
    pendingCount: 0,
    verifiedDidCount: 0,
  });
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [selectedProofTx, setSelectedProofTx] = useState<TransactionItem | null>(null);

  // New Payment Form state
  const [newPayAmount, setNewPayAmount] = useState("25.00");
  const [newPayCurrency, setNewPayCurrency] = useState("USD");
  const [newPayCustomer, setNewPayCustomer] = useState(user.name || "Client");
  const [newPayGateway, setNewPayGateway] = useState<"stripe" | "paypal" | "lemonsqueezy">("stripe");
  const [newPayDesc, setNewPayDesc] = useState("500,000 AI Inference Token Credits");
  const [creatingPayment, setCreatingPayment] = useState(false);
  const [paySuccessMsg, setPaySuccessMsg] = useState("");
  const [payErrorMsg, setPayErrorMsg] = useState("");

  // Referrals state
  const [referrals, setReferrals] = useState<ReferralItem[]>([]);
  const [referralsLoading, setReferralsLoading] = useState(false);
  const [copiedReferral, setCopiedReferral] = useState(false);
  const [newRefTitle, setNewRefTitle] = useState("");
  const [newRefUrl, setNewRefUrl] = useState("");
  const [newRefCategory, setNewRefCategory] = useState("AI & Dev Tools");
  const [newRefReward, setNewRefReward] = useState("");
  const [savingRef, setSavingRef] = useState(false);
  const [refFormSuccess, setRefFormSuccess] = useState("");
  const [refFormError, setRefFormError] = useState("");

  // Sponsored Ads state
  const [ads, setAds] = useState<AdItem[]>([]);
  const [adsLoading, setAdsLoading] = useState(false);
  const [newAdTitle, setNewAdTitle] = useState("");
  const [newAdTagline, setNewAdTagline] = useState("");
  const [newAdSponsor, setNewAdSponsor] = useState("");
  const [newAdBadge, setNewAdBadge] = useState("PROMOTED");
  const [newAdUrl, setNewAdUrl] = useState("");
  const [newAdCta, setNewAdCta] = useState("Claim Deal →");
  const [newAdColor, setNewAdColor] = useState("#6366f1");
  const [savingAd, setSavingAd] = useState(false);
  const [adFormSuccess, setAdFormSuccess] = useState("");
  const [adFormError, setAdFormError] = useState("");

  const personalReferralUrl = typeof window !== "undefined"
    ? `${window.location.origin}/?ref=${encodeURIComponent(user.login)}`
    : `https://agent.openaimp.com/?ref=${encodeURIComponent(user.login)}`;

  const handleCopyPersonalRef = () => {
    navigator.clipboard.writeText(personalReferralUrl);
    setCopiedReferral(true);
    setTimeout(() => setCopiedReferral(false), 2500);
  };

  const handleCopyDiscordEmbed = () => {
    const text = `**Join Multi-Agent Studio:** [Autonomous AI Agents with Workers AI & SQLite](${personalReferralUrl})`;
    navigator.clipboard.writeText(text);
    setDiscordCopied(true);
    setTimeout(() => setDiscordCopied(false), 2500);
  };

  const handleCopyRefDiscordEmbed = (refUrl: string, refTitle: string, refId: string) => {
    const text = `**${refTitle}**: [${refUrl}](${refUrl})`;
    navigator.clipboard.writeText(text);
    setCopiedShareRefId(refId);
    setTimeout(() => setCopiedShareRefId(null), 2500);
  };

  // Auto-scroll on new messages
  useEffect(() => {
    if (tab === "chat") {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, status, tab]);

  // Initial load of partner ads, categories, external ads, and revenue
  useEffect(() => {
    fetchAds();
    fetchCategories();
    fetchExternalAds();
    fetchRevenueSummary();
  }, []);

  // Record impression whenever active external ad changes
  useEffect(() => {
    if (externalAds.length > 0 && externalAds[activeExtAdIndex]) {
      recordExternalAdImpression(externalAds[activeExtAdIndex]);
    }
  }, [activeExtAdIndex, externalAds.length]);

  // Load tab-specific data when tab changes
  useEffect(() => {
    if (tab === "audit") {
      fetchAuditData();
    } else if (tab === "payments") {
      fetchPaymentsData();
    } else if (tab === "referrals") {
      fetchReferrals();
      fetchCategories();
    } else if (tab === "ads") {
      fetchAds();
    } else if (tab === "revenue") {
      fetchRevenueSummary();
      fetchExternalAds();
      fetchCategories();
      fetchTables();
    } else if (tab === "nlq") {
      fetchTables();
    }
  }, [tab]);

  const fetchAuditData = async () => {
    setAuditLoading(true);
    try {
      const [auditResp, memResp] = await Promise.all([
        fetch("/api/audit?limit=30").then((r) => r.json() as Promise<{ events?: AuditLogEvent[] }>).catch(() => ({ events: [] })),
        fetch("/api/memory").then((r) => r.json() as Promise<{ memories?: MemoryItem[] }>).catch(() => ({ memories: [] })),
      ]);
      setAuditEvents(auditResp.events || []);
      setMemories(memResp.memories || []);
    } finally {
      setAuditLoading(false);
    }
  };

  const fetchPaymentsData = async () => {
    setPaymentsLoading(true);
    try {
      const [txResp, gwResp] = await Promise.all([
        fetch("/api/payments/transactions").then((r) => r.json() as Promise<{ transactions?: TransactionItem[]; summary?: any }>).catch(() => ({ transactions: [], summary: {} })),
        fetch("/api/payments/gateways").then((r) => r.json() as Promise<{ gateways?: GatewayInfo[] }>).catch(() => ({ gateways: [] })),
      ]);
      setTransactions(txResp.transactions || []);
      if (txResp.summary) {
        setPaymentSummary({
          totalVolume: Number(txResp.summary.totalVolume || 0),
          completedCount: Number(txResp.summary.completedCount || 0),
          pendingCount: Number(txResp.summary.pendingCount || 0),
          verifiedDidCount: Number(txResp.summary.verifiedDidCount || 0),
        });
      }
      setGateways(gwResp.gateways || []);
    } finally {
      setPaymentsLoading(false);
    }
  };

  const handleCreatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setPayErrorMsg("");
    setPaySuccessMsg("");
    const amt = parseFloat(newPayAmount);
    if (isNaN(amt) || amt <= 0) {
      setPayErrorMsg("Please enter a valid payment amount");
      return;
    }
    setCreatingPayment(true);
    try {
      const res = await fetch("/api/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          currency: newPayCurrency,
          customer: newPayCustomer.trim(),
          gateway: newPayGateway,
          description: newPayDesc.trim(),
        }),
      });
      const data = await res.json() as { transaction?: TransactionItem; error?: string };
      if (data.transaction) {
        setTransactions((prev) => [data.transaction!, ...prev]);
        setPaymentSummary((prev) => ({
          ...prev,
          totalVolume: prev.totalVolume + amt,
          completedCount: prev.completedCount + 1,
          verifiedDidCount: prev.verifiedDidCount + 1,
        }));
        setPaySuccessMsg(`🎉 Payment initialized on ${newPayGateway.toUpperCase()} with Agent DID attestation!`);
        setTimeout(() => setPaySuccessMsg(""), 5000);
      } else {
        setPayErrorMsg(data.error || "Failed to create payment");
      }
    } catch (err: any) {
      setPayErrorMsg(err.message || "Failed to create payment");
    } finally {
      setCreatingPayment(false);
    }
  };

  const handleAuthorizeDraft = async (draftId: string, decision: "approved" | "rejected") => {
    try {
      const res = await fetch("/api/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, decision }),
      });
      const data = await res.json() as { success?: boolean; status?: string; checkoutUrl?: string };
      if (data.success) {
        setTransactions((prev) =>
          prev.map((t) => (t.id === draftId ? { ...t, status: (decision === "approved" ? "completed" : "rejected") as any, checkoutUrl: data.checkoutUrl || t.checkoutUrl } : t))
        );
        fetchPaymentsData();
      }
    } catch {
      // Ignore
    }
  };

  const fetchReferrals = async () => {
    setReferralsLoading(true);
    try {
      const resp = await fetch("/api/referrals");
      const data = await resp.json() as { referrals?: ReferralItem[] };
      setReferrals(data.referrals || []);
    } catch {
      // Ignore
    } finally {
      setReferralsLoading(false);
    }
  };

  const fetchAds = async () => {
    setAdsLoading(true);
    try {
      const resp = await fetch("/api/ads");
      const data = await resp.json() as { ads?: AdItem[] };
      setAds(data.ads || []);
    } catch {
      // Ignore
    } finally {
      setAdsLoading(false);
    }
  };

  const handleAdClick = (ad: AdItem) => {
    try {
      fetch("/api/ads/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ad.id }),
      });
      setAds((prev) =>
        prev.map((a) => (a.id === ad.id ? { ...a, clicks: a.clicks + 1 } : a))
      );
    } catch {
      // Ignore
    }
    window.open(ad.url, "_blank", "noopener,noreferrer");
  };

  const handleReferralClick = (ref: ReferralItem) => {
    try {
      fetch("/api/referrals/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ref.id }),
      });
      setReferrals((prev) =>
        prev.map((r) => (r.id === ref.id ? { ...r, clicks: r.clicks + 1 } : r))
      );
    } catch {
      // Ignore
    }
    window.open(ref.url, "_blank", "noopener,noreferrer");
  };

  const handleDeleteReferral = async (id: string) => {
    try {
      await fetch(`/api/referrals?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setReferrals((prev) => prev.filter((r) => r.id !== id));
    } catch {
      // Ignore
    }
  };

  const handleCreateReferral = async (e: React.FormEvent) => {
    e.preventDefault();
    setRefFormError("");
    setRefFormSuccess("");
    if (!newRefTitle.trim() || !newRefUrl.trim()) {
      setRefFormError("Please enter both title and target referral URL");
      return;
    }
    setSavingRef(true);
    try {
      const res = await fetch("/api/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newRefTitle.trim(),
          url: newRefUrl.trim(),
          category: newRefCategory,
          rewardText: newRefReward.trim() || "Exclusive community referral bonus",
        }),
      });
      const data = await res.json() as { referral?: ReferralItem; error?: string };
      if (data.referral) {
        setReferrals((prev) => [data.referral!, ...prev]);
        setNewRefTitle("");
        setNewRefUrl("");
        setNewRefReward("");
        setRefFormSuccess("🎉 Referral link published successfully!");
        setTimeout(() => setRefFormSuccess(""), 4000);
      } else {
        setRefFormError(data.error || "Failed to create referral link");
      }
    } catch (err: any) {
      setRefFormError(err.message || "Failed to save referral");
    } finally {
      setSavingRef(false);
    }
  };

  const handleCreateAd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdFormError("");
    setAdFormSuccess("");
    if (!newAdTitle.trim() || !newAdUrl.trim()) {
      setAdFormError("Please enter campaign title and target URL");
      return;
    }
    setSavingAd(true);
    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newAdTitle.trim(),
          tagline: newAdTagline.trim() || "Special offer for autonomous agent builders.",
          sponsor: newAdSponsor.trim() || user.name || "Community Partner",
          badge: newAdBadge.trim() || "PROMOTED",
          url: newAdUrl.trim(),
          ctaText: newAdCta.trim() || "Claim Deal →",
          accentColor: newAdColor,
        }),
      });
      const data = await res.json() as { ad?: AdItem; error?: string };
      if (data.ad) {
        setAds((prev) => [data.ad!, ...prev]);
        setNewAdTitle("");
        setNewAdTagline("");
        setNewAdSponsor("");
        setNewAdUrl("");
        setAdFormSuccess("🚀 Sponsored ad launched successfully!");
        setTimeout(() => setAdFormSuccess(""), 4000);
      } else {
        setAdFormError(data.error || "Failed to submit ad");
      }
    } catch (err: any) {
      setAdFormError(err.message || "Failed to submit ad");
    } finally {
      setSavingAd(false);
    }
  };

  const fetchCategories = async () => {
    setCategoriesLoading(true);
    try {
      const resp = await fetch("/api/categories");
      const data = (await resp.json()) as { categories?: CategoryItem[] };
      if (data.categories) {
        setCategories(data.categories);
        if (data.categories.length > 0 && !newRefCategory) {
          setNewRefCategory(data.categories[0].name);
        }
      }
    } catch {
      // Ignore
    } finally {
      setCategoriesLoading(false);
    }
  };

  const fetchExternalAds = async () => {
    setExternalAdsLoading(true);
    try {
      const resp = await fetch("/api/external-ads");
      const data = (await resp.json()) as { ads?: ExternalAdItem[] };
      if (data.ads) {
        setExternalAds(data.ads);
      }
    } catch {
      // Ignore
    } finally {
      setExternalAdsLoading(false);
    }
  };

  const fetchRevenueSummary = async () => {
    setRevenueLoading(true);
    try {
      const resp = await fetch("/api/revenue");
      const data = (await resp.json()) as RevenueSummaryData;
      setRevenueSummary(data);
    } catch {
      // Ignore
    } finally {
      setRevenueLoading(false);
    }
  };

  const fetchTables = async () => {
    setTablesLoading(true);
    try {
      const resp = await fetch("/api/schema/tables");
      const data = (await resp.json()) as { tables?: TableMetadataItem[] };
      if (data.tables) {
        setTables(data.tables);
      }
    } catch {
      // Ignore
    } finally {
      setTablesLoading(false);
    }
  };

  const browseTable = async (tableName: string, search?: string) => {
    setBrowsingLoading(true);
    try {
      const resp = await fetch("/api/schema/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: tableName, search: search || "" }),
      });
      const data = (await resp.json()) as { tableName: string; total: number; rows: any[] };
      setBrowsedData(data);
    } catch {
      setBrowsedData(null);
    } finally {
      setBrowsingLoading(false);
    }
  };

  const recordExternalAdImpression = (ad: ExternalAdItem) => {
    try {
      fetch("/api/external-ads/impression", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ad.id }),
      });
      setExternalAds((prev) =>
        prev.map((a) => (a.id === ad.id ? { ...a, impressions: a.impressions + 1, earnings: a.earnings + (a.cpmRate || 15) / 1000 } : a))
      );
    } catch {
      // Ignore
    }
  };

  const handleExternalAdClick = (ad: ExternalAdItem) => {
    try {
      fetch("/api/external-ads/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ad.id }),
      });
      setExternalAds((prev) =>
        prev.map((a) => (a.id === ad.id ? { ...a, clicks: a.clicks + 1, earnings: a.earnings + (a.cpcRate || 1.25) } : a))
      );
      if (revenueSummary) {
        setRevenueSummary((prev) =>
          prev ? { ...prev, totalAdClicks: prev.totalAdClicks + 1, adNetworkRevenue: prev.adNetworkRevenue + (ad.cpcRate || 1.25) } : null
        );
      }
    } catch {
      // Ignore
    }
    window.open(ad.targetUrl, "_blank", "noopener,noreferrer");
  };

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCatErrorMsg("");
    setCatSuccessMsg("");
    if (!newCatName.trim()) {
      setCatErrorMsg("Category name is required");
      return;
    }
    setSavingCat(true);
    try {
      const resp = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newCatName.trim(),
          icon: newCatIcon.trim() || "🏷️",
          description: newCatDesc.trim() || `Referrals in ${newCatName.trim()}`,
          sortOrder: Number(newCatOrder) || 10,
        }),
      });
      const data = (await resp.json()) as { success?: boolean; category?: CategoryItem; error?: string };
      if (data.category) {
        setCategories((prev) => [...prev, data.category!].sort((a, b) => a.sortOrder - b.sortOrder));
        setNewCatName("");
        setNewCatDesc("");
        setCatSuccessMsg(`✅ Category "${data.category.name}" created in ORM mas_categories!`);
        setTimeout(() => setCatSuccessMsg(""), 4000);
      } else {
        setCatErrorMsg(data.error || "Failed to create category");
      }
    } catch (err: any) {
      setCatErrorMsg(err.message || "Failed to create category");
    } finally {
      setSavingCat(false);
    }
  };

  const handleDeleteCategory = async (id: string) => {
    if (!confirm("Are you sure you want to delete this category?")) return;
    try {
      await fetch(`/api/categories?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setCategories((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // Ignore
    }
  };

  const handleCreateExternalAd = async (e: React.FormEvent) => {
    e.preventDefault();
    setExtAdErrorMsg("");
    setExtAdSuccessMsg("");
    if (!newExtTitle.trim() || !newExtUrl.trim()) {
      setExtAdErrorMsg("Title and Target URL are required");
      return;
    }
    setSavingExtAd(true);
    try {
      const resp = await fetch("/api/external-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newExtTitle.trim(),
          network: newExtNetwork,
          placement: newExtPlacement,
          tagline: newExtTagline.trim(),
          targetUrl: newExtUrl.trim(),
          ctaText: newExtCta.trim() || "Learn More →",
          cpmRate: parseFloat(newExtCpm) || 18.5,
          cpcRate: parseFloat(newExtCpc) || 1.5,
        }),
      });
      const data = (await resp.json()) as { success?: boolean; ad?: ExternalAdItem; error?: string };
      if (data.ad) {
        setExternalAds((prev) => [data.ad!, ...prev]);
        setNewExtTitle("");
        setNewExtTagline("");
        setNewExtUrl("");
        setExtAdSuccessMsg(`🎉 External Ad Placement "${data.ad.title}" activated on ${data.ad.network.toUpperCase()}!`);
        setTimeout(() => setExtAdSuccessMsg(""), 4000);
        fetchRevenueSummary();
      } else {
        setExtAdErrorMsg(data.error || "Failed to create external ad");
      }
    } catch (err: any) {
      setExtAdErrorMsg(err.message || "Failed to create external ad");
    } finally {
      setSavingExtAd(false);
    }
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isBusy) return;
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: input.trim() }],
      metadata: { sourceTab: "Chat & Agents", userLogin: user.login },
    });
    setInput("");
  };

  const handleChipClick = (prompt: string, sourceTab = "Chat & Agents") => {
    if (isBusy) return;
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: prompt }],
      metadata: { sourceTab, userLogin: user.login },
    });
  };

  const handleClearChat = async (skipConfirm?: boolean | React.MouseEvent) => {
    const shouldSkip = skipConfirm === true;
    if (!shouldSkip && !confirm("Are you sure you want to clear this conversation history?")) return;
    try {
      await fetch("/api/clear", { method: "POST" });
      if (typeof clearHistory === "function") {
        clearHistory();
      }
    } catch {
      // Ignore
    }
  };

  const handleDeleteMemory = async (key: string) => {
    try {
      await fetch(`/api/memory?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      setMemories((prev) => prev.filter((m) => m.key !== key));
    } catch {
      // Ignore
    }
  };

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-logo">🤖</div>
          <div className="brand-text">
            <h2>Multi-Agent Assistant</h2>
            <div className="agent-status-badge">
              <span className={`status-dot ${statusDotClass}`} />
              <span>{statusLabel}</span>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="tab-nav">
          <button
            className={`tab-btn ${tab === "trading" ? "active" : ""}`}
            onClick={() => {
              setTab("trading");
              setTbdMenuOpen(false);
            }}
          >
            📈 E*TRADE Brokerage
          </button>
          <button
            className={`tab-btn ${tab === "research" ? "active" : ""}`}
            onClick={() => {
              setTab("research");
              setTbdMenuOpen(false);
            }}
          >
            🔬 Yahoo Finance Screener
          </button>
          <button
            className={`tab-btn ${tab === "endpoints" ? "active" : ""}`}
            onClick={() => {
              setTab("endpoints");
              setTbdMenuOpen(false);
            }}
          >
            🔌 API &amp; MCP Endpoints
          </button>
          <div className="tab-menu">
            <button
              type="button"
              className={`tab-btn ${isTbdTab ? "active" : ""}`}
              aria-haspopup="menu"
              aria-expanded={tbdMenuOpen}
              onClick={() => setTbdMenuOpen((open) => !open)}
            >
              TBD ▾
            </button>
            {tbdMenuOpen && (
              <div className="tab-menu-items" role="menu" aria-label="Other areas">
                <button type="button" role="menuitem" className={tab === "chat" ? "active" : ""} onClick={() => { setTab("chat"); setTbdMenuOpen(false); }}>💬 Chat &amp; Agents</button>
                <button type="button" role="menuitem" className={tab === "nlq" ? "active" : ""} onClick={() => { setTab("nlq"); setTbdMenuOpen(false); }}>🗄️ Database Explorer</button>
                <button type="button" role="menuitem" className={tab === "audit" ? "active" : ""} onClick={() => { setTab("audit"); setTbdMenuOpen(false); }}>🛡️ Inspector &amp; Memory</button>
                <button type="button" role="menuitem" className={tab === "payments" ? "active" : ""} onClick={() => { setTab("payments"); setTbdMenuOpen(false); }}>💳 Payments &amp; DIDs</button>
                <button type="button" role="menuitem" className={tab === "referrals" ? "active" : ""} onClick={() => { setTab("referrals"); setTbdMenuOpen(false); }}>🎁 Referrals &amp; Earn</button>
                <button type="button" role="menuitem" className={tab === "ads" ? "active" : ""} onClick={() => { setTab("ads"); setTbdMenuOpen(false); }}>🚀 Sponsored Deals</button>
                <button type="button" role="menuitem" className={tab === "revenue" ? "active" : ""} onClick={() => { setTab("revenue"); setTbdMenuOpen(false); }}>💰 Revenue &amp; Ads</button>
              </div>
            )}
          </div>
        </nav>
        <AsyncJobsPanel />

        {/* User Badge */}
        <div className="user-profile">
          <img src={user.avatar} alt={user.login} className="user-avatar" />
          <div className="user-meta">
            <span className="user-name">{user.name}</span>
            <span className="user-login">@{user.login}</span>
          </div>
          <a href="/auth/logout" className="logout-btn" title="Sign out">
            Logout
          </a>
        </div>
      </header>

      {/* External Ad Network Monetization Strip */}
      {adDisplayConfig[tab] && externalAds.length > 0 && externalAds[activeExtAdIndex] && (
        <div className="external-ad-banner-strip">
          <div className="ext-ad-badge-group">
            <span className="ext-network-badge">
              {externalAds[activeExtAdIndex].network === "google" || externalAds[activeExtAdIndex].network === "adsense"
                ? "🌐 Google Ads"
                : externalAds[activeExtAdIndex].network === "ethicalads"
                ? "🛡️ EthicalAds"
                : externalAds[activeExtAdIndex].network === "carbon"
                ? "⚡ Carbon Ads"
                : "⭐ Direct Partner"}
            </span>
            <span className="ext-placement-badge">
              {externalAds[activeExtAdIndex].placement.replace("_", " ").toUpperCase()}
            </span>
          </div>

          <div className="ext-ad-content">
            <span className="ext-ad-title">{externalAds[activeExtAdIndex].title}</span>
            <span className="ext-ad-divider">—</span>
            <span className="ext-ad-tagline">{externalAds[activeExtAdIndex].tagline}</span>
          </div>

          <div className="ext-ad-earnings-pill" title="Live platform revenue generated by this placement">
            💰 CPM: ${externalAds[activeExtAdIndex].cpmRate.toFixed(2)} | CPC: ${externalAds[activeExtAdIndex].cpcRate.toFixed(2)} | Earned: ${externalAds[activeExtAdIndex].earnings.toFixed(2)}
          </div>

          <div className="ext-ad-actions">
            <button
              type="button"
              className="ext-ad-cta-btn"
              onClick={() => handleExternalAdClick(externalAds[activeExtAdIndex])}
            >
              {externalAds[activeExtAdIndex].ctaText}
            </button>
            {externalAds.length > 1 && (
              <button
                type="button"
                className="ext-ad-next-btn"
                title="View next ad in rotation"
                onClick={() => setActiveExtAdIndex((prev) => (prev + 1) % externalAds.length)}
              >
                ↻ Next ({activeExtAdIndex + 1}/{externalAds.length})
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Tab Content */}
      <main className="tab-viewport">
        {tab === "chat" && (
          <div className="chat-view">
            {/* Top Sponsor Spotlight Bar */}
            {ads.length > 0 && (
              <div
                className="sponsor-spotlight-bar"
                style={{ borderColor: `${ads[0].accentColor}55` }}
              >
                <div className="sponsor-tag-group">
                  <span
                    className="sponsor-pill"
                    style={{ background: `${ads[0].accentColor}25`, color: ads[0].accentColor }}
                  >
                    {ads[0].badge || "SPONSOR"}
                  </span>
                  <span className="sponsor-name">{ads[0].sponsor}</span>
                </div>
                <div className="sponsor-message">
                  <strong>{ads[0].title}</strong> — {ads[0].tagline}
                </div>
                <div className="sponsor-actions">
                  <button
                    type="button"
                    className="sponsor-cta-btn"
                    style={{ background: ads[0].accentColor }}
                    onClick={() => handleAdClick(ads[0])}
                  >
                    {ads[0].ctaText}
                  </button>
                  <button
                    type="button"
                    className="sponsor-more-btn"
                    onClick={() => setTab("ads")}
                    title="View all partner offers"
                  >
                    All Deals ↗
                  </button>
                </div>
              </div>
            )}

            <div className="chat-action-bar">
              <span className="chat-subtitle">Stateful Durable Object SQLite Session</span>
              {messages.length > 0 && (
                <button className="clear-btn" onClick={handleClearChat} title="Clear conversation">
                  🗑️ Clear chat
                </button>
              )}
            </div>

            <div className="messages-stream">
              {messages.length === 0 ? (
                <div className="hero-welcome">
                  <div className="hero-icon">⚡</div>
                  <h3>Enterprise Multi-Agent Studio</h3>
                  <p>
                    Your prompt is analyzed by an <strong>LLM Judge</strong> router and orchestrated across specialized sub-agents with Cloudflare Workers AI and transactional SQLite persistence.
                  </p>
                  <div className="quick-chips">
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Search the knowledge base: What features are available in Cloudflare Workers AI?")}
                    >
                      🔍 Search Knowledge Base
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Draft a payment refund of $120.00 USD for customer Acme Logistics")}
                    >
                      💳 Prepare Payment Draft
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Draft a high-priority task: Complete SOC2 compliance review by next Monday")}
                    >
                      📋 Draft High-Priority Task
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Remember that our enterprise team prefers TypeScript and dark-mode designs")}
                    >
                      🧠 Store Session Fact
                    </button>
                    <button
                      type="button"
                      className="chip-btn highlight-chip"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Perform FOSS equity research on NVDA using yfinance and Alpaca")}
                    >
                      🔬 Research NVDA (FOSS)
                    </button>
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={isBusy}
                      onClick={() => handleChipClick("Get live Alpaca quote and NBBO spread for BTC/USD")}
                    >
                      📊 Quote BTC/USD (Alpaca)
                    </button>
                  </div>
                </div>
              ) : (
                messages.map((msg: any) => {
                  const isUser = msg.role === "user";
                  const text = extractText(msg);

                  // Extract reasoning stream parts
                  const reasoningParts = !isUser && Array.isArray(msg.parts)
                    ? msg.parts.filter((p: any) => p && p.type === "reasoning")
                    : [];
                  const reasoningText = reasoningParts
                    .map((p: any) => p.text || p.reasoning || "")
                    .filter(Boolean)
                    .join("\n\n");

                  // Extract legitimate tool parts (strictly excluding stream lifecycle events and reasoning)
                  const toolParts = !isUser && Array.isArray(msg.parts)
                    ? msg.parts.filter((p: any) => {
                        if (!p || typeof p !== "object") return false;
                        const t = p.type;
                        if (t === "text" || t === "reasoning" || t === "step-start" || t === "step-end" || t === "finish") {
                          return false;
                        }
                        return true;
                      })
                    : [];

                  // Ignore empty assistant messages from interrupted or failed streams
                  if (!isUser && !text && toolParts.length === 0 && !reasoningText) {
                    return null;
                  }

                  return (
                    <div key={msg.id || Math.random()} className={`message-row ${msg.role}`}>
                      <div className="message-avatar">
                        {isUser ? (
                          <img src={user.avatar} alt="User" />
                        ) : (
                          <span className="bot-avatar">🤖</span>
                        )}
                      </div>
                      <div className="message-bubble">
                        <div className="message-header">
                          <span className="author-name">{isUser ? user.name : "Multi-Agent Orchestrator"}</span>
                          {isUser ? (
                            msg.metadata?.sourceTab && <span className="agent-tag">{msg.metadata.sourceTab}</span>
                          ) : <span className="agent-tag">Workers AI</span>}
                        </div>

                        {reasoningText && <ReasoningView reasoning={reasoningText} />}

                        {toolParts.length > 0 && (
                          <div className="tool-results-list">
                            {toolParts.map((part: any, pIdx: number) => {
                              const toolName = part.toolInvocation?.toolName || part.toolName || part.name || part.type || "tool";
                              const toolData = part.toolInvocation?.result ?? part.output ?? part.result ?? part.toolInvocation?.args ?? part.input ?? {};
                              return (
                                <ToolResultView
                                  key={pIdx}
                                  toolType={toolName}
                                  data={toolData}
                                  onAction={(actionPrompt) => handleChipClick(actionPrompt)}
                                  isBusy={isBusy}
                                />
                              );
                            })}
                          </div>
                        )}

                        {text && <MarkdownContent text={text} />}
                      </div>
                    </div>
                  );
                })
              )}

              {status === "streaming" && (
                <div className="message-row assistant">
                  <div className="message-avatar">
                    <span className="bot-avatar pulsing">🤖</span>
                  </div>
                  <div className="message-bubble streaming-bubble">
                    <div className="typing-indicator">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {status === "error" && (
              <div className="chat-error-banner">
                <span className="error-banner-icon">⚠️</span>
                <span className="error-banner-text">Agent connection or stream error. Try sending a message or reset session:</span>
                <button type="button" className="error-banner-btn" onClick={() => handleClearChat(true)}>
                  Reset & Clear History
                </button>
              </div>
            )}

            {/* Chat Input Bar */}
            <form className="chat-input-bar" onSubmit={handleSendChat}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={isBusy ? "Agent is processing response…" : "Ask a question, query knowledge base, draft a task, or save a memory…"}
                disabled={isBusy}
                autoFocus
              />
              <button
                type="submit"
                className="send-button"
                disabled={!input.trim() || isBusy}
              >
                {isBusy ? "Thinking…" : "Send ➔"}
              </button>
            </form>
          </div>
        )}

        {tab === "nlq" && (
          <div className="nlq-view">
            <div className="nlq-header">
              <h3>📊 Natural Language Database Query Engine (SQLite ORM)</h3>
              <p>
                Query relational SQLite tables, introspect database schema, retrieve table records, or add referral categories using natural language or direct ORM browsing.
              </p>
            </div>

            <div className="nlq-presets">
              <span className="preset-label">Natural Language Queries:</span>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("List all database tables and schema")}
              >
                🗄️ List tables & schema
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("Show referral categories in categories table")}
              >
                🏷️ Show categories table data
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("Add category 'Web3 & Crypto' to categories table")}
              >
                ➕ Add category 'Web3 & Crypto'
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("Show external ads inventory and earnings")}
              >
                📢 Show external ads & earnings
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("Show transactions and payment records")}
              >
                💳 Show transaction ledger
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("List all user questions asked")}
              >
                💬 List user questions
              </button>
            </div>

            <form className="chat-input-bar nlq-bar" onSubmit={(event) => {
              event.preventDefault();
              if (nlqInput.trim()) {
                handleChipClick(nlqInput.trim(), "Database Explorer");
                setNlqInput("");
                setTab("chat");
              }
            }}>
              <input
                type="text"
                value={nlqInput}
                onChange={(e) => setNlqInput(e.target.value)}
                placeholder="Ask the shared chat about database records or categories…"
              />
              <button type="submit" className="send-button" disabled={!nlqInput.trim() || isBusy}>
                Ask in Chat
              </button>
            </form>

            {/* Direct ORM Table Explorer Toolbar */}
            <div className="nlq-orm-toolbar">
              <span className="orm-tag">⚡ DIRECT ORM EXPLORER:</span>
              <select
                value={selectedBrowseTable}
                onChange={(e) => setSelectedBrowseTable(e.target.value)}
                className="orm-table-select"
              >
                <option value="mas_categories">🏷️ mas_categories (Referral Categories)</option>
                <option value="mas_referrals">🔗 mas_referrals (Referral Links)</option>
                <option value="mas_external_ads">📡 mas_external_ads (Ad Networks)</option>
                <option value="mas_ads">🚀 mas_ads (Sponsored Deals)</option>
                <option value="mas_transactions">💳 mas_transactions (Payments & DIDs)</option>
                <option value="mas_messages">💬 mas_messages (Conversation History)</option>
                <option value="mas_memory">🧠 mas_memory (Session Facts)</option>
                <option value="mas_events">🛡️ mas_events (Audit Log)</option>
              </select>

              <input
                type="text"
                value={browseSearch}
                onChange={(e) => setBrowseSearch(e.target.value)}
                placeholder="Search table text…"
                className="orm-search-input"
              />

              <button
                type="button"
                className="orm-browse-btn"
                onClick={() => browseTable(selectedBrowseTable, browseSearch)}
                disabled={browsingLoading}
              >
                {browsingLoading ? "Querying ORM…" : "🔍 Browse Records"}
              </button>
            </div>

            {/* Direct Table Browsing Results (if opened) */}
            {browsedData && (
              <div className="nlq-results-card orm-browsed-card">
                <div className="browsed-card-header">
                  <div className="browsed-title">
                    <span>🗄️ Table Data: <strong>{browsedData.tableName}</strong></span>
                    <span className="row-count-badge">{browsedData.total} Total Rows in SQLite ORM</span>
                  </div>
                  <button
                    type="button"
                    className="close-sm-btn"
                    onClick={() => setBrowsedData(null)}
                    title="Close browsed table"
                  >
                    ✕ Close
                  </button>
                </div>

                {browsedData.rows && browsedData.rows.length > 0 ? (
                  <div className="results-table-container">
                    <table className="results-table">
                      <thead>
                        <tr>
                          {Object.keys(browsedData.rows[0]).map((col) => (
                            <th key={col}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {browsedData.rows.map((row: any, i: number) => (
                          <tr key={i}>
                            {Object.keys(browsedData.rows[0]).map((col) => (
                              <td key={col} className="table-data-cell">
                                {typeof row[col] === "object" && row[col] !== null
                                  ? JSON.stringify(row[col])
                                  : String(row[col] ?? "—")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-results">No records found in table {browsedData.tableName}.</div>
                )}
              </div>
            )}

            {/* Natural Language Query Planner & Execution Results */}
            {nlqResult && (
              <div className="nlq-results-card">
                {nlqResult.plan && (
                  <div className="plan-badge-group">
                    <span className="plan-badge">Domain: <strong>{nlqResult.domain || nlqResult.plan.domain}</strong></span>
                    <span className="plan-badge">Operation: <strong>{nlqResult.plan.operation}</strong></span>
                    {nlqResult.plan.terms && <span className="plan-badge">Terms: <strong>"{nlqResult.plan.terms}"</strong></span>}
                    <span className="plan-badge count-badge">Matched: <strong>{nlqResult.count}</strong></span>
                  </div>
                )}

                {nlqResult.summary && (
                  <div className="nlq-summary-alert">
                    ℹ️ {nlqResult.summary}
                  </div>
                )}

                {/* Domain: Tables & Schemas Rendering */}
                {nlqResult.domain === "tables" && nlqResult.rows && nlqResult.rows.length > 0 && (
                  <div className="tables-schema-grid">
                    {nlqResult.rows.map((tbl: any, idx: number) => (
                      <div key={idx} className="table-schema-card">
                        <div className="schema-card-top">
                          <span className="schema-table-icon">🗄️</span>
                          <h5><code>{tbl.tableName}</code></h5>
                          <span className="row-count-badge">{tbl.rowCount} rows</span>
                        </div>
                        <p className="schema-desc">{tbl.description}</p>
                        <div className="schema-cols-preview">
                          <span className="cols-count-label">{tbl.columnCount} columns:</span>
                          <span className="cols-string">{tbl.columns}</span>
                        </div>
                        <button
                          type="button"
                          className="browse-data-btn"
                          onClick={() => {
                            setSelectedBrowseTable(tbl.tableName);
                            browseTable(tbl.tableName);
                          }}
                        >
                          🔍 Browse Records (ORM) →
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Domain: Category Mutation Rendering */}
                {nlqResult.domain === "category_mutation" && nlqResult.rows && (
                  <div className="category-mutation-result">
                    <div className="results-table-container">
                      <table className="results-table">
                        <thead>
                          <tr>
                            <th>Icon</th>
                            <th>Category</th>
                            <th>Slug</th>
                            <th>Description</th>
                            <th>Order</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nlqResult.rows.map((cat: any, i: number) => (
                            <tr key={i}>
                              <td style={{ fontSize: "1.25rem", textAlign: "center" }}>{cat.icon}</td>
                              <td><strong>{cat.name}</strong></td>
                              <td><code>{cat.slug}</code></td>
                              <td>{cat.description}</td>
                              <td>{cat.sortOrder}</td>
                              <td>
                                <span className={`status-pill ${cat.status === "ACTIVE" ? "active" : "inactive"}`}>
                                  {cat.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Domain: Table Data Dynamic Rendering */}
                {nlqResult.domain === "table_data" && nlqResult.rows && nlqResult.rows.length > 0 && (
                  <div className="results-table-container">
                    <table className="results-table">
                      <thead>
                        <tr>
                          {Object.keys(nlqResult.rows[0]).map((col) => (
                            <th key={col}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {nlqResult.rows.map((row: any, i: number) => (
                          <tr key={i}>
                            {Object.keys(nlqResult.rows[0]).map((col) => (
                              <td key={col} className="table-data-cell">
                                {typeof row[col] === "object" && row[col] !== null
                                  ? JSON.stringify(row[col])
                                  : String(row[col] ?? "—")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Domain: Conversation History Rendering */}
                {nlqResult.domain === "conversation" && nlqResult.rows && nlqResult.rows.length > 0 && (
                  <div className="results-table-container">
                    <table className="results-table">
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Agent</th>
                          <th>Content</th>
                          <th>Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {nlqResult.rows.map((row: any, i: number) => (
                          <tr key={i}>
                            <td><span className={`role-pill ${row.role}`}>{row.role || (row.count !== undefined ? "count" : "")}</span></td>
                            <td>{row.agent || "—"}</td>
                            <td className="content-cell">{row.content || (row.count !== undefined ? `Count: ${row.count}` : JSON.stringify(row))}</td>
                            <td className="timestamp-cell">{row.created_at ? new Date(row.created_at).toLocaleTimeString() : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {(!nlqResult.rows || nlqResult.rows.length === 0) && (
                  <div className="empty-results">No records matched the natural language query criteria.</div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "audit" && (
          <div className="audit-view">
            <div className="audit-header">
              <div>
                <h3>🛡️ System Audit & Memory Vault</h3>
                <p>Live observability stream into router decisions, sub-agent executions, LLM Judge evaluations, and SQLite memory state.</p>
              </div>
              <button className="refresh-btn" onClick={fetchAuditData} disabled={auditLoading}>
                {auditLoading ? "Refreshing…" : "🔄 Refresh Data"}
              </button>
            </div>

            <div className="audit-grid">
              {/* Memory Vault Panel */}
              <div className="audit-panel memory-panel">
                <div className="panel-title">
                  <span>🧠 Persistent Memory Vault</span>
                  <span className="badge-count">{memories.length} facts</span>
                </div>
                <div className="memory-list">
                  {memories.length === 0 ? (
                    <div className="empty-notice">No memories saved yet. Try asking the assistant to "Remember that..."</div>
                  ) : (
                    memories.map((m) => (
                      <div key={m.key} className="memory-card-item">
                        <div className="mem-header">
                          <span className="mem-key">🔑 {m.key}</span>
                          <button
                            className="delete-mem-btn"
                            onClick={() => handleDeleteMemory(m.key)}
                            title="Delete memory"
                          >
                            ×
                          </button>
                        </div>
                        <div className="mem-value">{m.value}</div>
                        <div className="mem-date">{new Date(m.updatedAt).toLocaleString()}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Audit Events Panel */}
              <div className="audit-panel events-panel">
                <div className="panel-title">
                  <span>📋 Real-time Event Log</span>
                  <span className="badge-count">{auditEvents.length} events</span>
                </div>
                <div className="events-stream">
                  {auditEvents.length === 0 ? (
                    <div className="empty-notice">No audit events logged yet.</div>
                  ) : (
                    auditEvents.map((e) => (
                      <div key={e.id} className="event-item">
                        <div className="event-header">
                          <span className={`event-agent-tag ${e.agent}`}>{e.agent.toUpperCase()}</span>
                          <span className="event-type">{e.type}</span>
                          <span className="event-time">{new Date(e.created_at).toLocaleTimeString()}</span>
                        </div>
                        <pre className="event-payload">{JSON.stringify(e.payload, null, 2)}</pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "payments" && (
          <div className="payments-view">
            {/* Header & Agent DID Ribbon */}
            <div className="tab-hero-header">
              <div className="hero-text-block">
                <h3>💳 Payments & Decentralized Identifiers (DID)</h3>
                <p>
                  Enterprise payment execution across Stripe, PayPal, and Lemon Squeezy with verifiable W3C Agent DIDs, cryptographic attestation, and human-in-the-loop authorization.
                </p>
                <div className="agent-dids-ribbon">
                  <span className="did-pill">
                    <span className="did-icon">🤖</span>
                    <code>did:agent:openaimp:payments</code>
                    <span className="did-role-tag">Signer</span>
                  </span>
                  <span className="did-pill">
                    <span className="did-icon">⚖️</span>
                    <code>did:agent:openaimp:judge</code>
                    <span className="did-role-tag">Evaluator</span>
                  </span>
                  <span className="did-pill">
                    <span className="did-icon">👤</span>
                    <code>did:user:github:{user.login}</code>
                    <span className="did-role-tag authorizer">Authorizer</span>
                  </span>
                </div>
              </div>
              <button
                className="refresh-btn"
                onClick={fetchPaymentsData}
                disabled={paymentsLoading}
              >
                {paymentsLoading ? "Refreshing…" : "🔄 Refresh"}
              </button>
            </div>

            {/* Gateway Status Cards Grid */}
            <div className="gateway-cards-grid">
              {gateways.map((gw) => (
                <div key={gw.id} className={`gateway-card ${gw.id}`}>
                  <div className="gw-card-header">
                    <div className="gw-name-group">
                      <span className="gw-icon">
                        {gw.id === "stripe" ? "💳" : gw.id === "paypal" ? "🅿️" : "🍋"}
                      </span>
                      <h5>{gw.name}</h5>
                    </div>
                    <span className={`gw-mode-badge ${gw.mode}`}>
                      {gw.mode.toUpperCase()}
                    </span>
                  </div>
                  <div className="gw-caps">
                    {gw.capabilities.map((c, i) => (
                      <span key={i} className="gw-cap-tag">{c}</span>
                    ))}
                  </div>
                  <div className="gw-webhook-info">
                    <code>Webhook: /api/payments/webhook?provider={gw.id}</code>
                  </div>
                </div>
              ))}
            </div>

            {/* Financial Analytics Ribbon */}
            <div className="referral-stats-ribbon">
              <div className="stat-card highlight">
                <span className="stat-icon">💰</span>
                <div className="stat-meta">
                  <span className="stat-num">${paymentSummary.totalVolume.toFixed(2)}</span>
                  <span className="stat-label">Total Settled Volume</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon">⚡</span>
                <div className="stat-meta">
                  <span className="stat-num">{paymentSummary.completedCount}</span>
                  <span className="stat-label">Settled Transactions</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon">🛡️</span>
                <div className="stat-meta">
                  <span className="stat-num">{paymentSummary.pendingCount}</span>
                  <span className="stat-label">Pending Authorizations</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon">🔐</span>
                <div className="stat-meta">
                  <span className="stat-num">{paymentSummary.verifiedDidCount}</span>
                  <span className="stat-label">Verifiable DID Signatures</span>
                </div>
              </div>
            </div>

            {/* 2-Column Grid: Create Payment / Intent Form + Transaction Ledger */}
            <div className="referral-columns-grid">
              {/* Left Column: Create Payment / Checkout Link Form */}
              <div className="referral-form-card">
                <div className="card-header">
                  <h4>➕ Initialize Payment / Checkout Link</h4>
                  <p>Issue a new payment intent across Stripe, PayPal, or Lemon Squeezy with cryptographic Agent DID attestation.</p>
                </div>

                <form onSubmit={handleCreatePayment} className="referral-form">
                  {paySuccessMsg && <div className="form-alert success">{paySuccessMsg}</div>}
                  {payErrorMsg && <div className="form-alert error">{payErrorMsg}</div>}

                  <div className="form-group">
                    <label>Payment Gateway Provider *</label>
                    <select
                      value={newPayGateway}
                      onChange={(e) => setNewPayGateway(e.target.value as any)}
                    >
                      <option value="stripe">Stripe (Card, Elements, Checkout)</option>
                      <option value="paypal">PayPal (Digital Wallet & Pay Later)</option>
                      <option value="lemonsqueezy">Lemon Squeezy (Merchant of Record)</option>
                    </select>
                  </div>

                  <div className="form-row-2">
                    <div className="form-group">
                      <label>Amount *</label>
                      <input
                        type="number"
                        step="0.01"
                        min="1"
                        placeholder="25.00"
                        value={newPayAmount}
                        onChange={(e) => setNewPayAmount(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Currency</label>
                      <select
                        value={newPayCurrency}
                        onChange={(e) => setNewPayCurrency(e.target.value)}
                      >
                        <option value="USD">USD ($)</option>
                        <option value="EUR">EUR (€)</option>
                        <option value="GBP">GBP (£)</option>
                        <option value="CAD">CAD ($)</option>
                      </select>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Customer Name or Account ID *</label>
                    <input
                      type="text"
                      placeholder="e.g. Acme Logistics or user@example.com"
                      value={newPayCustomer}
                      onChange={(e) => setNewPayCustomer(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Purpose / Description</label>
                    <input
                      type="text"
                      placeholder="e.g. 500,000 AI Inference Token Credits"
                      value={newPayDesc}
                      onChange={(e) => setNewPayDesc(e.target.value)}
                    />
                  </div>

                  <button
                    type="submit"
                    className="submit-action-btn"
                    disabled={creatingPayment || !newPayAmount || !newPayCustomer.trim()}
                  >
                    {creatingPayment ? "Signing & Initializing…" : `🚀 Create ${newPayGateway.toUpperCase()} Checkout Link`}
                  </button>
                </form>
              </div>

              {/* Right Column: Transaction Ledger & Human Authorization Queue */}
              <div className="referral-list-card">
                <div className="card-header">
                  <h4>📋 Transaction Ledger & DID Provenance ({transactions.length})</h4>
                  <p>Stateful record of all payment operations, drafts, and cryptographic audit proofs.</p>
                </div>

                <div className="referral-items-list">
                  {transactions.length === 0 ? (
                    <div className="empty-referrals-box">
                      <span className="empty-icon">💳</span>
                      <p>No transactions recorded yet.</p>
                      <span className="empty-sub">
                        Ask the AI assistant to draft a payment or use the form on the left.
                      </span>
                    </div>
                  ) : (
                    transactions.map((tx) => (
                      <div key={tx.id} className="referral-card-item transaction-card">
                        <div className="ref-top">
                          <span className={`gateway-pill ${tx.gateway}`}>{tx.gateway.toUpperCase()}</span>
                          <span className={`tx-status-pill ${tx.status}`}>{tx.status.replace("_", " ").toUpperCase()}</span>
                        </div>

                        <div className="tx-main-row">
                          <h5 className="ref-title">
                            {tx.action.toUpperCase()}: ${tx.amount.toFixed(2)} {tx.currency}
                          </h5>
                          <span className="tx-customer">for {tx.customer}</span>
                        </div>

                        {tx.note && <p className="ref-reward">📝 {tx.note}</p>}

                        {/* DID Attestation Bar */}
                        <div className="tx-did-bar">
                          <span className="did-proof-tag">DID SIGNED:</span>
                          <code>{tx.proposerDid}</code>
                        </div>

                        {/* Interactive Human Authorization for pending drafts */}
                        {tx.status === "awaiting_confirmation" && (
                          <div className="tx-hitl-box">
                            <div className="tx-hitl-notice">
                              🛡️ Human Authorization Required before gateway settlement.
                            </div>
                            <div className="tx-hitl-btns">
                              <button
                                type="button"
                                className="hitl-btn approve"
                                onClick={() => handleAuthorizeDraft(tx.id, "approved")}
                              >
                                ✅ Authorize & Settle
                              </button>
                              <button
                                type="button"
                                className="hitl-btn reject"
                                onClick={() => handleAuthorizeDraft(tx.id, "rejected")}
                              >
                                ❌ Reject
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="ref-footer">
                          {tx.checkoutUrl ? (
                            <a
                              href={tx.checkoutUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="visit-ref-btn"
                            >
                              Checkout Link ↗
                            </a>
                          ) : (
                            <span className="tx-date">{new Date(tx.createdAt).toLocaleTimeString()}</span>
                          )}

                          <button
                            type="button"
                            className="proof-inspect-btn"
                            onClick={() => setSelectedProofTx(tx)}
                            title="Inspect Cryptographic DID Proof"
                          >
                            🔐 Inspect DID Proof
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Cryptographic DID Proof Modal */}
            {selectedProofTx && (
              <div className="did-modal-overlay" onClick={() => setSelectedProofTx(null)}>
                <div className="did-modal-card" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <h4>🔐 W3C Agent Decentralized Identifier (DID) Proof</h4>
                    <button className="close-modal-btn" onClick={() => setSelectedProofTx(null)}>×</button>
                  </div>
                  <div className="modal-body">
                    <div className="proof-field">
                      <label>Transaction Draft ID</label>
                      <code>{selectedProofTx.id}</code>
                    </div>
                    <div className="proof-field">
                      <label>Proposer Agent DID</label>
                      <code>{selectedProofTx.proposerDid}</code>
                    </div>
                    <div className="proof-field">
                      <label>Human Authorizer DID</label>
                      <code>{selectedProofTx.authorizerDid || `did:user:github:${user.login}`}</code>
                    </div>
                    <div className="proof-field">
                      <label>Executor Agent DID</label>
                      <code>did:agent:openaimp:orchestrator</code>
                    </div>
                    <div className="proof-field">
                      <label>Settlement Gateway</label>
                      <code>{selectedProofTx.gateway.toUpperCase()}</code>
                    </div>
                    <div className="proof-field">
                      <label>Cryptographic Proof Signature (SHA-256 HMAC)</label>
                      <pre className="sig-code">{selectedProofTx.proofSignature || "0x4b78a9c2e1f40d89e5a1b3c7d6e8f2a4"}</pre>
                    </div>
                    <div className="proof-field">
                      <label>Timestamp</label>
                      <code>{selectedProofTx.createdAt}</code>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "referrals" && (
          <div className="referrals-view">
            {/* Header */}
            <div className="tab-hero-header">
              <div className="hero-text-block">
                <h3>🎁 Referrals & Partner Hub</h3>
                <p>
                  Invite colleagues to Multi-Agent Studio to unlock GPU compute credits, and place your own developer referral links to earn community rewards.
                </p>
              </div>
              <button
                className="refresh-btn"
                onClick={fetchReferrals}
                disabled={referralsLoading}
              >
                {referralsLoading ? "Refreshing…" : "🔄 Refresh"}
              </button>
            </div>

            {/* Top Share Box */}
            <div className="referral-share-card">
              <div className="referral-share-left">
                <span className="share-tag">YOUR EXCLUSIVE INVITE LINK</span>
                <h4>Share Multi-Agent Studio & Earn $10 Compute Credits</h4>
                <p>
                  When friends or coworkers sign up using your link, both of you unlock 50,000 free inference tokens and premium agent execution limits.
                </p>
                <div className="referral-link-input-group">
                  <input
                    type="text"
                    readOnly
                    value={personalReferralUrl}
                    className="referral-url-field"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    type="button"
                    className={`copy-link-btn ${copiedReferral ? "copied" : ""}`}
                    onClick={handleCopyPersonalRef}
                  >
                    {copiedReferral ? "✓ Copied!" : "📋 Copy Link"}
                  </button>
                </div>
              </div>

              <div className="referral-share-right">
                <span className="social-label">Share to All Social Media Platforms:</span>
                <div className="social-buttons-grid">
                  <a
                    href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                      `Build autonomous AI agents with Cloudflare Workers AI & SQLite on Multi-Agent Studio: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn x-twitter"
                    title="Share on X (Twitter)"
                  >
                    𝕏 X (Twitter)
                  </a>
                  <a
                    href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
                      personalReferralUrl
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn linkedin"
                    title="Share on LinkedIn"
                  >
                    💼 LinkedIn
                  </a>
                  <a
                    href={`https://reddit.com/submit?url=${encodeURIComponent(
                      personalReferralUrl
                    )}&title=${encodeURIComponent("Multi-Agent Studio: Autonomous AI Agents with Workers AI & SQLite")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn reddit"
                    title="Share on Reddit"
                  >
                    👽 Reddit
                  </a>
                  <a
                    href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(personalReferralUrl)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn facebook"
                    title="Share on Facebook"
                  >
                    📘 Facebook
                  </a>
                  <a
                    href={`https://api.whatsapp.com/send?text=${encodeURIComponent(
                      `Build autonomous AI agents on Multi-Agent Studio: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn whatsapp"
                    title="Share on WhatsApp"
                  >
                    💬 WhatsApp
                  </a>
                  <a
                    href={`https://t.me/share/url?url=${encodeURIComponent(
                      personalReferralUrl
                    )}&text=${encodeURIComponent("Check out Multi-Agent Studio for edge AI agents")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn telegram"
                    title="Share on Telegram"
                  >
                    ✈️ Telegram
                  </a>
                  <a
                    href={`https://www.threads.net/intent/post?text=${encodeURIComponent(
                      `Autonomous AI Agents on Cloudflare Workers AI: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn threads"
                    title="Share on Threads"
                  >
                    🧵 Threads
                  </a>
                  <a
                    href={`https://bsky.app/intent/compose?text=${encodeURIComponent(
                      `Check out Multi-Agent Studio for edge AI agents: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn bluesky"
                    title="Share on Bluesky"
                  >
                    🦋 Bluesky
                  </a>
                  <a
                    href={`https://news.ycombinator.com/submitlink?u=${encodeURIComponent(
                      personalReferralUrl
                    )}&t=${encodeURIComponent("Multi-Agent Studio: Edge AI agents on Cloudflare Workers")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn hackernews"
                    title="Share on Hacker News"
                  >
                    🟧 Hacker News
                  </a>
                  <a
                    href={`https://pinterest.com/pin/create/button/?url=${encodeURIComponent(
                      personalReferralUrl
                    )}&description=${encodeURIComponent("Autonomous AI Agents on Cloudflare Workers")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn pinterest"
                    title="Pin on Pinterest"
                  >
                    📌 Pinterest
                  </a>
                  <button
                    type="button"
                    className={`social-btn discord ${discordCopied ? "copied" : ""}`}
                    onClick={handleCopyDiscordEmbed}
                    title="Copy Discord rich markdown format"
                  >
                    👾 {discordCopied ? "✓ Discord Link Copied!" : "Discord Embed"}
                  </button>
                </div>
              </div>
            </div>

            {/* Metrics Ribbon */}
            <div className="referral-stats-ribbon">
              <div className="stat-card">
                <span className="stat-icon">🔗</span>
                <div className="stat-meta">
                  <span className="stat-num">{referrals.length}</span>
                  <span className="stat-label">Referrals Placed</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon">🖱️</span>
                <div className="stat-meta">
                  <span className="stat-num">{referrals.reduce((sum, r) => sum + r.clicks, 0)}</span>
                  <span className="stat-label">Total Link Clicks</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon">👥</span>
                <div className="stat-meta">
                  <span className="stat-num">
                    {referrals.reduce((sum, r) => sum + r.signups, 0) + (user.login ? 1 : 0)}
                  </span>
                  <span className="stat-label">Referred Sign-ups</span>
                </div>
              </div>
              <div className="stat-card highlight">
                <span className="stat-icon">💎</span>
                <div className="stat-meta">
                  <span className="stat-num">
                    ${((referrals.reduce((sum, r) => sum + r.signups, 0) + (user.login ? 1 : 0)) * 10).toFixed(0)}.00
                  </span>
                  <span className="stat-label">Earned Compute</span>
                </div>
              </div>
            </div>

            {/* Main 2-column Grid: Place Referral Link Form + Placed Links List */}
            <div className="referral-columns-grid">
              {/* Placement Form */}
              <div className="referral-form-card">
                <div className="card-header">
                  <h4>➕ Place a New Referral Link</h4>
                  <p>Publish your affiliate or referral link to your account to share with teammates and fellow developers.</p>
                </div>
                <form onSubmit={handleCreateReferral} className="referral-form">
                  {refFormSuccess && <div className="form-alert success">{refFormSuccess}</div>}
                  {refFormError && <div className="form-alert error">{refFormError}</div>}

                  <div className="form-group">
                    <label>Link Title / Service *</label>
                    <input
                      type="text"
                      placeholder="e.g. Cloudflare Workers AI Pro, Cursor AI, Supabase"
                      value={newRefTitle}
                      onChange={(e) => setNewRefTitle(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Destination Referral URL *</label>
                    <input
                      type="url"
                      placeholder="https://service.com/?ref=yourname"
                      value={newRefUrl}
                      onChange={(e) => setNewRefUrl(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-row-2">
                    <div className="form-group">
                      <label>Category</label>
                      <select
                        value={newRefCategory}
                        onChange={(e) => setNewRefCategory(e.target.value)}
                      >
                        {categories.length > 0 ? (
                          categories.map((cat) => (
                            <option key={cat.id} value={cat.name}>
                              {cat.icon} {cat.name}
                            </option>
                          ))
                        ) : (
                          <>
                            <option value="AI & Dev Tools">🤖 AI & Dev Tools</option>
                            <option value="Cloud & Hosting">☁️ Cloud & Hosting</option>
                            <option value="Database & Storage">🗄️ Database & Storage</option>
                            <option value="Security & Auth">🛡️ Security & Auth</option>
                            <option value="SaaS & Productivity">⚡ SaaS & Productivity</option>
                          </>
                        )}
                      </select>
                    </div>

                    <div className="form-group">
                      <label>Bonus / Reward Offer</label>
                      <input
                        type="text"
                        placeholder="e.g. Get $10 in free API credits"
                        value={newRefReward}
                        onChange={(e) => setNewRefReward(e.target.value)}
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="submit-action-btn"
                    disabled={savingRef || !newRefTitle.trim() || !newRefUrl.trim()}
                  >
                    {savingRef ? "Publishing…" : "🚀 Publish Referral Link"}
                  </button>
                </form>
              </div>

              {/* Placed Links List */}
              <div className="referral-list-card">
                <div className="card-header">
                  <h4>📋 Your Placed Referral Links ({referrals.length})</h4>
                  <p>Track clicks and manage your active promotional URLs.</p>
                </div>

                <div className="referral-items-list">
                  {referrals.length === 0 ? (
                    <div className="empty-referrals-box">
                      <span className="empty-icon">🔗</span>
                      <p>No referral links placed yet.</p>
                      <span className="empty-sub">
                        Use the form on the left to add your first affiliate or tool referral link.
                      </span>
                    </div>
                  ) : (
                    referrals.map((ref) => (
                      <div key={ref.id} className="referral-card-item">
                        <div className="ref-top">
                          <span className="ref-cat-pill">{ref.category}</span>
                          <span className="ref-clicks-pill">🖱️ {ref.clicks} clicks</span>
                        </div>
                        <h5 className="ref-title">{ref.title}</h5>
                        <p className="ref-reward">🎁 {ref.rewardText}</p>
                        <div className="ref-url-preview">
                          <code>{ref.url}</code>
                        </div>
                        <div className="ref-footer">
                          <button
                            type="button"
                            className="visit-ref-btn"
                            onClick={() => handleReferralClick(ref)}
                          >
                            Test Link ↗
                          </button>
                          <button
                            type="button"
                            className={`share-toggle-btn ${activeShareRefId === ref.id ? "active" : ""}`}
                            onClick={() => setActiveShareRefId(activeShareRefId === ref.id ? null : ref.id)}
                            title="Share on social media"
                          >
                            📢 Share Link
                          </button>
                          <button
                            type="button"
                            className="delete-ref-btn"
                            onClick={() => handleDeleteReferral(ref.id)}
                            title="Delete this referral"
                          >
                            🗑️ Delete
                          </button>
                        </div>
                        {activeShareRefId === ref.id && (
                          <div className="card-social-share-row">
                            <span className="card-share-lbl">Share:</span>
                            <a
                              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn x-twitter"
                              title="Share on X"
                            >
                              𝕏
                            </a>
                            <a
                              href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(ref.url)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn linkedin"
                              title="Share on LinkedIn"
                            >
                              💼
                            </a>
                            <a
                              href={`https://reddit.com/submit?url=${encodeURIComponent(ref.url)}&title=${encodeURIComponent(ref.title)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn reddit"
                              title="Share on Reddit"
                            >
                              👽
                            </a>
                            <a
                              href={`https://api.whatsapp.com/send?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn whatsapp"
                              title="Share on WhatsApp"
                            >
                              💬
                            </a>
                            <a
                              href={`https://t.me/share/url?url=${encodeURIComponent(ref.url)}&text=${encodeURIComponent(ref.title)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn telegram"
                              title="Share on Telegram"
                            >
                              ✈️
                            </a>
                            <a
                              href={`https://threads.net/intent/post?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn threads"
                              title="Share on Threads"
                            >
                              🧵
                            </a>
                            <a
                              href={`https://bsky.app/intent/compose?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn bluesky"
                              title="Share on Bluesky"
                            >
                              🦋
                            </a>
                            <button
                              type="button"
                              className="mini-social-btn discord"
                              onClick={() => handleCopyRefDiscordEmbed(ref.url, ref.title, ref.id)}
                              title="Copy Discord embed"
                            >
                              {copiedShareRefId === ref.id ? "✓" : "👾"}
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Google Ads Display Banner on Referrals Page */}
            {googleAdsEnabled && adDisplayConfig.referrals && (
              <div className="referral-ad-slot">
                <GoogleAdUnit
                  format="responsive"
                  publisherId={googlePublisherId}
                  slot={googleSlotId}
                  ad={externalAds.find((a) => a.network === "google" || a.network === "adsense") || externalAds[0]}
                  onTrackClick={handleExternalAdClick}
                />
              </div>
            )}

            {/* Official Social Media Platforms & Developer Community Hub */}
            <div className="referral-social-hub-card">
              <div className="card-header">
                <h4>🌐 Official Developer Social Platforms & Communities</h4>
                <p>
                  Connect with the OpenAIMP ecosystem, join real-time agent engineering discussions, and stay updated across all social media networks.
                </p>
              </div>

              <div className="social-platform-grid">
                <a href="https://github.com/OpenAIMP/cfagent" target="_blank" rel="noopener noreferrer" className="platform-card github">
                  <span className="platform-icon">🐙</span>
                  <div className="platform-info">
                    <strong>GitHub</strong>
                    <span>Source code, PRs, and issues</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://discord.com" target="_blank" rel="noopener noreferrer" className="platform-card discord">
                  <span className="platform-icon">👾</span>
                  <div className="platform-info">
                    <strong>Discord Server</strong>
                    <span>Real-time agent developer chat</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://x.com/OpenAIMP" target="_blank" rel="noopener noreferrer" className="platform-card twitter">
                  <span className="platform-icon">𝕏</span>
                  <div className="platform-info">
                    <strong>X (Twitter)</strong>
                    <span>Announcements & product updates</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://youtube.com/@OpenAIMP" target="_blank" rel="noopener noreferrer" className="platform-card youtube">
                  <span className="platform-icon">▶️</span>
                  <div className="platform-info">
                    <strong>YouTube</strong>
                    <span>Video tutorials & agent architecture demos</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://t.me/OpenAIMP" target="_blank" rel="noopener noreferrer" className="platform-card telegram">
                  <span className="platform-icon">✈️</span>
                  <div className="platform-info">
                    <strong>Telegram Community</strong>
                    <span>VIP channel & developer group</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://linkedin.com/company/openaimp" target="_blank" rel="noopener noreferrer" className="platform-card linkedin">
                  <span className="platform-icon">💼</span>
                  <div className="platform-info">
                    <strong>LinkedIn</strong>
                    <span>Enterprise agent solutions & news</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://reddit.com/r/Cloudflare" target="_blank" rel="noopener noreferrer" className="platform-card reddit">
                  <span className="platform-icon">👽</span>
                  <div className="platform-info">
                    <strong>Reddit</strong>
                    <span>r/Cloudflare & r/LocalLLaMA discussions</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://bsky.app/profile/openaimp.bsky.social" target="_blank" rel="noopener noreferrer" className="platform-card bluesky">
                  <span className="platform-icon">🦋</span>
                  <div className="platform-info">
                    <strong>Bluesky</strong>
                    <span>Open decentralized social updates</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://threads.net/@openaimp" target="_blank" rel="noopener noreferrer" className="platform-card threads">
                  <span className="platform-icon">🧵</span>
                  <div className="platform-info">
                    <strong>Threads</strong>
                    <span>Bite-sized AI developer discussions</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://instagram.com/openaimp" target="_blank" rel="noopener noreferrer" className="platform-card instagram">
                  <span className="platform-icon">📷</span>
                  <div className="platform-info">
                    <strong>Instagram</strong>
                    <span>Developer behind-the-scenes & clips</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://tiktok.com/@openaimp" target="_blank" rel="noopener noreferrer" className="platform-card tiktok">
                  <span className="platform-icon">🎵</span>
                  <div className="platform-info">
                    <strong>TikTok</strong>
                    <span>Quick tips & AI agent shorts</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://whatsapp.com" target="_blank" rel="noopener noreferrer" className="platform-card whatsapp">
                  <span className="platform-icon">💬</span>
                  <div className="platform-info">
                    <strong>WhatsApp Community</strong>
                    <span>Direct alerts & release announcements</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
              </div>
            </div>
          </div>
        )}

        {tab === "ads" && (
          <div className="ads-view">
            {/* Header */}
            <div className="tab-hero-header">
              <div className="hero-text-block">
                <h3>🚀 Sponsored Offers & Partner Marketplace</h3>
                <p>
                  Discover verified developer promotions, cloud compute grants, and API discounts. All placements run with real-time impression and click tracking.
                </p>
              </div>
              <button
                className="refresh-btn"
                onClick={fetchAds}
                disabled={adsLoading}
              >
                {adsLoading ? "Refreshing…" : "🔄 Refresh"}
              </button>
            </div>

            {/* Sponsored Offers Grid */}
            <div className="ads-grid">
              {ads.map((ad) => (
                <div
                  key={ad.id}
                  className="ad-spotlight-card"
                  style={{
                    borderColor: `${ad.accentColor}50`,
                    boxShadow: `0 8px 32px ${ad.accentColor}15`,
                  }}
                >
                  <div className="ad-card-top">
                    <span
                      className="ad-badge-tag"
                      style={{ background: `${ad.accentColor}25`, color: ad.accentColor }}
                    >
                      {ad.badge}
                    </span>
                    <span className="ad-sponsor-label">Sponsored by {ad.sponsor}</span>
                  </div>

                  <h4 className="ad-card-title">{ad.title}</h4>
                  <p className="ad-card-tagline">{ad.tagline}</p>

                  <div className="ad-stats-row">
                    <span className="ad-stat-pill">👁️ {ad.impressions} impressions</span>
                    <span className="ad-stat-pill">🖱️ {ad.clicks} clicks</span>
                  </div>

                  <div className="ad-card-action">
                    <button
                      type="button"
                      className="ad-cta-button"
                      style={{ background: ad.accentColor }}
                      onClick={() => handleAdClick(ad)}
                    >
                      {ad.ctaText}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Self-serve Ad Submission Form */}
            <div className="sponsor-submission-card">
              <div className="card-header">
                <h4>📢 Submit a Sponsored Placement</h4>
                <p>Feature your tool, API, or infrastructure platform to autonomous agent developers across the network.</p>
              </div>

              <form onSubmit={handleCreateAd} className="ad-submission-form">
                {adFormSuccess && <div className="form-alert success">{adFormSuccess}</div>}
                {adFormError && <div className="form-alert error">{adFormError}</div>}

                <div className="form-row-2">
                  <div className="form-group">
                    <label>Campaign / Product Title *</label>
                    <input
                      type="text"
                      placeholder="e.g. Workers AI Vectorize Bundle"
                      value={newAdTitle}
                      onChange={(e) => setNewAdTitle(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Sponsor / Brand Name *</label>
                    <input
                      type="text"
                      placeholder="e.g. Cloudflare Platform or Acme Corp"
                      value={newAdSponsor}
                      onChange={(e) => setNewAdSponsor(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>Tagline / Offer Description *</label>
                  <input
                    type="text"
                    placeholder="e.g. Accelerate multi-turn LLM reasoning with sub-millisecond vector lookups."
                    value={newAdTagline}
                    onChange={(e) => setNewAdTagline(e.target.value)}
                    required
                  />
                </div>

                <div className="form-row-3">
                  <div className="form-group">
                    <label>Destination Landing URL *</label>
                    <input
                      type="url"
                      placeholder="https://..."
                      value={newAdUrl}
                      onChange={(e) => setNewAdUrl(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>CTA Button Label</label>
                    <input
                      type="text"
                      placeholder="e.g. Claim $50 Credit →"
                      value={newAdCta}
                      onChange={(e) => setNewAdCta(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label>Accent Color</label>
                    <select
                      value={newAdColor}
                      onChange={(e) => setNewAdColor(e.target.value)}
                    >
                      <option value="#6366f1">Indigo (#6366f1)</option>
                      <option value="#f38020">Cloudflare Orange (#f38020)</option>
                      <option value="#06b6d4">Cyan (#06b6d4)</option>
                      <option value="#10b981">Emerald Green (#10b981)</option>
                      <option value="#a855f7">Purple (#a855f7)</option>
                      <option value="#f43f5e">Rose (#f43f5e)</option>
                    </select>
                  </div>
                </div>

                <button
                  type="submit"
                  className="submit-action-btn ad-btn"
                  disabled={savingAd || !newAdTitle.trim() || !newAdUrl.trim()}
                >
                  {savingAd ? "Submitting Placement…" : "🚀 Launch Sponsored Placement"}
                </button>
              </form>
            </div>
          </div>
        )}

        {tab === "revenue" && (
          <div className="revenue-view">
            {/* Header */}
            <div className="tab-hero-header">
              <div className="hero-text-block">
                <h3>💰 Revenue & Monetization Management</h3>
                <p>
                  Platform revenue accounting across external ad networks (CPM/CPC), sponsored marketplace placements, agent payment processing fees, and referral partner payouts powered by SQLite ORM.
                </p>
              </div>
              <button
                className="refresh-btn"
                onClick={() => {
                  fetchRevenueSummary();
                  fetchExternalAds();
                  fetchCategories();
                  fetchTables();
                }}
                disabled={revenueLoading}
              >
                {revenueLoading ? "Refreshing…" : "🔄 Refresh Financials"}
              </button>
            </div>

            {/* Comprehensive Revenue Metrics Grid */}
            <div className="revenue-grid">
              <div className="rev-card highlight-rev">
                <span className="rev-icon">💵</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.grossRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Total Gross Platform Revenue</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">🌐</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.adNetworkRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">External Ad Networks (CPM + CPC)</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">🚀</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.marketplaceRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Direct Sponsored Marketplace</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">💳</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.paymentPlatformFees?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Payment Processing Fees (2.5%)</span>
                </div>
              </div>

              <div className="rev-card expense-card">
                <span className="rev-icon">🎁</span>
                <div className="rev-meta">
                  <span className="rev-val">-${revenueSummary?.referralPayouts?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Referral Partner Payouts</span>
                </div>
              </div>

              <div className="rev-card net-profit-card">
                <span className="rev-icon">💎</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.netRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Net Platform Margin</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">👁️</span>
                <div className="rev-meta">
                  <span className="rev-val">
                    {revenueSummary?.totalImpressions || 0} / {revenueSummary?.totalAdClicks || 0}
                  </span>
                  <span className="rev-label">Ad Views / Link Clicks</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">📈</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.averageRPM?.toFixed(2) || "18.50"}</span>
                  <span className="rev-label">Average Ad Network RPM</span>
                </div>
              </div>
            </div>

            {/* External Ad Network Inventory Manager */}
            <div className="revenue-section-card">
              <div className="card-header">
                <h4>📡 External Ad Network Placements ({externalAds.length})</h4>
                <p>
                  Manage active network units (EthicalAds, Carbon Ads, Google AdSense, Direct) generating revenue per 1,000 views (CPM) and per click (CPC).
                </p>
              </div>

              <div className="results-table-container">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th>Placement Unit</th>
                      <th>Network</th>
                      <th>Slot</th>
                      <th>CPM Rate</th>
                      <th>CPC Rate</th>
                      <th>Views</th>
                      <th>Clicks</th>
                      <th>Total Earned</th>
                      <th>Status</th>
                      <th>Live Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {externalAds.map((ad) => (
                      <tr key={ad.id}>
                        <td>
                          <strong>{ad.title}</strong>
                          <div className="table-subtext">{ad.tagline}</div>
                        </td>
                        <td>
                          <span className={`ad-net-tag ${ad.network}`}>
                            {ad.network === "ethicalads" ? "EthicalAds" : ad.network === "carbon" ? "Carbon" : ad.network === "adsense" ? "AdSense" : "Direct"}
                          </span>
                        </td>
                        <td><code>{ad.placement}</code></td>
                        <td>${ad.cpmRate.toFixed(2)}</td>
                        <td>${ad.cpcRate.toFixed(2)}</td>
                        <td>{ad.impressions}</td>
                        <td>{ad.clicks}</td>
                        <td><strong className="earned-text">${ad.earnings.toFixed(2)}</strong></td>
                        <td>
                          <span className={`status-pill ${ad.isActive ? "active" : "inactive"}`}>
                            {ad.isActive ? "ACTIVE" : "PAUSED"}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="test-ad-btn"
                            onClick={() => handleExternalAdClick(ad)}
                          >
                            {ad.ctaText}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Form to Register New Ad Unit */}
              <div className="create-subcard">
                <h5>➕ Register New External Ad Network Placement</h5>
                {extAdSuccessMsg && <div className="form-alert success">{extAdSuccessMsg}</div>}
                {extAdErrorMsg && <div className="form-alert error">{extAdErrorMsg}</div>}

                <form onSubmit={handleCreateExternalAd} className="compact-form">
                  <div className="form-row-3">
                    <div className="form-group">
                      <label>Ad Campaign Title *</label>
                      <input
                        type="text"
                        placeholder="e.g. DeepSeek R1 Global Inference"
                        value={newExtTitle}
                        onChange={(e) => setNewExtTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Ad Network Provider</label>
                      <select
                        value={newExtNetwork}
                        onChange={(e) => setNewExtNetwork(e.target.value as any)}
                      >
                        <option value="ethicalads">🛡️ EthicalAds Developer Network</option>
                        <option value="carbon">⚡ Carbon Ads</option>
                        <option value="adsense">🌐 Google AdSense</option>
                        <option value="direct">⭐ Direct Sponsor</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Placement Slot</label>
                      <select
                        value={newExtPlacement}
                        onChange={(e) => setNewExtPlacement(e.target.value as any)}
                      >
                        <option value="header_leaderboard">Header Leaderboard (Top)</option>
                        <option value="in_stream">In-Stream Banner (Chat)</option>
                        <option value="footer_deck">Footer Deck</option>
                        <option value="sidebar">Sidebar Rail</option>
                      </select>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Tagline / Promo Copy</label>
                    <input
                      type="text"
                      placeholder="e.g. Serverless GPUs running 70B reasoning models with sub-second latency."
                      value={newExtTagline}
                      onChange={(e) => setNewExtTagline(e.target.value)}
                    />
                  </div>

                  <div className="form-row-4">
                    <div className="form-group">
                      <label>Target URL *</label>
                      <input
                        type="url"
                        placeholder="https://..."
                        value={newExtUrl}
                        onChange={(e) => setNewExtUrl(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>CTA Label</label>
                      <input
                        type="text"
                        placeholder="Claim Offer →"
                        value={newExtCta}
                        onChange={(e) => setNewExtCta(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>CPM Rate ($/1,000 views)</label>
                      <input
                        type="number"
                        step="0.5"
                        placeholder="18.50"
                        value={newExtCpm}
                        onChange={(e) => setNewExtCpm(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>CPC Rate ($/click)</label>
                      <input
                        type="number"
                        step="0.1"
                        placeholder="1.50"
                        value={newExtCpc}
                        onChange={(e) => setNewExtCpc(e.target.value)}
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="submit-action-btn"
                    disabled={savingExtAd || !newExtTitle.trim() || !newExtUrl.trim()}
                  >
                    {savingExtAd ? "Activating Placement…" : "🚀 Activate Ad Network Unit"}
                  </button>
                </form>
              </div>
            </div>

            {/* Referral Categories Taxonomy Manager (ORM) */}
            <div className="revenue-section-card">
              <div className="card-header">
                <h4>🏷️ Referral Categories Manager (SQLite ORM `mas_categories`)</h4>
                <p>
                  Configure and maintain the categorization taxonomy used by partners to list developer tools, affiliate links, and monetization campaigns.
                </p>
              </div>

              <div className="results-table-container">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th>Icon</th>
                      <th>Category Name</th>
                      <th>Slug</th>
                      <th>Description</th>
                      <th>Sort Order</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categories.map((cat) => (
                      <tr key={cat.id}>
                        <td style={{ fontSize: "1.25rem", textAlign: "center" }}>{cat.icon}</td>
                        <td><strong>{cat.name}</strong></td>
                        <td><code>{cat.slug}</code></td>
                        <td>{cat.description}</td>
                        <td>{cat.sortOrder}</td>
                        <td>
                          <span className={`status-pill ${cat.isActive ? "active" : "inactive"}`}>
                            {cat.isActive ? "ACTIVE" : "INACTIVE"}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="danger-sm-btn"
                            onClick={() => handleDeleteCategory(cat.id)}
                            title="Delete category"
                          >
                            🗑️ Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Form to Add New Category */}
              <div className="create-subcard">
                <h5>➕ Add New Referral Category via ORM</h5>
                {catSuccessMsg && <div className="form-alert success">{catSuccessMsg}</div>}
                {catErrorMsg && <div className="form-alert error">{catErrorMsg}</div>}

                <form onSubmit={handleCreateCategory} className="compact-form">
                  <div className="form-row-3">
                    <div className="form-group">
                      <label>Category Name *</label>
                      <input
                        type="text"
                        placeholder="e.g. Web3 & Crypto, DevOps & CI/CD"
                        value={newCatName}
                        onChange={(e) => setNewCatName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Emoji Icon</label>
                      <input
                        type="text"
                        placeholder="⚡"
                        value={newCatIcon}
                        onChange={(e) => setNewCatIcon(e.target.value)}
                        style={{ width: "80px", textAlign: "center" }}
                      />
                    </div>
                    <div className="form-group">
                      <label>Sort Priority (Order)</label>
                      <input
                        type="number"
                        placeholder="10"
                        value={newCatOrder}
                        onChange={(e) => setNewCatOrder(e.target.value)}
                        style={{ width: "100px" }}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Description</label>
                    <input
                      type="text"
                      placeholder="e.g. Decentralized infrastructure, smart contracts, and wallet tooling."
                      value={newCatDesc}
                      onChange={(e) => setNewCatDesc(e.target.value)}
                    />
                  </div>

                  <button
                    type="submit"
                    className="submit-action-btn"
                    disabled={savingCat || !newCatName.trim()}
                  >
                    {savingCat ? "Saving Category…" : "🏷️ Save Category via ORM"}
                  </button>
                </form>
              </div>
            </div>

            {/* SQLite ORM Database Tables Schema Inspection */}
            <div className="revenue-section-card">
              <div className="card-header">
                <h4>🗄️ Database Tables Schema & Record Counts (`DatabaseORM`)</h4>
                <p>
                  Direct view into the typed repositories and relational SQLite tables managed by the Durable Object ORM.
                </p>
              </div>

              <div className="tables-meta-grid">
                {tables.map((tbl) => (
                  <div key={tbl.name} className="table-card">
                    <div className="table-card-header">
                      <h5><code>{tbl.name}</code></h5>
                      <span className="row-count-badge">{tbl.rowCount} rows</span>
                    </div>
                    <p className="table-desc">{tbl.description}</p>
                    <div className="table-cols">
                      <span className="col-count">{tbl.columns.length} columns:</span>
                      <div className="col-tags">
                        {tbl.columns.map((c) => (
                          <span key={c.name} className={`col-pill ${c.isPrimary ? "pk" : ""}`}>
                            {c.name} {c.isPrimary ? "(PK)" : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="table-action">
                      <button
                        type="button"
                        className="browse-data-btn"
                        onClick={() => {
                          setSelectedBrowseTable(tbl.name);
                          browseTable(tbl.name);
                          setTab("nlq");
                        }}
                      >
                        🔍 Browse Table Records (ORM) →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Google Ads & Multi-Network Monetization Control Center */}
            <div className="revenue-section-card">
              <div className="card-header">
                <h4>🌐 Google Ads & Multi-Network Display Engine</h4>
                <p>
                  Configure official Google AdSense and network display banners, test live formats, and track impressions/clicks across the platform.
                </p>
              </div>

              <div className="google-ads-config-grid">
                <div className="config-form-card">
                  <h5>⚙️ Google Ads Configuration</h5>
                  <div className="form-group">
                    <label>Google Ads Display Status</label>
                    <div className="toggle-switch-row">
                      <button
                        type="button"
                        className={`toggle-btn ${googleAdsEnabled ? "active" : ""}`}
                        onClick={() => setGoogleAdsEnabled(!googleAdsEnabled)}
                      >
                        {googleAdsEnabled ? "🟢 Google Ads Active" : "⚪ Google Ads Paused"}
                      </button>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Google AdSense Publisher Client ID</label>
                    <input
                      type="text"
                      placeholder="ca-pub-9842109842109842"
                      value={googlePublisherId}
                      onChange={(e) => setGooglePublisherId(e.target.value)}
                    />
                  </div>

                  <div className="form-row-2">
                    <div className="form-group">
                      <label>Default Ad Slot ID</label>
                      <input
                        type="text"
                        placeholder="7812903456"
                        value={googleSlotId}
                        onChange={(e) => setGoogleSlotId(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>Display Format</label>
                      <select
                        value={googleAdFormat}
                        onChange={(e) => setGoogleAdFormat(e.target.value as any)}
                      >
                        <option value="responsive">Responsive Banner</option>
                        <option value="leaderboard">728x90 Leaderboard</option>
                        <option value="rectangle">300x250 Medium Rectangle</option>
                      </select>
                    </div>
                  </div>
                </div>

                {adDisplayConfig.ads && googleAdsEnabled && (
                  <div className="live-ad-preview-card">
                    <h5>Live Google Ads Preview</h5>
                    <GoogleAdUnit
                      format={googleAdFormat}
                      publisherId={googlePublisherId}
                      slot={googleSlotId}
                      ad={externalAds.find((a) => a.network === "google" || a.network === "adsense") || externalAds[0]}
                      onTrackClick={handleExternalAdClick}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* API & Model Context Protocol (MCP) Endpoints Explorer */}
        {tab === "endpoints" && (
          <div className="endpoints-view">
            <McpApiExplorer />
          </div>
        )}

        {/* E*TRADE Agentic Trading Hub */}
        {/* Kept mounted (hidden) so in-flight and finished requests survive tab switches */}
        <div className="trading-view" hidden={tab !== "trading"}>
          <ETradeTradingHub
            user={user}
            onSendPrompt={(prompt, sourceTab) => {
              setTab("chat");
              handleChipClick(prompt, sourceTab || "E*TRADE Brokerage");
            }}
          />
        </div>

        {tab === "research" && (
          <div className="research-view">
            <FossResearchHub
              user={user}
              onSendPrompt={(prompt, sourceTab) => {
                setTab("chat");
                handleChipClick(prompt, sourceTab || "Yahoo Finance Research");
              }}
              onTradeSymbol={(symbol) => {
                setTab("trading");
              }}
            />
          </div>
        )}

      </main>
    </div>
  );
}
