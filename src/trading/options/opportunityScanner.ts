/**
 * Cross-symbol opportunity scanner: runs the options agent pipeline over many
 * underlyings (a watchlist, an explicit list, or a stock-screen universe) and
 * ranks each symbol's best trade against the others.
 */

import { OptionsDataAgent } from "./optionsDataAgent";
import { StrategyRiskAgent, type StrategyScreenFilter } from "./strategyRiskAgent";
import { RecommendationAgent, type BestTradePick, type RankedStrategy, type RiskProfile } from "./recommendationAgent";
import type { StrategyCandidate, StrategyRequest } from "./strategyEngine";
import { MAX_SCAN_SYMBOLS as DEFAULT_MAX_SCAN_SYMBOLS, type DynamicOptionsScreener } from "../optionsScreener";
import { getOpportunityScannerConfig } from "../../config/etapiConfig";

const baseOppConfig = getOpportunityScannerConfig();
export const MAX_SCAN_SYMBOLS = baseOppConfig.maxScanSymbols;
const CONCURRENCY = baseOppConfig.concurrency;

/**
 * The two strategy questions a scan can answer (issue #23):
 *  - "strategy_fit" — Q1: "which names fit my strategy?" Returns the full
 *    accounting: every fitting name in `fits`, not a best-trade top-N.
 *  - "per_name_best" — Q2: "what is the best trade per name?" The headline
 *    list stays `opportunities` (top-N best-per-name), exactly the
 *    pre-#23 behavior, and is the default.
 */
export type ScanMode = "strategy_fit" | "per_name_best";

/**
 * Per-name parameters for one symbol in a scan (issue #23): a thesis
 * and/or target that override the shared template for that symbol only.
 * Supplied explicitly at the API/template level (e.g. the #84 UI form);
 * NLQ prose parsing does not produce these.
 */
export interface ScanSymbolOverride {
  thesis?: StrategyRequest["thesis"];
  target?:
    | { kind: "absolute"; price: number }
    | { kind: "percent"; pct: number };
}

export type ScanRequestTemplate = Omit<StrategyRequest, "symbol" | "targetPrice"> & {
  /**
   * A target price the user stated for one specific symbol (issue #19).
   * Scoped by design: it applies only to `symbol` when one is attached;
   * every other scanned symbol — and every symbol when no symbol is
   * attached — gets a thesis-derived target instead. A target stated in a
   * single-name question must never leak onto the other names in a scan.
   */
  statedTarget?: { price: number; symbol?: string };
  /**
   * Per-name parameters keyed by (uppercase) symbol (issue #23). An
   * override target wins over the shared statedTarget for that symbol —
   * it is the more specific instruction.
   */
  perSymbol?: Record<string, ScanSymbolOverride>;
};

export interface OpportunityRow {
  symbol: string;
  underlyingPrice: number;
  targetPrice: number;
  /** Where this row's target came from: the user's stated target for this
   *  symbol ("stated"), a per-name percent override ("percent"), or the
   *  thesis factor on spot ("thesis"). */
  targetSource: "stated" | "percent" | "thesis";
  pick: BestTradePick;
  score: number;
}

/** The best screen-passing candidate of one strategy type for one symbol
 *  (issue #22), flattened from the ranked matched set. */
export interface ScanMatrixCellBest {
  candidateId: string;
  label: string;
  compositeScore: number;
  score: number;
  expirationDate: string;
  legs: StrategyCandidate["legs"];
  netDebit: number;
  maxLoss: number;
  maxProfit: number | null;
  maxProfitUnbounded: boolean;
  targetRewardRisk: number;
  probabilityOfProfit: number;
}

/** One strategy type's fit for one symbol: how many candidates were built,
 *  how many passed the screen, how many were rejected (and why), and the
 *  best passing candidate when there is one. */
export interface ScanMatrixCell {
  strategyType: string;
  best: ScanMatrixCellBest | null;
  evaluatedCount: number;
  passedCount: number;
  rejectedCount: number;
  rejectionReasons: Record<string, number>;
}

/** One symbol's row in the names × strategy-types fit matrix (issue #22).
 *  The verdict is a screen-pass verdict only — "pass" means at least one
 *  candidate passed the screen in at least one type; score-threshold fit
 *  gating is issue #24, not this. */
