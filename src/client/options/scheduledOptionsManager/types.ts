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

/** Jobs the create form can register. Anything else stays API-only. */
export type CreatableJob = "optionsAnalysis" | "marketScreen" | "strategyDiscovery";

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

export type ScheduleMode = "interval" | "cron" | "delayed" | "scheduled";

/** The three input models a discovery schedule can carry (issues
 *  #126/#533/#534): complete saved views re-run verbatim; a symbol
 *  set + Strategy Profile whose targets are derived at run time; or
 *  no-view constraint sets — symbols + constraints only, no thesis
 *  and no target anywhere. */
export type DiscoveryInputModel = "saved-request" | "profile-derived" | "no-view";

/** The no-view discovery editor's state (issue #534): one symbol
 *  list plus the constraints every symbol shares. Numeric fields
 *  stay strings while editing and are converted by
 *  buildNoViewPayload on submit. The mode has NO thesis or target
 *  fields — none exist here, none are ever sent. */
export interface NoViewConstraintsDraft {
  symbolsText: string;
  maxPlannedLoss: string;
  minRewardRisk: string;
  /** "" applies the mode's default floor (0.35) on submit. */
  minProbabilityOfProfit: string;
  /** "" omits the bound. */
  minDte: string;
  /** "" omits the bound. */
  maxDte: string;
  riskProfile: "conservative" | "balanced" | "aggressive";
}
