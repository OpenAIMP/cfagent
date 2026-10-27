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
import { Badge, Button, Card, Notice, PageSection, PageShell, TextInput } from "./components/ui";
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
  listPosts,
  type ChannelTokenHealth,
  type PendingApproval,
  type SocialPostItem,
} from "./socialPostingApi";

const CHANNEL_LABELS: Record<string, string> = {
  threads: "Threads",
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

export function SocialPostingPanel() {
  const [date] = useState(() => todayInNewYork());
  const [briefText, setBriefText] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [goal, setGoal] = useState<ScheduledGoal | null>(null);
  const [goalMissing, setGoalMissing] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [posts, setPosts] = useState<SocialPostItem[]>([]);
  const [tokenChannels, setTokenChannels] = useState<Record<string, ChannelTokenHealth>>({});
  const [lastTick, setLastTick] = useState<ScheduleTick | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [brief, goals, pending, health, postsRes] = await Promise.all([
        getBrief(date),
        listGoals(),
        listPendingApprovals(date),
        getTokenHealth(),
        listPosts(date).catch(() => ({ ok: false, date, posts: [] as SocialPostItem[] })),
      ]);
      setBriefText(brief.brief ?? "");
      const found = goals.goals.find((g) => g.id === DAILY_SOCIAL_POST_GOAL_ID);
      setGoal(found ?? null);
      setGoalMissing(!found);
      setApprovals(pending.approvals);
      setPosts(postsRes.posts ?? []);
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
    <PageShell
      title="Social posting"
      scopeNote={`Today: ${date} · manual runs only — triggering never enables the daily schedule.`}
      loading={loading}
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!loading && (
        <>
          <PageSection title="Today's brief">
          <div style={{ display: "grid", gap: "var(--space-2)", maxWidth: 640 }}>
            <TextInput
              multiline
              rows={6}
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
                <span style={{ color: "var(--color-danger)", marginLeft: "var(--space-2)" }}>
                  Over the {SOCIAL_BRIEF_MAX_CHARS}-character cap — shorten the text to save.
                </span>
              )}
            </div>
            <div>
              <Button variant="primary" disabled={!canSave} onClick={() => void handleSave()}>
                {busy === "save" ? "Saving…" : "Save brief"}
              </Button>
              {savedNote && (
                <span style={{ color: "var(--color-success)", marginLeft: "var(--space-3)", fontSize: 13 }}>
                  {savedNote}
                </span>
              )}
            </div>
          </div>

          </PageSection>
          <PageSection title="Daily social post goal">
          {goalMissing && (
            <div style={{ opacity: 0.7 }}>
              The {DAILY_SOCIAL_POST_GOAL_ID} goal is not in the store yet.
            </div>
          )}
          {goal && (
            <div style={{ maxWidth: 640 }}>
              <Card>
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <strong>{goal.name}</strong>
                <code style={{ fontSize: 12 }}>{goal.id}</code>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{goal.cron}</span>
                <span style={{ marginLeft: "auto" }}>
                  <Badge tone={goal.enabled ? "success" : "neutral"} size="sm">
                    {goal.enabled ? "ENABLED" : "DISABLED"}
                  </Badge>
                </span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: "var(--space-1)" }}>
                operation <code>{goal.operation}</code> · budget ${(goal.budgetCents / 100).toFixed(2)} · last
                run {goal.lastRun ? new Date(goal.lastRun).toLocaleString() : "never"}
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                <Button variant="primary" disabled={!!busy} onClick={() => void handleTrigger()}>
                  Run now
                </Button>
              </div>
              {lastTick && (
                <div style={{ fontSize: 13, marginTop: "var(--space-2)" }}>
                  Last manual run: {new Date(lastTick.timestamp).toLocaleString()} — evaluated{" "}
                  {lastTick.goalsEvaluated}, created {lastTick.jobsCreated}, skipped {lastTick.jobsSkipped}
                  {lastTick.errors.length > 0 && (
                    <div style={{ color: "var(--color-danger)", marginTop: "var(--space-1)" }}>
                      {lastTick.errors.map((e, i) => (
                        <div key={i}>{e}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              </Card>
            </div>
          )}

          </PageSection>
          <PageSection title="Pending approvals">
          {approvals.length === 0 && (
            <div style={{ opacity: 0.7 }}>No pending approvals for {date}.</div>
          )}
          <div style={{ display: "grid", gap: "var(--space-2-5)", maxWidth: 640 }}>
          {approvals.map((a) => (
            <Card key={a.draftId}>
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <strong>{CHANNEL_LABELS[a.channel] ?? a.channel}</strong>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{a.status}</span>
                <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>
                  {new Date(a.requestedAtMs).toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: 13, marginTop: "var(--space-1)" }}>{a.text}</div>
            </Card>
          ))}
          </div>

          </PageSection>
          <PageSection title="Submitted posts">
          {posts.length === 0 && (
            <div style={{ opacity: 0.7 }}>No submitted posts or drafts for {date}.</div>
          )}
          <div style={{ display: "grid", gap: "var(--space-2-5)", maxWidth: 640 }}>
          {posts.map((p) => {
            const label = CHANNEL_LABELS[p.channel] ?? p.channel;
            const isPosted = p.status === "posted";
            const isDryRun = p.status === "dry-run-posted";
            return (
              <Card key={p.draftId}>
                <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: "var(--space-1-5)" }}>
                  <strong>{label}</strong>
                  <Badge tone={isPosted ? "success" : isDryRun ? "accent" : "neutral"} size="sm">
                    {p.status.toUpperCase()}
                  </Badge>
                  {p.platformPostId && (
                    <code style={{ fontSize: 12, opacity: 0.8 }}>ID: {p.platformPostId}</code>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>
                    {new Date(p.createdAtMs).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: 13, marginBottom: "var(--space-1)" }}>
                  <span style={{ opacity: 0.7 }}>Submission endpoint: </span>
                  <code style={{ fontSize: 12 }}>{p.submissionEndpoint || "—"}</code>
                </div>
                <div style={{ fontSize: 13, marginBottom: "var(--space-1-5)" }}>
                  <span style={{ opacity: 0.7 }}>Submitted post URL: </span>
                  {p.postUrl ? (
                    <a
                      href={p.postUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--color-primary)", textDecoration: "underline" }}
                    >
                      {p.postUrl}
                    </a>
                  ) : (
                    <span style={{ opacity: 0.7, fontSize: 12 }}>
                      {isDryRun ? "Dry run (simulated — not submitted to live platform)" : "Pending submission"}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, marginTop: "var(--space-1)" }}>{p.text}</div>
              </Card>
            );
          })}
          </div>

          </PageSection>
          <PageSection title="Token health">
          {SOCIAL_CHANNEL_ORDER.filter((id) => tokenChannels[id]).map((id) => {
            const channel = tokenChannels[id];
            return (
              <div key={id} style={{ fontSize: 13, marginBottom: "var(--space-1-5)" }}>
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
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: "var(--space-1)" }}>
            Validity reads Unknown in production by design: no live probe is wired, so validity is
            never assumed — only a real post proves a token works.
          </div>
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