export interface ScanMatrixRow {
  symbol: string;
  verdict: "pass" | "no_pass" | "skipped";
  /** Set only when verdict is "skipped": why the symbol was never evaluated. */
  skipReason?: string;
  /** Null when the symbol was skipped before a spot price existed. */
  targetPrice: number | null;
  targetSource: "stated" | "percent" | "thesis" | null;
  /** One cell per strategy type that had at least one built candidate;
   *  empty for skipped symbols. */
  cells: ScanMatrixCell[];
}

export interface OpportunityScanResult {
  scanned: number;
  withTrades: number;
  opportunities: OpportunityRow[];
  skipped: Array<{ symbol: string; reason: string }>;
  truncatedSymbols: number;
  /** Plain-language disclosures about scan-level assumptions (e.g. how a
   *  stated target was scoped). Empty when there is nothing to disclose. */
  assumptions: string[];
  /** The full names × strategy-types fit matrix (issue #22): one row for
   *  every symbol in the scanned batch, in batch (input) order. */
  matrix: ScanMatrixRow[];
  /** Which of the two strategy questions this scan answered (issue #23). */
  mode: ScanMode;
  /** Strategy-fit mode only: the matrix rows whose verdict is "pass",
   *  paginated by the scan's offset/limit. Empty in per_name_best mode,
   *  where `opportunities` is the headline list. "Fitting" is the #22
   *  screen-pass verdict — score-threshold gating is issue #24. */
  fits: ScanMatrixRow[];
  /** Strategy-fit mode only: total "pass" rows BEFORE pagination slicing.
   *  0 in per_name_best mode. */
  fitsTotal: number;
}

const TARGET_FACTOR: Record<StrategyRequest["thesis"], number> = baseOppConfig.targetFactors;

/**
 * Resolve the target price for one symbol in a scan (issue #19). A stated
 * target applies only to the symbol it was stated for; every other symbol
 * uses the thesis factor on its own spot price. Pure and exported for
 * direct unit testing.
 *
 * Precedence (issue #23): a per-name override target for this symbol wins
 * over the shared statedTarget — it is the more specific instruction. A
 * per-name thesis override (with no override target) also steers the
 * thesis factor used for the derived fallback.
 */
export function resolveScanTarget(
  template: ScanRequestTemplate,
  symbol: string,
  spotPrice: number,
  override?: ScanSymbolOverride,
): { targetPrice: number; source: "stated" | "percent" | "thesis" } {
  if (override?.target?.kind === "absolute") {
    return { targetPrice: override.target.price, source: "stated" };
  }
  if (override?.target?.kind === "percent") {
    return {
      targetPrice: Number((spotPrice * (1 + override.target.pct / 100)).toFixed(2)),
      source: "percent",
    };
  }
  const stated = template.statedTarget;
  if (stated?.symbol && stated.symbol.trim().toUpperCase() === symbol.toUpperCase()) {
    return { targetPrice: stated.price, source: "stated" };
  }
  const thesis = override?.thesis ?? template.thesis;
  return { targetPrice: Number((spotPrice * TARGET_FACTOR[thesis]).toFixed(2)), source: "thesis" };
}

/** Disclosure lines for a scan whose request carried a stated target. */
function scanTargetAssumptions(template: ScanRequestTemplate): string[] {
  const stated = template.statedTarget;
  if (!stated) return [];
  if (stated.symbol) {
    return [
      `Stated target $${stated.price.toFixed(2)} applied to ${stated.symbol.trim().toUpperCase()} only; every other symbol uses a thesis-derived target (spot × ${TARGET_FACTOR[template.thesis]} for ${template.thesis}).`,
    ];
  }
  return [
    `A target of $${stated.price.toFixed(2)} was stated without a symbol, so it was not applied to any scanned name; thesis-derived targets were used for all symbols.`,
  ];
}

/**
 * The single disclosure line for per-name overrides (issue #23): one entry
 * per symbol in the scanned batch that carries an override, symbols
 * ascending. Returns null when no batch symbol is overridden (or every
 * override is empty), so the caller can omit the line entirely.
 */
