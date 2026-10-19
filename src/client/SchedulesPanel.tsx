/**
 * Issue #309: Schedules Panel with tabbed grouping.
 *
 * Displays all durable schedules grouped by category:
 * - All | Stocks | Options | System | Queued
 *
 * Each schedule card shows:
 * - Human-readable schedule description (cron → English)
 * - Universe/thesis, job ID
 * - Trigger Now, Pause/Resume, Cancel actions
 *
 * Also supports creating new schedules.
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
  time?: number;
  createdAt?: string;
  nextRun?: string;
}

type ScheduleGroup = "all" | "stocks" | "options" | "system" | "queued";

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

interface SchedulesPanelProps {
  activeEnv?: string;
  userLogin?: string;
}

export function SchedulesPanel({ activeEnv, userLogin }: SchedulesPanelProps) {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ScheduleGroup>("all");

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as any;
      setSchedules(data.schedules || data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  const handleCancel = async (id: string) => {
    if (!confirm("Cancel this schedule?")) return;
    try {
      const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSchedules();
    } catch (err) {
      alert(`Failed to cancel: ${err instanceof Error ? err.message : err}`);
    }
  };

  const handleTriggerNow = async (id: string) => {
    try {
      const res = await fetch(`/api/schedules/${id}/trigger`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      alert("Triggered successfully");
    } catch (err) {
      alert(`Failed to trigger: ${err instanceof Error ? err.message : err}`);
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
      </div>

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
          const shortId = s.id.slice(0, 8) + "…";

          return (
            <div key={s.id} className="schedule-card">
              <div className="card-header">
                <span className="schedule-type">{s.type}</span>
                <span className="schedule-id" title={s.id}>{shortId}</span>
              </div>
              <div className="schedule-callback">{s.callback}</div>
              <div className="schedule-when">{scheduleDesc}</div>
              {universe && <div className="schedule-meta">Universe: {universe}</div>}
              {thesis && <div className="schedule-meta">Thesis: {thesis}</div>}
              {s.payload?.maxItems && (
                <div className="schedule-meta">Max items: {s.payload.maxItems}</div>
              )}
              <div className="card-actions">
                <button onClick={() => handleTriggerNow(s.id)} title="Run now">
                  ⚡ Trigger Now
                </button>
                <button
                  onClick={() => handleCancel(s.id)}
                  className="danger"
                  title="Cancel schedule"
                >
                  ✕ Cancel
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
