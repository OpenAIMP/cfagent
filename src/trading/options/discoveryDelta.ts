/**
 * Discovery (issue #14) — delta classification between comparable
 * runs (spec §6, stage 6).
 *
 * Compares the expressed setups of two runs (the store's
 * latestForScope supplies the baseline), keyed by (symbol, thesis):
 *
 *  - NEW — a setup with no counterpart in the previous run.
 *  - GONE — a previous setup with no counterpart now. A setup whose
 *    name now abstains is GONE (the item record says why it left);
 *    a thesis flip is GONE + NEW, never a mutation.
 *  - STRENGTHENED / WEAKENED — a continuing setup whose score moved
 *    by at least the configured threshold; inside the band, a
 *    confidence step decides.
 *  - UNCHANGED — a continuing setup inside the band at the same
 *    confidence.
 *
 * Only expressed setups participate; abstentions are coverage, not
 * positions. Pure and deterministic: output is sorted by symbol,
 * then thesis.
 */

import type { DiscoveryConfidence } from "./discoveryInference";
import type {
  DiscoverySetupExpressedItem,
  DiscoverySetupItem,
} from "./discoverySetupStore";
import type { OptionThesis } from "./strategyEngine";

export type DiscoveryDeltaKind = "NEW" | "STRENGTHENED" | "UNCHANGED" | "WEAKENED" | "GONE";

export interface DiscoveryDelta {
  symbol: string;
  thesis: OptionThesis;
  kind: DiscoveryDeltaKind;
  prevScore?: number;
  score?: number;
  prevConfidence?: DiscoveryConfidence;
  confidence?: DiscoveryConfidence;
}

const CONFIDENCE_RANK: Record<DiscoveryConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function setupKey(item: Pick<DiscoverySetupExpressedItem, "symbol" | "thesis">): string {
  return `${item.symbol}${item.thesis}`;
}

function setupsByKey(
  items: readonly DiscoverySetupItem[],
): Map<string, DiscoverySetupExpressedItem> {
  const map = new Map<string, DiscoverySetupExpressedItem>();
  for (const item of items) {
    if (item.kind === "setup") map.set(setupKey(item), item);
  }
  return map;
}

export function classifyDiscoveryDeltas(
  previous: readonly DiscoverySetupItem[],
  current: readonly DiscoverySetupItem[],
  scoreThreshold: number,
): DiscoveryDelta[] {
  const prev = setupsByKey(previous);
  const curr = setupsByKey(current);
  const deltas: DiscoveryDelta[] = [];

  for (const [key, item] of curr) {
    const before = prev.get(key);
    if (!before) {
      deltas.push({
        symbol: item.symbol,
        thesis: item.thesis,
        kind: "NEW",
        score: item.discoveryScore,
        confidence: item.confidence,
      });
      continue;
    }
    const movement = item.discoveryScore - before.discoveryScore;
    let kind: DiscoveryDeltaKind = "UNCHANGED";
    if (movement >= scoreThreshold) kind = "STRENGTHENED";
    else if (movement <= -scoreThreshold) kind = "WEAKENED";
    else if (CONFIDENCE_RANK[item.confidence] > CONFIDENCE_RANK[before.confidence]) kind = "STRENGTHENED";
    else if (CONFIDENCE_RANK[item.confidence] < CONFIDENCE_RANK[before.confidence]) kind = "WEAKENED";
    deltas.push({
      symbol: item.symbol,
      thesis: item.thesis,
      kind,
      prevScore: before.discoveryScore,
      score: item.discoveryScore,
      prevConfidence: before.confidence,
      confidence: item.confidence,
    });
  }

  for (const [key, item] of prev) {
    if (!curr.has(key)) {
      deltas.push({
        symbol: item.symbol,
        thesis: item.thesis,
        kind: "GONE",
        prevScore: item.discoveryScore,
        prevConfidence: item.confidence,
      });
    }
  }

  return deltas.sort((a, b) =>
    a.symbol !== b.symbol
      ? a.symbol < b.symbol
        ? -1
        : 1
      : a.thesis < b.thesis
        ? -1
        : a.thesis > b.thesis
          ? 1
          : 0,
  );
}
