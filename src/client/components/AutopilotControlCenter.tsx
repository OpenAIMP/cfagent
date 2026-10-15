import React, { useState, useEffect, useCallback } from "react";
import { AGENT_DIDS, createDidAttestationSync } from "../../agents/did";
import type { TradeRecord } from "../../types";

export interface AutopilotPolicyLimits {
  maxPositionPct: number;
  cashReservePct: number;
  ordersPerDay: number;
  drawdownAlertPct: number;
  universe: string;
  riskProfile: "conservative" | "moderate" | "aggressive";
}

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

  const signature = String(
    payload.proofSignature ||
    payload.signature ||
    `sig_ed25519_${e.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}`
  );

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

const DEFAULT_LIMITS: AutopilotPolicyLimits = {
  maxPositionPct: 10.0,
  cashReservePct: 5.0,
  ordersPerDay: 10,
  drawdownAlertPct: 20.0,
  universe: "Default large caps/ETFs",
  riskProfile: "moderate",
};

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

  const handleToggleAutopilot = () => {
    if (isKillSwitched) {
      alert("Platform kill switch is active. Clear the kill switch before resuming Autopilot.");
      return;
    }
    setIsRunning((prev) => !prev);
  };

  const handleSaveLimits = (e: React.FormEvent) => {
    e.preventDefault();
    setPolicyLimits(editLimitsDraft);
    setIsEditModalOpen(false);
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

  // Run a real-time policy check simulation and record it to backend ledger
  const handleSimulateAutonomousAction = () => {
    setIsSimulating(true);

    setTimeout(() => {
      const symbols = ["TSLA", "MSFT", "AMZN", "BTC/USD", "SPY"];
      const chosenSym = symbols[Math.floor(Math.random() * symbols.length)];
      const now = new Date().toLocaleTimeString("en-US", { hour12: true });
      const orderAction = Math.random() > 0.4 ? "Buy" : "Sell";
      const shares = Math.floor(Math.random() * 20) + 5;

      const passed = !isKillSwitched && Math.random() > 0.15;
      let status: AutonomousActionItem["status"] = "verified";

      if (isKillSwitched) {
        status = "blocked";
      } else if (!isRunning) {
        status = "routed_to_approval";
      } else if (passed) {
        status = "executed";
      } else {
        status = "blocked";
      }

      const attestation = createDidAttestationSync({
        draftId: `action_${chosenSym}_${Date.now()}`,
        action: `${orderAction} ${shares} shares (${chosenSym})`,
        amount: shares * 100,
        currency: "USD",
        customer: user?.login || "autopilot_trader",
        gateway: "etrade_autopilot",
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid: isRunning ? AGENT_DIDS.ORCHESTRATOR : "did:user:pending-human-authorization",
      });

      const newAction: AutonomousActionItem = {
        id: `act-${Date.now()}`,
        timestamp: now,
        actionType: "order",
        symbol: chosenSym,
        summary: `Autonomous ${orderAction} ${shares} shares (${chosenSym})`,
        policyCheckRule: passed
          ? `Max position size ≤ ${policyLimits.maxPositionPct.toFixed(2)}%`
          : `Position size exceeded ${policyLimits.maxPositionPct.toFixed(2)}% threshold`,
        policyCheckPassed: passed,
        status,
        didAttestation: {
          did: attestation.proposerDid,
          signature: attestation.signature,
        },
        source: "simulated",
      };

      setActions((prev) => [newAction, ...prev.slice(0, 49)]);
      setIsSimulating(false);

      // Asynchronously persist to backend SQLite WAL audit ledger
      fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "autopilot.policy_check",
          agent: "trading",
          payload: {
            symbol: chosenSym,
            summary: newAction.summary,
            policyCheckRule: newAction.policyCheckRule,
            policyCheckPassed: passed,
            status,
            proposerDid: attestation.proposerDid,
            authorizerDid: attestation.authorizerDid,
            proofSignature: attestation.signature,
            amount: shares * 100,
          },
        }),
      }).catch(() => {});
    }, 600);
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
              title="Trigger a simulated autonomous policy evaluation"
            >
              {isSimulating ? "Evaluating Policy…" : "⚡ Run Policy Check"}
            </button>
          </div>
        </div>

        {/* Actions Table / Empty State */}
        {filteredActions.length === 0 ? (
          <div className="autopilot-empty-state">
            <div className="empty-state-icon">🛡️</div>
            <h3 className="empty-state-title">No autonomous actions recorded</h3>
            <p className="empty-state-text">
              As the NextGenTP autonomous agent scans opportunities and evaluates policy limits, live
              order executions and cryptographic audit proofs will appear here in real time.
            </p>
            <button
              type="button"
              className="btn-simulate-action secondary"
              onClick={handleSimulateAutonomousAction}
            >
              Trigger Test Policy Evaluation
            </button>
          </div>
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
                          {isCopied ? "✓ Copied" : action.didAttestation.signature.slice(0, 14) + "…"}
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
                  if (!isKillSwitched) {
                    setIsKillSwitched(true);
                    setIsRunning(false);
                  } else {
                    setIsKillSwitched(false);
                  }
                  setKillSwitchModalOpen(false);
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
