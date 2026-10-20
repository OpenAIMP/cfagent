import React, { useState, useEffect, useCallback } from "react";
import { AGENT_DIDS } from "../../agents/did";
import { EmptyState } from "./ui";
import { normalizeAutopilotLimits, type AutopilotPolicyLimits } from "../../services/riskPolicyEngine";
import type { TradeRecord } from "../../types";

/**
 * Limits are defined by the policy engine — the single source of truth shared
 * with the server, so the limit the UI shows is the limit that is enforced.
 */
export type { AutopilotPolicyLimits } from "../../services/riskPolicyEngine";

export interface AutonomousActionItem {
  id: string;
  timestamp: string;
  actionType: "order" | "policy_check" | "risk_guardrail" | "rebalance";
  symbol: string;
  summary: string;
  policyCheckRule: string;
  policyCheckPassed: boolean;
  status: "executed" | "routed_to_approval" | "verified" | "blocked";
  didAttestation: {
    did: string;
    signature: string;
  };
  source?: "live" | "simulated";
}

export interface AuditLogRawEvent {
  id: string;
  type: string;
  agent: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * Maps a backend SQLite WAL audit event (mas_events) to an autonomous action row.
 */
export function mapAuditLogToAutonomousAction(e: AuditLogRawEvent): AutonomousActionItem {
  const payload = (e.payload && typeof e.payload === "object") ? e.payload : {};
  let actionType: AutonomousActionItem["actionType"] = "policy_check";
  const typeLower = (e.type || "").toLowerCase();

  if (typeLower.includes("order") || typeLower.includes("trade") || typeLower.includes("alpaca.order")) {
    actionType = "order";
  } else if (
    typeLower.includes("risk") ||
    typeLower.includes("guardrail") ||
    typeLower.includes("drawdown") ||
    typeLower.includes("reserve")
  ) {
    actionType = "risk_guardrail";
  } else if (typeLower.includes("rebalance") || typeLower.includes("allocation")) {
    actionType = "rebalance";
  } else {
    actionType = "policy_check";
  }

  // Symbol resolution
  const symbol = String(
    payload.symbol ||
    payload.ticker ||
    (actionType === "risk_guardrail" ? "PORTFOLIO" : e.agent === "judge" ? "PORTFOLIO" : "SPY/QQQ")
  ).toUpperCase();

  // Summary generation
  let summary = "";
  if (payload.summary && typeof payload.summary === "string") {
    summary = payload.summary;
  } else if (typeLower === "alpaca.order_placed") {
    summary = `Alpaca ${payload.side || "order"} ${payload.qty || ""} shares @ ${payload.status || "placed"}`;
  } else if (typeLower === "etrade.order_executed") {
    summary = `E*TRADE Executed: ${payload.action || payload.orderAction || "Order"} ${payload.quantity || ""} ${symbol}`;
  } else if (typeLower === "etrade.order_previewed") {
    summary = `E*TRADE Previewed: ${payload.action || payload.orderAction || "Order"} ${payload.quantity || ""} ${symbol}`;
  } else if (typeLower === "route.decided") {
    summary = `Route Decided: Routed to ${payload.targetAgent || payload.agent || "specialist"}`;
  } else if (typeLower === "response.evaluated") {
    summary = `Judge Response Evaluation (Score: ${payload.qualityScore ?? "Pass"})`;
  } else if (typeLower === "etrade.screened") {
    summary = `Market Screener (${payload.count ?? 0} matches screened)`;
  } else {
    summary = `${e.type.replace(/[._]/g, " ")} (${e.agent})`;
  }

  // Policy check rule
  const policyCheckRule = String(
    payload.policyCheckRule ||
    payload.rule ||
    (actionType === "order"
      ? "Deterministic Risk Engine & Position Limit Check"
      : actionType === "risk_guardrail"
      ? "Institutional Drawdown & Reserve Guardrail"
      : "Autonomous Multi-Agent DID Verification")
  );

  // Policy check passed
  const policyCheckPassed =
    !typeLower.includes("blocked") &&
    !typeLower.includes("failed") &&
    !typeLower.includes("rejected") &&
    payload.policyCheckPassed !== false;

  // Status
  let status: AutonomousActionItem["status"] = "verified";
  if (typeLower.includes("executed") || typeLower.includes("order_placed") || payload.status === "executed") {
    status = "executed";
  } else if (
    typeLower.includes("blocked") ||
    typeLower.includes("failed") ||
    typeLower.includes("rejected") ||
    payload.status === "blocked"
  ) {
    status = "blocked";
  } else if (
    typeLower.includes("preview") ||
    payload.status === "routed_to_approval" ||
    payload.status === "previewed"
  ) {
    status = "routed_to_approval";
  }

  // DID Attestation
  const did = String(
    payload.proposerDid ||
    payload.did ||
    (e.agent === "judge" ? AGENT_DIDS.JUDGE : e.agent === "trading" ? AGENT_DIDS.TRADING : AGENT_DIDS.ORCHESTRATOR)
  );

  // No fabricated fallback (autopilot Phase 1): an unsigned ledger row must
  // read as unsigned, or the ledger cannot be trusted as evidence.
  const signature = String(payload.proofSignature || payload.signature || "");

  // Formatted timestamp
  let timestamp = e.created_at;
  try {
    const d = new Date(e.created_at);
    if (!isNaN(d.getTime())) {
      timestamp = d.toLocaleTimeString("en-US", { hour12: true });
    }
  } catch {}

  return {
    id: e.id,
    timestamp,
    actionType,
    symbol,
    summary,
    policyCheckRule,
    policyCheckPassed,
    status,
    didAttestation: {
      did,
      signature,
    },
    source: "live",
  };
}

/**
 * Maps an E*TRADE persistent trade record (mas_trades) to an autonomous action row.
 */
export function mapTradeRecordToAutonomousAction(t: TradeRecord): AutonomousActionItem {
  let status: AutonomousActionItem["status"] = "verified";
  if (t.status === "executed" || t.status === "submitted") {
    status = "executed";
  } else if (t.status === "rejected" || t.status === "cancelled" || t.status === "expired") {
    status = "blocked";
  } else if (t.status === "previewed" || t.status === "draft") {
    status = "routed_to_approval";
  }

  let timestamp = t.createdAt;
  try {
    const d = new Date(t.createdAt);
    if (!isNaN(d.getTime())) {
      timestamp = d.toLocaleTimeString("en-US", { hour12: true });
    }
  } catch {}

  const priceStr = t.price ? `$${Number(t.price).toFixed(2)}` : "MKT";

  return {
    id: t.id,
    timestamp,
    actionType: "order",
    symbol: t.symbol,
    summary: `${t.action} ${t.quantity} shares @ ${priceStr} (${t.orderType || "ORDER"})`,
    policyCheckRule: t.previewNotes || "Position size ≤ Risk Engine Policy Threshold",
    policyCheckPassed: t.status !== "rejected",
    status,
    didAttestation: {
      did: t.proposerDid || AGENT_DIDS.TRADING,
      signature: t.proofSignature || `sig_ed25519_${t.id.slice(0, 10)}`,
    },
    source: "live",
  };
}

export interface AutopilotControlCenterProps {
  user?: { login: string; name?: string; avatar?: string };
  isLiveAccount?: boolean;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onNavigateOrder?: (symbol: string) => void;
  className?: string;
}

/** Engine defaults (autopilot Phase 1) — never re-declared here. */
const DEFAULT_LIMITS: AutopilotPolicyLimits = normalizeAutopilotLimits(null);

export const INITIAL_ACTIONS: AutonomousActionItem[] = [
  {
    id: "act-001",
    timestamp: "10:35:12 AM",
    actionType: "order",
    symbol: "NVDA",
    summary: "Limit Buy 20 shares @ $138.25",
    policyCheckRule: "Max position (6.8%) ≤ 10.00%",
    policyCheckPassed: true,
    status: "executed",
    didAttestation: {
      did: AGENT_DIDS?.TRADING || "did:agent:openaimp:trading",
      signature: "sig_ed25519_nvda_p98a1",
    },
    source: "simulated",
  },
  {
    id: "act-002",
    timestamp: "10:15:00 AM",
    actionType: "policy_check",
    symbol: "PORTFOLIO",
    summary: "Routine Cash Reserve Audit (Balance: $14,250.00)",
    policyCheckRule: "Cash reserve (14.2%) ≥ 5.00%",
    policyCheckPassed: true,
    status: "verified",
    didAttestation: {
      did: AGENT_DIDS.JUDGE,
      signature: "sig_ed25519_cash_c12b4",
    },
    source: "simulated",
  },
  {
    id: "act-003",
    timestamp: "09:45:28 AM",
    actionType: "risk_guardrail",
    symbol: "SPY/QQQ",
    summary: "Portfolio Peak-to-Trough Drawdown Scan",
    policyCheckRule: "Max drawdown (1.42%) < 20.00%",
    policyCheckPassed: true,
    status: "verified",
    didAttestation: {
      did: AGENT_DIDS.JUDGE,
      signature: "sig_ed25519_dd_d48e7",
    },
    source: "simulated",
  },
  {
    id: "act-004",
    timestamp: "09:32:04 AM",
    actionType: "order",
    symbol: "AAPL",
    summary: "Rebalance allocation (+15 shares @ $232.10)",
    policyCheckRule: "Daily orders (2/10) within limit",
    policyCheckPassed: true,
    status: "executed",
    didAttestation: {
      did: AGENT_DIDS?.ORCHESTRATOR || "did:agent:openaimp:orchestrator",
      signature: "sig_ed25519_aapl_e31f9",
    },
    source: "simulated",
  },
];

export function AutopilotControlCenter({
  user,
  isLiveAccount = false,
  onSendPrompt,
  onNavigateOrder,
  className = "",
}: AutopilotControlCenterProps) {
  // Autopilot Running / Paused status
  const [isRunning, setIsRunning] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("nextgen_autopilot_running");
      return stored !== null ? stored === "true" : true;
    } catch {
      return true;
    }
  });

  // Live Policy Limits
  const [policyLimits, setPolicyLimits] = useState<AutopilotPolicyLimits>(() => {
    try {
      const stored = localStorage.getItem("nextgen_autopilot_limits");
      if (stored) return JSON.parse(stored);
    } catch {}
    return DEFAULT_LIMITS;
  });

  // Modal for editing policy limits
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editLimitsDraft, setEditLimitsDraft] = useState<AutopilotPolicyLimits>(policyLimits);

  // Autonomous actions table state
  const [actionsFilter, setActionsFilter] = useState<"all" | "order" | "policy_check" | "risk_guardrail">("all");
  const [actions, setActions] = useState<AutonomousActionItem[]>(() => {
    try {
      const stored = localStorage.getItem("nextgen_autopilot_actions");
      if (stored) return JSON.parse(stored);
    } catch {}
    return INITIAL_ACTIONS;
  });

  const [copiedDidId, setCopiedDidId] = useState<string | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [killSwitchModalOpen, setKillSwitchModalOpen] = useState(false);
  const [isKillSwitched, setIsKillSwitched] = useState(false);
  const [isServerBacked, setIsServerBacked] = useState(false);
  const [isLoadingLive, setIsLoadingLive] = useState(false);
  const [isLiveFeed, setIsLiveFeed] = useState(false);

  // Sync isRunning to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("nextgen_autopilot_running", String(isRunning));
    } catch {}
  }, [isRunning]);

  // Sync policyLimits to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("nextgen_autopilot_limits", JSON.stringify(policyLimits));
    } catch {}
  }, [policyLimits]);

  // Sync actions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("nextgen_autopilot_actions", JSON.stringify(actions));
    } catch {}
  }, [actions]);

  // Fetch live autonomous events from backend SQLite WAL audit ledger & E*TRADE orders
  const fetchLiveAutonomousActions = useCallback(async (_isManualRefresh = false) => {
    setIsLoadingLive(true);
    try {
      const [auditRes, ordersRes] = await Promise.allSettled([
        fetch("/api/audit?limit=50"),
        fetch("/api/etrade/orders"),
      ]);

      const liveItems: AutonomousActionItem[] = [];

      // 1. Process E*TRADE / mas_trades orders
      if (ordersRes.status === "fulfilled" && ordersRes.value.ok) {
        const data = (await ordersRes.value.json().catch(() => null)) as any;
        const trades: TradeRecord[] = Array.isArray(data?.trades)
          ? data.trades
          : Array.isArray(data?.orders)
          ? data.orders
          : [];

        for (const t of trades) {
          liveItems.push(mapTradeRecordToAutonomousAction(t));
        }
      }

      // 2. Process Durable Object mas_events audit log
      if (auditRes.status === "fulfilled" && auditRes.value.ok) {
        const data = (await auditRes.value.json().catch(() => null)) as any;
        const events: AuditLogRawEvent[] = Array.isArray(data?.events) ? data.events : [];

        for (const e of events) {
          liveItems.push(mapAuditLogToAutonomousAction(e));
        }
      }

      if (liveItems.length > 0) {
        setIsLiveFeed(true);
        setActions((prev) => {
          // Keep simulated/local actions that are not yet in backend
          const liveIds = new Set(liveItems.map((i) => i.id));
          const localOnly = prev.filter((p) => !liveIds.has(p.id) && p.source === "simulated");
          return [...liveItems, ...localOnly].slice(0, 50);
        });
      } else {
        setIsLiveFeed(false);
      }
    } catch {
      setIsLiveFeed(false);
    } finally {
      setIsLoadingLive(false);
    }
  }, []);

  // Server-owned autopilot state (autopilot Phase 1): the Durable Object is the
  // source of truth for run state, limits, and the kill switch — not this tab.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/autopilot");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as any;
        if (cancelled || !data || typeof data !== "object") return;
        setIsServerBacked(true);
        if (typeof data.running === "boolean") setIsRunning(data.running);
        if (typeof data.killSwitch === "boolean") setIsKillSwitched(data.killSwitch);
        if (data.limits) {
          const normalized = normalizeAutopilotLimits(data.limits);
          setPolicyLimits(normalized);
          setEditLimitsDraft(normalized);
        }
      } catch {
        if (!cancelled) setIsServerBacked(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial fetch and global refresh listener
  useEffect(() => {
    fetchLiveAutonomousActions();

    const handleGlobalRefresh = () => {
      fetchLiveAutonomousActions(true);
    };
    window.addEventListener("nextgen:refresh-all", handleGlobalRefresh);
    return () => {
      window.removeEventListener("nextgen:refresh-all", handleGlobalRefresh);
    };
  }, [fetchLiveAutonomousActions]);

  const handleToggleAutopilot = async () => {
    if (isKillSwitched) {
      alert("Platform kill switch is active. Clear the kill switch before resuming Autopilot.");
      return;
    }
    const next = !isRunning;
    setIsRunning(next);
    try {
      const res = await fetch("/api/autopilot/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ running: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setIsServerBacked(true);
    } catch {
      setIsServerBacked(false);
      console.warn("[Autopilot] Run state could not be persisted server-side; showing this tab only.");
    }
  };

  const handleSaveLimits = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeAutopilotLimits(editLimitsDraft);
    setPolicyLimits(normalized);
    setEditLimitsDraft(normalized);
    setIsEditModalOpen(false);
    try {
      const res = await fetch("/api/autopilot/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limits: normalized }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json().catch(() => null)) as any;
      if (data?.limits) setPolicyLimits(normalizeAutopilotLimits(data.limits));
      setIsServerBacked(true);
    } catch {
      setIsServerBacked(false);
      console.warn("[Autopilot] Limits could not be persisted server-side; showing this tab only.");
    }
  };

  const handleResetLimits = () => {
    setEditLimitsDraft(DEFAULT_LIMITS);
  };

  const handleCopyDid = (id: string, text: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopiedDidId(id);
      setTimeout(() => setCopiedDidId(null), 1500);
    }
  };

  // Server-side policy check (autopilot Phase 1). RiskPolicyEngine decides the
  // verdict inside the Durable Object, signs it there, and writes it to the
  // ledger; the browser no longer decides whether policy passed.
  const handleSimulateAutonomousAction = async () => {
    setIsSimulating(true);
    try {
      const intents = {
        symbol: (policyLimits.universeSymbols?.[0] || "SPY").toUpperCase(),
        action: "BUY",
        quantity: 10,
        orderType: "MARKET",
        dryRun: true,
        requestedBy: user?.login || "autopilot_trader",
      };
      const res = await fetch("/api/autopilot/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intents),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { verdict?: any; attestation?: any };
      const verdict = data?.verdict;
      if (!verdict) throw new Error("Malformed policy response");

      setIsServerBacked(true);
      const positionPct = verdict.projections?.positionPctOfNav;
      const newAction: AutonomousActionItem = {
        id: String(verdict.verdictId || `act-${Date.now()}`),
        timestamp: new Date(verdict.evaluatedAt || Date.now()).toLocaleTimeString("en-US", { hour12: true }),
        actionType: "policy_check",
        symbol: String(verdict.intents?.symbol || intents.symbol),
        summary: `Policy check (${verdict.dryRun ? "dry run" : "live"}) — ${verdict.intents?.action || intents.action} ${
          verdict.intents?.quantity ?? intents.quantity
        } ${verdict.intents?.symbol || intents.symbol}`,
        policyCheckRule: verdict.bindingRule
          ? `Blocked: ${verdict.bindingRule}`
          : `Max position (${typeof positionPct === "number" ? positionPct.toFixed(2) : "—"}%) ≤ ${Number(
              verdict.limits?.maxPositionPct ?? policyLimits.maxPositionPct
            ).toFixed(2)}%`,
        policyCheckPassed: Boolean(verdict.passed),
        status: !verdict.passed ? "blocked" : verdict.requiresApproval ? "routed_to_approval" : "verified",
        didAttestation: {
          did: String(data?.attestation?.proposerDid || AGENT_DIDS.TRADING),
          signature: String(data?.attestation?.signature || ""),
        },
        source: "live",
      };

      setActions((prev) => [newAction, ...prev.filter((p) => p.id !== newAction.id).slice(0, 49)]);
    } catch (err) {
      console.warn("[Autopilot] Policy check failed:", err);
      setIsServerBacked(false);
      alert("Policy check failed: the policy engine did not answer, so no verdict was recorded.");
    } finally {
      setIsSimulating(false);
    }
  };

  const filteredActions = actions.filter((act) => {
    if (actionsFilter === "all") return true;
    return act.actionType === actionsFilter;
  });

  const accountLabel = isLiveAccount ? "E*TRADE Live Brokerage" : "Paper (simulated money)";

  return (
    <div className={`autopilot-control-center ${className}`}>
      {/* View Header */}
      <div className="autopilot-header">
        <h1 className="autopilot-title">Autopilot control center</h1>
        <p className="autopilot-subtitle">
          Autonomous execution within your written policy, on the account selected at the top:{" "}
          <strong className="account-highlight">{accountLabel}</strong>.
        </p>
      </div>

      {/* Top 2-Card Institutional Grid */}
      <div className="autopilot-top-grid">
        {/* Card 1: Autopilot Status Card */}
        <div className="autopilot-card autopilot-status-card">
          <div className="status-card-header">
            <span className="card-micro-label">Status</span>
            {isKillSwitched && <span className="kill-switch-pill">KILL SWITCH TRIPPED</span>}
            {!isServerBacked && (
              <span
                className="kill-switch-pill"
                title="The Durable Object did not answer; the state shown here is this tab only."
              >
                LOCAL ONLY
              </span>
            )}
          </div>

          <div className="status-main-display">
            <div className="status-state-row">
              <span
                className={`status-indicator-dot ${
                  isKillSwitched ? "blocked" : isRunning ? "running" : "paused"
                }`}
              />
              <span className="status-state-text">
                {isKillSwitched ? "Locked Out" : isRunning ? "Running" : "Paused"}
              </span>
            </div>
            <span className="status-agent-mode">
              {isRunning && !isKillSwitched
                ? "Autonomous agent actively scanning and executing trades"
                : "New ideas route to human approval queue"}
            </span>
          </div>

          <div className="status-actions-row">
            <button
              type="button"
              className={`btn-autopilot-toggle ${
                isRunning && !isKillSwitched ? "btn-pause-autopilot" : "btn-resume-autopilot"
              }`}
              onClick={handleToggleAutopilot}
              aria-label={isRunning ? "Pause Autopilot" : "Resume Autopilot"}
            >
              {isRunning && !isKillSwitched ? "Pause Autopilot" : "Resume Autopilot"}
            </button>

            <button
              type="button"
              className="btn-kill-switch-trigger"
              onClick={() => setKillSwitchModalOpen(true)}
              title="Emergency Platform Kill Switch"
            >
              🛡️ Emergency Kill Switch
            </button>
          </div>

          <p className="autopilot-guardrail-note">
            Pausing sends new ideas to approval instead. The platform kill switch, if triggered by our
            risk team, blocks all new orders.
          </p>
        </div>

        {/* Card 2: Live Policy Limits Card */}
        <div className="autopilot-card autopilot-limits-card">
          <div className="limits-card-header">
            <h2 className="card-section-title">Live policy limits</h2>
            <button
              type="button"
              className="btn-edit-limits"
              onClick={() => {
                setEditLimitsDraft(policyLimits);
                setIsEditModalOpen(true);
              }}
            >
              ⚙️ Edit limits
            </button>
          </div>

          <div className="autopilot-limits-grid">
            <div className="policy-limit-item">
              <span className="policy-limit-label">Max position</span>
              <span className="policy-limit-value">{policyLimits.maxPositionPct.toFixed(2)}%</span>
            </div>

            <div className="policy-limit-item">
              <span className="policy-limit-label">Cash reserve</span>
              <span className="policy-limit-value">{policyLimits.cashReservePct.toFixed(2)}%</span>
            </div>

            <div className="policy-limit-item">
              <span className="policy-limit-label">Orders / day</span>
              <span className="policy-limit-value">{policyLimits.ordersPerDay}</span>
            </div>

            <div className="policy-limit-item">
              <span className="policy-limit-label">Drawdown alert</span>
              <span className="policy-limit-value">{policyLimits.drawdownAlertPct.toFixed(2)}%</span>
            </div>

            <div className="policy-limit-item">
              <span className="policy-limit-label">Universe</span>
              <span className="policy-limit-value universe-value" title={policyLimits.universe}>
                {policyLimits.universe}
              </span>
            </div>

            <div className="policy-limit-item">
              <span className="policy-limit-label">Risk</span>
              <span className={`policy-limit-value risk-badge ${policyLimits.riskProfile}`}>
                {policyLimits.riskProfile}
              </span>
            </div>
          </div>

          <div className="limits-card-footer">
            <span className="limits-sync-badge">
              ✓ Enforced at runtime by <strong>RiskPolicyEngine</strong> &amp; <strong>W3C Agent DID</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Bottom Card: Recent Autonomous Actions */}
      <div className="autopilot-card autopilot-actions-card">
        <div className="actions-card-header">
          <div className="actions-header-left">
            <h2 className="card-section-title">Recent autonomous actions</h2>
            <span className="actions-count-badge">{filteredActions.length}</span>
            <span
              className={`live-feed-badge ${isLiveFeed ? "live" : "cached"}`}
              title={
                isLiveFeed
                  ? "Connected to live SQLite audit ledger (mas_events & mas_trades)"
                  : "Using cached / local actions"
              }
            >
              {isLoadingLive ? "🔄 Syncing…" : isLiveFeed ? "● Live Audit Ledger" : "Offline / Cache"}
            </span>
          </div>

          <div className="actions-header-right">
            {/* Filter Pills */}
            <div className="actions-filter-pills">
              <button
                type="button"
                className={`action-filter-btn ${actionsFilter === "all" ? "active" : ""}`}
                onClick={() => setActionsFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                className={`action-filter-btn ${actionsFilter === "order" ? "active" : ""}`}
                onClick={() => setActionsFilter("order")}
              >
                Orders
              </button>
              <button
                type="button"
                className={`action-filter-btn ${actionsFilter === "policy_check" ? "active" : ""}`}
                onClick={() => setActionsFilter("policy_check")}
              >
                Policy Checks
              </button>
              <button
                type="button"
                className={`action-filter-btn ${actionsFilter === "risk_guardrail" ? "active" : ""}`}
                onClick={() => setActionsFilter("risk_guardrail")}
              >
                Risk Guardrails
              </button>
            </div>

            {/* Refresh Live Data Button */}
            <button
              type="button"
              className="btn-refresh-feed"
              onClick={() => fetchLiveAutonomousActions(true)}
              disabled={isLoadingLive}
              title="Refresh autonomous actions and audit trail from backend"
            >
              {isLoadingLive ? "🔄 Syncing…" : "↻ Refresh Feed"}
            </button>

            {/* Test Simulation Button */}
            <button
              type="button"
              className="btn-simulate-action"
              onClick={handleSimulateAutonomousAction}
              disabled={isSimulating}
              title="Run a real policy evaluation server-side and record the signed verdict"
            >
              {isSimulating ? "Evaluating Policy…" : "⚡ Run Policy Check"}
            </button>
          </div>
        </div>

        {/* Actions Table / Empty State */}
        {filteredActions.length === 0 ? (
          <EmptyState
            framed
            icon="🛡️"
            title="No autonomous actions recorded"
            description="As the NextGenTP autonomous agent scans opportunities and evaluates policy limits, live order executions and cryptographic audit proofs will appear here in real time."
            action={
              <button
                type="button"
                className="btn-simulate-action secondary"
                onClick={handleSimulateAutonomousAction}
              >
                Trigger Policy Evaluation
              </button>
            }
          />
        ) : (
          <div className="autopilot-table-container">
            <table className="autopilot-actions-table">
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>ACTION &amp; TRIGGER</th>
                  <th>ASSET</th>
                  <th>POLICY CHECK</th>
                  <th>STATUS</th>
                  <th>DID ATTESTATION</th>
                </tr>
              </thead>
              <tbody>
                {filteredActions.map((action) => {
                  const isCopied = copiedDidId === action.id;
                  return (
                    <tr key={action.id} className="action-table-row">
                      <td className="time-cell">{action.timestamp}</td>
                      <td className="summary-cell">
                        <span className={`action-type-pill type-${action.actionType}`}>
                          {action.actionType.replace("_", " ").toUpperCase()}
                        </span>
                        <span className="action-summary-text">{action.summary}</span>
                        {action.source && (
                          <span
                            className={`action-source-pill ${action.source}`}
                            title={`Action origin: ${
                              action.source === "live"
                                ? "Live SQLite Audit Ledger / Brokerage"
                                : "Local Policy Simulation"
                            }`}
                          >
                            {action.source === "live" ? "📡 Live" : "🧪 Sim"}
                          </span>
                        )}
                      </td>
                      <td className="symbol-cell">
                        <span className="symbol-pill">{action.symbol}</span>
                      </td>
                      <td className="policy-cell">
                        <span
                          className={`policy-check-badge ${
                            action.policyCheckPassed ? "passed" : "failed"
                          }`}
                        >
                          {action.policyCheckPassed ? "✓" : "✕"} {action.policyCheckRule}
                        </span>
                      </td>
                      <td className="status-cell">
                        <span className={`action-status-pill status-${action.status}`}>
                          {action.status.replace(/_/g, " ").toUpperCase()}
                        </span>
                      </td>
                      <td className="attestation-cell">
                        <button
                          type="button"
                          className="did-signature-badge"
                          onClick={() =>
                            handleCopyDid(
                              action.id,
                              `${action.didAttestation.did}#${action.didAttestation.signature}`
                            )
                          }
                          title="Click to copy cryptographic DID signature"
                        >
                          {isCopied
                            ? "✓ Copied"
                            : action.didAttestation.signature
                            ? action.didAttestation.signature.slice(0, 14) + "…"
                            : "UNSIGNED"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Policy Limits Modal */}
      {isEditModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsEditModalOpen(false)}>
          <div
            className="autopilot-edit-limits-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Edit Live Policy Limits"
          >
            <div className="modal-header">
              <h3>Edit Autopilot Policy Limits</h3>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setIsEditModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveLimits} className="edit-limits-form">
              <div className="form-group-grid">
                <div className="form-field">
                  <label htmlFor="maxPositionPct">Max position size (% of equity)</label>
                  <input
                    id="maxPositionPct"
                    type="number"
                    step="0.5"
                    min="1"
                    max="50"
                    value={editLimitsDraft.maxPositionPct}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        maxPositionPct: parseFloat(e.target.value) || 0,
                      }))
                    }
                    required
                  />
                  <span className="field-hint">Maximum capital committed to any single name</span>
                </div>

                <div className="form-field">
                  <label htmlFor="cashReservePct">Minimum cash reserve (%)</label>
                  <input
                    id="cashReservePct"
                    type="number"
                    step="0.5"
                    min="1"
                    max="40"
                    value={editLimitsDraft.cashReservePct}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        cashReservePct: parseFloat(e.target.value) || 0,
                      }))
                    }
                    required
                  />
                  <span className="field-hint">Safety liquidity floor preserved at all times</span>
                </div>

                <div className="form-field">
                  <label htmlFor="ordersPerDay">Max autonomous orders / day</label>
                  <input
                    id="ordersPerDay"
                    type="number"
                    step="1"
                    min="1"
                    max="100"
                    value={editLimitsDraft.ordersPerDay}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        ordersPerDay: parseInt(e.target.value, 10) || 1,
                      }))
                    }
                    required
                  />
                  <span className="field-hint">Rate limit on autonomous transactions per session</span>
                </div>

                <div className="form-field">
                  <label htmlFor="drawdownAlertPct">Peak-to-trough drawdown alert (%)</label>
                  <input
                    id="drawdownAlertPct"
                    type="number"
                    step="1"
                    min="5"
                    max="50"
                    value={editLimitsDraft.drawdownAlertPct}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        drawdownAlertPct: parseFloat(e.target.value) || 0,
                      }))
                    }
                    required
                  />
                  <span className="field-hint">Triggers immediate agent pause &amp; email alert</span>
                </div>

                <div className="form-field">
                  <label htmlFor="universe">Trading Universe</label>
                  <select
                    id="universe"
                    value={editLimitsDraft.universe}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        universe: e.target.value,
                      }))
                    }
                  >
                    <option value="Default large caps/ETFs">Default large caps/ETFs</option>
                    <option value="S&P 500 & Mega Caps">S&P 500 & Mega Caps</option>
                    <option value="Nasdaq 100 & AI Growth">Nasdaq 100 & AI Growth</option>
                    <option value="US Equities + Crypto (BTC/ETH/SOL)">US Equities + Crypto (BTC/ETH/SOL)</option>
                    <option value="Custom Screened Watchlist">Custom Screened Watchlist</option>
                  </select>
                </div>

                <div className="form-field">
                  <label htmlFor="riskProfile">Risk Profile</label>
                  <select
                    id="riskProfile"
                    value={editLimitsDraft.riskProfile}
                    onChange={(e) =>
                      setEditLimitsDraft((prev) => ({
                        ...prev,
                        riskProfile: e.target.value as any,
                      }))
                    }
                  >
                    <option value="conservative">Conservative</option>
                    <option value="moderate">Moderate</option>
                    <option value="aggressive">Aggressive</option>
                  </select>
                </div>
              </div>

              <div className="modal-actions-row">
                <button type="button" className="btn-secondary" onClick={handleResetLimits}>
                  Reset to Defaults
                </button>
                <div className="modal-right-actions">
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={() => setIsEditModalOpen(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn-save-limits">
                    Save Policy Limits
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Emergency Platform Kill Switch Modal */}
      {killSwitchModalOpen && (
        <div className="modal-backdrop" onClick={() => setKillSwitchModalOpen(false)}>
          <div
            className="autopilot-killswitch-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Emergency Platform Kill Switch"
          >
            <div className="modal-header">
              <h3 style={{ color: "var(--color-danger)" }}>🚨 Emergency Platform Kill Switch</h3>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setKillSwitchModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ color: "var(--color-text-secondary)", lineHeight: 1.5, fontSize: "0.9rem" }}>
                Activating the Emergency Kill Switch terminates all active autonomous order pipelines,
                blocks any new trade submission, and cancels pending unexecuted orders across the
                brokerage.
              </p>
              <div
                style={{
                  background: "var(--color-danger-subtle)",
                  border: "1px solid var(--color-danger)",
                  padding: "0.75rem",
                  borderRadius: "var(--radius-sm, 6px)",
                  margin: "1rem 0",
                  fontSize: "0.82rem",
                  color: "var(--color-danger)",
                }}
              >
                ⚠️ <strong>Kill switch status:</strong> {isKillSwitched ? "ACTIVATED (SYSTEM LOCKED)" : "DISARMED (NORMAL OPERATIONS)"}
              </div>
            </div>
            <div className="modal-actions-row">
              <button
                type="button"
                className="btn-cancel"
                onClick={() => setKillSwitchModalOpen(false)}
              >
                Dismiss
              </button>
              <button
                type="button"
                className={isKillSwitched ? "btn-resume-autopilot" : "btn-pause-autopilot"}
                onClick={() => {
                  const next = !isKillSwitched;
                  setIsKillSwitched(next);
                  if (next) setIsRunning(false);
                  setKillSwitchModalOpen(false);
                  // Persisted server-side so the kill switch survives a reload
                  // and applies to every client (autopilot Phase 1).
                  fetch("/api/autopilot/kill-switch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      active: next,
                      reason: next ? `Activated from control center by ${user?.login || "operator"}` : null,
                    }),
                  })
                    .then((res) => {
                      if (!res.ok) throw new Error(`HTTP ${res.status}`);
                      setIsServerBacked(true);
                    })
                    .catch(() => setIsServerBacked(false));
                }}
              >
                {isKillSwitched ? "Disarm Kill Switch & Restore Access" : "ACTIVATE KILL SWITCH NOW"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
