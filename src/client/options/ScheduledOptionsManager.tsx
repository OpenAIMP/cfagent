import React, { useState, useEffect, useCallback } from "react";
import { apiFetch as fetch } from "../apiFetch";
import { listProfiles } from "../scannerApi";
import { TextInput, Select, EmptyState } from "../components/ui";
import type { StrategyProfile } from "../../trading";
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

/** One autonomous options-analysis run as returned by GET /api/options/latest (#223). */
export interface OptionsRunSummary {
  timestamp: string;
  success: boolean;
  trigger?: string;
  thesis?: string;
  symbols?: string[];
  withTrades?: number;
  summary?: string;
  error?: string;
}

/** Shared schedule-card metadata for user-owned stock and options jobs. */
export interface SystemJobInfo {
  label: string;
  description: string;
  triggerRoute: string;
}

export const SYSTEM_JOBS: Record<string, SystemJobInfo> = {
  autonomousMarketScreen: {
    label: "Stock Market Screen",
    description: "Screens the selected live stock universe with E*TRADE quotes and generates a PDF report.",
    triggerRoute: "/api/schedules/trigger-screen",
  },
  autonomousOptionsAnalysis: {
    label: "Options Market Screen",
    description: "Screens the selected live universe against E*TRADE option chains and generates a report.",
    triggerRoute: "/api/schedules/trigger-options-analysis",
  },
  autonomousStrategyDiscovery: {
    label: "Strategy Discovery",
    description:
      "Re-runs saved discovery views (symbol, thesis, target) captured from the discovery panel against the live E*TRADE chain and stores the ranked results.",
    triggerRoute: "/api/schedules/trigger-discovery",
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
  autonomousStrategyDiscovery: SYSTEM_JOBS.autonomousStrategyDiscovery.triggerRoute,
};

export function systemJobFor(callback: unknown): SystemJobInfo | undefined {
  return typeof callback === "string" ? SYSTEM_JOBS[callback] : undefined;
}

export function triggerRouteFor(callback: unknown): string | undefined {
  return typeof callback === "string" ? TRIGGER_ROUTES[callback] : undefined;
}

/** Jobs the create form can register. Anything else stays API-only. */
export type CreatableJob = "optionsAnalysis" | "marketScreen" | "strategyDiscovery";

export const JOB_CALLBACKS: Record<CreatableJob, string> = {
  optionsAnalysis: "autonomousOptionsAnalysis",
  marketScreen: "autonomousMarketScreen",
  strategyDiscovery: "autonomousStrategyDiscovery",
};

/**
 * One saved discovery view as edited in the create form (issue #126).
 * A discovery schedule re-runs complete StrategyRequests verbatim, so
 * the form edits the request itself; numeric fields stay strings while
 * editing and are converted by buildDiscoveryRequests on submit.
 */
export interface DiscoveryRequestDraft {
  symbol: string;
  thesis: "bullish" | "bearish" | "range_bound" | "large_move";
  targetPrice: string;
  targetDate: string;
  expectedIvDirection: "rise" | "unchanged" | "fall";
  maxPlannedLoss: string;
  minRewardRisk: string;
  /** "" omits the field (the server then applies its balanced default weights). */
  optimizationBias: string;
  dataMode: "live" | "calibrated-demo";
  /** Comma-separated registry ids; "all" is the discovery panel's own default. */
  allowedStrategies: string;
  /** "" omits the field. */
  maxDte: string;
}

/** Server cap: MAX_SAVED_REQUESTS_PER_RUN (src/trading/options/discoveryRunStore.ts). */
export const DISCOVERY_REQUEST_LIMIT = 25;

const DISCOVERY_THESES = ["bullish", "bearish", "range_bound", "large_move"] as const;
const DISCOVERY_IV_DIRECTIONS = ["rise", "unchanged", "fall"] as const;

export function blankDiscoveryRequestDraft(): DiscoveryRequestDraft {
  return {
    symbol: "",
    thesis: "bullish",
    targetPrice: "",
    targetDate: "",
    expectedIvDirection: "unchanged",
    maxPlannedLoss: "",
    minRewardRisk: "",
    optimizationBias: "",
    dataMode: "live",
    allowedStrategies: "all",
    maxDte: "",
  };
}

/** Map a stored StrategyRequest (a schedule's payload) back into a form draft. */
export function discoveryDraftFromRequest(req: any): DiscoveryRequestDraft {
  const base = blankDiscoveryRequestDraft();
  if (!req || typeof req !== "object") return base;
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  return {
    symbol: typeof req.symbol === "string" ? req.symbol : "",
    thesis: DISCOVERY_THESES.includes(req.thesis) ? req.thesis : "bullish",
    targetPrice: num(req.targetPrice),
    targetDate: typeof req.targetDate === "string" ? req.targetDate : "",
    expectedIvDirection: DISCOVERY_IV_DIRECTIONS.includes(req.expectedIvDirection)
      ? req.expectedIvDirection
      : "unchanged",
    maxPlannedLoss: num(req.maxPlannedLoss),
    minRewardRisk: num(req.minRewardRisk),
    optimizationBias: num(req.optimizationBias),
    dataMode: req.dataMode === "calibrated-demo" ? "calibrated-demo" : "live",
    allowedStrategies:
      Array.isArray(req.allowedStrategies) && req.allowedStrategies.length > 0
        ? req.allowedStrategies.join(", ")
        : "all",
    maxDte: num(req.maxDte),
  };
}

/**
 * Convert form drafts into the payload.requests array, mirroring the
 * required-field checks of the server's validateStrategyRequest
 * (src/trading/options/strategyRiskAgent.ts). That validator is
 * server-only — it resolves strategy ids against the server registry —
 * so an unknown strategy id passes here and is rejected by the create
 * route's 400, whose message the form surfaces verbatim. Returns
 * { error } with a user-facing message for the first problem found.
 */
export function buildDiscoveryRequests(
  drafts: DiscoveryRequestDraft[]
): { requests: Array<Record<string, any>> } | { error: string } {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    return { error: "Add at least one saved discovery view." };
  }
  if (drafts.length > DISCOVERY_REQUEST_LIMIT) {
    return { error: `Discovery schedules are capped at ${DISCOVERY_REQUEST_LIMIT} saved views per schedule.` };
  }
  const requests: Array<Record<string, any>> = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const label = `Saved view ${i + 1}${d.symbol.trim() ? ` (${d.symbol.trim().toUpperCase()})` : ""}`;
    const symbol = d.symbol.trim().toUpperCase();
    if (!symbol) return { error: `${label}: a symbol is required.` };
    const targetPrice = Number(d.targetPrice);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      return { error: `${label}: target price must be a positive number.` };
    }
    if (!d.targetDate.trim()) return { error: `${label}: a target date is required.` };
    const maxPlannedLoss = Number(d.maxPlannedLoss);
    if (!Number.isFinite(maxPlannedLoss) || maxPlannedLoss <= 0) {
      return { error: `${label}: max planned loss must be a positive number.` };
    }
    const minRewardRisk = Number(d.minRewardRisk);
    if (!Number.isFinite(minRewardRisk) || minRewardRisk < 0) {
      return { error: `${label}: minimum reward/risk must be zero or more.` };
    }
    const allowedStrategies = d.allowedStrategies
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowedStrategies.length === 0) {
      return { error: `${label}: name at least one allowed strategy (or "all").` };
    }
    const request: Record<string, any> = {
      symbol,
      thesis: d.thesis,
      targetPrice,
      targetDate: d.targetDate.trim(),
      expectedIvDirection: d.expectedIvDirection,
      maxPlannedLoss,
      minRewardRisk,
      allowedStrategies,
      dataMode: d.dataMode,
    };
    if (d.optimizationBias.trim() !== "") {
      const bias = Number(d.optimizationBias);
      if (!Number.isInteger(bias) || bias < 0 || bias > 100) {
        return { error: `${label}: optimization bias must be a whole number from 0 to 100.` };
      }
      request.optimizationBias = bias;
    }
    if (d.maxDte.trim() !== "") {
      const maxDte = Number(d.maxDte);
      if (!Number.isInteger(maxDte) || maxDte < 1) {
        return { error: `${label}: max DTE must be a whole number of at least 1.` };
      }
      request.maxDte = maxDte;
    }
    requests.push(request);
  }
  return { requests };
}

