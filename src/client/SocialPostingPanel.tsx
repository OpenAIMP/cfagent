/**
 * Issue #1382: Social posting panel — brief editor, manual trigger, status readout.
 *
 * Deliberately NO enable/disable control: the goal's enabled state is a
 * read-only readout, and a manual trigger runs the goal once without
 * enabling the daily schedule. The brief editor stores only what the user
 * types — with no stored brief it starts empty, never with invented text.
 * All reads/writes go through the existing session-gated routes.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  listGoals,
  triggerGoal,
  type ScheduledGoal,
  type ScheduleTick,
} from "./scheduleApi";
import {
  DAILY_SOCIAL_POST_GOAL_ID,
  SOCIAL_BRIEF_MAX_CHARS,
  SOCIAL_CHANNEL_ORDER,
  getBrief,
  getTokenHealth,
  listPendingApprovals,
  saveBrief,
  todayInNewYork,
  type ChannelTokenHealth,
  type PendingApproval,
} from "./socialPostingApi";

const CHANNEL_LABELS: Record<string, string> = {
  threads: "Threads",
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

const inputStyle: React.CSSProperties = { padding: "8px 12px", width: "100%" };

export function SocialPostingPanel() {
  const [date] = useState(() => todayInNewYork());
  const [briefText, setBriefText] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [goal, setGoal] = useState<ScheduledGoal | null>(null);
  const [goalMissing, setGoalMissing] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [tokenChannels, setTokenChannels] = useState<Record<string, ChannelTokenHealth>>({});
  const [lastTick, setLastTick] = useState<ScheduleTick | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [brief, goals, pending, health] = await Promise.all([
        getBrief(date),
        listGoals(),
        listPendingApprovals(date),
        getTokenHealth(),
      ]);
      setBriefText(brief.brief ?? "");
      const found = goals.goals.find((g) => g.id === DAILY_SOCIAL_POST_GOAL_ID);
      setGoal(found ?? null);
      setGoalMissing(!found);
      setApprovals(pending.approvals);
      const channelMap: Record<string, ChannelTokenHealth> = {};
      if (Array.isArray(health.channels)) {
        for (const c of health.channels) {
          if (c && typeof c === "object" && (c as ChannelTokenHealth).channel) {
            channelMap[(c as ChannelTokenHealth).channel] = c as ChannelTokenHealth;
          }
        }
      } else if (health.channels && typeof health.channels === "object") {
        Object.assign(channelMap, health.channels);
      }
      setTokenChannels(channelMap);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load social posting status.");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const overCap = briefText.length > SOCIAL_BRIEF_MAX_CHARS;
  const canSave = briefText.trim().length > 0 && !overCap && !busy;

  const handleSave = async () => {
    if (!canSave) return;
    setBusy("save");
    setError("");
    try {
      const saved = await saveBrief(briefText, date);
      setSavedNote(`Brief saved for ${saved.date}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save brief.");
    } finally {
      setBusy("");
    }
  };

  const handleTrigger = async () => {
    if (busy || !goal) return;
    setBusy("trigger");
    setError("");
    try {
      const result = await triggerGoal(DAILY_SOCIAL_POST_GOAL_ID);
      setLastTick(result.tick);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Trigger failed.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="social-posting-panel">
      <h3 style={{ margin: "0 0 4px" }}>Social posting</h3>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
        Today: {date} · manual runs only — triggering never enables the daily schedule.
      </div>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: 12 }}>{error}</div>}
      {loading && <div>Loading…</div>}

      {!loading && (
        <>
          <h3 style={{ margin: "12px 0 8px" }}>Today&apos;s brief</h3>
          <div style={{ display: "grid", gap: 8, maxWidth: 640 }}>
            <textarea
              style={{ ...inputStyle, minHeight: 120 }}
              placeholder="Write today's post here…"
              value={briefText}
              onChange={(e) => {
                setBriefText(e.target.value);
                setSavedNote("");
              }}
            />
            <div style={{ fontSize: 13, opacity: 0.8 }}>
              {briefText.length} / {SOCIAL_BRIEF_MAX_CHARS} characters
              {overCap && (
                <span style={{ color: "var(--color-danger)", marginLeft: 8 }}>
                  Over the {SOCIAL_BRIEF_MAX_CHARS}-character cap — shorten the text to save.
                </span>
              )}
            </div>
            <div>
              <button disabled={!canSave} onClick={() => void handleSave()}>
                {busy === "save" ? "Saving…" : "Save brief"}
              </button>
              {savedNote && (
                <span style={{ color: "var(--color-success)", marginLeft: 12, fontSize: 13 }}>
                  {savedNote}
                </span>
              )}
            </div>
          </div>

          <h3 style={{ margin: "20px 0 8px" }}>Daily social post goal</h3>
          {goalMissing && (
            <div style={{ opacity: 0.7 }}>
              The {DAILY_SOCIAL_POST_GOAL_ID} goal is not in the store yet.
            </div>
          )}
          {goal && (
            <div
              style={{ border: "1px solid var(--color-border-medium)", borderRadius: 8, padding: "10px 12px", marginBottom: 10, maxWidth: 640 }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <strong>{goal.name}</strong>
                <code style={{ fontSize: 12 }}>{goal.id}</code>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{goal.cron}</span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 12,
                    fontWeight: 700,
                    color: goal.enabled ? "var(--color-success)" : "var(--color-text-muted)",
                  }}
                >
                  {goal.enabled ? "ENABLED" : "DISABLED"}
                </span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
                operation <code>{goal.operation}</code> · budget ${(goal.budgetCents / 100).toFixed(2)} · last
                run {goal.lastRun ? new Date(goal.lastRun).toLocaleString() : "never"}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button disabled={!!busy} onClick={() => void handleTrigger()}>
                  Run now
                </button>
              </div>
              {lastTick && (
                <div style={{ fontSize: 13, marginTop: 8 }}>
                  Last manual run: {new Date(lastTick.timestamp).toLocaleString()} — evaluated{" "}
                  {lastTick.goalsEvaluated}, created {lastTick.jobsCreated}, skipped {lastTick.jobsSkipped}
                  {lastTick.errors.length > 0 && (
                    <div style={{ color: "var(--color-danger)", marginTop: 4 }}>
                      {lastTick.errors.map((e, i) => (
                        <div key={i}>{e}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <h3 style={{ margin: "20px 0 8px" }}>Pending approvals</h3>
          {approvals.length === 0 && (
            <div style={{ opacity: 0.7 }}>No pending approvals for {date}.</div>
          )}
          {approvals.map((a) => (
            <div
              key={a.draftId}
              style={{ border: "1px solid var(--color-border-medium)", borderRadius: 8, padding: "10px 12px", marginBottom: 10, maxWidth: 640 }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <strong>{CHANNEL_LABELS[a.channel] ?? a.channel}</strong>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{a.status}</span>
                <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>
                  {new Date(a.requestedAtMs).toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{a.text}</div>
            </div>
          ))}

          <h3 style={{ margin: "20px 0 8px" }}>Token health</h3>
          {SOCIAL_CHANNEL_ORDER.filter((id) => tokenChannels[id]).map((id) => {
            const channel = tokenChannels[id];
            return (
              <div key={id} style={{ fontSize: 13, marginBottom: 6 }}>
                <strong>{CHANNEL_LABELS[id] ?? id}</strong> —{" "}
                {channel.presence === "configured" ? "Configured" : "Not configured"} · validity{" "}
                {channel.validity === "valid"
                  ? "Valid"
                  : channel.validity === "invalid"
                    ? "Invalid"
                    : "Unknown"}
              </div>
            );
          })}
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            Validity reads Unknown in production by design: no live probe is wired, so validity is
            never assumed — only a real post proves a token works.
          </div>
        </>
      )}
    </div>
  );
}
