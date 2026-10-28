/**
 * Options report matrix views (issue #2091): the two directions of the
 * chain-vs-strategies evaluation, as pure builders over the scan result.
 *
 * - "Strategies fit my name": one row per symbol, the strategy types whose
 *   cells passed, with each type's best candidate.
 * - "Names fit my strategy": one row per strategy type, the symbols that
 *   passed, with the type's best candidate overall.
 * - Strategy coverage: which registry strategies were evaluated on the
 *   fetched chain and which were not — with the reason named, never silently
 *   dropped. A strategy whose catalog horizon exceeds the fetched chain's
 *   max DTE is horizon-limited; any other unevaluated strategy built no
 *   candidate on the fetched chain.
 *
 * Cell strategy types ARE definition ids (`candidate.type = def.id`), so the
 * evaluated set is the union of cell types — no id/type mapping is needed.
 */

import { defaultRegistry } from "./options/strategies/catalog";
import type { ScanMatrixRow, ScanTypeRollup } from "./options/opportunityScanner";

export interface PassingStrategy {
  strategyType: string;
  label: string;
  bestComposite: number | null;
  bestScore: number | null;
  bestExpirationDate: string | null;
}

export interface StrategiesByNameRow {
  symbol: string;
  gateBucket: ScanMatrixRow["gateBucket"];
  passing: PassingStrategy[];
  evaluatedCount: number;
  passedCount: number;
}

export interface NamesByStrategyRow {
  strategyType: string;
  label: string;
  symbolsEvaluated: number;
  symbolsPassed: number;
  evaluatedCount: number;
  passedCount: number;
  rejectedCount: number;
  bestSymbol: string | null;
  bestLabel: string | null;
  bestComposite: number | null;
}

export interface NotEvaluatedStrategy {
  id: string;
  label: string;
  reason: string;
}

export interface StrategyCoverage {
  scope: "all" | "thesis";
  evaluatedStrategyIds: string[];
  notEvaluated: NotEvaluatedStrategy[];
}

/** Per-symbol passing strategies, best composite first, best-less last. */
export function buildStrategiesByNameRows(matrix: ScanMatrixRow[]): StrategiesByNameRow[] {
  return matrix.map((row) => {
    const passing = row.cells
      .filter((cell) => cell.passedCount > 0)
      .map((cell) => ({
        strategyType: cell.strategyType,
        label: cell.best?.label ?? cell.strategyType,
        bestComposite: cell.best?.compositeScore ?? null,
        bestScore: cell.best?.score ?? null,
        bestExpirationDate: cell.best?.expirationDate ?? null,
      }))
      .sort((a, b) => {
        if (a.bestComposite !== null && b.bestComposite !== null && a.bestComposite !== b.bestComposite) return b.bestComposite - a.bestComposite;
        if (a.bestComposite !== null && b.bestComposite === null) return -1;
        if (a.bestComposite === null && b.bestComposite !== null) return 1;
        return a.strategyType.localeCompare(b.strategyType);
      });
    return {
      symbol: row.symbol,
      gateBucket: row.gateBucket,
      passing,
      evaluatedCount: row.cells.reduce((sum, cell) => sum + cell.evaluatedCount, 0),
      passedCount: row.cells.reduce((sum, cell) => sum + cell.passedCount, 0),
    };
  });
}

/** Per-strategy rollup rows, in the rollup's own order (best composite first). */
export function buildNamesByStrategyRows(rollup: ScanTypeRollup[]): NamesByStrategyRow[] {
  return rollup.map((entry) => ({
    strategyType: entry.strategyType,
    label: entry.bestOverall?.label ?? entry.strategyType,
    symbolsEvaluated: entry.symbolsEvaluated,
    symbolsPassed: entry.symbolsPassed,
    evaluatedCount: entry.evaluatedCount,
    passedCount: entry.passedCount,
    rejectedCount: entry.rejectedCount,
    bestSymbol: entry.bestOverall?.symbol ?? null,
    bestLabel: entry.bestOverall?.label ?? null,
    bestComposite: entry.bestOverall?.compositeScore ?? null,
  }));
}

/**
 * Which wanted strategies the fetched chain evaluated, and which it did not.
 * `wantedIds` are registry ids (["all"] resolves to the full registry).
 * `fetchedMaxDte` is the scan's data horizon: a strategy whose catalog
 * horizon exceeds it could not have built a candidate from this chain.
 */
export function buildStrategyCoverage(
  matrix: ScanMatrixRow[],
  wantedIds: string[] | undefined,
  fetchedMaxDte: number | undefined,
  scope: "all" | "thesis" = "all",
): StrategyCoverage {
  const wanted = defaultRegistry.resolveMany(wantedIds ?? ["all"]).ids;
  const evaluated = new Set<string>();
  for (const row of matrix) {
    for (const cell of row.cells) evaluated.add(cell.strategyType);
  }
  const evaluatedStrategyIds = [...evaluated].sort();
  const notEvaluated: NotEvaluatedStrategy[] = [];
  for (const id of wanted) {
    if (evaluated.has(id)) continue;
    const def = defaultRegistry.get(id);
    if (!def) continue;
    const horizon = def.dataHorizonDte ?? def.requiredMaxDte ?? 0;
    const reason = fetchedMaxDte !== undefined && horizon > fetchedMaxDte
      ? `requires expiries beyond the fetched chain (catalog horizon ${horizon} DTE > fetched ${fetchedMaxDte} DTE)`
      : "built no candidate on the fetched chain";
    notEvaluated.push({ id, label: def.label, reason });
  }
  notEvaluated.sort((a, b) => a.id.localeCompare(b.id));
  return { scope, evaluatedStrategyIds, notEvaluated };
}