export type ScheduleMode = "interval" | "cron" | "delayed" | "scheduled";

/** The two input models a discovery schedule can carry (issues
 *  #126/#533): complete saved views re-run verbatim, or a symbol set
 *  + Strategy Profile whose targets are derived at run time. */
export type DiscoveryInputModel = "saved-request" | "profile-derived";

/** Parse the profile-derived symbols field: comma- or
 *  newline-separated, trimmed, uppercased, blanks dropped (order
 *  preserved). */
export function parseDerivedSymbols(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

// Mirrors the create route's ticker check (src/agents/routes/
// schedules.ts) so an invalid ticker fails in the form, not at the
// route; the route remains the backstop.
const DERIVED_SYMBOL_RE = /^[A-Z0-9./-]{1,16}$/;

/**
 * Build the profile-derived schedule payload (issue #533, spec R1)
 * from the form state, with the route's arm-time rules mirrored
 * client-side: a profile is required, and exactly ONE symbol source
 * is emitted — explicit symbols XOR a watchlist name — so the payload
 * can never carry both (the route 400s on both/neither). Returns
 * { error } with a user-facing message for the first problem found.
 */
export function buildProfileDerivedPayload(input: {
  source: "symbols" | "watchlist";
  symbolsText: string;
  watchlistName: string;
  profileId: string;
}): { payload: Record<string, any> } | { error: string } {
  const profileId = input.profileId.trim();
  if (!profileId) {
    return { error: "Choose a Strategy Profile to derive targets under." };
  }
  if (input.source === "watchlist") {
    const watchlistName = input.watchlistName.trim();
    if (!watchlistName) {
      return { error: "Enter the name of a watchlist to derive targets for." };
    }
    return { payload: { inputModel: "profile-derived", watchlistName, profileId } };
  }
  const symbols = parseDerivedSymbols(input.symbolsText);
  if (symbols.length === 0) {
    return { error: "Enter at least one symbol to derive targets for." };
  }
  if (symbols.length > DISCOVERY_REQUEST_LIMIT) {
    return {
      error: `Profile-derived discovery schedules are capped at ${DISCOVERY_REQUEST_LIMIT} symbols per schedule.`,
    };
  }
  const bad = symbols.find((s) => !DERIVED_SYMBOL_RE.test(s));
  if (bad) return { error: `"${bad}" is not a valid ticker symbol.` };
  return { payload: { inputModel: "profile-derived", symbols, profileId } };
}

/**
 * Why a Strategy Profile cannot support target derivation, or null
 * when it can (issue #533 decisions D1/D3, mirrored client-side so
 * the picker can disable the profile with the reason shown): no
 * thesis → no direction to derive toward; missing risk caps → no
 * honest values exist to construct the request with.
 */
export function profileDerivationBlockReason(
  profile: Pick<StrategyProfile, "thesis" | "maxPlannedLoss" | "minRewardRisk">
): string | null {
  if (!profile.thesis) return "no thesis — cannot derive direction";
  if (profile.maxPlannedLoss === undefined || profile.minRewardRisk === undefined) {
    return "missing max planned loss or min reward/risk — cannot derive targets";
  }
  return null;
}

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

  const updateDiscoveryRequest = (idx: number, patch: Partial<DiscoveryRequestDraft>) =>
    setDiscoveryRequests((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));

  // On-Demand Execution State: which trigger is in flight — "hero" for
  // the banner Run Now button, otherwise the schedule's id.
  const [triggeringKey, setTriggeringKey] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<any | null>(null);

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
    setDiscoveryRequests([blankDiscoveryRequestDraft()]);
    setDiscoveryInputModel("saved-request");
    setDerivedSource("symbols");
    setDerivedSymbolsText("");
    setDerivedWatchlistName("");
    setDerivedProfileId("");
    setModalOpen(true);
  };

  // Edit a user-created stock screen, options screen, or discovery schedule.
  const handleEditSchedule = (item: ScheduledTaskItem) => {
    setEditingScheduleId(item.id);
    const payload = payloadOf(item);
    if (item.callback === "autonomousStrategyDiscovery") {
      setJobType("strategyDiscovery");
      if (payload.inputModel === "profile-derived") {
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
      setThesis(payload.thesis || "bullish");
      setRiskProfile(payload.riskProfile || "balanced");
      setPushToSlack(payload.pushToSlack !== false);
      if (payload.slackChannel) setSlackChannel(payload.slackChannel);
      if (payload.emailTo) setEmailTo(payload.emailTo);
      if (payload.webhookUrl) setWebhookUrl(payload.webhookUrl);
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

    let callback: string;
    let payload: Record<string, any>;
    if (jobType === "strategyDiscovery" && discoveryInputModel === "profile-derived") {
      // Profile-derived discovery (issue #533): the payload names a
      // symbol set + a Strategy Profile and stores NO target — each
      // target is derived at run time. The create route's arm-time
      // validation is the backstop; its 400 surfaces below exactly
      // as the saved-view path's does.
      const built = buildProfileDerivedPayload({
        source: derivedSource,
        symbolsText: derivedSymbolsText,
        watchlistName: derivedWatchlistName,
        profileId: derivedProfileId,
      });
      if ("error" in built) {
        setError(built.error);
        setSubmitting(false);
        return;
      }
      callback = JOB_CALLBACKS.strategyDiscovery;
      payload = {
        ...built.payload,
        environment: activeEnv,
        trigger: "scheduled",
      };
    } else if (jobType === "strategyDiscovery") {
      // Discovery schedules carry complete saved StrategyRequests; the
      // create route validates each one and its 400 is the backstop for
      // anything this form cannot check (e.g. unknown strategy ids).
      const built = buildDiscoveryRequests(discoveryRequests);
      if ("error" in built) {
        setError(built.error);
        setSubmitting(false);
        return;
      }
      callback = JOB_CALLBACKS.strategyDiscovery;
      payload = {
        requests: built.requests,
        environment: activeEnv,
        trigger: "scheduled",
      };
    } else {
      const symbols = targetSymbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!Number.isInteger(maxItems) || maxItems < 0) {
        setError("Max items must be a whole number greater than or equal to zero.");
        setSubmitting(false);
        return;
      }
      if (!targetUniverse && symbols.length === 0) {
        setError("Choose a universe or enter at least one symbol.");
        setSubmitting(false);
        return;
      }
      if (jobType === "marketScreen" && !targetUniverse) {
        setError("Stock screens require one live universe.");
        setSubmitting(false);
        return;
      }

      if (jobType === "marketScreen") {
        callback = JOB_CALLBACKS.marketScreen;
        payload = {
          ...(targetUniverse ? { universe: targetUniverse } : { symbols }),
          maxItems,
          sector: "Technology",
          trigger: "scheduled",
        };
      } else {
        callback = JOB_CALLBACKS.optionsAnalysis;
        payload = {
          ...(targetUniverse ? { universe: targetUniverse } : { symbols }),
          maxItems,
          thesis,
          riskProfile,
          pushToSlack,
          slackChannel: pushToSlack ? slackChannel : undefined,
          emailTo: emailTo.trim() || undefined,
          webhookUrl: webhookUrl.trim() || undefined,
          environment: activeEnv,
          trigger: "scheduled",
        };
      }
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
            setSuccessMsg(
              `✓ ${label} executed! ${d.completedCount ?? 0} of ${d.requestCount ?? 0} saved views produced results.${failedNote}`
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

    const symbols = targetSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (!targetUniverse && symbols.length === 0) {
      setError("Choose a universe or enter at least one symbol.");
      setTriggeringKey(null);
      return;
    }

    const payload = {
      ...(targetUniverse ? { universe: targetUniverse } : { symbols }),
      maxItems,
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

      {/* Issue #223: autonomous options runs (last 5 of the persisted 20). */}
      <section className="sched-section-card">
        <header className="sched-section-header">
          <h4>
            <span>📈</span> Latest Autonomous Options Runs
            <span className="sched-count-pill">{latestRuns.length} Runs</span>
          </h4>
          <button
            type="button"
            className="btn-sched-action-sm"
            onClick={fetchLatestRuns}
            disabled={runsLoading}
          >
            {runsLoading ? "Refreshing…" : "↻ Refresh"}
          </button>
        </header>

        {runsError ? (
          <p style={{ margin: "0.4rem 0 0", fontSize: "0.78rem", color: "var(--color-danger)" }}>{runsError}</p>
        ) : null}

        {latestRuns.length === 0 && !runsLoading ? (
          <p style={{ margin: "0.4rem 0 0", fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
            No options runs recorded yet. A scheduled or manual analysis appears here once it completes.
          </p>
        ) : (
          <div className="schedules-grid">
            {latestRuns.map((run, idx) => (
              <div className="schedule-item-card is-options" key={`${run.timestamp}-${idx}`}>
                <div className="schedule-card-top">
                  <span className={`schedule-type-badge ${run.success ? "interval" : "once"}`}>
                    {run.success ? "completed" : "failed"}
                  </span>
                  <span className="schedule-id-snippet" title={run.timestamp}>
                    {new Date(run.timestamp).toLocaleString()}
                  </span>
                </div>
                <h5 className="schedule-title">
                  {run.symbols && run.symbols.length > 0 ? run.symbols.join(", ") : "Autonomous options analysis"}
                </h5>
                <div className="schedule-payload-details">
                  <div className="payload-row">
                    <span className="payload-label">setups:</span>
                    <span className="payload-value">{run.withTrades ?? 0}</span>
                  </div>
                  <div className="payload-row">
                    <span className="payload-label">trigger:</span>
                    <span className="payload-value">
                      {run.trigger || "scheduled"}
                      {run.thesis ? ` · ${run.thesis}` : ""}
                    </span>
                  </div>
                </div>
                {run.summary ? <p className="schedule-system-note">{run.summary}</p> : null}
                {!run.success && run.error ? (
                  <p style={{ margin: "0.4rem 0 0", fontSize: "0.76rem", color: "var(--color-danger)" }}>{run.error}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

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
          <EmptyState
            icon="📅"
            description="Create a stock screen, options analysis, or saved-view discovery schedule to see it here; legacy app-created jobs are not recreated automatically."
            title="No active schedules"
            action={<button
              type="button"
              className="btn-sched-primary"
              onClick={openCreateModal}
            >
              + Create First Schedule
            </button>}
          />
        ) : (
          <div className="schedules-grid">
            {schedules.map((item) => {
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
              const cardTitle = isDerivedDiscovery
                ? "Strategy Discovery · Profile-derived"
                : title;
              const payloadRows: Array<[string, unknown]> = isDerivedDiscovery
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
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                      <span className={`schedule-type-badge ${item.type}`}>
                        {item.type}
                      </span>
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
                        {isDerivedDiscovery
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
                            <span className="payload-value">{payload.universe || "Universe scan"}</span>
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
                  ) : payload.sector ? (
                    <div className="schedule-payload-details">
                      <div className="payload-row">
                        <span className="payload-label">Sector:</span>
                        <span className="payload-value">{formatPayloadValue(payload.sector)}</span>
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
                        title={`Run ${cardTitle} immediately, on demand`}
                      >
                        {triggeringKey === item.id ? "⚡ Running…" : "⚡ Trigger Now"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-sched-action-sm"
                      style={{ background: "var(--color-accent-subtle)", borderColor: "var(--color-border-focus)", color: "var(--color-accent)" }}
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
        <h3>{editingScheduleId ? "✏ Update Screening Schedule" : "⏰ Configure New Schedule"}</h3>
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
              {/* Job Picker */}
              {!editingScheduleId && (
                <div className="sched-form-group">
                  <label htmlFor="sched-job-type" className="sched-form-label">
                    Job
                    <span className="hint">What runs when this schedule fires</span>
                  </label>
                  <Select id="sched-job-type"
                    value={jobType}
                    onChange={(e) => {
                      const nextJobType = e.target.value as CreatableJob;
                      setJobType(nextJobType);
                      if (nextJobType === "marketScreen" && !targetUniverse) setTargetUniverse("NASDAQ100");
                    }}
                  >
                    <option value="optionsAnalysis">Autonomous Options Analysis</option>
                    <option value="marketScreen">Autonomous Market Screen (Stocks)</option>
                    <option value="strategyDiscovery">Saved-View Strategy Discovery</option>
                  </Select>
                </div>
              )}

              {/* Target Universe or Symbols */}
              {jobType !== "strategyDiscovery" && (editingScheduleId || jobType === "optionsAnalysis" || jobType === "marketScreen") && (
                <div className="sched-form-group">
                  <label htmlFor="sched-target-universe" className="sched-form-label">
                    Target Universe
                    <span className="hint">Screens all symbols in the universe</span>
                  </label>
                  <Select id="sched-target-universe"
                    value={targetUniverse}
                    onChange={(e) => setTargetUniverse(e.target.value)}
                  >
                    {jobType === "optionsAnalysis" && <option value="">Custom symbols (below)</option>}
                    <option value="TECH">Technology (keyword discovery)</option>
                    <option value="NASDAQ100">Nasdaq-100</option>
                    <option value="SP100">S&P 100</option>
                    <option value="SP500">S&P 500</option>
                    <option value="RUSSELL2000">Russell 2000</option>
                    <option value="ETF">ETFs</option>
                    <option value="LEV_ETF">Leveraged ETFs</option>
                  </Select>
                  {!targetUniverse && jobType === "optionsAnalysis" && (
                    <>
                      <label htmlFor="sched-target-symbols" className="sched-form-label" style={{ marginTop: "0.5rem" }}>
                        Target Equity Symbols
                        <span className="hint">Comma-separated tickers</span>
                      </label>
                      <TextInput id="sched-target-symbols"
                        type="text"
                        value={targetSymbols}
                        onChange={(e) => setTargetSymbols(e.target.value)}
                        placeholder="e.g. NVDA, AAPL, SPY, MSFT"
                        required
                      />
                    </>
                  )}
                </div>
              )}

              {jobType !== "strategyDiscovery" && (
                <div className="sched-form-group">
                  <label htmlFor="sched-max-items" className="sched-form-label">
                    Max items
                    <span className="hint">Maximum live symbols scanned per run; 0 means all selected symbols.</span>
                  </label>
                  <TextInput id="sched-max-items"
                    type="number"
                    min={0}
                    step={1}
                    value={maxItems}
                    onChange={(e) => setMaxItems(Number(e.target.value))}
                    required
                  />
                </div>
              )}

              {/* Discovery input model (issues #126/#533) */}
              {jobType === "strategyDiscovery" && (
                <div className="sched-form-group">
                  <label className="sched-form-label">
                    Input Model
                    <span className="hint">
                      Saved views re-run complete strategy requests verbatim. Symbol set + profile
                      stores no targets — each symbol&apos;s target is derived from its live chain
                      at run time under a saved Strategy Profile and labelled DERIVED on the run.
                    </span>
                  </label>
                  <Select
                    value={discoveryInputModel}
                    onChange={(e) => setDiscoveryInputModel(e.target.value as DiscoveryInputModel)}
                    aria-label="Discovery input model"
                  >
                    <option value="saved-request">Saved views</option>
                    <option value="profile-derived">Symbol set + profile (derived targets)</option>
                  </Select>
                </div>
              )}

              {/* Saved discovery views (issue #126) */}
              {jobType === "strategyDiscovery" && discoveryInputModel === "saved-request" && (
                <div className="sched-form-group">
                  <label className="sched-form-label">
                    Saved Discovery Views
                    <span className="hint">
                      Each view is a complete strategy request, re-run verbatim when this schedule
                      fires — the same view the discovery panel runs interactively. Strategy ids are
                      validated by the server against the registry when you save.
                    </span>
                  </label>
                  {discoveryRequests.map((draft, idx) => (
                    <div className="discovery-request-card" key={idx}>
                      <div className="discovery-request-card-head">
                        <strong>
                          View {idx + 1}
                          {draft.symbol.trim() ? ` — ${draft.symbol.trim().toUpperCase()}` : ""}
                        </strong>
                        {discoveryRequests.length > 1 && (
                          <button
                            type="button"
                            className="btn-sched-action-sm"
                            onClick={() =>
                              setDiscoveryRequests((prev) => prev.filter((_, i) => i !== idx))
                            }
                          >
                            ✕ Remove
                          </button>
                        )}
                      </div>
                      <div className="discovery-request-grid">
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-symbol`} className="sched-form-label">Symbol</label>
                          <TextInput id={`sched-discovery-${idx}-symbol`}
                            type="text"
                            value={draft.symbol}
                            onChange={(e) => updateDiscoveryRequest(idx, { symbol: e.target.value })}
                            placeholder="e.g. NVDA"
                            aria-label={`View ${idx + 1} symbol`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-thesis`} className="sched-form-label">Thesis</label>
                          <Select id={`sched-discovery-${idx}-thesis`}
                            value={draft.thesis}
                            onChange={(e) =>
                              updateDiscoveryRequest(idx, { thesis: e.target.value as DiscoveryRequestDraft["thesis"] })
                            }
                            aria-label={`View ${idx + 1} thesis`}
                          >
                            <option value="bullish">Bullish</option>
                            <option value="bearish">Bearish</option>
                            <option value="range_bound">Range-bound</option>
                            <option value="large_move">Large move</option>
                          </Select>
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-target-price`} className="sched-form-label">Target Price ($)</label>
                          <TextInput id={`sched-discovery-${idx}-target-price`}
                            type="number"
                            min={0}
                            step="0.01"
                            value={draft.targetPrice}
                            onChange={(e) => updateDiscoveryRequest(idx, { targetPrice: e.target.value })}
                            placeholder="e.g. 200"
                            aria-label={`View ${idx + 1} target price`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-target-date`} className="sched-form-label">Target Date</label>
                          <TextInput id={`sched-discovery-${idx}-target-date`}
                            type="date"
                            value={draft.targetDate}
                            onChange={(e) => updateDiscoveryRequest(idx, { targetDate: e.target.value })}
                            aria-label={`View ${idx + 1} target date`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-expected-iv-direction`} className="sched-form-label">Expected IV Direction</label>
                          <Select id={`sched-discovery-${idx}-expected-iv-direction`}
                            value={draft.expectedIvDirection}
                            onChange={(e) =>
                              updateDiscoveryRequest(idx, {
                                expectedIvDirection: e.target.value as DiscoveryRequestDraft["expectedIvDirection"],
                              })
                            }
                            aria-label={`View ${idx + 1} expected IV direction`}
                          >
                            <option value="rise">Rise</option>
                            <option value="unchanged">Unchanged</option>
                            <option value="fall">Fall</option>
                          </Select>
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-data-mode`} className="sched-form-label">Data Mode</label>
                          <Select id={`sched-discovery-${idx}-data-mode`}
                            value={draft.dataMode}
                            onChange={(e) =>
                              updateDiscoveryRequest(idx, { dataMode: e.target.value as DiscoveryRequestDraft["dataMode"] })
                            }
                            aria-label={`View ${idx + 1} data mode`}
                          >
                            <option value="live">Live chain</option>
                            <option value="calibrated-demo">Calibrated demo (gate permitting)</option>
                          </Select>
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-max-planned-loss`} className="sched-form-label">Max Planned Loss ($)</label>
                          <TextInput id={`sched-discovery-${idx}-max-planned-loss`}
                            type="number"
                            min={0}
                            step="1"
                            value={draft.maxPlannedLoss}
                            onChange={(e) => updateDiscoveryRequest(idx, { maxPlannedLoss: e.target.value })}
                            placeholder="e.g. 500"
                            aria-label={`View ${idx + 1} max planned loss`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-min-reward-risk`} className="sched-form-label">Min Reward / Risk</label>
                          <TextInput id={`sched-discovery-${idx}-min-reward-risk`}
                            type="number"
                            min={0}
                            step="0.1"
                            value={draft.minRewardRisk}
                            onChange={(e) => updateDiscoveryRequest(idx, { minRewardRisk: e.target.value })}
                            placeholder="e.g. 1"
                            aria-label={`View ${idx + 1} minimum reward risk`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-optimization-bias`} className="sched-form-label">Optimization Bias (0–100, optional)</label>
                          <TextInput id={`sched-discovery-${idx}-optimization-bias`}
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={draft.optimizationBias}
                            onChange={(e) => updateDiscoveryRequest(idx, { optimizationBias: e.target.value })}
                            placeholder="Blank = balanced"
                            aria-label={`View ${idx + 1} optimization bias`}
                          />
                        </div>
                        <div className="sched-form-group">
                          <label htmlFor={`sched-discovery-${idx}-max-dte`} className="sched-form-label">Max DTE (optional)</label>
                          <TextInput id={`sched-discovery-${idx}-max-dte`}
                            type="number"
                            min={1}
                            step={1}
                            value={draft.maxDte}
                            onChange={(e) => updateDiscoveryRequest(idx, { maxDte: e.target.value })}
                            placeholder="e.g. 45"
                            aria-label={`View ${idx + 1} max DTE`}
                          />
                        </div>
                      </div>
                      <div className="sched-form-group" style={{ marginTop: "0.7rem" }}>
                        <label htmlFor={`sched-discovery-${idx}-allowed-strategies`} className="sched-form-label">
                          Allowed Strategies
                          <span className="hint">Comma-separated registry ids, or "all" for the full registry (the panel default)</span>
                        </label>
                        <TextInput id={`sched-discovery-${idx}-allowed-strategies`}
                          type="text"
                          value={draft.allowedStrategies}
                          onChange={(e) => updateDiscoveryRequest(idx, { allowedStrategies: e.target.value })}
                          placeholder="all"
                          aria-label={`View ${idx + 1} allowed strategies`}
                          required
                        />
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn-sched-secondary"
                    onClick={() =>
                      setDiscoveryRequests((prev) => [...prev, blankDiscoveryRequestDraft()])
                    }
                    disabled={discoveryRequests.length >= DISCOVERY_REQUEST_LIMIT}
                  >
                    + Add another saved view
                  </button>
                </div>
              )}

              {/* Profile-derived discovery (issue #533) */}
              {jobType === "strategyDiscovery" && discoveryInputModel === "profile-derived" && (
                <div className="sched-form-group">
                  <label className="sched-form-label">
                    Symbol Set + Strategy Profile
                    <span className="hint">
                      No target is stored on this schedule. When it fires, each symbol&apos;s
                      target is derived from its live chain — spot ± the expected move under the
                      profile&apos;s thesis — and recorded as DERIVED on the run. A symbol whose
                      target cannot be derived honestly abstains, with the reason recorded.
                    </span>
                  </label>
                  <div className="sched-form-group">
                    <label className="sched-form-label">Symbol Source</label>
                    <Select
                      value={derivedSource}
                      onChange={(e) => setDerivedSource(e.target.value as "symbols" | "watchlist")}
                      aria-label="Derived symbol source"
                    >
                      <option value="symbols">Symbols</option>
                      <option value="watchlist">Watchlist name</option>
                    </Select>
                  </div>
                  {derivedSource === "symbols" ? (
                    <div className="sched-form-group">
                      <label className="sched-form-label">
                        Symbols
                        <span className="hint">Comma- or newline-separated tickers, up to {DISCOVERY_REQUEST_LIMIT}</span>
                      </label>
                      <TextInput
                        multiline
                        rows={3}
                        value={derivedSymbolsText}
                        onChange={(e) => setDerivedSymbolsText(e.target.value)}
                        placeholder="e.g. NVDA, AAPL, MSFT"
                        aria-label="Derived symbols"
                      />
                    </div>
                  ) : (
                    <div className="sched-form-group">
                      <label className="sched-form-label">
                        Watchlist Name
                        <span className="hint">Resolved against your stored watchlists when the schedule fires</span>
                      </label>
                      <TextInput
                        type="text"
                        value={derivedWatchlistName}
                        onChange={(e) => setDerivedWatchlistName(e.target.value)}
                        placeholder="e.g. My List"
                        aria-label="Derived watchlist name"
                      />
                    </div>
                  )}
                  <div className="sched-form-group">
                    <label className="sched-form-label">Strategy Profile</label>
                    <Select
                      value={derivedProfileId}
                      onChange={(e) => setDerivedProfileId(e.target.value)}
                      aria-label="Derived strategy profile"
                    >
                      <option value="">Select a profile…</option>
                      {profiles.map((profile) => {
                        const reason = profileDerivationBlockReason(profile);
                        return (
                          <option key={profile.id} value={profile.id} disabled={reason !== null}>
                            {profile.name} (v{profile.version}){reason ? ` — ${reason}` : ""}
                          </option>
                        );
                      })}
                    </Select>
                    {profilesError && (
                      <p className="sched-preset-note" role="alert">
                        Could not load your strategy profiles: {profilesError}
                      </p>
                    )}
                    {!profilesError && profiles.length === 0 && (
                      <p className="sched-preset-note">
                        No saved strategy profiles found — create one in the opportunity scanner
                        first, then arm it here.
                      </p>
                    )}
                    {selectedDerivedProfileReason && (
                      <p className="sched-preset-note">
                        This profile cannot derive targets ({selectedDerivedProfileReason}) — pick
                        another profile, or update the profile first.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Schedule Cadence / Type */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div className="sched-form-group">
                  <label htmlFor="sched-cadence-type" className="sched-form-label">Cadence Type</label>
                  <Select id="sched-cadence-type"
                    value={scheduleType}
                    onChange={(e) => setScheduleType(e.target.value as ScheduleMode)}
                  >
                    <option value="interval">Interval (Every X Minutes/Hours)</option>
                    <option value="cron">Cron Expression (Specific Time/Days)</option>
                    <option value="delayed">Delayed (Once, After a Delay)</option>
                    <option value="scheduled">One-Shot (Specific Date &amp; Time)</option>
                  </Select>
                </div>

                {scheduleType === "interval" && (
                  <div className="sched-form-group">
                    <label htmlFor="sched-interval-seconds" className="sched-form-label">Interval Seconds</label>
                    <TextInput id="sched-interval-seconds"
                      type="number"
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
                    <label htmlFor="sched-cron-expression" className="sched-form-label">Cron Expression</label>
                    <TextInput id="sched-cron-expression"
                      type="text"
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
                    <label htmlFor="sched-delay-seconds" className="sched-form-label">Delay Seconds</label>
                    <TextInput id="sched-delay-seconds"
                      type="number"
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
                    <label htmlFor="sched-run-at" className="sched-form-label">Run At (One-Shot)</label>
                    <TextInput id="sched-run-at"
                      type="datetime-local"
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
              {jobType !== "strategyDiscovery" && (editingScheduleId || jobType === "optionsAnalysis") && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                    <div className="sched-form-group">
                      <label htmlFor="sched-market-thesis" className="sched-form-label">Market Thesis / Outlook</label>
                      <Select id="sched-market-thesis"
                        value={thesis}
                        onChange={(e) => setThesis(e.target.value as any)}
                      >
                        <option value="bullish">Bullish (Calls, Bull Spreads)</option>
                        <option value="bearish">Bearish (Puts, Bear Spreads)</option>
                        <option value="neutral">Neutral (Iron Condor, Calendar)</option>
                        <option value="directional">Directional (Breakouts &amp; Straddles)</option>
                      </Select>
                    </div>

                    <div className="sched-form-group">
                      <label htmlFor="sched-risk-profile" className="sched-form-label">Risk Profile</label>
                      <Select id="sched-risk-profile"
                        value={riskProfile}
                        onChange={(e) => setRiskProfile(e.target.value as any)}
                      >
                        <option value="conservative">Conservative (High POP &gt; 65%, Defined Risk)</option>
                        <option value="balanced">Balanced (Optimal R/R &gt; 1.5x, Moderate POP)</option>
                        <option value="aggressive">Aggressive (Maximum Leverage &amp; Upside)</option>
                      </Select>
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
                          <TextInput
                            type="text"
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
                          <TextInput
                            type="email"
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
                          <TextInput
                            type="url"
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
