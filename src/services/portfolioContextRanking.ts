/**
 * Issue #17 (portfolio context, opt-in): existing positions as ranking
 * modifiers — and nothing else.
 *
 * Pure module, no I/O: the caller supplies the positions snapshot, this
 * module turns it into flags and applies them to a ranked list. The
 * thresholds are CONCENTRATION_POLICY's (issue #35/G2) — this module
 * invents no new numbers. The share basis is portfolio MARKET VALUE
 * (positions' marketValue), not the concentration report's delta
 * exposure; flag messages say so, so the two are never confused.
 *
 * Modifier semantics (settled 2026-10-25, no invented magnitude): a
 * stable partition. Flagged candidates rank below unflagged ones,
 * relative order preserved within each group. No score is rescaled,
 * nothing is filtered out, and turning the flag off restores the
 * original order exactly. Unknown-sector names bucket under "Unknown"
 * (same as the concentration report) and are never treated as
 * diversified by default.
 */

import { CONCENTRATION_POLICY } from "./portfolioConcentration";
import { sectorOf } from "./correlationService";

export interface PortfolioPositionInput {
  symbol: string;
  marketValue: number | null | undefined;
}

export type PortfolioContextFlagKind =
  | "held-concentration"
  | "sector-concentration";

export interface PortfolioContextFlag {
  kind: PortfolioContextFlagKind;
  symbol: string;
  /** Share of total portfolio market value, in percent. */
  sharePct: number;
  sector?: string;
  message: string;
}

/**
 * Flag every ranked-relevant name the book already concentrates in.
 * A symbol is flagged when its own value share reaches the policy's
 * material threshold, or when its sector reaches the policy's dominant
 * threshold. Empty, zero-total, and non-positive-value snapshots flag
 * nothing — an absent book is not a diversified book, it is no data.
 */
export function buildPortfolioFlags(
  positions: PortfolioPositionInput[]
): Map<string, PortfolioContextFlag[]> {
  const bySymbol = new Map<string, number>();
  let total = 0;
  for (const p of positions) {
    const value =
      typeof p.marketValue === "number" && Number.isFinite(p.marketValue)
        ? p.marketValue
        : 0;
    if (value <= 0) continue;
    const symbol = p.symbol.toUpperCase();
    bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + value);
    total += value;
  }

  const flags = new Map<string, PortfolioContextFlag[]>();
  if (total <= 0) return flags;

  const bySector = new Map<string, number>();
  for (const [symbol, value] of bySymbol) {
    const sector = sectorOf(symbol) ?? "Unknown";
    bySector.set(sector, (bySector.get(sector) ?? 0) + value);
  }

  for (const [symbol, value] of bySymbol) {
    const sharePct = (value / total) * 100;
    const symbolFlags: PortfolioContextFlag[] = [];
    if (sharePct >= CONCENTRATION_POLICY.materialSharePct) {
      symbolFlags.push({
        kind: "held-concentration",
        symbol,
        sharePct,
        message:
          `${symbol} already carries ${sharePct.toFixed(1)}% of portfolio ` +
          `market value — adding it concentrates further.`,
      });
    }
    const sector = sectorOf(symbol) ?? "Unknown";
    const sectorSharePct = ((bySector.get(sector) ?? 0) / total) * 100;
    if (sectorSharePct >= CONCENTRATION_POLICY.dominantSectorSharePct) {
      symbolFlags.push({
        kind: "sector-concentration",
        symbol,
        sharePct: sectorSharePct,
        sector,
        message:
          `${symbol} is in ${sector}, which already carries ` +
          `${sectorSharePct.toFixed(1)}% of portfolio market value.`,
      });
    }
    if (symbolFlags.length > 0) flags.set(symbol, symbolFlags);
  }
  return flags;
}

/**
 * Stable partition: unflagged candidates keep their order first,
 * flagged candidates keep theirs after. Returns a new array; the input
 * is never mutated. `demoted` lists flagged symbols in ranked order.
 */
export function applyPortfolioContextRanking<T extends { symbol: string }>(
  ranked: T[],
  flagsBySymbol: Map<string, PortfolioContextFlag[]>
): { ranked: T[]; demoted: string[] } {
  const unflagged: T[] = [];
  const flagged: T[] = [];
  const demoted: string[] = [];
  for (const item of ranked) {
    if (flagsBySymbol.has(item.symbol.toUpperCase())) {
      flagged.push(item);
      demoted.push(item.symbol);
    } else {
      unflagged.push(item);
    }
  }
  return { ranked: [...unflagged, ...flagged], demoted };
}
