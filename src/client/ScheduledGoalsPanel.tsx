/**
 * Issue #159: ScheduledAgent dashboard — goals, tick history, and add-goal form.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  listGoals,
  getTickHistory,
  addGoal,
  setGoalEnabled,
  triggerGoal,
  removeGoal,
  type ScheduledGoal,
  type ScheduleTick,
} from "./scheduleApi";

export interface ScheduledGoalsPanelProps {
  embedded?: boolean;
}

const inputStyle: React.CSSProperties = { padding: "8px 12px", width: "100%" };

export function ScheduledGoalsPanel({ embedded = false }: ScheduledGoalsPanelProps = {}) {
  const [goals, setGoals] = useState<ScheduledGoal[]>([]);
  const [ticks, setTicks] = useState<ScheduleTick[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    id: "",
    name: "",
    cron: "",
    operation: "",
    budgetCents: "",
  });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [g, t] = await Promise.all([listGoals(), getTickHistory(20)]);
      setGoals(g.goals);
      setTicks(t.ticks);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load schedules.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed.");
    } finally {
      setBusy("");
    }
  };

  const submitGoal = async () => {
    setFormError("");
    const budgetCents = Number(form.budgetCents);
    if (!form.id.trim() || !form.name.trim() || !form.cron.trim() || !form.operation.trim()) {
      setFormError("id, name, cron, and operation are required.");
      return;
    }
    if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
      setFormError("budget must be a positive number of cents.");
      return;
    }
    await withBusy("add", async () => {
      await addGoal({
        id: form.id,
        name: form.name,
        cron: form.cron,
        operation: form.operation,
        budgetCents: Math.floor(budgetCents),
      });
      setForm({ id: "", name: "", cron: "", operation: "", budgetCents: "" });
    });
  };

  return (
    <div className={embedded ? "" : "scheduled-goals-panel"}>
      <h3 style={{ margin: "0 0 12px" }}>Scheduled goals</h3>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: 12 }}>{error}</div>}
      {loading && <div>Loading…</div>}

      {!loading && goals.length === 0 && <div style={{ opacity: 0.7 }}>No scheduled goals.</div>}
      {goals.map((g) => (
        <div
          key={g.id}
          style={{ border: "1px solid var(--color-border-medium)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <strong>{g.name}</strong>
            <code style={{ fontSize: 12 }}>{g.id}</code>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{g.cron}</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 12,
                fontWeight: 700,
                color: g.enabled ? "var(--color-success)" : "var(--color-text-muted)",
              }}
            >
              {g.enabled ? "ENABLED" : "DISABLED"}
            </span>
          </div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
            operation <code>{g.operation}</code> · budget ${(g.budgetCents / 100).toFixed(2)} · last
            run {g.lastRun ? new Date(g.lastRun).toLocaleString() : "never"}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              disabled={!!busy}
              onClick={() =>
                void withBusy(`toggle-${g.id}`, () => setGoalEnabled(g.id, !g.enabled).then(() => {}))
              }
            >
              {g.enabled ? "Disable" : "Enable"}
            </button>
            <button disabled={!!busy} onClick={() => void withBusy(`trigger-${g.id}`, () => triggerGoal(g.id).then(() => {}))}>
              Run now
            </button>
            <button
              disabled={!!busy}
              onClick={() => {
                if (window.confirm(`Remove scheduled goal "${g.name}"?`)) {
                  void withBusy(`remove-${g.id}`, () => removeGoal(g.id).then(() => {}));
                }
              }}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <h3 style={{ margin: "20px 0 12px" }}>Add goal</h3>
      {formError && <div style={{ color: "var(--color-danger)", marginBottom: 8 }}>{formError}</div>}
      <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
        <input style={inputStyle} placeholder="id (e.g. weekly-report)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
        <input style={inputStyle} placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input style={inputStyle} placeholder='cron (e.g. "0 6 * * *")' value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
        <input style={inputStyle} placeholder="operation (e.g. search.query)" value={form.operation} onChange={(e) => setForm({ ...form, operation: e.target.value })} />
        <input style={inputStyle} placeholder="budget in cents (e.g. 500)" value={form.budgetCents} onChange={(e) => setForm({ ...form, budgetCents: e.target.value })} />
        <div>
          <button disabled={busy === "add"} onClick={() => void submitGoal()}>
            {busy === "add" ? "Adding…" : "Add goal"}
          </button>
        </div>
      </div>

      <h3 style={{ margin: "20px 0 12px" }}>Recent ticks</h3>
      {ticks.length === 0 && <div style={{ opacity: 0.7 }}>No ticks recorded yet.</div>}
      {ticks.map((t, i) => (
        <div key={`${t.timestamp}-${i}`} style={{ fontSize: 13, marginBottom: 8, borderBottom: "1px solid var(--color-border-subtle)", paddingBottom: 8 }}>
          <div>
            <strong>{new Date(t.timestamp).toLocaleString()}</strong> — evaluated {t.goalsEvaluated},
            created {t.jobsCreated}, skipped {t.jobsSkipped}
          </div>
          {t.errors.length > 0 && (
            <div style={{ color: "var(--color-danger)", marginTop: 4 }}>
              {t.errors.map((e, j) => (
                <div key={j}>{e}</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
