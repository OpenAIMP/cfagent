import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "./components/ui";
import { apiFetch as fetch } from "./apiFetch";
import { listProfiles } from "./scannerApi";
import type { StrategyProfile } from "../trading";
import { etToUtcCron } from "./options/cronTime";
import "./scheduledOptions.css";
import type {
  CreatableJob,
  DiscoveryInputModel,
  DiscoveryRequestDraft,
  NoViewConstraintsDraft,
  OptionsRunSummary,
  ScheduleFormState,
  ScheduleMode,
  ScheduledOptionsManagerProps,
  ScheduledTaskItem,
} from "./scheduledOptionsManager/types";
import {
  TRIGGER_ROUTES,
  systemJobFor,
  triggerRouteFor,
} from "./scheduledOptionsManager/systemJobs";
import {
  blankDiscoveryRequestDraft,
  discoveryDraftFromRequest,
} from "./scheduledOptionsManager/discoveryRequests";
import { profileDerivationBlockReason } from "./scheduledOptionsManager/profileDerived";
import {
  blankNoViewConstraintsDraft,
  noViewDraftFromConstraintSets,
} from "./scheduledOptionsManager/noView";
import { payloadOf } from "./scheduledOptionsManager/format";
import {
  buildOptionsRunNowPayload,
  buildScheduleSubmission,
  parseSymbolsText,
} from "./scheduledOptionsManager/payloadBuilders";
import { LiveResultPreview } from "./scheduledOptionsManager/LiveResultPreview";
import { LatestRunsSection } from "./scheduledOptionsManager/LatestRunsSection";
import { SchedulesSection } from "./scheduledOptionsManager/SchedulesSection";
import { AuditTrailSection } from "./scheduledOptionsManager/AuditTrailSection";
import { ScheduleFormModal } from "./scheduledOptionsManager/ScheduleFormModal";

export type {
  CreatableJob,
  DiscoveryInputModel,
  DiscoveryRequestDraft,
  NoViewConstraintsDraft,
  OptionsRunSummary,
  ScheduleFormState,
  ScheduleMode,
  ScheduledOptionsManagerProps,
  ScheduledTaskItem,
  SystemJobInfo,
} from "./scheduledOptionsManager/types";
export {
  JOB_CALLBACKS,
  SYSTEM_JOBS,
  TRIGGER_ROUTES,
  systemJobFor,
  triggerRouteFor,
} from "./scheduledOptionsManager/systemJobs";
export {
  DISCOVERY_REQUEST_LIMIT,
  blankDiscoveryRequestDraft,
  buildDiscoveryRequests,
  discoveryDraftFromRequest,
} from "./scheduledOptionsManager/discoveryRequests";
export {
  buildProfileDerivedPayload,
  parseDerivedSymbols,
  profileDerivationBlockReason,
} from "./scheduledOptionsManager/profileDerived";
export {
  NO_VIEW_DEFAULT_MIN_POP,
  blankNoViewConstraintsDraft,
  buildNoViewPayload,
  formatNoViewConstraints,
  noViewDraftFromConstraintSets,
} from "./scheduledOptionsManager/noView";
export { formatNextRun, formatPayloadValue } from "./scheduledOptionsManager/format";
export {
  buildOptionsRunNowPayload,
  buildScheduleSubmission,
  parseSymbolsText,
  validateScheduleCriteriaClient,
} from "./scheduledOptionsManager/payloadBuilders";

