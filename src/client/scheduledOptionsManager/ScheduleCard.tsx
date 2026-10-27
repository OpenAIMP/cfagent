import React from "react";
import { Button, TextInput } from "../components/ui";
import type { StrategyProfile } from "../../trading";
import type { ScheduledTaskItem } from "./types";
import { systemJobFor, triggerRouteFor } from "./systemJobs";
import { FREQUENCY_PRESETS, cadenceText, formatNextRun, formatPayloadValue, payloadOf } from "./format";
import { formatNoViewConstraints } from "./noView";

export interface ScheduleCardProps {
  item: ScheduledTaskItem;
  activeEnv: string;
  userLogin: string;
  profiles: StrategyProfile[];
  triggeringKey: string | null;
  detailId: string | null;
  detail: any;
  detailLoading: boolean;
  detailError: string | null;
  handleToggleDetails: (item: ScheduledTaskItem) => Promise<void>;
  handleTriggerCard: (item: ScheduledTaskItem) => Promise<void>;
  handleEditSchedule: (item: ScheduledTaskItem) => void;
  handleCancelSchedule: (scheduleId: string) => Promise<void>;
  /** S7: enable/disable + frequency edit folded in from the nav
   *  panel when the two schedule UIs merged into one surface. */
  handlePauseResume: (item: ScheduledTaskItem) => Promise<void>;
  freqEditingId: string | null;
  freqCustomCron: string;
  setFreqCustomCron: (value: string) => void;
  handleToggleFrequency: (item: ScheduledTaskItem) => void;
  handleApplyFrequency: (
    item: ScheduledTaskItem,
    body: { scheduleType: "interval" | "cron"; intervalSeconds?: number; cron?: string }
  ) => Promise<void>;
}

