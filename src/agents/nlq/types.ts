import { type OptionsStrategyDeps } from "../nlqOptionsStrategy";
import type { ProfileRef, ScanRunStore } from "../../trading";
import type { AgentScheduleItem, OptionScreenRejection, StockScreenLedger, StockScreenResult } from "../../types";
import { NLQPlan } from "./schema";
export interface NLQValidationResult {
  validated: boolean;
  isValid?: boolean;
  model: string;
  domain: string;
  detectedDomain?: string;
  action?: string;
  suggestedAction?: string;
  interpretation: string;
  confidence?: number;
  corrected?: boolean;
  preventedStockScreenerFallback?: boolean;
}

export interface NLQQueryResult {
  plan: NLQPlan;
  count: number;
  domain: string;
  targetTable?: string;
  summary?: string;
  rows: Array<Record<string, unknown>>;
  executedAt: string;
  status?: string;
  reconciled?: boolean;
  planSource?: "llm" | "fastpath" | "fallback" | "llm_validated";
  llmValidation?: NLQValidationResult;
  discrepancy?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  /** Issue #27: id of the persisted scan run (options_opportunities
   *  only, when the caller threaded a ScanRunStore through). */
  scanRunId?: string;
  /** Issue #27: whether the scan run was persisted; false means a
   *  store was supplied but its save failed (the scan still succeeded). */
  persisted?: boolean;
  /** Issue #28: the saved strategy profile an options action ran under
   *  (id + name + version), when one was selected in the question. */
  profileRef?: ProfileRef | null;
  scanLedger?: StockScreenLedger | Record<string, unknown>;
  discovery?: StockScreenResult["discovery"];
  validationError?: string;
  quoteQuality?: {
    maxAgeSeconds?: number;
    referenceAgeSeconds?: number;
    staleContractsReturned: number;
    unknownFreshnessContracts: number;
    freshestStaleQuoteAgeSeconds?: number;
  };
  rejections?: OptionScreenRejection[];
  fetchErrors?: Array<{ symbol: string; reason: string }>;
  warnings?: string[];
  displayMarkdown?: string;
  movers?: StockScreenResult["movers"];
}

/**
 * Issue #109: narrow port over the hosting Agent's Cloudflare Agents
 * scheduling API. The orchestrator binds its own schedule /
 * scheduleEvery / cancelSchedule / listSchedules methods into this
 * shape and injects it through the NLQ execution deps, so scheduling
 * plans arm REAL SDK schedules (persisted in cf_agent_schedules) and
 * return REAL schedule ids. Contexts without a port (e.g. the MCP
 * facade) get honest failures from the scheduling executor instead of
 * fabricated success.
 */
export interface NLQSchedulingPort {
  schedule(
    when: Date | string | number,
    callback: string,
    payload?: unknown,
    options?: { idempotent?: boolean }
  ): Promise<AgentScheduleItem>;
  scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<AgentScheduleItem>;
  cancelSchedule(id: string): Promise<boolean>;
  listSchedules(): Promise<AgentScheduleItem[]>;
}

/** Execution deps for executeNLQQueryAsync: the options-strategy deps
 *  plus the optional scheduling port (issue #109). */
export interface NLQExecutionDeps extends OptionsStrategyDeps {
  schedulingPort?: NLQSchedulingPort;
}

export interface NLQPlanOptions {
  preferLLM?: boolean;
  skipLLM?: boolean;
  context?: string;
  validateWithLLM?: boolean;
}
