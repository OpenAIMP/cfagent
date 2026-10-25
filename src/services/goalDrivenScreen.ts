/**
 * Issue #1122 (epic #1096 Phase 3) — Screeners v2: goal/scenario-driven
 * stock + options screens.
 *
 * A Phase 1 scenario (goalScenarioEngine.ScenarioDefinition) becomes a
 * screen plan — goal outlook, the taxonomy's gate-admissible
 * structures, and filters derived from the scenario's constraints
 * (DTE window, liquidity floor, spread cap) — and the run executes
 * through the Phase 0 ScreeningProvider registry ONLY. There is no
 * second screening implementation here and no parallel pipeline: this
 * service is a plan + orchestration layer over the existing provider
 * contract, the way researchDiscovery is a mode over researchPipeline.
 *
 * Partial semantics follow the screenerEvents contract (#462): one
 * asset class failing yields a QUALIFIED PARTIAL result — the other
 * class's hits plus the failed class and its reason, never presented
 * as a complete screen. Both classes failing is a failure. Zero hits
 * is a legitimate complete result, distinct from partial.
 *
 * Durability: runGoalDrivenScreenWithLedger adopts the screener task
 * ledger (#607 — the screener mirror of researchTaskLedger #577) for
 * goal-driven runs: idempotent by run key (a duplicate delivery
 * returns the existing record and does NOT re-execute), heartbeat,
 * the ledger's deterministic outcome evaluation, and total failure
 * ending ESCALATED, visible to a human.
 *
 * READ-ONLY: screening never places, modifies, or cancels orders.
 */

import type {
  OptionScreenerFilter,
  StockScreenerFilter,
} from "../types";
import type { Outlook } from "./researchGates";
import type { GoalKind } from "./goalScenarioStore";
import {
  GOAL_TAXONOMY,
  type ScenarioDefinition,
} from "./goalScenarioEngine";
import type {
  ScreeningProviderAssetClass,
  ScreeningProviderRegistry,
  ScreeningResult,
} from "../trading";
import {
  evaluateScreenerOutcome,
  type ScreenerTask,
  type ScreenerTaskLedger,
} from "./screenerTaskLedger";

/* ------------------------------------------------------------------ */
/* Screen plan                                                         */
/* ------------------------------------------------------------------ */

export interface GoalScreenPlan {
  goalKind: GoalKind;
  outlook: Outlook;
  /** Taxonomy default structures for the goal (gate-admissible families). */
  structures: string[];
  stockFilter: StockScreenerFilter;
  optionsFilter: OptionScreenerFilter;
}

const MOMENTUM_BY_OUTLOOK: Record<string, NonNullable<StockScreenerFilter["momentum"]>> = {
  bullish: "bullish_breakout",
  bearish: "bearish_pullback",
  volatile: "high_relative_volume",
  range_bound: "any",
  unknown: "any",
};

