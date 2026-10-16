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

export type ScanRequestTemplate = Omit<StrategyRequest, "symbol" | "targetPrice"> & {
  /**
   * A target price the user stated for one specific symbol (issue #19).
   * Scoped by design: it applies only to `symbol` when one is attached;
   * every other scanned symbol — and every symbol when no symbol is
   * attached — gets a thesis-derived target instead. A target stated in a
   * single-name question must never leak onto the other names in a scan.
   */
  statedTarget?: { price: number; symbol?: string };
};

export interface OpportunityRow {
  symbol: string;
  underlyingPrice: number;
  targetPrice: number;
  /** Where this row's target came from: the user's stated target for this
   *  symbol ("stated") or the thesis factor on spot ("thesis"). */
  targetSource: "stated" | "thesis";
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
  targetSource: "stated" | "thesis" | null;
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
}

const TARGET_FACTOR: Record<StrategyRequest["thesis"], number> = baseOppConfig.targetFactors;

/**
 * Resolve the target price for one symbol in a scan (issue #19). A stated
 * target applies only to the symbol it was stated for; every other symbol
 * uses the thesis factor on its own spot price. Pure and exported for
 * direct unit testing.
 */
export function resolveScanTarget(
  template: ScanRequestTemplate,
  symbol: string,
  spotPrice: number,
): { targetPrice: number; source: "stated" | "thesis" } {
  const stated = template.statedTarget;
  if (stated?.symbol && stated.symbol.trim().toUpperCase() === symbol.toUpperCase()) {
    return { targetPrice: stated.price, source: "stated" };
  }
  return { targetPrice: Number((spotPrice * TARGET_FACTOR[template.thesis]).toFixed(2)), source: "thesis" };
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
    options: { riskProfile?: RiskProfile; strategyFilter?: StrategyScreenFilter; limit?: number } = {}
  ): Promise<OpportunityScanResult> {
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const batch = unique.slice(0, MAX_SCAN_SYMBOLS);
    const profile = options.riskProfile ?? "balanced";
    const skipped: OpportunityScanResult["skipped"] = [];
    const assumptions = scanTargetAssumptions(template);
    // The stated target is scan-level scoping metadata, not a request field:
    // strip it so per-symbol StrategyRequests stay exactly StrategyRequest-shaped.
    const { statedTarget: _statedTarget, ...requestTemplate } = template;

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
        const { targetPrice, source: targetSource } = resolveScanTarget(template, symbol, price);
        const request: StrategyRequest = {
          ...requestTemplate,
          symbol,
          targetPrice,
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
    return {
      scanned: batch.length,
      withTrades: opportunities.length,
      opportunities: opportunities.slice(0, options.limit ?? 10),
      skipped,
      truncatedSymbols: Math.max(0, unique.length - batch.length),
      assumptions,
      matrix: outcomes.map((o) => o.matrix),
    };
  }
}
