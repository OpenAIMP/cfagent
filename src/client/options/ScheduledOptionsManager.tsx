import React, { useState, useEffect, useCallback } from "react";
import { apiFetch as fetch } from "../apiFetch";
import { etToUtcCron } from "./cronTime";
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
  /** Agents SDK Schedule.time: unix seconds of the next execution. */
  time?: number;
  createdAt?: string;
  nextRun?: string;
}

export interface ScheduledOptionsManagerProps {
  activeEnv?: string;
  userLogin?: string;
  onPreviewTrade?: (candidate: any) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

/**
 * The app's baseline schedules: registered by OrchestratorAgent.onStart
 * on every agent start, so they are part of the product, not user data.
 * Recognising them by callback lets the UI label them honestly, offer
 * each job's own on-demand trigger, and protect them from the
 * edit/cancel flows that are safe for user-created schedules.
 */
export interface SystemJobInfo {
  label: string;
  description: string;
  triggerRoute: string;
}

export const SYSTEM_JOBS: Record<string, SystemJobInfo> = {
  autoRenewETradeTokens: {
    label: "E*TRADE Token Renewal (System)",
    description:
      "Renews the E*TRADE OAuth tokens before they expire at midnight ET, so every background job keeps its broker access.",
    triggerRoute: "/api/schedules/trigger-renew",
  },
  autonomousMarketScreen: {
    label: "Autonomous Market Screen (System)",
    description:
      "Hourly E*TRADE stock screen of one market universe (Nasdaq-100, S&P 100/500, Russell 2000, ETFs). Scores each name on sentiment, momentum, value and factor grades; publishes standouts + PDF report to Slack.",
    triggerRoute: "/api/schedules/trigger-screen",
  },
  autonomousOptionsAnalysis: {
    label: "Strategy/Symbol Scanner — Scheduled (System)",
    description:
      "Hourly options strategy scan across the full strategy catalog. For each tracked symbol it prices every strategy against live E*TRADE option chains and reports the best structures per direction thesis (bullish/bearish/range-bound/large-move).",
    triggerRoute: "/api/schedules/trigger-options-analysis",
  },
  collectIvHistory: {
    label: "IV History Collection (System)",
    description:
      "Records one closing ATM implied-volatility data point per tracked symbol each weekday, building the IV history series used for IV rank and percentile.",
    triggerRoute: "/api/schedules/trigger-iv-collection",
  },
};

/**
 * Callback → its on-demand trigger route. Callbacks absent here
 * (sendScheduledReminder, expireStaleOrderDraft, executeAsyncJob, …)
 * have no trigger route and render no Trigger control — a card's
 * Trigger always runs that card's own job, never a different one.
 */
export const TRIGGER_ROUTES: Record<string, string> = {
  autonomousOptionsAnalysis: "/api/schedules/trigger-options-analysis",
  autonomousMarketScreen: SYSTEM_JOBS.autonomousMarketScreen.triggerRoute,
  autoRenewETradeTokens: SYSTEM_JOBS.autoRenewETradeTokens.triggerRoute,
  collectIvHistory: SYSTEM_JOBS.collectIvHistory.triggerRoute,
};

export function systemJobFor(callback: unknown): SystemJobInfo | undefined {
  return typeof callback === "string" ? SYSTEM_JOBS[callback] : undefined;
}

export function triggerRouteFor(callback: unknown): string | undefined {
  return typeof callback === "string" ? TRIGGER_ROUTES[callback] : undefined;
}

/** Jobs the create form can register. Anything else stays API-only. */
export type CreatableJob = "optionsAnalysis" | "ivCollection";

export const JOB_CALLBACKS: Record<CreatableJob, string> = {
  optionsAnalysis: "autonomousOptionsAnalysis",
  ivCollection: "collectIvHistory",
};

export type ScheduleMode = "interval" | "cron" | "delayed" | "scheduled";

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

// Presets are Eastern-Time intents: picking one converts the ET time to
// a UTC cron for the current ET offset (see ./cronTime). The cron string
// is computed at pick time, never stored here as a literal — a literal
// would fire 4-5 hours early, as the previous hard-coded values did.
const CRON_PRESETS = [
  { label: "Market Open (9:30 AM ET M-F)", etHour: 9, etMinute: 30, daysOfWeek: "1-5" },
  { label: "Midday Scan (12:00 PM ET M-F)", etHour: 12, etMinute: 0, daysOfWeek: "1-5" },
  { label: "Market Close (4:00 PM ET M-F)", etHour: 16, etMinute: 0, daysOfWeek: "1-5" },
  { label: "Daily Overnight (11:00 PM ET)", etHour: 23, etMinute: 0, daysOfWeek: "*" },
];

/** The payload object of a schedule, or {} when absent/malformed. */
function payloadOf(item: ScheduledTaskItem): Record<string, any> {
  const p = item?.payload;
  return p && typeof p === "object" && !Array.isArray(p) ? p : {};
}

/** Faithful one-line rendering of an arbitrary payload value. */
export function formatPayloadValue(value: any): string {
  if (value === undefined || value === null) return "—";
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((v) => String(v)).join(", ") : "—";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Next-run display from an SDK Schedule object (detail or list row). */
export function formatNextRun(schedule: any): string {
  const t = schedule?.time;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) {
    const d = new Date(t * 1000);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  if (typeof schedule?.nextRun === "string" && schedule.nextRun) return schedule.nextRun;
  if (typeof schedule?.date === "string" && schedule.date) {
    const d = new Date(schedule.date);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return "—";
}

function cadenceText(item: ScheduledTaskItem): string {
  if (item.intervalSeconds) return `Every ${Math.round(item.intervalSeconds / 60)} min`;
  if (item.cron) return `Cron: ${item.cron}`;
  if (item.type === "delayed" && item.delayInSeconds) return `Once, after ${item.delayInSeconds}s`;
  if (item.type === "scheduled" && item.date) {
    const d = new Date(item.date);
    return Number.isNaN(d.getTime()) ? "One-shot (date)" : `Once at ${d.toLocaleString()}`;
  }
  return "Scheduled Timer";
}

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
  const [jobType, setJobType] = useState<CreatableJob>("optionsAnalysis");
  const [targetSymbols, setTargetSymbols] = useState("NVDA, AAPL, SPY, MSFT");
  const [targetUniverse, setTargetUniverse] = useState("");
  const [scheduleType, setScheduleType] = useState<ScheduleMode>("interval");
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const [cronExpression, setCronExpression] = useState(() =>
    etToUtcCron({ hour: 9, minute: 30, daysOfWeek: "1-5" })
  );
  const [delaySeconds, setDelaySeconds] = useState(1800);
  const [scheduledDate, setScheduledDate] = useState("");
  const [thesis, setThesis] = useState<"bullish" | "bearish" | "neutral" | "directional">("bullish");
  const [riskProfile, setRiskProfile] = useState<"conservative" | "balanced" | "aggressive">("balanced");
  const [pushToSlack, setPushToSlack] = useState(true);
  const [slackChannel, setSlackChannel] = useState("#options-alerts");
  const [emailTo, setEmailTo] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  // On-Demand Execution State: which trigger is in flight — "hero" for
  // the banner Run Now button, otherwise the schedule's id.
  const [triggeringKey, setTriggeringKey] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<any | null>(null);

  // System-schedule cancel guard: the id awaiting inline confirmation.
  const [confirmingCancelId, setConfirmingCancelId] = useState<string | null>(null);

  // Detail expansion state (GET /api/schedules/:id, fetched on demand)
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Audit Logs State
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  const authHeaders = useCallback(
    (extra: Record<string, string> = {}) => ({
      ...extra,
      "x-environment": activeEnv,
      "x-user-login": userLogin,
    }),
    [activeEnv, userLogin]
  );

  // Fetch Schedules
  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/schedules", { headers: authHeaders() });
      const data = (await res.json().catch(() => ({}))) as any;
      const rawList = Array.isArray(data?.schedules) ? data.schedules : Array.isArray(data) ? data : null;
      if (res.ok && rawList) {
        // Shape-guard: only rows the card renderer can trust — a
        // malformed row must never crash the panel.
        setSchedules(
          rawList.filter(
            (s: any) =>
              s && typeof s === "object" && typeof s.id === "string" && typeof s.callback === "string"
          )
        );
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
  }, [authHeaders]);

  // Fetch Audit Trail
  const fetchAudit = useCallback(async () => {
    setLoadingAudit(true);
    try {
      const res = await fetch("/api/audit?limit=40", { headers: authHeaders() });
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
  }, [authHeaders]);

  useEffect(() => {
    fetchSchedules();
    fetchAudit();
  }, [fetchSchedules, fetchAudit]);

  // Open the modal for a NEW schedule (never an edit session).
  const openCreateModal = () => {
    setEditingScheduleId(null);
    setJobType("optionsAnalysis");
    setModalOpen(true);
  };

  // Edit Existing Schedule — user-created options analysis only. System
  // schedules and other callbacks have no Edit control at all (see the
  // card renderer): the form cannot represent them, and "editing" one
  // would cancel it and recreate an analysis schedule in its place.
  const handleEditSchedule = (item: ScheduledTaskItem) => {
    setEditingScheduleId(item.id);
    setJobType("optionsAnalysis");
    const payload = payloadOf(item);
    const syms = payload.symbols;
    setTargetSymbols(Array.isArray(syms) ? syms.join(", ") : "NVDA, AAPL, SPY, MSFT");
    setThesis(payload.thesis || "bullish");
    setRiskProfile(payload.riskProfile || "balanced");
    setScheduleType(
      item.type === "cron" || item.type === "delayed" || item.type === "scheduled" ? item.type : "interval"
    );
    if (item.intervalSeconds) setIntervalSeconds(item.intervalSeconds);
    if (item.cron) setCronExpression(item.cron);
    if (item.delayInSeconds) setDelaySeconds(item.delayInSeconds);
    setPushToSlack(payload.pushToSlack !== false);
    if (payload.slackChannel) setSlackChannel(payload.slackChannel);
    if (payload.emailTo) setEmailTo(payload.emailTo);
    if (payload.webhookUrl) setWebhookUrl(payload.webhookUrl);
    setModalOpen(true);
  };

  // Create or Update Schedule
  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessMsg(null);

    const isIvJob = !editingScheduleId && jobType === "ivCollection";

    let callback: string;
    let payload: Record<string, any>;
    if (isIvJob) {
      callback = JOB_CALLBACKS.ivCollection;
      payload = { userLogin };
    } else {
      const symbols = targetSymbols
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      callback = JOB_CALLBACKS.optionsAnalysis;
      payload = {
        ...(targetUniverse ? { universe: targetUniverse } : { symbols: symbols.length > 0 ? symbols : ["NVDA", "AAPL", "SPY"] }),
        thesis,
        riskProfile,
        pushToSlack,
        slackChannel: pushToSlack ? slackChannel : undefined,
        emailTo: emailTo.trim() || undefined,
        webhookUrl: webhookUrl.trim() || undefined,
        environment: activeEnv,
      };
    }

    const requestBody: any = {
      callback,
      scheduleType,
      payload,
    };

    if (scheduleType === "interval") {
      requestBody.intervalSeconds = Number(intervalSeconds);
    } else if (scheduleType === "cron") {
      requestBody.cron = cronExpression.trim();
    } else if (scheduleType === "delayed") {
      requestBody.delayInSeconds = Number(delaySeconds);
    } else if (scheduleType === "scheduled") {
      if (!scheduledDate) {
        setError("Pick a date and time for the one-shot run.");
        setSubmitting(false);
        return;
      }
      requestBody.date = new Date(scheduledDate).toISOString();
    }

    try {
      // If editing an existing schedule, cancel the prior schedule first
      if (editingScheduleId) {
        try {
          await fetch("/api/schedules/cancel", {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ id: editingScheduleId }),
          });
        } catch (priorErr) {
          console.warn("[ScheduledOptionsManager] Note on prior schedule cancellation:", priorErr);
        }
      }

      const res = await fetch("/api/schedules/create", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
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

  // Cancel Schedule — the actual POST. Guarding lives in the callers:
  // window.confirm for user schedules, the inline two-step confirm for
  // system schedules.
  const doCancelSchedule = async (scheduleId: string) => {
    try {
      const res = await fetch("/api/schedules/cancel", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ id: scheduleId }),
      });
      const data = (await res.json()) as any;
      if (res.ok && (data.cancelled || data.success)) {
        setSuccessMsg(`✓ Schedule ${scheduleId} cancelled`);
        setConfirmingCancelId(null);
        fetchSchedules();
        fetchAudit();
      } else {
        setError(data.error || "Failed to cancel schedule");
      }
    } catch (err: any) {
      setError(err.message || "Failed to cancel schedule");
    }
  };

  const handleCancelSchedule = async (scheduleId: string) => {
    if (!confirm(`Cancel scheduled task ${scheduleId}?`)) return;
    await doCancelSchedule(scheduleId);
  };

  // Run one schedule's own job on demand, via that job's trigger route.
  const handleTriggerCard = async (item: ScheduledTaskItem) => {
    const route = triggerRouteFor(item.callback);
    if (!route) return;
    setTriggeringKey(item.id);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch(route, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payloadOf(item)),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.success !== false && !data.error) {
        const label = systemJobFor(item.callback)?.label || "Autonomous Options Intelligence";
        if (item.callback === "autonomousOptionsAnalysis") {
          if (data.data) setLiveResult(data.data);
          setSuccessMsg(`✓ ${label} executed! Found ${data.data?.withTrades ?? 0} actionable setups.`);
        } else if (item.callback === "collectIvHistory" && data.data && typeof data.data === "object") {
          const d = data.data;
          setSuccessMsg(
            `✓ ${label} executed for ${d.date || "today"}: ${d.recorded ?? 0} recorded, ` +
              `${d.alreadyRecorded ?? 0} already recorded, ${d.failed ?? 0} failed.`
          );
        } else {
          setSuccessMsg(`✓ ${label} executed.${data.message ? ` ${data.message}` : ""}`);
        }
        fetchAudit();
      } else {
        setError(data.error || "Execution failed");
      }
    } catch (err: any) {
      setError(err.message || "Failed to execute schedule");
    } finally {
      setTriggeringKey(null);
    }
  };

  // Hero "Run Now": an immediate options analysis with the form state.
  const handleTriggerNow = async () => {
    setTriggeringKey("hero");
    setError(null);
    setSuccessMsg(null);
    setLiveResult(null);

    const symbols = targetSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const payload = {
      ...(targetUniverse ? { universe: targetUniverse } : { symbols: symbols.length > 0 ? symbols : ["NVDA", "AAPL", "SPY", "MSFT"] }),
      thesis,
      riskProfile,
      pushToSlack,
      slackChannel: pushToSlack ? slackChannel : undefined,
      emailTo: emailTo.trim() || undefined,
      webhookUrl: webhookUrl.trim() || undefined,
      environment: activeEnv,
    };

    try {
      const res = await fetch(TRIGGER_ROUTES.autonomousOptionsAnalysis, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
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
      setTriggeringKey(null);
    }
  };

  // Detail expansion: fetch the authoritative SDK Schedule by id.
  const handleToggleDetails = async (item: ScheduledTaskItem) => {
    if (detailId === item.id) {
      setDetailId(null);
      setDetail(null);
      setDetailError(null);
      return;
    }
    setDetailId(item.id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(item.id)}`, {
        headers: authHeaders(),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data && typeof data === "object" && typeof data.id === "string") {
        setDetail(data);
      } else {
        setDetailError(data?.error || "Schedule details unavailable.");
      }
    } catch (err: any) {
      setDetailError(err.message || "Schedule details unavailable.");
    } finally {
      setDetailLoading(false);
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
            Cloudflare Agents Durable Timers (<code>schedule</code> / <code>scheduleEvery</code>) run inside the <strong>OrchestratorAgent</strong> Durable Object — each registered job fires on its own schedule, independently of whether your browser tab is open. When a scheduled analysis or screen completes, its results are broadcast to connected app clients, and notifications are sent only to the channels configured on that job (Slack, email, webhook) — a channel the job doesn&apos;t configure receives nothing.
          </p>
        </div>

        <div className="sched-hero-actions">
          <button
            type="button"
            className="btn-sched-secondary"
            onClick={() => handleTriggerNow()}
            disabled={triggeringKey !== null}
            title="Execute the options intelligence scan immediately on demand"
          >
            {triggeringKey === "hero" ? "⚡ Running Screen…" : "⚡ Run Now"}
          </button>
          <button
            type="button"
            className="btn-sched-primary"
            onClick={openCreateModal}
            title="Register a new durable schedule"
          >
            <span>+</span> New Schedule
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
            </div>
          </div>

          <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "0.88rem" }}>
            {liveResult.summary}
          </p>

          {Array.isArray(liveResult.opportunities) && liveResult.opportunities.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.75rem", marginTop: "0.5rem" }}>
              {liveResult.opportunities.map((opp: any) => {
                const cand = opp.pick?.best?.candidate;
                return (
                  <div key={opp.symbol} style={{ background: "var(--color-card)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-md)", padding: "0.85rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                      <strong style={{ color: "var(--color-accent)", fontSize: "0.95rem" }}>{opp.symbol}</strong>
                      <span style={{ background: "var(--color-accent-subtle)", color: "var(--color-accent)", fontSize: "0.74rem", padding: "0.15rem 0.45rem", borderRadius: "var(--radius-xs, 4px)", fontWeight: "bold" }}>
                        Score: {opp.score}/100
                      </span>
                    </div>
                    <p style={{ color: "var(--color-text-primary)", margin: "0 0 0.5rem", fontSize: "0.84rem", fontWeight: 600 }}>
                      {cand?.label || "Options Setup"}
                    </p>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.76rem", color: "var(--color-text-muted)" }}>
                      <span>Max Profit: <strong style={{ color: "var(--color-success)" }}>{cand?.maxProfitUnbounded ? "∞" : `$${cand?.maxProfit?.toFixed(2) || "0"}`}</strong></span>
                      <span>Max Loss: <strong style={{ color: "var(--color-danger)" }}>${cand?.maxLoss?.toFixed(2) || "0"}</strong></span>
                    </div>
                    {cand && onPreviewTrade && (
                      <button
                        type="button"
                        style={{ marginTop: "0.6rem", width: "100%", padding: "0.35rem", fontSize: "0.74rem", background: "var(--color-accent-subtle)", border: "1px solid var(--color-border-focus)", color: "var(--color-accent)", borderRadius: "var(--radius-xs, 4px)", cursor: "pointer", fontWeight: 600 }}
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
              onClick={openCreateModal}
            >
              + Create First Schedule
            </button>
          </div>
        ) : (
          <div className="schedules-grid">
            {schedules.map((item) => {
              const systemJob = systemJobFor(item.callback);
              const isSystem = Boolean(systemJob);
              const isOptions = item.callback === "autonomousOptionsAnalysis";
              const payload = payloadOf(item);
              const triggerRoute = triggerRouteFor(item.callback);
              const title = systemJob?.label || (isOptions ? "Autonomous Options Intelligence" : item.callback);
              const symbols = Array.isArray(payload.symbols)
                ? payload.symbols.filter((s: any) => typeof s === "string")
                : [];
              const confirmingCancel = confirmingCancelId === item.id;

              return (
                <div
                  key={item.id}
                  className={`schedule-item-card ${isOptions ? "is-options" : ""} ${isSystem ? "is-system" : ""}`}
                >
                  <div className="schedule-card-top">
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                      <span className={`schedule-type-badge ${item.type}`}>
                        {item.type}
                      </span>
                      {isSystem && <span className="schedule-system-badge">System</span>}
                    </div>
                    <span className="schedule-id-snippet" title={item.id}>
                      {item.id.slice(0, 16)}…
                    </span>
                  </div>

                  <div>
                    <h5 className="schedule-title">{title}</h5>
                    <div className="schedule-cadence">{cadenceText(item)}</div>
                    {systemJob && (
                      <p className="schedule-system-note">
                        {systemJob.description} Registered by the app at startup.
                      </p>
                    )}
                  </div>

                  {isOptions ? (
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

                      {(typeof payload.thesis === "string" || typeof payload.riskProfile === "string") && (
                        <div className="payload-row">
                          <span className="payload-label">Thesis &amp; Risk:</span>
                          <span className="payload-value">
                            {typeof payload.thesis === "string" ? payload.thesis.toUpperCase() : "—"} ·{" "}
                            {typeof payload.riskProfile === "string" ? payload.riskProfile : "—"}
                          </span>
                        </div>
                      )}

                      <div className="payload-row">
                        <span className="payload-label">Notifications:</span>
                        <div className="channel-indicators">
                          {payload.pushToSlack && <span className="chan-badge slack" title="Slack Alerts">Slack</span>}
                          {payload.emailTo && <span className="chan-badge email" title="Email Briefs">Email</span>}
                          {payload.webhookUrl && <span className="chan-badge webhook" title="Signed Webhook">Webhook</span>}
                          {!payload.pushToSlack && !payload.emailTo && !payload.webhookUrl && (
                            <span className="payload-value">None configured — results surface in this app only</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="schedule-payload-details">
                      {Object.keys(payload).length > 0 ? (
                        Object.entries(payload).map(([key, value]) => (
                          <div className="payload-row" key={key}>
                            <span className="payload-label">{key}:</span>
                            <span className="payload-value">{formatPayloadValue(value)}</span>
                          </div>
                        ))
                      ) : (
                        <div className="payload-row">
                          <span className="payload-label">Payload:</span>
                          <span className="payload-value">— none —</span>
                        </div>
                      )}
                    </div>
                  )}

                  {confirmingCancel && (
                    <div className="schedule-cancel-confirm" role="alert">
                      <span>
                        Stop the <strong>{title}</strong> system job? It stays off only until the
                        agent restarts — restarting re-registers it. Until then, this background
                        function does not run.
                      </span>
                      <div style={{ display: "flex", gap: "0.4rem" }}>
                        <button
                          type="button"
                          className="btn-sched-cancel-sm"
                          onClick={() => doCancelSchedule(item.id)}
                        >
                          Yes, cancel it
                        </button>
                        <button
                          type="button"
                          className="btn-sched-action-sm"
                          onClick={() => setConfirmingCancelId(null)}
                        >
                          Keep it
                        </button>
                      </div>
                    </div>
                  )}

                  {detailId === item.id && (
                    <div className="schedule-detail-panel">
                      {detailLoading ? (
                        <p className="schedule-detail-status">Loading schedule details…</p>
                      ) : detailError ? (
                        <p className="schedule-detail-status" role="alert">{detailError}</p>
                      ) : detail ? (
                        <>
                          <div className="payload-row">
                            <span className="payload-label">Schedule ID:</span>
                            <span className="payload-value schedule-detail-id">{detail.id}</span>
                          </div>
                          <div className="payload-row">
                            <span className="payload-label">Type:</span>
                            <span className="payload-value">{detail.type || item.type}</span>
                          </div>
                          <div className="payload-row">
                            <span className="payload-label">Callback:</span>
                            <span className="payload-value">{detail.callback || item.callback}</span>
                          </div>
                          <div className="payload-row">
                            <span className="payload-label">Next run:</span>
                            <span className="payload-value">{formatNextRun(detail)}</span>
                          </div>
                          {typeof detail.cron === "string" && (
                            <div className="payload-row">
                              <span className="payload-label">Cron (UTC):</span>
                              <span className="payload-value">{detail.cron}</span>
                            </div>
                          )}
                          {typeof detail.intervalSeconds === "number" && (
                            <div className="payload-row">
                              <span className="payload-label">Interval:</span>
                              <span className="payload-value">{detail.intervalSeconds}s</span>
                            </div>
                          )}
                          {typeof detail.delayInSeconds === "number" && (
                            <div className="payload-row">
                              <span className="payload-label">Delay:</span>
                              <span className="payload-value">{detail.delayInSeconds}s</span>
                            </div>
                          )}
                          {typeof detail.date === "string" && (
                            <div className="payload-row">
                              <span className="payload-label">Runs at:</span>
                              <span className="payload-value">{formatNextRun({ date: detail.date })}</span>
                            </div>
                          )}
                          <div className="payload-row" style={{ alignItems: "flex-start" }}>
                            <span className="payload-label">Payload:</span>
                            <pre className="schedule-detail-payload">
                              {JSON.stringify(detail.payload ?? null, null, 2)}
                            </pre>
                          </div>
                        </>
                      ) : null}
                    </div>
                  )}

                  <div className="schedule-card-footer">
                    <button
                      type="button"
                      className="btn-sched-action-sm"
                      onClick={() => handleToggleDetails(item)}
                      title="Inspect this schedule (type, next run, payload)"
                    >
                      {detailId === item.id ? "▾ Hide Details" : "🔍 Details"}
                    </button>
                    {triggerRoute && (
                      <button
                        type="button"
                        className="btn-sched-action-sm"
                        onClick={() => handleTriggerCard(item)}
                        disabled={triggeringKey !== null}
                        title={`Run ${title} immediately, on demand`}
                      >
                        {triggeringKey === item.id ? "⚡ Running…" : "⚡ Trigger Now"}
                      </button>
                    )}
                    {!isSystem && isOptions && (
                      <button
                        type="button"
                        className="btn-sched-action-sm"
                        style={{ background: "var(--color-accent-subtle)", borderColor: "var(--color-border-focus)", color: "var(--color-accent)" }}
                        onClick={() => handleEditSchedule(item)}
                        title="Update parameters or cadence for this schedule"
                      >
                        ✏ Edit / Update
                      </button>
                    )}
                    {!confirmingCancel &&
                      (isSystem ? (
                        <button
                          type="button"
                          className="btn-sched-cancel-sm"
                          onClick={() => setConfirmingCancelId(item.id)}
                          title="Cancel this system schedule (it is re-registered when the agent restarts)"
                        >
                          ✕ Cancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-sched-cancel-sm"
                          onClick={() => handleCancelSchedule(item.id)}
                          title="Permanently cancel this durable schedule"
                        >
                          ✕ Cancel
                        </button>
                      ))}
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
          <p style={{ color: "var(--color-text-dim)", fontSize: "0.85rem", margin: "0.5rem 0" }}>
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
                        <strong style={{ color: payload.withTrades > 0 ? "var(--color-success)" : "var(--color-text-muted)" }}>
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
                <h3>{editingScheduleId ? "✏ Update Options Screening Schedule" : "⏰ Configure New Schedule"}</h3>
                <p>Register a durable Cloudflare Agents SDK timer to run in the background.</p>
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
              {/* Job Picker (create only — edits are analysis-only) */}
              {!editingScheduleId && (
                <div className="sched-form-group">
                  <label className="sched-form-label">
                    Job
                    <span className="hint">What runs when this schedule fires</span>
                  </label>
                  <select
                    className="sched-select"
                    value={jobType}
                    onChange={(e) => setJobType(e.target.value as CreatableJob)}
                  >
                    <option value="optionsAnalysis">Autonomous Options Analysis</option>
                    <option value="ivCollection">IV History Collection</option>
                  </select>
                  {jobType === "ivCollection" && (
                    <p className="sched-preset-note">
                      Records one ATM IV data point per tracked symbol (your watchlists plus the
                      curated universe) into the IV history series. No analysis options apply —
                      the job runs under your login.
                    </p>
                  )}
                </div>
              )}

              {/* Target Universe or Symbols (options analysis only) */}
              {(editingScheduleId || jobType === "optionsAnalysis") && (
                <div className="sched-form-group">
                  <label className="sched-form-label">
                    Target Universe
                    <span className="hint">Screens all symbols in the universe</span>
                  </label>
                  <select
                    className="sched-input"
                    value={targetUniverse}
                    onChange={(e) => setTargetUniverse(e.target.value)}
                  >
                    <option value="">Custom symbols (below)</option>
                    <option value="TECH">Technology (keyword discovery)</option>
                    <option value="NASDAQ100">Nasdaq-100</option>
                    <option value="SP100">S&P 100</option>
                    <option value="SP500">S&P 500</option>
                    <option value="RUSSELL2000">Russell 2000</option>
                    <option value="ETF">ETFs</option>
                    <option value="LEV_ETF">Leveraged ETFs</option>
                  </select>
                  {!targetUniverse && (
                    <>
                      <label className="sched-form-label" style={{ marginTop: "0.5rem" }}>
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
                    </>
                  )}
                </div>
              )}

              {/* Schedule Cadence / Type */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div className="sched-form-group">
                  <label className="sched-form-label">Cadence Type</label>
                  <select
                    className="sched-select"
                    value={scheduleType}
                    onChange={(e) => setScheduleType(e.target.value as ScheduleMode)}
                  >
                    <option value="interval">Interval (Every X Minutes/Hours)</option>
                    <option value="cron">Cron Expression (Specific Time/Days)</option>
                    <option value="delayed">Delayed (Once, After a Delay)</option>
                    <option value="scheduled">One-Shot (Specific Date &amp; Time)</option>
                  </select>
                </div>

                {scheduleType === "interval" && (
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
                )}

                {scheduleType === "cron" && (
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
                          onClick={() =>
                            setCronExpression(
                              etToUtcCron({ hour: p.etHour, minute: p.etMinute, daysOfWeek: p.daysOfWeek })
                            )
                          }
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <p className="sched-preset-note">
                      Preset times are Eastern (ET) and are converted to UTC when picked, because
                      schedules run in UTC. After the spring or autumn clock change, a saved schedule
                      will fire one hour off its ET label until you re-save it.
                    </p>
                  </div>
                )}

                {scheduleType === "delayed" && (
                  <div className="sched-form-group">
                    <label className="sched-form-label">Delay Seconds</label>
                    <input
                      type="number"
                      className="sched-input"
                      value={delaySeconds}
                      onChange={(e) => setDelaySeconds(Number(e.target.value))}
                      min={1}
                      step={60}
                      required
                    />
                    <p className="sched-preset-note">
                      Runs once, this many seconds after the schedule is saved.
                    </p>
                  </div>
                )}

                {scheduleType === "scheduled" && (
                  <div className="sched-form-group">
                    <label className="sched-form-label">Run At (One-Shot)</label>
                    <input
                      type="datetime-local"
                      className="sched-input"
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                      required
                    />
                    <p className="sched-preset-note">
                      Runs once at the chosen date and time (your local time).
                    </p>
                  </div>
                )}
              </div>

              {/* Thesis & Risk Profile + Dispatch (options analysis only) */}
              {(editingScheduleId || jobType === "optionsAnalysis") && (
                <>
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
                          HMAC SHA-256 signed JSON payload. Dispatched only when OUTBOUND_WEBHOOK_SECRET is configured on the server — without a signing secret, the webhook is not sent.
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

                      {/* Broadcast — platform behaviour, not a per-job channel:
                          rendered as a note, not a selectable channel (issue #123/F15). */}
                      <div className="channel-check-card" style={{ opacity: 0.9 }}>
                        <div className="channel-check-top">
                          <strong>WebSocket UI Broadcast</strong>
                        </div>
                        <span className="channel-check-desc">
                          Not a channel you configure: when a scheduled run completes, its results are always broadcast to connected app clients.
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              )}

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
