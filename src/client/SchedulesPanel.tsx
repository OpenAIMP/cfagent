/**
 * S7 (consolidation, umbrella #958): THE one schedule UI. This panel
 * hosts the screening-schedule section (ScheduledOptionsManager —
 * kind-specific cards, structured create/edit forms, latest runs,
 * audit trail, live preview) for the three screening callbacks and
 * renders every other schedule in the store (system, queued, NLQ
 * reminders, …) as generic cards below it. Before S7 the two UIs
 * sat in different tabs over the same store with different payload
 * builders and feature sets; payload construction for the screening
 * kinds now lives in exactly one place
 * (scheduledOptionsManager/payloadBuilders).
 *
 * Issue #309: Schedules Panel with tabbed grouping.
 * Issue #273: full schedules management UI — pause/resume, inline
 * frequency editing, per-job trigger, delete, and a create form fed by
 * the server's callback allow-list (GET /api/schedules returns
 * `creatableCallbacks`).
 *
 * Displays all durable schedules grouped by category:
 * - All | Stocks | Options | System | Queued
 *
 * Each schedule card shows:
 * - Human-readable schedule description (cron → English)
 * - Universe/thesis/payload summary, job ID, next run, status
 * - Trigger Now, Pause/Resume, Edit frequency, Delete actions
 *
 * Paused jobs stay listed with a Paused badge (the backend keeps their
 * definition in the paused store; see services/scheduleManagement.ts).
 */

import { useState, useEffect, useCallback } from "react";
import { Button, TextInput, useToast } from "./components/ui";
import { apiFetch as fetch } from "./apiFetch";
import "./reports.css";

export interface ScheduleItem {
  id: string;
  type: "interval" | "cron" | "delayed" | "scheduled";
  callback: string;
  payload?: any;
  intervalSeconds?: number;
  cron?: string;
  /** Unix seconds of the next run (SDK schedules). */
  time?: number;
  createdAt?: string;
  nextRun?: string;
  /** Issue #273: paused jobs are merged into the list by the backend. */
  paused?: boolean;
  pausedAt?: string;
}

type ScheduleGroup = "all" | "stocks" | "options" | "system" | "queued";

/** Frequency presets for the inline editor — defined once in the
 *  screening section's format module since S7 (both card kinds use
 *  the same editor); re-exported here for existing importers. */
export { FREQUENCY_PRESETS } from "./scheduledOptionsManager/format";
import { FREQUENCY_PRESETS } from "./scheduledOptionsManager/format";
import { ScheduledOptionsManager } from "./ScheduledOptionsManager";

/**
 * Translate a cron expression to human-readable English.
 * Supports the patterns used by our schedulers.
 */
export function cronToEnglish(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;

  const [min, hour, dom, month, dow] = parts;

  // Hourly: "5 * * * *" → "Every hour at :05"
  if (hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const m = min.padStart(2, "0");
    return `Every hour at :${m}`;
  }

  // Daily: "0 3 * * *" → "Daily at 3:00 AM UTC"
  if (dom === "*" && month === "*" && dow === "*") {
    const h = parseInt(hour, 10);
    const m = min.padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `Daily at ${h12}:${m} ${ampm} UTC`;
  }

  // Weekly: "15 22 * * 1-5" → "Weekdays at 10:15 PM UTC"
  if (dom === "*" && month === "*") {
    const h = parseInt(hour, 10);
    const m = min.padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const days = dow === "1-5" ? "Weekdays" :
                 dow === "0" ? "Sundays" :
                 dow === "6" ? "Saturdays" : `Days ${dow}`;
    return `${days} at ${h12}:${m} ${ampm} UTC`;
  }

  return cron;
}

/**
 * Categorize a schedule into a group for tabbed display.
 */
export function categorizeSchedule(s: ScheduleItem): Exclude<ScheduleGroup, "all" | "queued"> {
  const cb = s.callback.toLowerCase();
  const payload = s.payload || {};

  // Queued async jobs
  if (s.type === "delayed" || cb.includes("executeasyncjob")) {
    return "system"; // Will be overridden to "queued" by caller for delayed type
  }

  // Options scanners + strategy discovery (S7: discovery was
  // previously miscounted as "system" — it is an options kind).
  if (
    cb.includes("autonomousoptionsanalysis") ||
    cb.includes("autonomousstrategydiscovery") ||
    cb.includes("options")
  ) {
    return "options";
  }

  // Stock screeners
  if (cb.includes("autonomousmarketscreen") || payload.universe) {
    return "stocks";
  }

  // System jobs (token renewal, IV collection)
  return "system";
}