/** Merge filter fields: only fields actually set on `override` win. */
function mergeDefined<T extends object>(base: T, override?: Partial<T>): T {
  if (!override) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Derive the screen plan from a scenario. Constraint mapping is the
 * scenario's own language (goalScenarioEngine.ScenarioConstraints):
 * dteWindow → min/max DTE, liquidityFloor → OI/volume/spread floors.
 * Caller base filters win per-field — explicit caller intent over
 * plan defaults, never the reverse.
 */
export function buildGoalScreenPlan(
  scenario: ScenarioDefinition,
  opts?: {
    symbols?: string[];
    baseStockFilter?: StockScreenerFilter;
    baseOptionsFilter?: OptionScreenerFilter;
  }
): GoalScreenPlan {
  const taxonomy = GOAL_TAXONOMY[scenario.goalKind];
  const outlook = scenario.direction ?? taxonomy.outlook;
  const constraints = scenario.constraints;

  const planStock: StockScreenerFilter = {
    momentum: MOMENTUM_BY_OUTLOOK[outlook] ?? "any",
  };
  const planOptions: OptionScreenerFilter = {};
  if (constraints.dteWindow) {
    planOptions.minDte = constraints.dteWindow.min;
    planOptions.maxDte = constraints.dteWindow.max;
  }
  if (constraints.liquidityFloor?.minOpenInterest !== undefined) {
    planOptions.minOpenInterest = constraints.liquidityFloor.minOpenInterest;
  }
  if (constraints.liquidityFloor?.minVolume !== undefined) {
    planOptions.minVolume = constraints.liquidityFloor.minVolume;
  }
  if (constraints.liquidityFloor?.maxSpreadPct !== undefined) {
    planOptions.maxSpreadPct = constraints.liquidityFloor.maxSpreadPct;
  }
  if (opts?.symbols && opts.symbols.length > 0) {
    planOptions.underlyingSymbols = [...opts.symbols];
  }

  return {
    goalKind: scenario.goalKind,
    outlook,
    structures: [...taxonomy.defaultStructures],
    stockFilter: mergeDefined(planStock, opts?.baseStockFilter),
    optionsFilter: mergeDefined(planOptions, opts?.baseOptionsFilter),
  };
}

/* ------------------------------------------------------------------ */
/* Unified run                                                         */
/* ------------------------------------------------------------------ */

export interface GoalScreenHit {
  assetClass: ScreeningProviderAssetClass;
  providerId: string;
  symbol: string;
  /** Plan structures this underlying is a candidate for (options hits). */
  structures?: string[];
}

export interface GoalDrivenScreenResult {
  goalKind: GoalKind;
  outlook: Outlook;
  plan: GoalScreenPlan;
  status: "complete" | "partial" | "failed";
  hits: GoalScreenHit[];
  counts: {
    stocksScanned: number;
    stocksMatched: number;
    optionsUnderlyingsScanned: number;
    optionsContractsMatched: number;
    hits: number;
  };
  /** Present whenever any requested asset class failed (screenerEvents qualification). */
  partial?: {
    failedClasses: ScreeningProviderAssetClass[];
    reasons: Record<string, string>;
  };
  completedAt: string;
  /** Issue #1335: stored report artifacts (PDF + XLSX + CSV), set by
   *  the agent after the run completes — 0-hit runs included. Each
   *  format records its own generated/failed state; a failed artifact
   *  never fails the run. */
  pdfKey?: string;
  pdfStatus?: "generated" | "failed";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus?: "generated" | "failed";
  csvError?: string;
}

export async function runGoalDrivenScreen(input: {
  registry: ScreeningProviderRegistry;
  scenario: ScenarioDefinition;
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
  now?: Date;
}): Promise<GoalDrivenScreenResult> {
  const plan = buildGoalScreenPlan(input.scenario, {
    symbols: input.symbols,
    baseStockFilter: input.baseStockFilter,
    baseOptionsFilter: input.baseOptionsFilter,
  });
  const requested: ScreeningProviderAssetClass[] = input.assetClasses ?? ["stocks", "options"];

  const hits: GoalScreenHit[] = [];
  const counts = {
    stocksScanned: 0,
    stocksMatched: 0,
    optionsUnderlyingsScanned: 0,
    optionsContractsMatched: 0,
    hits: 0,
  };
  const failedClasses: ScreeningProviderAssetClass[] = [];
  const reasons: Record<string, string> = {};

  for (const assetClass of requested) {
    try {
      const screened: ScreeningResult =
        assetClass === "stocks"
          ? await input.registry.screen({ assetClass: "stocks", filter: plan.stockFilter })
          : await input.registry.screen({ assetClass: "options", filter: plan.optionsFilter });
      if (screened.assetClass === "stocks") {
        const result = screened.result as { totalScanned?: number; matchedCount?: number; stocks?: Array<{ symbol: string }> };
        counts.stocksScanned = result.totalScanned ?? 0;
        counts.stocksMatched = result.matchedCount ?? result.stocks?.length ?? 0;
        for (const stock of result.stocks ?? []) {
          hits.push({ assetClass: "stocks", providerId: screened.providerId, symbol: stock.symbol });
        }
      } else {
        const result = screened.result as {
          totalUnderlyingsScanned?: number;
          matchedCount?: number;
          contracts?: Array<{ underlyingSymbol: string }>;
        };
        counts.optionsUnderlyingsScanned = result.totalUnderlyingsScanned ?? 0;
        counts.optionsContractsMatched = result.matchedCount ?? result.contracts?.length ?? 0;
        const seen = new Set<string>();
        for (const contract of result.contracts ?? []) {
          if (seen.has(contract.underlyingSymbol)) continue;
          seen.add(contract.underlyingSymbol);
          hits.push({
            assetClass: "options",
            providerId: screened.providerId,
            symbol: contract.underlyingSymbol,
            structures: [...plan.structures],
          });
        }
      }
    } catch (err) {
      failedClasses.push(assetClass);
      reasons[assetClass] = err instanceof Error ? err.message : String(err);
    }
  }

  counts.hits = hits.length;
  const status: GoalDrivenScreenResult["status"] =
    failedClasses.length === 0
      ? "complete"
      : failedClasses.length >= requested.length
        ? "failed"
        : "partial";

  return {
    goalKind: plan.goalKind,
    outlook: plan.outlook,
    plan,
    status,
    hits,
    counts,
    ...(failedClasses.length > 0
      ? { partial: { failedClasses, reasons } }
      : {}),
    completedAt: (input.now ?? new Date()).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Ledger adoption (durable, idempotent autonomous runs)               */
/* ------------------------------------------------------------------ */

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "escalated", "cancelled"]);

/**
 * Run a goal-driven screen under the screener task ledger.
 *
 * Idempotency: any existing record carrying the run key — active or
 * terminal — is authoritative; a duplicate delivery returns it with
 * `executed: false` and the providers are never re-invoked. A fresh
 * run is claimed, started, and heartbeated before execution; total
 * failure is failed-then-escalated (the ledger's human-visible
 * terminal state), partial completion completes with the ledger's
 * partial flag + deterministic evaluation.
 */
export async function runGoalDrivenScreenWithLedger(input: {
  ledger: ScreenerTaskLedger;
  registry: ScreeningProviderRegistry;
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
  const existing = (await input.ledger.list(200)).find(
    (t) => t.idempotencyKey === input.idempotencyKey
  );
  if (existing) return { task: existing, executed: false };

  const { task, created } = await input.ledger.create({
    trigger: input.trigger,
    universe: `goal:${input.scenario.goalKind}`,
    sector: input.scenario.direction,
    userLogin: input.userLogin,
    idempotencyKey: input.idempotencyKey,
  });
  if (!created) return { task, executed: false };

  await input.ledger.claim(task.id);
  await input.ledger.start(task.id);
  await input.ledger.heartbeat(task.id);

  let result: GoalDrivenScreenResult;
  try {
    result = await runGoalDrivenScreen({
      registry: input.registry,
      scenario: input.scenario,
      assetClasses: input.assetClasses,
      symbols: input.symbols,
      baseStockFilter: input.baseStockFilter,
      baseOptionsFilter: input.baseOptionsFilter,
      now: input.now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await input.ledger.fail(task.id, message);
    const escalated = await input.ledger.escalate(
      task.id,
      "goal-driven screen threw unexpectedly; awaiting human review"
    );
    return { task: escalated, executed: true };
  }

  if (result.status === "failed") {
    const reasons = result.partial
      ? Object.entries(result.partial.reasons)
          .map(([klass, reason]) => `${klass}: ${reason}`)
          .join("; ")
      : "all requested asset classes failed";
    await input.ledger.fail(task.id, reasons);
    const escalated = await input.ledger.escalate(
      task.id,
      "goal-driven screen failed on every requested asset class; awaiting human review"
    );
    return { task: escalated, executed: true, result };
  }

  const partial = result.status === "partial";
  const evaluation = evaluateScreenerOutcome(
    {
      success: true,
      runTimestamp: result.completedAt,
      totalScanned: result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned,
      matchedCount: result.counts.hits,
      opportunities: result.counts.hits,
      partial,
      qualificationPresent: partial ? result.partial !== undefined : false,
      error: null,
    },
    result.completedAt
  );
  const completed = await input.ledger.complete(task.id, {
    runTimestamp: result.completedAt,
    totalScanned: result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned,
    matchedCount: result.counts.hits,
    opportunitiesCount: result.counts.hits,
    partial,
    evaluation,
  });
  return { task: completed, executed: true, result };
}
