/**
 * Production runtime for the unified screening stack (consolidation
 * C1, issue #1201, epic #1151 R1).
 *
 * Before C1 the #1096 stack had no production caller: the Phase 0
 * ScreeningProviderRegistry, the Phase 3 goal-driven screen, and
 * backtest-on-screen were exercised only by tests, while every
 * reachable surface ran the pre-#1096 entry points. This module is
 * the wiring that closes R1 — the production registry factory and
 * the run helpers the route, the ScreenerAgent, and the schedule
 * service compose:
 *
 *  - `createLiveStockScreener` binds the registry's stock leg to the
 *    LIVE listing-feed engine (`DynamicMarketScreener.screenLive` —
 *    the same engine `ETradeService.screenMarketsAsync` serves to
 *    NLQ/MCP screens today). The Phase 0 wrapper contract calls
 *    `IMarketScreener.screenMarkets`, whose snapshot evaluator is NOT
 *    a live production path; this adapter is what makes the wrapped
 *    call honest in production. Design decision recorded on #1201:
 *    the goal-driven screen is a discovery screen, so its stock leg
 *    binds this engine rather than the ScreenerAgent DO pipeline
 *    (whose per-run PDF/XLSX generation, run lock, and richer run
 *    record belong to the raw-filter surfaces that already execute
 *    through it).
 *  - `createProductionScreeningRegistry` builds the registry via the
 *    Phase 0 default factory under the descriptor ids
 *    (SCREENING_PROVIDER_DESCRIPTORS) — options leg is the production
 *    `DynamicOptionsScreener`.
 *  - `runProductionGoalScreen` composes registry + the Phase 3
 *    ledger-backed run (`runGoalDrivenScreenWithLedger`).
 *  - `executeGoalScreenRun` is the shared caller-side seam for the
 *    route and the schedule service: run via the ScreenerAgent, then
 *    record the run on the canonical seams — one mas_reports record
 *    (#308), one screening activity entry (Phase 6), and optional
 *    Phase 6 channel delivery. A duplicate delivery (executed=false)
 *    records nothing twice.
 *  - `executeScreenBacktest` gives backtest-on-screen its production
 *    entry: daily bars from the existing Yahoo history fetch; a
 *    symbol without history is excluded by the engine with its
 *    reason — never fabricated.
 */

import type {
  OptionScreenerFilter,
  StockScreenResult,
  StockScreenerFilter,
} from "../types";
import {
  createDefaultScreeningRegistry,
  DynamicMarketScreener,
  fetchYahooDailyHistory,
  type DynamicOptionsScreener,
  type IMarketScreener,
  type ScreeningProviderAssetClass,
  type ScreeningProviderRegistry,
} from "../trading";
import {
  runGoalDrivenScreenWithLedger,
  type GoalDrivenScreenResult,
} from "./goalDrivenScreen";
import type { ScreenerTask, ScreenerTaskLedger } from "./screenerTaskLedger";
import {
  buildScenario,
  type ScenarioConstraints,
  type ScenarioDefinition,
  type ScenarioShockGrid,
} from "./goalScenarioEngine";
import type {
  GoalRecord,
  ScenarioRecord,
} from "./goalScenarioStore";
import type { ScenarioConfigSnapshot } from "./goalScenarioEngine";
import {
  backtestScreenCandidates,
  type BacktestResult,
  type PriceBar,
} from "./screenBacktest";
import {
  createScreeningDeliverySenders,
  deliverScreeningContent,
  formatGoalScreenDelivery,
  type ScreeningChannel,
  type ScreeningChannelResult,
} from "./screeningDelivery";
import { recordScreeningActivity } from "./screeningActivity";
import type { DatabaseORM } from "../orm";

/* ------------------------------------------------------------------ */
/* Production registry                                                 */
/* ------------------------------------------------------------------ */

/**
 * IMarketScreener adapter over the live listing-feed engine. The
 * wrapped `screenMarkets` call executes `screenLive` (acquireUniverse
 * "all-listings" + screenWithQuotes — the shared pipeline core), the
 * production stock screen NLQ/MCP already run.
 */
export function createLiveStockScreener(
  inner: Pick<DynamicMarketScreener, "screenLive"> = new DynamicMarketScreener()
): IMarketScreener {
  return {
    async screenMarkets(filter?: StockScreenerFilter): Promise<StockScreenResult> {
      return inner.screenLive(filter);
    },
  };
}