export function ScheduledOptionsManager({
  activeEnv = "sandbox",
  userLogin,
  onPreviewTrade,
  onSendPrompt,
  groupFilter = "all",
  refreshSignal,
  openCreateSignal,
}: ScheduledOptionsManagerProps) {
  // Schedules List State
  const [schedules, setSchedules] = useState<ScheduledTaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Issue #223: autonomous options runs persisted by the DO (last 20 kept).
  const [latestRuns, setLatestRuns] = useState<OptionsRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);

  // Form State
  const [jobType, setJobType] = useState<CreatableJob>("optionsAnalysis");
  const [targetSymbols, setTargetSymbols] = useState("");
  const [maxItems, setMaxItems] = useState(100);
  const [targetUniverse, setTargetUniverse] = useState("NASDAQ100");
  const [sector, setSector] = useState("Technology");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minMarketCap, setMinMarketCap] = useState("");
  const [maxPe, setMaxPe] = useState("");
  const [trendFilter, setTrendFilter] = useState("");
  // Issue #1499 (#940-E): stored stocks preset for market-screen schedules.
  const [presetId, setPresetId] = useState("");
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
  // Saved discovery views edited by the create form (issue #126).
  const [discoveryRequests, setDiscoveryRequests] = useState<DiscoveryRequestDraft[]>([
    blankDiscoveryRequestDraft(),
  ]);
  // Profile-derived discovery form state (issue #533): the input
  // model switch, the symbol source (symbols XOR watchlist name),
  // and the Strategy Profile picker.
  const [discoveryInputModel, setDiscoveryInputModel] = useState<DiscoveryInputModel>("saved-request");
  const [derivedSource, setDerivedSource] = useState<"symbols" | "watchlist">("symbols");
  const [derivedSymbolsText, setDerivedSymbolsText] = useState("");
  const [derivedWatchlistName, setDerivedWatchlistName] = useState("");
  const [derivedProfileId, setDerivedProfileId] = useState("");
  const [profiles, setProfiles] = useState<StrategyProfile[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  // No-view discovery form state (issue #534): the shared constraint
  // editor, plus whether the schedule being edited was armed with
  // per-symbol constraints the shared editor cannot represent
  // verbatim (surfaced in the form when true).
  const [noViewDraft, setNoViewDraft] = useState<NoViewConstraintsDraft>(blankNoViewConstraintsDraft());
  const [noViewDivergent, setNoViewDivergent] = useState(false);

  const updateNoViewDraft = (patch: Partial<NoViewConstraintsDraft>) =>
    setNoViewDraft((prev) => ({ ...prev, ...patch }));

  const updateDiscoveryRequest = (idx: number, patch: Partial<DiscoveryRequestDraft>) =>
    setDiscoveryRequests((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));

  // On-Demand Execution State: which trigger is in flight — "hero" for
  // the banner Run Now button, otherwise the schedule's id.
  const [triggeringKey, setTriggeringKey] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<any | null>(null);

  // S7: frequency editing folded in from the nav panel — presets +
  // custom cron applied with PUT /api/schedules/:id.
  const [freqEditingId, setFreqEditingId] = useState<string | null>(null);
  const [freqCustomCron, setFreqCustomCron] = useState("");

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
        setSchedules(rawList.filter((s: any) =>
          s && typeof s === "object" && typeof s.id === "string" &&
          (s.callback === "autonomousMarketScreen" || s.callback === "autonomousOptionsAnalysis" ||
            s.callback === "autonomousStrategyDiscovery")
        ));
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
          e.type.startsWith("screener.") ||
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

  // Strategy Profiles for the profile-derived discovery form and
  // for resolving profile names on schedule cards (issue #533).
  // Best-effort: a failed load leaves the picker empty with the
  // error shown in the form, and cards fall back to the stored
  // profile id — the client never invents a profile name.
  useEffect(() => {
    let cancelled = false;
    listProfiles(activeEnv, userLogin)
      .then((list) => {
        if (!cancelled) {
          setProfiles(list);
          setProfilesError(null);
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setProfiles([]);
          setProfilesError(err?.message || "Failed to load strategy profiles");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeEnv, userLogin]);


  // Issue #223: latest autonomous options runs. Polls so a scheduled fire
  // shows up without a manual refresh; failure is reported, never faked.
  const fetchLatestRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const res = await fetch("/api/options/latest", { headers: authHeaders() });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setLatestRuns(Array.isArray(data?.runs) ? data.runs.slice(0, 5) : []);
      setRunsError(null);
    } catch (err: any) {
      setRunsError(err?.message || "Could not load autonomous options runs");
    } finally {
      setRunsLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    fetchLatestRuns();
    const timer = setInterval(fetchLatestRuns, 60_000);
    return () => clearInterval(timer);
  }, [fetchLatestRuns]);

  // Open the modal for a NEW schedule (never an edit session).
  const openCreateModal = () => {
    setEditingScheduleId(null);
    setJobType("optionsAnalysis");
    setTargetUniverse("NASDAQ100");
    setTargetSymbols("");
    setMaxItems(100);
    setSector("Technology");
    setMinPrice("");
    setMaxPrice("");
    setMinMarketCap("");
    setMaxPe("");
    setTrendFilter("");
    setPresetId("");
    setDiscoveryRequests([blankDiscoveryRequestDraft()]);
    setDiscoveryInputModel("saved-request");
    setDerivedSource("symbols");
    setDerivedSymbolsText("");
    setDerivedWatchlistName("");
    setDerivedProfileId("");
    setNoViewDraft(blankNoViewConstraintsDraft());
    setNoViewDivergent(false);
    setModalOpen(true);
  };

  // Edit a user-created stock screen, options screen, or discovery schedule.
  const handleEditSchedule = (item: ScheduledTaskItem) => {
    setEditingScheduleId(item.id);
    const payload = payloadOf(item);
    if (item.callback === "autonomousStrategyDiscovery") {
      setJobType("strategyDiscovery");
      if (payload.inputModel === "no-view") {
        // Hydrate the no-view editor from the payload's constraint
        // sets (issue #534): the model switch, the symbol list, and
        // the shared constraints (with the divergence flag when the
        // sets were armed per-symbol).
        setDiscoveryInputModel("no-view");
        const { draft, shared } = noViewDraftFromConstraintSets(
          Array.isArray(payload.constraintSets) ? payload.constraintSets : []
        );
        setNoViewDraft(draft);
        setNoViewDivergent(!shared);
        setDiscoveryRequests([blankDiscoveryRequestDraft()]);
      } else if (payload.inputModel === "profile-derived") {
        // Hydrate the profile-derived editor from the payload
        // (issue #533): the model switch, the one symbol source the
        // payload carries, and the profile it derives under.
        setDiscoveryInputModel("profile-derived");
        const syms = Array.isArray(payload.symbols)
          ? payload.symbols.filter((s: any) => typeof s === "string")
          : [];
        setDerivedSymbolsText(syms.join(", "));
        const watchlistName = typeof payload.watchlistName === "string" ? payload.watchlistName : "";
        setDerivedWatchlistName(watchlistName);
        setDerivedSource(watchlistName ? "watchlist" : "symbols");
        setDerivedProfileId(typeof payload.profileId === "string" ? payload.profileId : "");
        setDiscoveryRequests([blankDiscoveryRequestDraft()]);
      } else {
        setDiscoveryInputModel("saved-request");
        const saved = Array.isArray(payload.requests) ? payload.requests : [];
        setDiscoveryRequests(
          saved.length > 0 ? saved.map(discoveryDraftFromRequest) : [blankDiscoveryRequestDraft()]
        );
      }
    } else {
      setJobType(item.callback === "autonomousMarketScreen" ? "marketScreen" : "optionsAnalysis");
      const syms = payload.symbols;
      setTargetSymbols(Array.isArray(syms) ? syms.join(", ") : "");
      setMaxItems(Number.isSafeInteger(payload.maxItems) ? payload.maxItems : 100);
      setTargetUniverse(
        typeof payload.universe === "string"
          ? payload.universe
          : item.callback === "autonomousMarketScreen" ? "NASDAQ100" : ""
      );
      setSector(typeof payload.sector === "string" ? payload.sector : "Technology");
      setPresetId(typeof payload.presetId === "string" ? payload.presetId : "");
      setThesis(payload.thesis || "bullish");
      setRiskProfile(payload.riskProfile || "balanced");
      setPushToSlack(payload.pushToSlack !== false);
      if (payload.slackChannel) setSlackChannel(payload.slackChannel);
      if (payload.emailTo) setEmailTo(payload.emailTo);
      if (payload.webhookUrl) setWebhookUrl(payload.webhookUrl);
      if (payload.filters) {
        setMinPrice(payload.filters.minPrice != null ? String(payload.filters.minPrice) : "");
        setMaxPrice(payload.filters.maxPrice != null ? String(payload.filters.maxPrice) : "");
        setMinMarketCap(payload.filters.minMarketCap != null ? String(payload.filters.minMarketCap) : "");
        // Issue #959: the canonical filter fields are maxPeRatio and
        // momentum. The pre-#959 form sent filters.maxPe / filters.trend,
        // which are NOT StockScreenerFilter fields and were silently
        // ignored by the engine. maxPe hydrates from the legacy name
        // for stored schedules (same meaning, renamed field); the
        // legacy trend values never had engine semantics, so only the
        // canonical momentum hydrates.
        setMaxPe(payload.filters.maxPeRatio != null ? String(payload.filters.maxPeRatio) : payload.filters.maxPe != null ? String(payload.filters.maxPe) : "");
        setTrendFilter(payload.filters.momentum || "");
      } else {
        setMinPrice("");
        setMaxPrice("");
        setMinMarketCap("");
        setMaxPe("");
        setTrendFilter("");
      }
    }
    setScheduleType(
      item.type === "cron" || item.type === "delayed" || item.type === "scheduled" ? item.type : "interval"
    );
    if (item.intervalSeconds) setIntervalSeconds(item.intervalSeconds);
    if (item.cron) setCronExpression(item.cron);
    if (item.delayInSeconds) setDelaySeconds(item.delayInSeconds);
    setModalOpen(true);
  };

  // Create or Update Schedule
  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessMsg(null);

    // S7: the one payload-construction path — the kind builders in
    // scheduledOptionsManager/payloadBuilders (golden-pinned against
    // the bodies this inline code used to submit).
    const built = buildScheduleSubmission({
      jobType,
      targetSymbols,
      maxItems,
      targetUniverse,
      sector,
      minPrice,
      maxPrice,
      minMarketCap,
      maxPe,
      trendFilter,
      presetId,
      scheduleType,
      intervalSeconds,
      cronExpression,
      delaySeconds,
      scheduledDate,
      thesis,
      riskProfile,
      pushToSlack,
      slackChannel,
      emailTo,
      webhookUrl,
      discoveryRequests,
      discoveryInputModel,
      derivedSource,
      derivedSymbolsText,
      derivedWatchlistName,
      derivedProfileId,
      noViewDraft,
      environment: activeEnv,
    });
    if ("error" in built) {
      setError(built.error);
      setSubmitting(false);
      return;
    }
    const requestBody: any = built.requestBody;

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

  // Cancel Schedule — the actual POST.
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

  // S7: pause/resume folded in from the nav panel (issue #273
  // routes). Pausing keeps the definition in the paused store; the
  // list keeps the row with its Paused badge.
  const handlePauseResume = async (item: ScheduledTaskItem) => {
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch(`/api/schedules/${item.id}/${item.paused ? "resume" : "pause"}`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.success !== false) {
        setSuccessMsg(`✓ Schedule ${item.id} ${item.paused ? "resumed" : "paused"}`);
        fetchSchedules();
        fetchAudit();
      } else {
        setError(data.error || `Failed to ${item.paused ? "resume" : "pause"} schedule`);
      }
    } catch (err: any) {
      setError(err.message || "Failed to update schedule");
    }
  };

  // S7: frequency-only edit (the nav panel's PUT path) — cadence
  // changes without re-opening the full form.
  const applyFrequency = async (
    item: ScheduledTaskItem,
    body: { scheduleType: "interval" | "cron"; intervalSeconds?: number; cron?: string }
  ) => {
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${item.id}`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.success !== false) {
        setFreqEditingId(null);
        setFreqCustomCron("");
        setSuccessMsg(`✓ Schedule ${item.id} frequency updated`);
        fetchSchedules();
      } else {
        setError(data.error || "Failed to update frequency");
      }
    } catch (err: any) {
      setError(err.message || "Failed to update frequency");
    }
  };

  const handleToggleFrequency = (item: ScheduledTaskItem) => {
    setFreqEditingId(freqEditingId === item.id ? null : item.id);
    setFreqCustomCron("");
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
        } else if (item.callback === "autonomousStrategyDiscovery") {
          const d = data.data;
          if (d && typeof d === "object") {
            const failedNote =
              (d.failedCount ?? 0) > 0
                ? ` ${d.failedCount} failed${Array.isArray(d.failures) && d.failures.length > 0
                    ? `: ${d.failures.map((f: any) => `${f.symbol} (${f.error})`).join("; ")}`
                    : ""}.`
                : "";
            // The unit the run counted: saved views, or constraint
            // sets for a no-view schedule (issue #534) — a no-view
            // run is never reported as views.
            const unitLabel =
              payloadOf(item).inputModel === "no-view" ? "constraint sets" : "saved views";
            setSuccessMsg(
              `✓ ${label} executed! ${d.completedCount ?? 0} of ${d.requestCount ?? 0} ${unitLabel} produced results.${failedNote}`
            );
          } else {
            setSuccessMsg(`✓ ${label} executed.${data.message ? ` ${data.message}` : ""}`);
          }
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

    const symbols = parseSymbolsText(targetSymbols);
    if (!targetUniverse && symbols.length === 0) {
      setError("Choose a universe or enter at least one symbol.");
      setTriggeringKey(null);
      return;
    }

    // S7: the hero payload comes from the same builders module as
    // the schedule payloads (its own shape — no trigger stamp).
    const payload = buildOptionsRunNowPayload({
      jobType,
      targetSymbols,
      maxItems,
      targetUniverse,
      sector,
      minPrice,
      maxPrice,
      minMarketCap,
      maxPe,
      trendFilter,
      scheduleType,
      intervalSeconds,
      cronExpression,
      delaySeconds,
      scheduledDate,
      thesis,
      riskProfile,
      pushToSlack,
      slackChannel,
      emailTo,
      webhookUrl,
      discoveryRequests,
      discoveryInputModel,
      derivedSource,
      derivedSymbolsText,
      derivedWatchlistName,
      derivedProfileId,
      noViewDraft,
      environment: activeEnv,
    });

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

  // S7 host signals: the hosting SchedulesPanel asks this section
  // to refetch (its Refresh button) or to open the create modal (its
  // "New schedule" button — the one structured create form).
  const prevRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (prevRefreshSignal.current !== refreshSignal) {
      prevRefreshSignal.current = refreshSignal;
      fetchSchedules();
    }
  }, [refreshSignal, fetchSchedules]);

  const prevOpenCreateSignal = useRef(openCreateSignal);
  useEffect(() => {
    if (prevOpenCreateSignal.current !== openCreateSignal) {
      prevOpenCreateSignal.current = openCreateSignal;
      openCreateModal();
    }
  }, [openCreateSignal]);

  // S7: the host's tab filter narrows which screening kinds show.
  const visibleSchedules = schedules.filter((s) =>
    groupFilter === "stocks"
      ? s.callback === "autonomousMarketScreen"
      : groupFilter === "options"
        ? s.callback === "autonomousOptionsAnalysis" ||
          s.callback === "autonomousStrategyDiscovery"
        : true
  );

  const selectedDerivedProfile = profiles.find((p) => p.id === derivedProfileId);
  const selectedDerivedProfileReason = selectedDerivedProfile
    ? profileDerivationBlockReason(selectedDerivedProfile)
    : null;

  return (
    <div className="scheduled-options-manager">
      {/* Top Hero Banner */}
      <div className="sched-hero-banner">
        <div className="sched-hero-info">
          <h3>
            <span>⏰</span> Autonomous Options Screening &amp; Schedulers
          </h3>
          <p>
            Persistent Background Timers (<code>schedule</code> / <code>scheduleEvery</code>) run within the autonomous orchestration runtime — each registered job fires on its own schedule, independently of whether your browser tab is open. When a scheduled analysis or screen completes, its results are broadcast to connected app clients, and notifications are sent only to the channels configured on that job (Slack, email, webhook) — a channel the job doesn&apos;t configure receives nothing.
          </p>
        </div>

        <div className="sched-hero-actions">
          <Button
            type="button"
            className="btn-sched-secondary"
            onClick={() => handleTriggerNow()}
            disabled={triggeringKey !== null}
            title="Execute the options intelligence scan immediately on demand"
          >
            {triggeringKey === "hero" ? "⚡ Running Screen…" : "⚡ Run Now"}
          </Button>
          <Button
            type="button"
            className="btn-sched-primary"
            onClick={openCreateModal}
            title="Register a new durable schedule"
          >
            <span>+</span> New Schedule
          </Button>
        </div>
      </div>

      <div className="sched-arch-callout">
        <div>
          🛡️ <strong>Page-Independent Execution Guarantee:</strong> Timers persist in server-side distributed state. You can close this browser anytime — scheduled tasks continue firing on schedule.
        </div>
        <div className="sched-arch-badges">
          <span className="arch-pill">💬 Slack Block Kit [✓ Approve]</span>
          <span className="arch-pill">📧 Dark-Mode Payoff Briefs</span>
          <span className="arch-pill">🔗 Signed Webhooks</span>
          <span className="arch-pill">📡 WebSocket Push</span>
        </div>
      </div>

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
      <LiveResultPreview liveResult={liveResult} onPreviewTrade={onPreviewTrade} />

      {/* Latest autonomous options runs (#223): persisted analysis runs, newest first. */}
      <LatestRunsSection
        latestRuns={latestRuns}
        runsLoading={runsLoading}
        runsError={runsError}
        fetchLatestRuns={fetchLatestRuns}
      />

      {/* Active Schedules Section */}
      <SchedulesSection
        schedules={visibleSchedules}
        loading={loading}
        fetchSchedules={fetchSchedules}
        openCreateModal={openCreateModal}
        activeEnv={activeEnv}
        userLogin={userLogin}
        profiles={profiles}
        triggeringKey={triggeringKey}
        detailId={detailId}
        detail={detail}
        detailLoading={detailLoading}
        detailError={detailError}
        handleToggleDetails={handleToggleDetails}
        handleTriggerCard={handleTriggerCard}
        handleEditSchedule={handleEditSchedule}
        handleCancelSchedule={handleCancelSchedule}
        handlePauseResume={handlePauseResume}
        freqEditingId={freqEditingId}
        freqCustomCron={freqCustomCron}
        setFreqCustomCron={setFreqCustomCron}
        handleToggleFrequency={handleToggleFrequency}
        handleApplyFrequency={applyFrequency}
      />

      {/* Execution Audit Trail Section */}
      <AuditTrailSection
        auditLogs={auditLogs}
        loadingAudit={loadingAudit}
        fetchAudit={fetchAudit}
      />

      {/* Create Schedule Modal */}
      {modalOpen && (
        <ScheduleFormModal
          editingScheduleId={editingScheduleId}
          submitting={submitting}
          setModalOpen={setModalOpen}
          handleCreateSchedule={handleCreateSchedule}
          jobType={jobType}
          setJobType={setJobType}
          targetUniverse={targetUniverse}
          setTargetUniverse={setTargetUniverse}
          targetSymbols={targetSymbols}
          setTargetSymbols={setTargetSymbols}
          maxItems={maxItems}
          setMaxItems={setMaxItems}
          sector={sector}
          setSector={setSector}
          minPrice={minPrice}
          setMinPrice={setMinPrice}
          maxPrice={maxPrice}
          setMaxPrice={setMaxPrice}
          minMarketCap={minMarketCap}
          setMinMarketCap={setMinMarketCap}
          maxPe={maxPe}
          setMaxPe={setMaxPe}
          trendFilter={trendFilter}
          setTrendFilter={setTrendFilter}
          presetId={presetId}
          setPresetId={setPresetId}
          userLogin={userLogin}
          discoveryInputModel={discoveryInputModel}
          setDiscoveryInputModel={setDiscoveryInputModel}
          discoveryRequests={discoveryRequests}
          setDiscoveryRequests={setDiscoveryRequests}
          updateDiscoveryRequest={updateDiscoveryRequest}
          derivedSource={derivedSource}
          setDerivedSource={setDerivedSource}
          derivedSymbolsText={derivedSymbolsText}
          setDerivedSymbolsText={setDerivedSymbolsText}
          derivedWatchlistName={derivedWatchlistName}
          setDerivedWatchlistName={setDerivedWatchlistName}
          derivedProfileId={derivedProfileId}
          setDerivedProfileId={setDerivedProfileId}
          profiles={profiles}
          profilesError={profilesError}
          selectedDerivedProfileReason={selectedDerivedProfileReason}
          noViewDraft={noViewDraft}
          updateNoViewDraft={updateNoViewDraft}
          noViewDivergent={noViewDivergent}
          scheduleType={scheduleType}
          setScheduleType={setScheduleType}
          intervalSeconds={intervalSeconds}
          setIntervalSeconds={setIntervalSeconds}
          cronExpression={cronExpression}
          setCronExpression={setCronExpression}
          delaySeconds={delaySeconds}
          setDelaySeconds={setDelaySeconds}
          scheduledDate={scheduledDate}
          setScheduledDate={setScheduledDate}
          thesis={thesis}
          setThesis={setThesis}
          riskProfile={riskProfile}
          setRiskProfile={setRiskProfile}
          pushToSlack={pushToSlack}
          setPushToSlack={setPushToSlack}
          slackChannel={slackChannel}
          setSlackChannel={setSlackChannel}
          emailTo={emailTo}
          setEmailTo={setEmailTo}
          webhookUrl={webhookUrl}
          setWebhookUrl={setWebhookUrl}
        />
      )}
    </div>
  );
}
