import React, { useState, useEffect, useCallback } from "react";
import { apiFetch as fetch } from "../apiFetch";
import "./scheduledOptions.css";

export interface ScheduledTaskItem {
  id: string;
  type: "interval" | "cron" | "delayed" | "scheduled";
  callback: string;
  payload?: any;
  intervalSeconds?: number;
  cron?: string;
  date?: string;
  delayInSeconds?: number;
  createdAt?: string;
  nextRun?: string;
}

export interface ScheduledOptionsManagerProps {
  activeEnv?: string;
  userLogin?: string;
  onPreviewTrade?: (candidate: any) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

const SYMBOL_PRESETS = [
  { label: "Megacap Tech", symbols: "NVDA, AAPL, MSFT, AMZN, GOOGL" },
  { label: "Index ETFs", symbols: "SPY, QQQ, IWM, DIA" },
  { label: "Semiconductors", symbols: "NVDA, AMD, AVGO, TSM, INTC" },
  { label: "High Beta Momentum", symbols: "TSLA, META, NFLX, PLTR, COIN" },
];

const INTERVAL_PRESETS = [
  { label: "Every 15 min", seconds: 900 },
  { label: "Every 30 min", seconds: 1800 },
  { label: "Every 1 hour", seconds: 3600 },
  { label: "Every 4 hours", seconds: 14400 },
];

const CRON_PRESETS = [
  { label: "Market Open (9:30 AM ET M-F)", cron: "30 9 * * 1-5" },
  { label: "Midday Scan (12:00 PM ET M-F)", cron: "0 12 * * 1-5" },
  { label: "Market Close (4:00 PM ET M-F)", cron: "0 16 * * 1-5" },
  { label: "Daily Overnight (11:00 PM ET)", cron: "0 23 * * *" },
];

export function ScheduledOptionsManager({
  activeEnv = "sandbox",
  userLogin = "default_trader",
  onPreviewTrade,
  onSendPrompt,
}: ScheduledOptionsManagerProps) {
  // Schedules List State
  const [schedules, setSchedules] = useState<ScheduledTaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);

  // Form State
  const [targetSymbols, setTargetSymbols] = useState("NVDA, AAPL, SPY, MSFT");
  const [scheduleType, setScheduleType] = useState<"interval" | "cron">("interval");
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const [cronExpression, setCronExpression] = useState("30 9 * * 1-5");
  const [thesis, setThesis] = useState<"bullish" | "bearish" | "neutral" | "directional">("bullish");
  const [riskProfile, setRiskProfile] = useState<"conservative" | "balanced" | "aggressive">("balanced");
  const [pushToSlack, setPushToSlack] = useState(true);
  const [slackChannel, setSlackChannel] = useState("#options-alerts");
  const [emailTo, setEmailTo] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  // Live On-Demand Execution State
  const [triggeringNow, setTriggeringNow] = useState(false);
  const [liveResult, setLiveResult] = useState<any | null>(null);