function scanOverrideAssumption(template: ScanRequestTemplate, batch: string[]): string | null {
  if (!template.perSymbol) return null;
  const applied = batch
    .filter((symbol) => template.perSymbol![symbol])
    .sort((a, b) => a.localeCompare(b));
  const entries: string[] = [];
  for (const symbol of applied) {
    const override = template.perSymbol[symbol];
    const clauses: string[] = [];
    if (override.thesis) clauses.push(`thesis ${override.thesis}`);
    if (override.target?.kind === "absolute") {
      clauses.push(`target $${override.target.price.toFixed(2)}`);
    } else if (override.target?.kind === "percent") {
      clauses.push(`target ${override.target.pct >= 0 ? "+" : ""}${override.target.pct.toFixed(1)}%`);
    }
    if (clauses.length) entries.push(`${symbol} (${clauses.join(", ")})`);
  }
  return entries.length ? `Per-name overrides applied: ${entries.join("; ")}.` : null;
}

/**
 * Build one symbol's matrix cells from the scanner's own build/screen/rank
 * outputs (issue #22). Evaluated counts come from grouping the built
 * candidates by type; rejections are mapped back to their candidate's type;
 * the per-type best is the highest-composite entry of the ranked matched
 * set. Cells are ordered by best compositeScore descending (best-less cells
 * last), ties broken by strategy type ascending for determinism.
 */