export function createProductionScreeningRegistry(deps: {
  stockScreener?: IMarketScreener;
  optionsScreener: Pick<DynamicOptionsScreener, "screenOptions">;
}): ScreeningProviderRegistry {
  return createDefaultScreeningRegistry({
    stockScreener: deps.stockScreener ?? createLiveStockScreener(),
    optionsScreener: deps.optionsScreener,
  });
}

/* ------------------------------------------------------------------ */
/* Goal-driven screen composition                                      */
/* ------------------------------------------------------------------ */

export interface GoalScreenRunRequest {
  scenario: ScenarioDefinition;
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  userLogin?: string;
  environment?: "TEST" | "PROD";
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
}

/** The ScreenerAgent surface executeGoalScreenRun depends on (RPC stub in production). */
export interface GoalScreenAgentPort {
  runGoalScreen(
    req: GoalScreenRunRequest
  ): Promise<{ task: ScreenerTask; executed: boolean; result?: GoalDrivenScreenResult }>;
}

/**
 * The production goal-screen run: registry over production engines +
 * the Phase 3 ledger-backed execution. Composed by ScreenerAgent with
 * its DO-owned ledger; unit-tested here with fake engines + a memory
 * ledger.
 */
export async function runProductionGoalScreen(input: {
  ledger: ScreenerTaskLedger;
  stockScreener?: IMarketScreener;
  optionsScreener: Pick<DynamicOptionsScreener, "screenOptions">;
  scenario: ScenarioDefinition;
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  userLogin?: string;
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
  now?: Date;
}): Promise<{ task: ScreenerTask; executed: boolean; result?: GoalDrivenScreenResult }> {
  const registry = createProductionScreeningRegistry({
    stockScreener: input.stockScreener,
    optionsScreener: input.optionsScreener,
  });
  return runGoalDrivenScreenWithLedger({
    ledger: input.ledger,
    registry,
    scenario: input.scenario,
    trigger: input.trigger,
    idempotencyKey: input.idempotencyKey,
    userLogin: input.userLogin,
    assetClasses: input.assetClasses,
    symbols: input.symbols,
    baseStockFilter: input.baseStockFilter,
    baseOptionsFilter: input.baseOptionsFilter,
    now: input.now,
  });
}

/**
 * Rebuild a runnable ScenarioDefinition from a stored goal + scenario
 * (Phase 0 store). The store does not persist a direction — the
 * taxonomy default applies, exactly as buildScenario defaults it —
 * and a config snapshot embedded in the stored constraints (the
 * persistScenario idiom) is restored as the scenario's snapshot;
 * absent one, the current defaults' snapshot is used.
 */
export function scenarioFromStoredRecord(
  goal: GoalRecord,
  record: ScenarioRecord
): ScenarioDefinition {
  const base = buildScenario({ goalKind: goal.kind, portfolioRef: record.portfolioRef });
  const stored = (record.constraints ?? {}) as Record<string, unknown>;
  const { configSnapshot, ...storedConstraints } = stored;
  return {
    ...base,
    portfolioRef: record.portfolioRef,
    shocks: (record.shocks as ScenarioShockGrid | undefined) ?? base.shocks,
    constraints: {
      ...base.constraints,
      ...(storedConstraints as ScenarioConstraints),
    },
    configSnapshot:
      (configSnapshot as ScenarioConfigSnapshot | undefined) ?? base.configSnapshot,
  };
}

/* ------------------------------------------------------------------ */
/* Shared run execution (route + schedule service)                     */
/* ------------------------------------------------------------------ */

export interface GoalScreenRunOutcome {
  taskId: string;
  taskStatus: string;
  executed: boolean;
  result?: GoalDrivenScreenResult;
  delivery?: ScreeningChannelResult[];
}

/**
 * Run one goal-driven screen through the ScreenerAgent and record it
 * on the canonical seams. Duplicate deliveries (the agent returns
 * executed=false) store nothing and deliver nothing — the existing
 * ledger record is the run.
 */