  // Audit Logs State
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  // Fetch Schedules
  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/schedules", {
        headers: {
          "x-environment": activeEnv,
          "x-user-login": userLogin,
        },
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && Array.isArray(data.schedules)) {
        setSchedules(data.schedules);
      } else if (res.ok && Array.isArray(data)) {
        setSchedules(data);
      } else {
        setSchedules([]);
        if (data && data.error) setError(data.error);
      }
    } catch (err: any) {
      console.warn("[ScheduledOptionsManager] Note on fetching schedules:", err);
      setSchedules([]);
      setError("Unable to connect to durable scheduling service. Check your connection or trigger analysis directly.");
    } finally {
      setLoading(false);
    }
  }, [activeEnv, userLogin]);

  // Fetch Audit Trail
  const fetchAudit = useCallback(async () => {
    setLoadingAudit(true);
    try {
      const res = await fetch("/api/audit?limit=40", {
        headers: {
          "x-environment": activeEnv,
          "x-user-login": userLogin,
        },
      });
      const data = (await res.json()) as any;
      if (res.ok && Array.isArray(data.events)) {
        const filtered = data.events.filter((e: any) =>
          e.type.startsWith("options.") ||
          e.type.startsWith("schedule.") ||
          e.type.includes("scheduled")
        );
        setAuditLogs(filtered);
      }
    } catch {
      // Non-critical audit fetch failure
    } finally {
      setLoadingAudit(false);
    }
  }, [activeEnv, userLogin]);

  useEffect(() => {
    fetchSchedules();
    fetchAudit();
  }, [fetchSchedules, fetchAudit]);

  // Edit Existing Schedule
  const handleEditSchedule = (item: ScheduledTaskItem) => {
    setEditingScheduleId(item.id);
    const syms = item.payload?.symbols;
    setTargetSymbols(Array.isArray(syms) ? syms.join(", ") : "NVDA, AAPL, SPY, MSFT");
    setThesis(item.payload?.thesis || "bullish");
    setRiskProfile(item.payload?.riskProfile || "balanced");
    setScheduleType(item.type === "cron" ? "cron" : "interval");
    if (item.intervalSeconds) setIntervalSeconds(item.intervalSeconds);
    if (item.cron) setCronExpression(item.cron);
    setPushToSlack(item.payload?.pushToSlack !== false);
    if (item.payload?.slackChannel) setSlackChannel(item.payload.slackChannel);
    if (item.payload?.emailTo) setEmailTo(item.payload.emailTo);
    if (item.payload?.webhookUrl) setWebhookUrl(item.payload.webhookUrl);
    setModalOpen(true);
  };

  // Create or Update Schedule
  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessMsg(null);

    const symbols = targetSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const payload = {
      symbols: symbols.length > 0 ? symbols : ["NVDA", "AAPL", "SPY"],
      thesis,
      riskProfile,
      pushToSlack,
      slackChannel: pushToSlack ? slackChannel : undefined,
      emailTo: emailTo.trim() || undefined,
      webhookUrl: webhookUrl.trim() || undefined,
      environment: activeEnv,
    };

    const requestBody: any = {
      callback: "autonomousOptionsAnalysis",
      scheduleType,
      payload,
    };

    if (scheduleType === "interval") {
      requestBody.intervalSeconds = Number(intervalSeconds);
    } else {
      requestBody.cron = cronExpression.trim();
    }

    try {
      // If editing an existing schedule, cancel the prior schedule first
      if (editingScheduleId) {
        try {
          await fetch("/api/schedules/cancel", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-environment": activeEnv,
              "x-user-login": userLogin,
            },
            body: JSON.stringify({ id: editingScheduleId }),
          });
        } catch (priorErr) {
          console.warn("[ScheduledOptionsManager] Note on prior schedule cancellation:", priorErr);
        }
      }

      const res = await fetch("/api/schedules/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          "x-user-login": userLogin,
        },
        body: JSON.stringify(requestBody),
      });

      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.success) {
        setSuccessMsg(
          editingScheduleId
            ? "✓ Schedule updated successfully!"
            : `✓ Schedule created successfully! (ID: ${data.schedule?.id || "active"})`
        );
        setEditingScheduleId(null);
        setModalOpen(false);
        fetchSchedules();
        fetchAudit();
      } else {
        setError(data.error || "Failed to save schedule");
      }
    } catch (err: any) {
      setError(err.message || "Failed to save schedule");
    } finally {
      setSubmitting(false);
    }
  };

  // Cancel Schedule
  const handleCancelSchedule = async (scheduleId: string) => {
    if (!confirm(`Cancel scheduled task ${scheduleId}?`)) return;
    try {
      const res = await fetch("/api/schedules/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          "x-user-login": userLogin,
        },
        body: JSON.stringify({ id: scheduleId }),
      });
      const data = (await res.json()) as any;
      if (res.ok && (data.cancelled || data.success)) {
        setSuccessMsg(`✓ Schedule ${scheduleId} cancelled`);
        fetchSchedules();
        fetchAudit();
      } else {
        setError(data.error || "Failed to cancel schedule");
      }
    } catch (err: any) {
      setError(err.message || "Failed to cancel schedule");
    }
  };

  // Trigger Immediate Execution
  const handleTriggerNow = async (customPayload?: any) => {
    setTriggeringNow(true);
    setError(null);
    setSuccessMsg(null);
    setLiveResult(null);

    const symbols = targetSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const payload = customPayload || {
      symbols: symbols.length > 0 ? symbols : ["NVDA", "AAPL", "SPY", "MSFT"],
      thesis,
      riskProfile,
      pushToSlack,
      slackChannel: pushToSlack ? slackChannel : undefined,
      emailTo: emailTo.trim() || undefined,
      webhookUrl: webhookUrl.trim() || undefined,
      environment: activeEnv,
    };

    try {
      const res = await fetch("/api/schedules/trigger-options-analysis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          "x-user-login": userLogin,
        },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as any;
      if (res.ok && data.success) {
        setLiveResult(data.data);
        setSuccessMsg(`✓ Autonomous options analysis executed! Found ${data.data?.withTrades ?? 0} actionable setups.`);
        fetchAudit();
      } else {
        setError(data.error || "Execution failed");
      }
    } catch (err: any) {
      setError(err.message || "Failed to execute options analysis");
    } finally {
      setTriggeringNow(false);
    }
  };

  return (
    <div className="scheduled-options-manager">
      {/* Top Hero Banner */}
      <div className="sched-hero-banner">
        <div className="sched-hero-info">
          <h3>
            <span>⏰</span> Autonomous Options Screening &amp; Schedulers
          </h3>
          <p>
            Cloudflare Agents Durable Timers (<code>schedule</code> / <code>scheduleEvery</code>) execute continuously inside the <strong>OrchestratorAgent</strong> Durable Object. Screening runs 24/7 independently of whether your browser tab is open, continuously scanning Greeks and multi-leg spreads and pushing alerts to Slack, Email, Webhook, and live WebSocket broadcasts.
          </p>
        </div>

        <div className="sched-hero-actions">
          <button
            type="button"
            className="btn-sched-secondary"
            onClick={() => handleTriggerNow()}
            disabled={triggeringNow}
            title="Execute the options intelligence scan immediately on demand"
          >
            {triggeringNow ? "⚡ Running Screen…" : "⚡ Run Now"}
          </button>
          <button
            type="button"
            className="btn-sched-primary"
            onClick={() => setModalOpen(true)}
            title="Register a new durable interval or cron options screening schedule"
          >
            <span>+</span> New Options Schedule
          </button>
        </div>
      </div>

      {/* Architecture & Reliability Strip */}
      <div className="sched-arch-callout">
        <div>
          🛡️ <strong>Page-Independent Execution Guarantee:</strong> Timers persist in Cloudflare Durable Object storage. You can close this browser anytime — scheduled tasks continue firing on schedule.
        </div>
        <div className="sched-arch-badges">
          <span className="arch-pill">💬 Slack Block Kit [✓ Approve]</span>
          <span className="arch-pill">📧 Dark-Mode Payoff Briefs</span>
          <span className="arch-pill">🔗 Signed Webhooks</span>
          <span className="arch-pill">📡 WebSocket Push</span>
        </div>
      </div>

      {/* Status Messages */}
      {error && (
        <div className="options-error" role="alert" style={{ margin: 0 }}>
          {error}
        </div>
      )}
      {successMsg && (
        <div className="execution-result-banner success" style={{ margin: 0 }}>
          <span>{successMsg}</span>
        </div>
      )}

      {/* Live Result Preview Banner */}
      {liveResult && (
        <div className="live-execution-preview">
          <div className="preview-top-bar">
            <h4>⚡ Live Screening Execution Completed</h4>
            <div className="dispatch-status-pills">
              <span className={`dispatch-pill ${liveResult.notifications?.slack ? "success" : liveResult.notifications?.slack === false ? "failed" : "skipped"}`}>
                Slack: {liveResult.notifications?.slack ? "✓ Sent" : liveResult.notifications?.slack === false ? "✕ Error" : "–"}
              </span>
              <span className={`dispatch-pill ${liveResult.notifications?.email ? "success" : liveResult.notifications?.email === false ? "failed" : "skipped"}`}>
                Email: {liveResult.notifications?.email ? "✓ Delivered" : liveResult.notifications?.email === false ? "✕ Error" : "–"}
              </span>
              <span className={`dispatch-pill ${liveResult.notifications?.webhook ? "success" : liveResult.notifications?.webhook === false ? "failed" : "skipped"}`}>
                Webhook: {liveResult.notifications?.webhook ? "✓ Dispatched" : liveResult.notifications?.webhook === false ? "✕ Error" : "–"}
              </span>
              <span className="dispatch-pill success">Broadcast: ✓ Active</span>
            </div>
          </div>

          <p style={{ margin: 0, color: "#cbd5e1", fontSize: "0.88rem" }}>
            {liveResult.summary}
          </p>

          {Array.isArray(liveResult.opportunities) && liveResult.opportunities.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.75rem", marginTop: "0.5rem" }}>
              {liveResult.opportunities.map((opp: any) => {
                const cand = opp.pick?.best?.candidate;
                return (
                  <div key={opp.symbol} style={{ background: "rgba(18, 26, 47, 0.8)", border: "1px solid rgba(56, 189, 248, 0.25)", borderRadius: "8px", padding: "0.85rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                      <strong style={{ color: "#38bdf8", fontSize: "0.95rem" }}>{opp.symbol}</strong>
                      <span style={{ background: "rgba(56, 189, 248, 0.15)", color: "#38bdf8", fontSize: "0.74rem", padding: "0.15rem 0.45rem", borderRadius: "4px", fontWeight: "bold" }}>
                        Score: {opp.score}/100
                      </span>
                    </div>
                    <p style={{ color: "#f8fafc", margin: "0 0 0.5rem", fontSize: "0.84rem", fontWeight: 600 }}>
                      {cand?.label || "Options Setup"}
                    </p>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.76rem", color: "#94a3b8" }}>
                      <span>Max Profit: <strong style={{ color: "#22c55e" }}>{cand?.maxProfitUnbounded ? "∞" : `$${cand?.maxProfit?.toFixed(2) || "0"}`}</strong></span>
                      <span>Max Loss: <strong style={{ color: "#ef4444" }}>${cand?.maxLoss?.toFixed(2) || "0"}</strong></span>
                    </div>
                    {cand && onPreviewTrade && (
                      <button
                        type="button"
                        style={{ marginTop: "0.6rem", width: "100%", padding: "0.35rem", fontSize: "0.74rem", background: "rgba(37,99,235,0.2)", border: "1px solid #2563eb", color: "#60a5fa", borderRadius: "4px", cursor: "pointer", fontWeight: 600 }}
                        onClick={() => onPreviewTrade(cand)}
                      >
                        ⚡ Preview in Order Ticket
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Active Schedules Section */}
      <section className="sched-section-card">
        <header className="sched-section-header">
          <h4>
            <span>⏱️</span> Active Durable Schedules
            <span className="sched-count-pill">{schedules.length} Active</span>
          </h4>
          <button
            type="button"
            className="btn-sched-action-sm"
            onClick={fetchSchedules}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "↻ Refresh"}
          </button>
        </header>

        {schedules.length === 0 && !loading ? (
          <div className="schedules-empty-state">
            <span style={{ fontSize: "2.5rem" }}>📅</span>
            <p>No active scheduled tasks currently running.</p>
            <button
              type="button"
              className="btn-sched-primary"
              onClick={() => setModalOpen(true)}
            >
              + Create First Options Schedule
            </button>
          </div>
        ) : (
          <div className="schedules-grid">
            {schedules.map((item) => {
              const isOptions = item.callback === "autonomousOptionsAnalysis";
              const symbols = item.payload?.symbols || [];
              const thesisStr = item.payload?.thesis || "BULLISH";

              return (
                <div
                  key={item.id}
                  className={`schedule-item-card ${isOptions ? "is-options" : ""}`}
                >
                  <div className="schedule-card-top">
                    <span className={`schedule-type-badge ${item.type}`}>
                      {item.type}
                    </span>
                    <span className="schedule-id-snippet" title={item.id}>
                      {item.id.slice(0, 16)}…
                    </span>
                  </div>

                  <div>
                    <h5 className="schedule-title">
                      {isOptions ? "Autonomous Options Intelligence" : item.callback}
                    </h5>
                    <div className="schedule-cadence">
                      {item.intervalSeconds ? `Every ${Math.round(item.intervalSeconds / 60)} min` : item.cron ? `Cron: ${item.cron}` : "Scheduled Timer"}
                    </div>
                  </div>

                  <div className="schedule-payload-details">
                    <div className="payload-row">
                      <span className="payload-label">Target Symbols:</span>
                      <div className="payload-symbols-pills">
                        {symbols.length > 0 ? (
                          symbols.map((sym: string) => (
                            <span key={sym} className="sym-tag">
                              {sym}
                            </span>
                          ))
                        ) : (
                          <span className="payload-value">Sector Scanner</span>
                        )}
                      </div>
                    </div>

                    <div className="payload-row">
                      <span className="payload-label">Thesis &amp; Risk:</span>
                      <span className="payload-value">
                        {thesisStr.toUpperCase()} · {item.payload?.riskProfile || "Balanced"}
                      </span>
                    </div>

                    <div className="payload-row">
                      <span className="payload-label">Omnichannel:</span>
                      <div className="channel-indicators">
                        {item.payload?.pushToSlack && <span className="chan-badge slack" title="Slack Alerts">Slack</span>}
                        {item.payload?.emailTo && <span className="chan-badge email" title="Email Briefs">Email</span>}
                        {item.payload?.webhookUrl && <span className="chan-badge webhook" title="Signed Webhook">Webhook</span>}
                        <span className="chan-badge" style={{ background: "rgba(16,185,129,0.15)", color: "#34d399", border: "1px solid rgba(16,185,129,0.3)" }}>Broadcast</span>
                      </div>
                    </div>
                  </div>

                  <div className="schedule-card-footer">
                    <button
                      type="button"
                      className="btn-sched-action-sm"
                      onClick={() => handleTriggerNow(item.payload)}
                      disabled={triggeringNow}
                      title="Run analysis immediately with this schedule's payload"
                    >
                      ⚡ Trigger Now
                    </button>
                    <button
                      type="button"
                      className="btn-sched-action-sm"
                      style={{ background: "rgba(56, 189, 248, 0.15)", borderColor: "rgba(56, 189, 248, 0.4)", color: "#38bdf8" }}
                      onClick={() => handleEditSchedule(item)}
                      title="Update parameters or cadence for this schedule"
                    >
                      ✏ Edit / Update
                    </button>
                    <button
                      type="button"
                      className="btn-sched-cancel-sm"
                      onClick={() => handleCancelSchedule(item.id)}
                      title="Permanently cancel this durable schedule"
                    >
                      ✕ Cancel
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Execution Audit Trail Section */}
      <section className="sched-section-card">
        <header className="sched-section-header">
          <h4>
            <span>📜</span> Execution History &amp; Audit Trail
            <span className="sched-count-pill">{auditLogs.length} Events</span>
          </h4>
          <button
            type="button"
            className="btn-sched-action-sm"
            onClick={fetchAudit}
            disabled={loadingAudit}
          >
            {loadingAudit ? "Loading…" : "↻ Refresh"}
          </button>
        </header>

        {auditLogs.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.85rem", margin: "0.5rem 0" }}>
            No recent options scheduling audit logs found. Run a screen or wait for the next scheduled interval to populate this ledger.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="sched-audit-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Event Type</th>
                  <th>Symbols</th>
                  <th>Actionable Setups</th>
                  <th>Dispatched Channels</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log: any) => {
                  const payload = log.payload || {};
                  const isSuccess = !log.type.includes("failed");
                  const notifs = payload.notifications || {};

                  return (
                    <tr key={log.id}>
                      <td>{new Date(log.created_at || log.createdAt).toLocaleTimeString()}</td>
                      <td>
                        <span className={`status-indicator-dot ${isSuccess ? "green" : "red"}`} />
                        <code>{log.type}</code>
                      </td>
                      <td>
                        {Array.isArray(payload.symbols) ? payload.symbols.join(", ") : "–"}
                      </td>
                      <td>
                        <strong style={{ color: payload.withTrades > 0 ? "#22c55e" : "#94a3b8" }}>
                          {payload.withTrades ?? "–"}
                        </strong>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.3rem" }}>
                          {notifs.slack && <span className="chan-badge slack">Slack</span>}
                          {notifs.email && <span className="chan-badge email">Email</span>}
                          {notifs.webhook && <span className="chan-badge webhook">Webhook</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Create Schedule Modal */}
      {modalOpen && (
        <div className="sched-modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="sched-modal-card" onClick={(e) => e.stopPropagation()}>
            <header className="sched-modal-header">
              <div>
                <h3>{editingScheduleId ? "✏ Update Options Screening Schedule" : "⏰ Configure New Options Schedule"}</h3>
                <p>Register a durable Cloudflare Agents SDK timer to screen options 24/7 in the background.</p>
              </div>
              <button
                type="button"
                className="btn-modal-close"
                onClick={() => setModalOpen(false)}
              >
                ✕
              </button>
            </header>

            <form onSubmit={handleCreateSchedule} style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
              {/* Target Symbols Input & Quick Presets */}
              <div className="sched-form-group">
                <label className="sched-form-label">
                  Target Equity Symbols
                  <span className="hint">Comma-separated tickers</span>
                </label>
                <input
                  type="text"
                  className="sched-input"
                  value={targetSymbols}
                  onChange={(e) => setTargetSymbols(e.target.value)}
                  placeholder="e.g. NVDA, AAPL, SPY, MSFT"
                  required
                />
                <div className="preset-chips-row">
                  {SYMBOL_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className="preset-chip"
                      onClick={() => setTargetSymbols(p.symbols)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Schedule Cadence / Type */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div className="sched-form-group">
                  <label className="sched-form-label">Cadence Type</label>
                  <select
                    className="sched-select"
                    value={scheduleType}
                    onChange={(e) => setScheduleType(e.target.value as any)}
                  >
                    <option value="interval">Interval (Every X Minutes/Hours)</option>
                    <option value="cron">Cron Expression (Specific Time/Days)</option>
                  </select>
                </div>

                {scheduleType === "interval" ? (
                  <div className="sched-form-group">
                    <label className="sched-form-label">Interval Seconds</label>
                    <input
                      type="number"
                      className="sched-input"
                      value={intervalSeconds}
                      onChange={(e) => setIntervalSeconds(Number(e.target.value))}
                      min={60}
                      step={60}
                      required
                    />
                    <div className="preset-chips-row">
                      {INTERVAL_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          className="preset-chip"
                          onClick={() => setIntervalSeconds(p.seconds)}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="sched-form-group">
                    <label className="sched-form-label">Cron Expression</label>
                    <input
                      type="text"
                      className="sched-input"
                      value={cronExpression}
                      onChange={(e) => setCronExpression(e.target.value)}
                      placeholder="e.g. 30 9 * * 1-5"
                      required
                    />
                    <div className="preset-chips-row">
                      {CRON_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          className="preset-chip"
                          onClick={() => setCronExpression(p.cron)}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Thesis & Risk Profile */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div className="sched-form-group">
                  <label className="sched-form-label">Market Thesis / Outlook</label>
                  <select
                    className="sched-select"
                    value={thesis}
                    onChange={(e) => setThesis(e.target.value as any)}
                  >
                    <option value="bullish">Bullish (Calls, Bull Spreads)</option>
                    <option value="bearish">Bearish (Puts, Bear Spreads)</option>
                    <option value="neutral">Neutral (Iron Condor, Calendar)</option>
                    <option value="directional">Directional (Breakouts &amp; Straddles)</option>
                  </select>
                </div>

                <div className="sched-form-group">
                  <label className="sched-form-label">Risk Profile</label>
                  <select
                    className="sched-select"
                    value={riskProfile}
                    onChange={(e) => setRiskProfile(e.target.value as any)}
                  >
                    <option value="conservative">Conservative (High POP &gt; 65%, Defined Risk)</option>
                    <option value="balanced">Balanced (Optimal R/R &gt; 1.5x, Moderate POP)</option>
                    <option value="aggressive">Aggressive (Maximum Leverage &amp; Upside)</option>
                  </select>
                </div>
              </div>

              {/* Omnichannel Dispatch Options */}
              <div className="sched-form-group">
                <label className="sched-form-label">
                  Omnichannel Notification Dispatch
                  <span className="hint">Push trade alerts automatically</span>
                </label>

                <div className="channels-checkbox-grid">
                  {/* Slack */}
                  <label className="channel-check-card">
                    <div className="channel-check-top">
                      <input
                        type="checkbox"
                        checked={pushToSlack}
                        onChange={(e) => setPushToSlack(e.target.checked)}
                      />
                      <strong>Slack Block Kit</strong>
                    </div>
                    <span className="channel-check-desc">
                      Interactive cards with <code>[✓ Approve &amp; Preview Order]</code> buttons
                    </span>
                    {pushToSlack && (
                      <input
                        type="text"
                        className="sched-input"
                        style={{ marginTop: "0.3rem", padding: "0.4rem 0.6rem", fontSize: "0.78rem" }}
                        value={slackChannel}
                        onChange={(e) => setSlackChannel(e.target.value)}
                        placeholder="Slack Channel (e.g. #trading-desk)"
                      />
                    )}
                  </label>

                  {/* Email */}
                  <label className="channel-check-card">
                    <div className="channel-check-top">
                      <input
                        type="checkbox"
                        checked={Boolean(emailTo)}
                        onChange={(e) => setEmailTo(e.target.checked ? "trader@firm.com" : "")}
                      />
                      <strong>Dark-Mode Email Brief</strong>
                    </div>
                    <span className="channel-check-desc">
                      Detailed payoff metrics grid, breakevens, and Greeks summary
                    </span>
                    {Boolean(emailTo) && (
                      <input
                        type="email"
                        className="sched-input"
                        style={{ marginTop: "0.3rem", padding: "0.4rem 0.6rem", fontSize: "0.78rem" }}
                        value={emailTo}
                        onChange={(e) => setEmailTo(e.target.value)}
                        placeholder="Recipient Email (e.g. trader@firm.com)"
                      />
                    )}
                  </label>

                  {/* Webhook */}
                  <label className="channel-check-card">
                    <div className="channel-check-top">
                      <input
                        type="checkbox"
                        checked={Boolean(webhookUrl)}
                        onChange={(e) => setWebhookUrl(e.target.checked ? "https://api.firm.com/webhooks/options" : "")}
                      />
                      <strong>Outbound Signed Webhook</strong>
                    </div>
                    <span className="channel-check-desc">
                      HMAC SHA-256 authenticated JSON payload for institutional trade engines
                    </span>
                    {Boolean(webhookUrl) && (
                      <input
                        type="url"
                        className="sched-input"
                        style={{ marginTop: "0.3rem", padding: "0.4rem 0.6rem", fontSize: "0.78rem" }}
                        value={webhookUrl}
                        onChange={(e) => setWebhookUrl(e.target.value)}
                        placeholder="https://..."
                      />
                    )}
                  </label>

                  {/* Broadcast */}
                  <div className="channel-check-card" style={{ opacity: 0.9 }}>
                    <div className="channel-check-top">
                      <input type="checkbox" checked disabled />
                      <strong>WebSocket UI Broadcast</strong>
                    </div>
                    <span className="channel-check-desc">
                      Live real-time pop-up notification pushed to all connected client tabs
                    </span>
                  </div>
                </div>
              </div>

              <footer className="sched-modal-footer">
                <button
                  type="button"
                  className="btn-sched-secondary"
                  onClick={() => setModalOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-sched-primary"
                  disabled={submitting}
                >
                  {submitting
                    ? "Saving Schedule…"
                    : editingScheduleId
                    ? "✓ Save Updated Schedule"
                    : "✓ Register Durable Schedule"}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