/** One-line payload summary for payloads without universe/thesis. */
export function payloadSummary(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  if (Array.isArray(payload.symbols) && payload.symbols.length) {
    return `Symbols: ${payload.symbols.slice(0, 6).join(", ")}${payload.symbols.length > 6 ? "…" : ""}`;
  }
  const keys = Object.keys(payload).filter(
    (k) => !["userLogin", "environment", "env", "trigger"].includes(k)
  );
  if (!keys.length) return "";
  const text = keys
    .slice(0, 4)
    .map((k) => {
      const v = payload[k];
      const rendered = typeof v === "object" ? "…" : String(v);
      return `${k}: ${rendered}`;
    })
    .join(" · ");
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

interface SchedulesPanelProps {
  activeEnv?: string;
  userLogin?: string;
  /** S7: forwarded to the screening section's live-result preview. */
  onPreviewTrade?: (candidate: any) => void;
}

export const SCREENING_CALLBACKS = new Set([
  "autonomousMarketScreen",
  "autonomousOptionsAnalysis",
  "autonomousStrategyDiscovery",
]);

export function SchedulesPanel({ activeEnv, userLogin, onPreviewTrade }: SchedulesPanelProps) {
  const toast = useToast();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ScheduleGroup>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customCron, setCustomCron] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  // S7: the generic raw-JSON create form is gone — the server's
  // creatable allow-list is exactly the three screening callbacks,
  // whose one structured create form lives in the screening section.
  // These counters are the host signals that open it / refresh it.
  const [openCreateSignal, setOpenCreateSignal] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const envHeaders = activeEnv ? { "x-environment": activeEnv } : undefined;

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/schedules", {
        headers: envHeaders,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as any;
      setSchedules(data.schedules || data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEnv]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  /** Shared mutating-action helper: run, surface errors, refresh. */
  const runAction = async (fn: () => Promise<Response>) => {
    setActionError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchSchedules();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this schedule? This cannot be undone.")) return;
    await runAction(() =>
      fetch(`/api/schedules/${id}`, { method: "DELETE", headers: envHeaders })
    );
  };

  const handleTriggerNow = async (id: string) => {
    const ok = await runAction(() =>
      fetch(`/api/schedules/${id}/trigger`, { method: "POST", headers: envHeaders })
    );
    if (ok) toast.success("Triggered successfully");
  };

  const handlePauseResume = async (s: ScheduleItem) => {
    await runAction(() =>
      fetch(`/api/schedules/${s.id}/${s.paused ? "resume" : "pause"}`, {
        method: "POST",
        headers: envHeaders,
      })
    );
  };

  const applyFrequency = async (s: ScheduleItem, body: Record<string, unknown>) => {
    const ok = await runAction(() =>
      fetch(`/api/schedules/${s.id}`, {
        method: "PUT",
        headers: { ...envHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    if (ok) {
      setEditingId(null);
      setCustomCron("");
    }
  };

  // The screening kinds render in the screening section (kind
  // cards); the generic grid below carries every other callback.
  const genericSchedules = schedules.filter((s) => !SCREENING_CALLBACKS.has(s.callback));

  // Filter by active tab
  const filtered = genericSchedules.filter((s) => {
    if (activeTab === "all") return true;
    if (activeTab === "queued") return s.type === "delayed";
    return categorizeSchedule(s) === activeTab;
  });

  // Count by group
  const counts: Record<ScheduleGroup, number> = {
    all: schedules.length,
    stocks: schedules.filter((s) => categorizeSchedule(s) === "stocks" && s.type !== "delayed").length,
    options: schedules.filter((s) => categorizeSchedule(s) === "options" && s.type !== "delayed").length,
    system: schedules.filter((s) => categorizeSchedule(s) === "system" && s.type !== "delayed").length,
    queued: schedules.filter((s) => s.type === "delayed").length,
  };

  const tabs: { id: ScheduleGroup; label: string }[] = [
    { id: "all", label: `All (${counts.all})` },
    { id: "stocks", label: `Stocks (${counts.stocks})` },
    { id: "options", label: `Options (${counts.options})` },
    { id: "system", label: `System (${counts.system})` },
    { id: "queued", label: `Queued (${counts.queued})` },
  ];

  if (loading) return <div className="schedules-panel">Loading schedules…</div>;
  if (error) return <div className="schedules-panel error">Error: {error} <Button onClick={fetchSchedules}>Retry</Button></div>;

  return (
    <div className="schedules-panel">
      {userLogin && (
        <div className="schedule-context">
          Schedules for <strong>{userLogin}</strong>{activeEnv ? ` · E*TRADE ${activeEnv}` : ""}
        </div>
      )}
      <div className="schedules-tabs">
        {tabs.map((t) => (
          <Button
            key={t.id}
            className={`tab ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </Button>
        ))}
        <Button
          className="tab refresh"
          onClick={() => {
            fetchSchedules();
            setRefreshSignal((n) => n + 1);
          }}
          title="Refresh"
        >
          ↻ Refresh
        </Button>
        <Button
          className="tab refresh"
          onClick={() => setOpenCreateSignal((n) => n + 1)}
          title="Create a new schedule"
        >
          ＋ New schedule
        </Button>
      </div>

      {actionError && <div className="schedule-action-error">{actionError}</div>}

      {userLogin && (activeTab === "all" || activeTab === "stocks" || activeTab === "options") && (
        <ScheduledOptionsManager
          activeEnv={activeEnv}
          userLogin={userLogin}
          onPreviewTrade={onPreviewTrade}
          groupFilter={activeTab === "all" ? "all" : activeTab}
          refreshSignal={refreshSignal}
          openCreateSignal={openCreateSignal}
        />
      )}

      <div className="schedules-grid">
        {filtered.length === 0 &&
          schedules.filter(
            (s) =>
              SCREENING_CALLBACKS.has(s.callback) &&
              (activeTab === "all" ||
                (activeTab === "stocks" && s.callback === "autonomousMarketScreen") ||
                (activeTab === "options" &&
                  s.callback !== "autonomousMarketScreen"))
          ).length === 0 && (
            <div className="empty">No schedules in this group.</div>
          )}
        {filtered.map((s) => {
          const scheduleDesc = s.cron
            ? cronToEnglish(s.cron)
            : s.type === "interval"
            ? `Every ${Math.round((s.intervalSeconds || 0) / 60)} min`
            : s.type === "delayed"
            ? "Delayed (queued)"
            : s.type;
          const universe = s.payload?.universe;
          const thesis = s.payload?.thesis;
          const summary = !universe && !thesis ? payloadSummary(s.payload) : "";
          const accountScoped = ["autonomousmarketscreen", "autonomousoptionsanalysis", "autorenewetradetokens", "collectivhistory"]
            .some((name) => s.callback.toLowerCase().includes(name));
          const owner = s.payload?.userLogin;
          const environment = s.payload?.environment || s.payload?.env;
          const shortId = s.id.slice(0, 8) + "…";
          const recurring = s.type === "cron" || s.type === "interval";
          const nextRun = !s.paused && s.time
            ? new Date(s.time * 1000).toLocaleString()
            : null;

          return (
            <div key={s.id} className="schedule-card">
              <div className="card-header">
                <span className="schedule-type">{s.type}</span>
                <span className="schedule-id" title={s.id}>{shortId}</span>
                {s.paused ? (
                  <span className="schedule-status paused">Paused</span>
                ) : (
                  <span className="schedule-status active">Active</span>
                )}
              </div>
              <div className="schedule-callback">{s.callback}</div>
              <div className="schedule-when">{scheduleDesc}</div>
              {universe && <div className="schedule-meta">Universe: {universe}</div>}
              {thesis && <div className="schedule-meta">Thesis: {thesis}</div>}
              {summary && <div className="schedule-meta">{summary}</div>}
              {s.payload?.maxItems != null && (
                <div className="schedule-meta">Max items: {s.payload.maxItems}</div>
              )}
              {nextRun && <div className="schedule-meta">Next run: {nextRun}</div>}
              {accountScoped && (
                <div className={`schedule-meta ${owner ? "schedule-auth-ok" : "schedule-auth-missing"}`}>
                  {owner
                    ? `E*TRADE account: ${owner}${environment ? ` · ${environment}` : ""}`
                    : "E*TRADE account: missing — this schedule cannot authenticate"}
                </div>
              )}
              <div className="card-actions">
                <Button onClick={() => handleTriggerNow(s.id)} disabled={!!s.paused} title={s.paused ? "Resume before triggering" : "Run now"}>
                  ⚡ Trigger Now
                </Button>
                <Button onClick={() => handlePauseResume(s)} title={s.paused ? "Resume schedule" : "Pause schedule"}>
                  {s.paused ? "▶ Resume" : "⏸ Pause"}
                </Button>
                {recurring && (
                  <Button
                    onClick={() => {
                      setEditingId(editingId === s.id ? null : s.id);
                      setCustomCron("");
                    }}
                    title="Edit frequency"
                  >
                    🕐 Edit frequency
                  </Button>
                )}
                <Button
                  onClick={() => handleDelete(s.id)}
                  className="danger"
                  title="Delete schedule"
                >
                  ✕ Delete
                </Button>
              </div>
              {editingId === s.id && (
                <div className="schedule-editor">
                  <div className="schedule-presets">
                    {FREQUENCY_PRESETS.map((p) => (
                      <Button
                        key={p.id}
                        type="button"
                        className="preset"
                        onClick={() => applyFrequency(s, { ...p.body })}
                        title={`Set frequency to ${p.label}`}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                  <div className="schedule-editor-custom">
                    <TextInput
                      type="text"
                      placeholder="Custom cron, e.g. 0 9 * * 1-5"
                      value={customCron}
                      onChange={(e) => setCustomCron(e.target.value)}
                    />
                    <Button
                      type="button"
                      disabled={!customCron.trim()}
                      onClick={() => applyFrequency(s, { scheduleType: "cron", cron: customCron.trim() })}
                    >
                      Apply cron
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
