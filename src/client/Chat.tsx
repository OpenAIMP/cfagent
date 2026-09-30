import React, { useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

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

  // 3. Payment Draft Tool
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
  const [tab, setTab] = useState<"chat" | "nlq" | "audit" | "payments" | "referrals" | "ads">("chat");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Agent connection
  const agent = useAgent({ agent: "SearchAgent", name: user.login });
  const { messages, sendMessage, status, clearHistory } = useAgentChat({ agent });

  const isBusy = status === "streaming" || status === "submitted";
  const statusLabel = isBusy ? "Thinking…" : status === "error" ? "Error" : "Ready";
  const statusDotClass = isBusy ? "streaming" : status === "error" ? "error" : "ready";

  // NLQ state
  const [nlqInput, setNlqInput] = useState("");
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqResult, setNlqResult] = useState<any>(null);

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

  // Auto-scroll on new messages
  useEffect(() => {
    if (tab === "chat") {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, status, tab]);

  // Initial load of partner ads for top banner & deals
  useEffect(() => {
    fetchAds();
  }, []);

  // Load tab-specific data when tab changes
  useEffect(() => {
    if (tab === "audit") {
      fetchAuditData();
    } else if (tab === "payments") {
      fetchPaymentsData();
    } else if (tab === "referrals") {
      fetchReferrals();
    } else if (tab === "ads") {
      fetchAds();
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

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isBusy) return;
    sendMessage({ text: input.trim() });
    setInput("");
  };

  const handleChipClick = (prompt: string) => {
    if (isBusy) return;
    sendMessage({ text: prompt });
  };

  const handleRunNLQ = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nlqInput.trim() || nlqLoading) return;
    setNlqLoading(true);
    setNlqResult(null);
    try {
      const resp = await fetch("/api/nlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: nlqInput.trim() }),
      });
      setNlqResult(await resp.json());
    } catch (err) {
      setNlqResult({ error: "Failed to connect to NLQ endpoint" });
    } finally {
      setNlqLoading(false);
    }
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
            className={`tab-btn ${tab === "chat" ? "active" : ""}`}
            onClick={() => setTab("chat")}
          >
            💬 Chat & Agents
          </button>
          <button
            className={`tab-btn ${tab === "nlq" ? "active" : ""}`}
            onClick={() => setTab("nlq")}
          >
            📊 Analytics (NLQ)
          </button>
          <button
            className={`tab-btn ${tab === "audit" ? "active" : ""}`}
            onClick={() => setTab("audit")}
          >
            🛡️ Inspector & Memory
          </button>
          <button
            className={`tab-btn ${tab === "payments" ? "active" : ""}`}
            onClick={() => setTab("payments")}
          >
            💳 Payments & DIDs
          </button>
          <button
            className={`tab-btn ${tab === "referrals" ? "active" : ""}`}
            onClick={() => setTab("referrals")}
          >
            🎁 Referrals & Earn
          </button>
          <button
            className={`tab-btn ${tab === "ads" ? "active" : ""}`}
            onClick={() => setTab("ads")}
          >
            🚀 Sponsored Deals
          </button>
        </nav>

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
                          {isUser ? null : <span className="agent-tag">Workers AI</span>}
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
              <h3>📊 Natural Language Message Analytics</h3>
              <p>
                Query your conversation transcript directly with natural language. The system converts your query into a read-only query plan executed securely over SQLite.
              </p>
            </div>

            <div className="nlq-presets">
              <span className="preset-label">Try asking:</span>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("How many total messages are in this conversation?")}
              >
                🔢 Count all messages
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("Find all assistant messages containing search results")}
              >
                🔍 Search for knowledge references
              </button>
              <button
                className="chip-btn"
                onClick={() => setNlqInput("List all user questions asked")}
              >
                💬 List user questions
              </button>
            </div>

            <form className="chat-input-bar nlq-bar" onSubmit={handleRunNLQ}>
              <input
                type="text"
                value={nlqInput}
                onChange={(e) => setNlqInput(e.target.value)}
                placeholder="e.g. Count messages or search topics discussed…"
                disabled={nlqLoading}
              />
              <button
                type="submit"
                className="send-button"
                disabled={!nlqInput.trim() || nlqLoading}
              >
                {nlqLoading ? "Analyzing…" : "Run Query"}
              </button>
            </form>

            {nlqResult && (
              <div className="nlq-results-card">
                {nlqResult.plan && (
                  <div className="plan-badge-group">
                    <span className="plan-badge">Operation: <strong>{nlqResult.plan.operation}</strong></span>
                    {nlqResult.plan.terms && <span className="plan-badge">Terms: <strong>"{nlqResult.plan.terms}"</strong></span>}
                    <span className="plan-badge">Role: <strong>{nlqResult.plan.role}</strong></span>
                    <span className="plan-badge count-badge">Matched: <strong>{nlqResult.count}</strong></span>
                  </div>
                )}

                {nlqResult.rows && nlqResult.rows.length > 0 ? (
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
                ) : (
                  <div className="empty-results">No conversation records matched the query criteria.</div>
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
                <span className="social-label">Quick Share:</span>
                <div className="social-buttons">
                  <a
                    href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                      `Build autonomous AI agents with Cloudflare Workers AI & SQLite on Multi-Agent Studio: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn x-twitter"
                  >
                    𝕏 Share on X
                  </a>
                  <a
                    href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
                      personalReferralUrl
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn linkedin"
                  >
                    💼 LinkedIn
                  </a>
                  <a
                    href={`https://t.me/share/url?url=${encodeURIComponent(
                      personalReferralUrl
                    )}&text=${encodeURIComponent("Check out Multi-Agent Studio for edge AI agents")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn telegram"
                  >
                    ✈️ Telegram
                  </a>
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
                        <option value="AI & Dev Tools">AI & Dev Tools</option>
                        <option value="Cloud & Hosting">Cloud & Hosting</option>
                        <option value="Database & Storage">Database & Storage</option>
                        <option value="Security & Auth">Security & Auth</option>
                        <option value="SaaS & Productivity">SaaS & Productivity</option>
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
                            className="delete-ref-btn"
                            onClick={() => handleDeleteReferral(ref.id)}
                            title="Delete this referral"
                          >
                            🗑️ Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
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
      </main>
    </div>
  );
}