export function ScheduleCard({
  item,
  activeEnv,
  userLogin,
  profiles,
  triggeringKey,
  detailId,
  detail,
  detailLoading,
  detailError,
  handleToggleDetails,
  handleTriggerCard,
  handleEditSchedule,
  handleCancelSchedule,
  handlePauseResume,
  freqEditingId,
  freqCustomCron,
  setFreqCustomCron,
  handleToggleFrequency,
  handleApplyFrequency,
}: ScheduleCardProps) {
              const systemJob = systemJobFor(item.callback);
              const isOptions = item.callback === "autonomousOptionsAnalysis";
              const isDiscovery = item.callback === "autonomousStrategyDiscovery";
              const payload = payloadOf(item);
              const triggerRoute = triggerRouteFor(item.callback);
              const title = systemJob?.label || (isOptions ? "Autonomous Options Intelligence" : item.callback);
              const symbols = Array.isArray(payload.symbols)
                ? payload.symbols.filter((s: any) => typeof s === "string")
                : [];
              const savedRequests = Array.isArray(payload.requests) ? payload.requests : [];
              // Issue #533: a profile-derived discovery schedule is
              // labelled as its own model on the card — never as a
              // saved-view schedule — with its symbols and profile.
              const isDerivedDiscovery = isDiscovery && payload.inputModel === "profile-derived";
              const derivedProfile = isDerivedDiscovery
                ? profiles.find((p) => p.id === payload.profileId)
                : undefined;
              // Issue #534: a no-view discovery schedule likewise —
              // labelled No-view, with its symbols and the shared
              // constraints (there is no view to show).
              const isNoViewDiscovery = isDiscovery && payload.inputModel === "no-view";
              const noViewSets = isNoViewDiscovery && Array.isArray(payload.constraintSets)
                ? payload.constraintSets
                : [];
              const noViewSymbols = noViewSets
                .map((s: any) => (typeof s?.symbol === "string" ? s.symbol : ""))
                .filter(Boolean);
              const cardTitle = isNoViewDiscovery
                ? "Strategy Discovery · No-view"
                : isDerivedDiscovery
                  ? "Strategy Discovery · Profile-derived"
                  : title;
              const payloadRows: Array<[string, unknown]> = isNoViewDiscovery
                ? [
                    ["userLogin", payload.userLogin || userLogin || "—"],
                    ["environment", payload.environment || activeEnv || "—"],
                    ["input model", "No-view"],
                    ["symbols", noViewSymbols.length > 0 ? noViewSymbols.join(", ") : "—"],
                    ["constraints", noViewSets.length > 0 ? formatNoViewConstraints(noViewSets[0]) : "—"],
                    ...(noViewSets.length > 1 &&
                    noViewSets.some(
                      (s: any) => formatNoViewConstraints(s) !== formatNoViewConstraints(noViewSets[0])
                    )
                      ? [["note", "constraint sets differ per symbol — see Details"] as [string, unknown]]
                      : []),
                    ["trigger", payload.trigger || "scheduled"],
                  ]
                : isDerivedDiscovery
                ? [
                    ["userLogin", payload.userLogin || userLogin || "—"],
                    ["environment", payload.environment || activeEnv || "—"],
                    ["input model", "Profile-derived"],
                    ...(symbols.length > 0
                      ? [["symbols", symbols.join(", ")] as [string, unknown]]
                      : [["watchlist", typeof payload.watchlistName === "string" ? payload.watchlistName : "—"] as [string, unknown]]),
                    ["profile", derivedProfile
                      ? `${derivedProfile.name} (v${derivedProfile.version})`
                      : typeof payload.profileId === "string" ? payload.profileId : "—"],
                    ["trigger", payload.trigger || "scheduled"],
                  ]
                : isDiscovery
                  ? [
                      ["userLogin", payload.userLogin || userLogin || "—"],
                      ["environment", payload.environment || activeEnv || "—"],
                      ["saved views", savedRequests.length],
                      ["trigger", payload.trigger || "scheduled"],
                    ]
                  : [
                      ["userLogin", payload.userLogin || userLogin || "—"],
                      ["environment", payload.environment || activeEnv || "—"],
                      ["universe", payload.universe || (Array.isArray(payload.symbols) ? "Custom symbols" : "—")],
                      ["maxItems", payload.maxItems ?? (Array.isArray(payload.symbols) ? payload.symbols.length : "all")],
                      ["trigger", payload.trigger || "scheduled"],
                    ];

              return (
                <div
                  key={item.id}
                  className={`schedule-item-card ${isOptions ? "is-options" : isDiscovery ? "is-discovery" : "is-stock"}`}
                >
                  <div className="schedule-card-top">
                    <div style={{ display: "flex", gap: "var(--space-1-5)", alignItems: "center" }}>
                      <span className={`schedule-type-badge ${item.type}`}>
                        {item.type}
                      </span>
                      {item.paused ? (
                        <span className="schedule-status paused">Paused</span>
                      ) : null}
                      <span className="schedule-system-badge">{isOptions ? "Options" : isDiscovery ? "Discovery" : "Stock"}</span>
                    </div>
                    <span className="schedule-id-snippet" title={item.id}>
                      {item.id.slice(0, 16)}…
                    </span>
                  </div>

                  <div>
                    <h5 className="schedule-title">{cardTitle}</h5>
                    <div className="schedule-cadence">{cadenceText(item)}</div>
                    {systemJob && (
                      <p className="schedule-system-note">
                        {isNoViewDiscovery
                          ? "Ranks each symbol's live chain under the stored constraints only — no thesis, no target, and no view is stored on this schedule or set when it fires."
                          : isDerivedDiscovery
                            ? "Derives each symbol's target at run time from its live chain under a saved Strategy Profile — no target is stored on this schedule."
                            : systemJob.description}
                      </p>
                    )}
                  </div>

                  <div className="schedule-payload-details">
                    {payloadRows.map(([key, value]) => (
                      <div className="payload-row" key={String(key)}>
                        <span className="payload-label">{key}:</span>
                        <span className="payload-value">{formatPayloadValue(value)}</span>
                      </div>
                    ))}
                  </div>

                  {isDiscovery && savedRequests.length > 0 && (
                    <div className="schedule-payload-details">
                      {savedRequests.slice(0, 5).map((req: any, idx: number) => (
                        <div className="payload-row" key={idx}>
                          <span className="payload-label">{typeof req?.symbol === "string" ? req.symbol : "?"}:</span>
                          <span className="payload-value">
                            {typeof req?.thesis === "string" ? req.thesis : "—"} · target{" "}
                            {typeof req?.targetPrice === "number" ? `$${req.targetPrice}` : "—"} by{" "}
                            {typeof req?.targetDate === "string" ? req.targetDate : "—"}
                          </span>
                        </div>
                      ))}
                      {savedRequests.length > 5 && (
                        <div className="payload-row">
                          <span className="payload-value">…and {savedRequests.length - 5} more saved views</span>
                        </div>
                      )}
                    </div>
                  )}

                  {isOptions || item.callback === "autonomousMarketScreen" ? (
                    <div className="schedule-payload-details">
                      {isOptions && (
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
                              <span className="payload-value">{payload.universe || "Universe scan"}</span>
                            )}
                          </div>
                        </div>
                      )}

                      {payload.sector && (
                        <div className="payload-row">
                          <span className="payload-label">Sector:</span>
                          <span className="payload-value">{formatPayloadValue(payload.sector)}</span>
                        </div>
                      )}

                      {isOptions && (typeof payload.thesis === "string" || typeof payload.riskProfile === "string") && (
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
                  ) : null}

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
                          {detail.callback === "autonomousStrategyDiscovery" &&
                            payloadOf(detail).inputModel === "profile-derived" && (
                              <>
                                <div className="payload-row">
                                  <span className="payload-label">Input model:</span>
                                  <span className="payload-value">Profile-derived</span>
                                </div>
                                <div className="payload-row">
                                  <span className="payload-label">Profile ID:</span>
                                  <span className="payload-value">
                                    {typeof payloadOf(detail).profileId === "string"
                                      ? payloadOf(detail).profileId
                                      : "—"}
                                  </span>
                                </div>
                                <p className="sched-preset-note">
                                  Targets derived at run time: no target is stored on this
                                  schedule — each symbol&apos;s target is derived from its live
                                  chain under this profile when the schedule fires, and a symbol
                                  whose target cannot be derived honestly abstains, with the
                                  reason recorded on the run.
                                </p>
                              </>
                            )}
                          {detail.callback === "autonomousStrategyDiscovery" &&
                            payloadOf(detail).inputModel === "no-view" && (
                              <>
                                <div className="payload-row">
                                  <span className="payload-label">Input model:</span>
                                  <span className="payload-value">No-view</span>
                                </div>
                                <div className="payload-row">
                                  <span className="payload-label">Constraint sets:</span>
                                  <span className="payload-value">
                                    {Array.isArray(payloadOf(detail).constraintSets)
                                      ? payloadOf(detail).constraintSets.length
                                      : 0}
                                  </span>
                                </div>
                                <p className="sched-preset-note">
                                  No view on this schedule: it stores constraint sets only —
                                  no thesis and no target exists to run with. When it fires,
                                  each symbol&apos;s chain is ranked by the target-free
                                  no-view-v1 score model under its constraints, and a symbol
                                  where nothing qualifies abstains, with the gate reasons
                                  recorded on the run.
                                </p>
                              </>
                            )}
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
                    <Button
                      type="button"
                      className="btn-sched-action-sm"
                      onClick={() => handleToggleDetails(item)}
                      title="Inspect this schedule (type, next run, payload)"
                    >
                      {detailId === item.id ? "▾ Hide Details" : "🔍 Details"}
                    </Button>
                    {triggerRoute && (
                      <Button
                        type="button"
                        className="btn-sched-action-sm"
                        onClick={() => handleTriggerCard(item)}
                        disabled={triggeringKey !== null || !!item.paused}
                        title={item.paused ? "Resume before triggering" : `Run ${cardTitle} immediately, on demand`}
                      >
                        {triggeringKey === item.id ? "⚡ Running…" : "⚡ Trigger Now"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      className="btn-sched-action-sm"
                      style={{ background: "var(--color-accent-subtle)", borderColor: "var(--color-border-focus)", color: "var(--color-accent)" }}
                      onClick={() => handleEditSchedule(item)}
                      title="Update parameters or cadence for this schedule"
                    >
                      ✏ Edit / Update
                    </Button>
                    <Button
                      type="button"
                      className="btn-sched-action-sm"
                      onClick={() => handlePauseResume(item)}
                      title={item.paused ? "Resume schedule" : "Pause schedule"}
                    >
                      {item.paused ? "▶ Resume" : "⏸ Pause"}
                    </Button>
                    {(item.type === "cron" || item.type === "interval") && (
                      <Button
                        type="button"
                        className="btn-sched-action-sm"
                        onClick={() => handleToggleFrequency(item)}
                        title="Edit frequency"
                      >
                        🕐 Edit frequency
                      </Button>
                    )}
                    <Button
                      type="button"
                      className="btn-sched-cancel-sm"
                      onClick={() => handleCancelSchedule(item.id)}
                      title="Permanently cancel this durable schedule"
                    >
                      ✕ Cancel
                    </Button>
                  </div>

                  {freqEditingId === item.id && (
                    <div className="schedule-editor">
                      <div className="schedule-presets">
                        {FREQUENCY_PRESETS.map((p) => (
                          <Button
                            key={p.id}
                            type="button"
                            className="preset"
                            onClick={() => handleApplyFrequency(item, { ...p.body })}
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
                          value={freqCustomCron}
                          onChange={(e) => setFreqCustomCron(e.target.value)}
                        />
                        <Button
                          type="button"
                          disabled={!freqCustomCron.trim()}
                          onClick={() =>
                            handleApplyFrequency(item, {
                              scheduleType: "cron",
                              cron: freqCustomCron.trim(),
                            })
                          }
                        >
                          Apply cron
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
}
