/**
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

/** Frequency presets shared by the inline editor and the create form. */
export const FREQUENCY_PRESETS: {
  id: string;
  label: string;
  body: { scheduleType: "interval" | "cron"; intervalSeconds?: number; cron?: string };
}[] = [
  { id: "5m", label: "5m", body: { scheduleType: "interval", intervalSeconds: 300 } },
  { id: "15m", label: "15m", body: { scheduleType: "interval", intervalSeconds: 900 } },
  { id: "30m", label: "30m", body: { scheduleType: "interval", intervalSeconds: 1800 } },
  { id: "hourly", label: "Hourly", body: { scheduleType: "cron", cron: "0 * * * *" } },
  { id: "2h", label: "2h", body: { scheduleType: "interval", intervalSeconds: 7200 } },
  { id: "daily", label: "Daily", body: { scheduleType: "cron", cron: "0 13 * * *" } },
];

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

  // Options scanners
  if (cb.includes("autonomousoptionsanalysis") || cb.includes("options")) {
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
}

export function SchedulesPanel({ activeEnv, userLogin }: SchedulesPanelProps) {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [creatableCallbacks, setCreatableCallbacks] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ScheduleGroup>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customCron, setCustomCron] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createCallback, setCreateCallback] = useState("");
  const [createPreset, setCreatePreset] = useState("hourly");
  const [createCron, setCreateCron] = useState("");
  const [createPayload, setCreatePayload] = useState("{}");
  const [createError, setCreateError] = useState<string | null>(null);

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
      if (Array.isArray(data.creatableCallbacks)) {
        setCreatableCallbacks(data.creatableCallbacks);
      }
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
    if (ok) alert("Triggered successfully");
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

  const handleCreate = async () => {
    setCreateError(null);
    let payload: unknown;
    try {
      payload = createPayload.trim() ? JSON.parse(createPayload) : {};
    } catch {
      setCreateError("Payload must be valid JSON.");
      return;
    }
    const callback = createCallback || creatableCallbacks[0] || "";
    if (!callback) {
      setCreateError("No creatable callbacks are available.");
      return;
    }
    const preset = FREQUENCY_PRESETS.find((p) => p.id === createPreset);
    const timing = createCron.trim()
      ? { scheduleType: "cron", cron: createCron.trim() }
      : preset?.body || { scheduleType: "cron", cron: "0 * * * *" };
    try {
      const res = await fetch("/api/schedules/create", {
        method: "POST",
        headers: { ...envHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ...timing, callback, payload }),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setShowCreate(false);
      setCreateCron("");
      setCreatePayload("{}");
      await fetchSchedules();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  };

  // Filter by active tab
  const filtered = schedules.filter((s) => {
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
  if (error) return <div className="schedules-panel error">Error: {error} <button onClick={fetchSchedules}>Retry</button></div>;

  return (
    <div className="schedules-panel">
      {userLogin && (
        <div className="schedule-context">
          Schedules for <strong>{userLogin}</strong>{activeEnv ? ` · E*TRADE ${activeEnv}` : ""}
        </div>
      )}
      <div className="schedules-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button className="tab refresh" onClick={fetchSchedules} title="Refresh">
          ↻ Refresh
        </button>
        <button className="tab refresh" onClick={() => setShowCreate((v) => !v)} title="Create a new schedule">
          ＋ New schedule
        </button>
      </div>

      {actionError && <div className="schedule-action-error">{actionError}</div>}

      {showCreate && (
        <div className="schedule-create-form">
          <div className="schedule-create-row">
            <label htmlFor="schedule-create-callback">Callback</label>
            <select
              id="schedule-create-callback"
              value={createCallback || creatableCallbacks[0] || ""}
              onChange={(e) => setCreateCallback(e.target.value)}
            >
              {creatableCallbacks.map((cb) => (
                <option key={cb} value={cb}>
                  {cb}
                </option>
              ))}
            </select>
          </div>
          <div className="schedule-create-row">
            <span className="schedule-create-label">Frequency</span>
            <div className="schedule-presets">
              {FREQUENCY_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset ${createPreset === p.id && !createCron.trim() ? "active" : ""}`}
                  onClick={() => {
                    setCreatePreset(p.id);
                    setCreateCron("");
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="schedule-create-row">
            <label htmlFor="schedule-create-cron">Custom cron</label>
            <input
              id="schedule-create-cron"
              type="text"
              placeholder="Cron expression, e.g. 0 9 * * 1-5 (optional)"
              value={createCron}
              onChange={(e) => setCreateCron(e.target.value)}
            />
          </div>
          <div className="schedule-create-row">
            <label htmlFor="schedule-create-payload">Payload (JSON)</label>
            <textarea
              id="schedule-create-payload"
              rows={3}
              value={createPayload}
              onChange={(e) => setCreatePayload(e.target.value)}
            />
          </div>
          {createError && <div className="schedule-action-error">{createError}</div>}
          <div className="schedule-create-actions">
            <button type="button" onClick={handleCreate}>
              Create schedule
            </button>
            <button type="button" onClick={() => setShowCreate(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="schedules-grid">
        {filtered.length === 0 && (
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
                <button onClick={() => handleTriggerNow(s.id)} disabled={!!s.paused} title={s.paused ? "Resume before triggering" : "Run now"}>
                  ⚡ Trigger Now
                </button>
                <button onClick={() => handlePauseResume(s)} title={s.paused ? "Resume schedule" : "Pause schedule"}>
                  {s.paused ? "▶ Resume" : "⏸ Pause"}
                </button>
                {recurring && (
                  <button
                    onClick={() => {
                      setEditingId(editingId === s.id ? null : s.id);
                      setCustomCron("");
                    }}
                    title="Edit frequency"
                  >
                    🕐 Edit frequency
                  </button>
                )}
                <button
                  onClick={() => handleDelete(s.id)}
                  className="danger"
                  title="Delete schedule"
                >
                  ✕ Delete
                </button>
              </div>
              {editingId === s.id && (
                <div className="schedule-editor">
                  <div className="schedule-presets">
                    {FREQUENCY_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="preset"
                        onClick={() => applyFrequency(s, { ...p.body })}
                        title={`Set frequency to ${p.label}`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="schedule-editor-custom">
                    <input
                      type="text"
                      placeholder="Custom cron, e.g. 0 9 * * 1-5"
                      value={customCron}
                      onChange={(e) => setCustomCron(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!customCron.trim()}
                      onClick={() => applyFrequency(s, { scheduleType: "cron", cron: customCron.trim() })}
                    >
                      Apply cron
                    </button>
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