function buildMatrixCells(
  candidates: StrategyCandidate[],
  rejected: Array<{ id: string; reason: string }>,
  rankedMatched: RankedStrategy[],
): ScanMatrixCell[] {
  const typeById = new Map(candidates.map((c) => [c.id, c.type]));
  const cells = new Map<string, ScanMatrixCell>();
  const cellFor = (strategyType: string): ScanMatrixCell => {
    let cell = cells.get(strategyType);
    if (!cell) {
      cell = {
        strategyType,
        best: null,
        evaluatedCount: 0,
        passedCount: 0,
        rejectedCount: 0,
        rejectionReasons: {},
      };
      cells.set(strategyType, cell);
    }
    return cell;
  };
  for (const c of candidates) cellFor(c.type).evaluatedCount++;
  for (const r of rejected) {
    const strategyType = typeById.get(r.id);
    if (!strategyType) continue;
    const cell = cellFor(strategyType);
    cell.rejectedCount++;
    cell.rejectionReasons[r.reason] = (cell.rejectionReasons[r.reason] ?? 0) + 1;
  }
  for (const cell of cells.values()) cell.passedCount = cell.evaluatedCount - cell.rejectedCount;
  // rankedMatched is already sorted by compositeScore descending, so the
  // first entry seen per type is that type's best.
  for (const entry of rankedMatched) {
    const cell = cells.get(entry.candidate.type);
    if (cell && !cell.best) {
      const c = entry.candidate;
      cell.best = {
        candidateId: c.id,
        label: c.label,
        compositeScore: entry.compositeScore,
        score: c.score,
        expirationDate: c.expirationDate,
        legs: c.legs,
        netDebit: c.netDebit,
        maxLoss: c.maxLoss,
        maxProfit: c.maxProfit,
        maxProfitUnbounded: c.maxProfitUnbounded,
        targetRewardRisk: c.targetRewardRisk,
        probabilityOfProfit: c.modelImpliedProbabilityOfProfit,
      };
    }
  }
  return [...cells.values()].sort((a, b) => {
    const sa = a.best?.compositeScore;
    const sb = b.best?.compositeScore;
    if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
    if (sa !== undefined && sb === undefined) return -1;
    if (sa === undefined && sb !== undefined) return 1;
    return a.strategyType.localeCompare(b.strategyType);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export class OpportunityScanner {
  private readonly data: OptionsDataAgent;
  private readonly risk = new StrategyRiskAgent();
  private readonly recommender = new RecommendationAgent();

  constructor(screener: DynamicOptionsScreener) {
    this.data = new OptionsDataAgent(screener);
  }

  async scan(
    symbols: string[],
    template: ScanRequestTemplate,
    options: {
      riskProfile?: RiskProfile;
      strategyFilter?: StrategyScreenFilter;
      limit?: number;
      /** Which strategy question to answer (issue #23); default
       *  "per_name_best". In strategy_fit mode `limit` paginates `fits`
       *  instead of `opportunities`. */
      mode?: ScanMode;
      /** Strategy-fit pagination offset into the pass rows; default 0. */
      offset?: number;
    } = {}
  ): Promise<OpportunityScanResult> {
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const batch = unique.slice(0, MAX_SCAN_SYMBOLS);
    const profile = options.riskProfile ?? "balanced";
    const mode = options.mode ?? "per_name_best";
    const skipped: OpportunityScanResult["skipped"] = [];
    const overrideAssumption = scanOverrideAssumption(template, batch);
    const assumptions = [
      ...scanTargetAssumptions(template),
      ...(overrideAssumption ? [overrideAssumption] : []),
    ];
    // The stated target and the per-name overrides are scan-level scoping
    // metadata, not request fields: strip them so per-symbol
    // StrategyRequests stay exactly StrategyRequest-shaped.
    const { statedTarget: _statedTarget, perSymbol: _perSymbol, ...requestTemplate } = template;

    const outcomes = await mapLimit(batch, CONCURRENCY, async (symbol): Promise<{ opportunity: OpportunityRow | null; matrix: ScanMatrixRow }> => {
      const skippedMatrixRow = (reason: string): ScanMatrixRow => ({
        symbol,
        verdict: "skipped",
        skipReason: reason,
        targetPrice: null,
        targetSource: null,
        cells: [],
      });
      try {
        const snapshot = await this.data.loadSnapshot({ ...requestTemplate, symbol });
        const price = snapshot.contracts[0]?.underlyingPrice;
        if (!price) {
          const reason = snapshot.validationError || snapshot.screen.fetchErrors?.[0]?.reason || "No eligible option contracts";
          skipped.push({ symbol, reason });
          return { opportunity: null, matrix: skippedMatrixRow(reason) };
        }
        // Per-name parameters (issue #23): this symbol's override steers
        // its target resolution and, when it carries a thesis, the thesis
        // its build/screen/pick run under. The snapshot load above stays
        // on the shared template, as before.
        const override = template.perSymbol?.[symbol];
        const { targetPrice, source: targetSource } = resolveScanTarget(template, symbol, price, override);
        const request: StrategyRequest = {
          ...requestTemplate,
          symbol,
          targetPrice,
          thesis: override?.thesis ?? requestTemplate.thesis,
        };
        const built = this.risk.buildStrategies(snapshot.contracts, request);
        const { matched, rejected } = this.risk.screenStrategies(built.candidates, options.strategyFilter);
        // The fit matrix is additive: it reports every built/screened
        // candidate per strategy type, ranked once via the recommender.
        // The pick path below is unchanged and still uses pickBestTrade.
        const cells = buildMatrixCells(built.candidates, rejected, this.recommender.rank(matched, request, profile));
        const matrix: ScanMatrixRow = {
          symbol,
          verdict: cells.some((c) => c.passedCount > 0) ? "pass" : "no_pass",
          targetPrice,
          targetSource,
          cells,
        };
        const pick = this.recommender.pickBestTrade(matched, request, profile, 2);
        if (!pick.best) {
          skipped.push({ symbol, reason: pick.rationale[0] || "No qualifying strategy" });
          return { opportunity: null, matrix };
        }
        return {
          opportunity: { symbol, underlyingPrice: price, targetPrice, targetSource, pick, score: pick.best.compositeScore },
          matrix,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Scan failed";
        skipped.push({ symbol, reason });
        return { opportunity: null, matrix: skippedMatrixRow(reason) };
      }
    });

    const opportunities = outcomes
      .map((o) => o.opportunity)
      .filter((r): r is OpportunityRow => r !== null)
      .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const matrix = outcomes.map((o) => o.matrix);
    // Strategy-fit accounting (issue #23): every "pass" matrix row is a
    // fit. `limit` paginates this list in strategy_fit mode, so
    // `opportunities` keeps its default top-10 cap there; in
    // per_name_best mode `limit` slices `opportunities` as it always has.
    const passRows = mode === "strategy_fit" ? matrix.filter((m) => m.verdict === "pass") : [];
    const offset = options.offset ?? 0;
    return {
      scanned: batch.length,
      withTrades: opportunities.length,
      opportunities: opportunities.slice(0, mode === "per_name_best" ? options.limit ?? 10 : 10),
      skipped,
      truncatedSymbols: Math.max(0, unique.length - batch.length),
      assumptions,
      matrix,
      mode,
      fits: passRows.slice(offset, options.limit === undefined ? undefined : offset + options.limit),
      fitsTotal: passRows.length,
    };
  }
}
