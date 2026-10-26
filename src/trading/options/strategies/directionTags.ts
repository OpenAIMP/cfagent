/**
 * Issue #275 — strategy direction tags.
 *
 * Every strategy in the catalog carries direction tags: they are the
 * strategy definition's `theses` (bullish / bearish / range_bound /
 * large_move), already authored per strategy in catalog.ts. This
 * module is the single place that names the vocabulary, labels it for
 * the UI, resolves a strategy's tags from the registry, and stamps
 * scan opportunities with their pick's direction (the scheduled-run
 * tagging the issue asks for).
 */

import { defaultRegistry } from "./catalog";
import type { OptionThesis } from "../strategyEngine";
import type { PriceRegime } from "../../../types";

export const DIRECTION_TAGS = ["bullish", "bearish", "range_bound", "large_move"] as const;

export type DirectionTag = (typeof DIRECTION_TAGS)[number];

export const DIRECTION_TAG_LABELS: Record<DirectionTag, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  range_bound: "Range-bound",
  large_move: "Large move",
};

const DIRECTION_SET = new Set<string>(DIRECTION_TAGS);

export function isDirectionTag(value: string): value is DirectionTag {
  return DIRECTION_SET.has(value);
}

/** The direction tags of a catalog strategy (by strategy id); [] when
 * the id is unknown — never a guessed direction. */
export function directionTagsForStrategy(strategyId: string): DirectionTag[] {
  if (!strategyId) return [];
  const def = defaultRegistry.get(strategyId);
  if (!def) return [];
  return (def.theses as OptionThesis[]).filter(isDirectionTag);
}

/** The shape of a scan opportunity row for tagging purposes: the row's
 * best pick names its strategy via candidate.type (= the catalog id). */
export interface DirectionTaggableRow {
  pick?: {
    best?: {
      candidate?: { type?: string };
    };
  };
}

/**
 * Stamp each opportunity row with `directionTags` resolved from its
 * pick's strategy. Pure: returns new row objects, leaves the input
 * untouched. Rows without a pick (or with an unknown strategy) get an
 * empty list — visible as "untagged", never silently mislabeled.
 */
export function tagOpportunitiesWithDirection<T extends DirectionTaggableRow>(
  rows: readonly T[]
): Array<T & { directionTags: DirectionTag[] }> {
  return rows.map((row) => ({
    ...row,
    directionTags: directionTagsForStrategy(row.pick?.best?.candidate?.type || ""),
  }));
}

/**
 * Issue #1654 slice 5 — bullish-spread regime rule
 * (screener-rules.md: DN underlyings hard-reject bullish selling).
 *
 * A "bullish spread" is a catalog strategy in the "vertical" category
 * whose theses include "bullish" — today exactly call_debit_spread
 * (Bull Call Spread) and put_credit_spread (Bull Put Spread). Single-leg
 * bullish strategies (long_call), bullish stock plays (covered_call),
 * and bearish verticals (put_debit_spread) are NOT spreads under this
 * rule and are never blocked by it. Unknown strategy ids are not
 * bullish spreads — never a guessed direction.
 *
 * NOTE — rule defined here, pipeline enforcement deferred: no
 * per-underlying regime flows through the options scan today (zero
 * "regime" references in the options pipeline), so there is no call
 * site with a regime input yet. Slice 8 (enrichment) threads the
 * attached regime into the scan and calls
 * isStrategyAllowedUnderRegime at the strategy-selection filter in
 * strategyEngine.ts (~line 976, where defs are filtered by thesis).
 * Until then this rule is tested but uncalled — it must not be wired
 * to an invented regime input.
 */
export function isBullishSpreadStrategy(strategyId: string): boolean {
  if (!strategyId) return false;
  const def = defaultRegistry.get(strategyId);
  if (!def) return false;
  return def.category === "vertical" && (def.theses as string[]).includes("bullish");
}

/** False only for a bullish spread on a DN underlying; everything else
 *  passes, including a null (unknown) regime — an unknown regime must
 *  not silently kill candidates the rule cannot judge. */
export function isStrategyAllowedUnderRegime(
  strategyId: string,
  regime: PriceRegime | null
): boolean {
  if (regime !== "DN") return true;
  return !isBullishSpreadStrategy(strategyId);
}