export async function executeGoalScreenRun(input: {
  agent: GoalScreenAgentPort;
  orm: DatabaseORM;
  env: unknown;
  userLogin: string;
  scenario: ScenarioDefinition;
  scenarioSource: "built" | "stored";
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  environment?: "TEST" | "PROD";
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
  deliver?: ScreeningChannel[];
  emailTo?: string;
  actor?: string;
}): Promise<GoalScreenRunOutcome> {
  const run = await input.agent.runGoalScreen({
    scenario: input.scenario,
    trigger: input.trigger,
    idempotencyKey: input.idempotencyKey,
    userLogin: input.userLogin,
    environment: input.environment,
    assetClasses: input.assetClasses,
    symbols: input.symbols,
    baseStockFilter: input.baseStockFilter,
    baseOptionsFilter: input.baseOptionsFilter,
  });
  if (!run.executed || !run.result) {
    return { taskId: run.task.id, taskStatus: run.task.status, executed: false };
  }
  const result = run.result;
  const summary =
    `Goal screen (${result.goalKind}/${result.outlook}) ${result.status}: ` +
    `${result.counts.hits} hit(s) from ${result.counts.stocksScanned} stocks + ` +
    `${result.counts.optionsUnderlyingsScanned} option underlyings.`;
  input.orm.storeCanonicalReport({
    runId: `goal-screen:${run.task.id}`,
    generationId: `goal-screen:${run.task.id}`,
    title: `Goal screen — ${result.goalKind} (${result.outlook})`,
    source: "goal_screen",
    summary,
    body: {
      trigger: input.trigger,
      scenarioSource: input.scenarioSource,
      taskId: run.task.id,
      result,
      // Issue #1335: artifact keys ride top-level so the Runs read
      // surface (runSummaryFromReport) finds them — the result object
      // alone is not in its lookup chain.
      ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
      ...(result.pdfStatus ? { pdfStatus: result.pdfStatus } : {}),
      ...(result.pdfError ? { pdfError: result.pdfError } : {}),
      ...(result.xlsxKey ? { xlsxKey: result.xlsxKey } : {}),
      ...(result.xlsxStatus ? { xlsxStatus: result.xlsxStatus } : {}),
      ...(result.xlsxError ? { xlsxError: result.xlsxError } : {}),
      ...(result.csvKey ? { csvKey: result.csvKey } : {}),
      ...(result.csvStatus ? { csvStatus: result.csvStatus } : {}),
      ...(result.csvError ? { csvError: result.csvError } : {}),
    },
    createdAt: result.completedAt,
  });
  recordScreeningActivity(input.orm as any, {
    userLogin: input.userLogin,
    kind: "screen_run",
    summary: `Goal screen ${result.goalKind} (${result.outlook}) — ${result.status}, ${result.counts.hits} hit(s).`,
    detail: {
      taskId: run.task.id,
      status: result.status,
      counts: result.counts,
      trigger: input.trigger,
      scenarioSource: input.scenarioSource,
    },
    refId: run.task.id,
    actor: input.actor,
  });

  let delivery: ScreeningChannelResult[] | undefined;
  if (input.deliver && input.deliver.length > 0) {
    const formatted = formatGoalScreenDelivery(result);
    delivery = await deliverScreeningContent({
      channels: input.deliver,
      subject: formatted.subject,
      text: formatted.text,
      event: "screening.goal_screen",
      data: {
        taskId: run.task.id,
        goalKind: result.goalKind,
        outlook: result.outlook,
        status: result.status,
        hits: result.counts.hits,
      },
      emailTo: input.emailTo,
      senders: createScreeningDeliverySenders(input.env, input.orm, input.userLogin),
      sql: input.orm as any,
      userLogin: input.userLogin,
      actor: input.actor,
    });
  }
  return {
    taskId: run.task.id,
    taskStatus: run.task.status,
    executed: true,
    result,
    ...(delivery ? { delivery } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Backtest-on-screen                                                  */
/* ------------------------------------------------------------------ */

async function fetchLivePriceBars(symbol: string): Promise<PriceBar[] | null> {
  const bars = await fetchYahooDailyHistory(symbol);
  if (!bars) return null;
  return bars.map((b) => ({ date: b.date, close: b.close }));
}

/**
 * Backtest-on-screen over live daily history (Yahoo). Candidates are
 * the caller's symbols as stock candidates; a symbol whose history
 * cannot be fetched is excluded by the engine with its reason —
 * provenance stays "live" because every supplied bar is a live fetch
 * and nothing is synthesized.
 */
export async function executeScreenBacktest(input: {
  symbols: string[];
  fetchPrices?: (symbol: string) => Promise<PriceBar[] | null>;
  folds?: number;
  holdingBars?: number;
  capital?: number;
}): Promise<BacktestResult> {
  const fetchPrices = input.fetchPrices ?? fetchLivePriceBars;
  const prices: Record<string, PriceBar[]> = {};
  for (const symbol of input.symbols) {
    const bars = await fetchPrices(symbol);
    if (bars && bars.length > 0) prices[symbol] = bars;
  }
  return backtestScreenCandidates({
    candidates: input.symbols.map((symbol) => ({ symbol, kind: "stock" as const })),
    prices,
    provenance: "live",
    folds: input.folds,
    holdingBars: input.holdingBars,
    capital: input.capital,
  });
}
