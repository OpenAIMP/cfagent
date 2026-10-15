/**
 * Portfolio-level risk aggregation (issue #34, gap G1 — part of epic #32).
 *
 * Until now the platform's risk numbers were strictly per candidate / per
 * trade: positions synced from the broker were display-only, and no component
 * computed combined Delta/Theta/Vega or total defined max loss, so a set of
 * individually acceptable trades could be one concentrated bet with nothing
 * measuring it. This module is that missing aggregation step.
 *
 * Design discipline (mirrors the server strategy engine):
 *  - Deterministic: the pure aggregator takes a fully-resolved snapshot
 *    (positions + chain Greeks + betas + SPY price) and produces identical
 *    output for identical input. No randomness, no hidden I/O.
 *  - Honest partial coverage: a position that cannot be resolved (no
 *    contract detail in the source payload, no chain Greeks, no beta) is
 *    NEVER silently zeroed. It is listed in `excluded` (contributes nothing)
 *    or `partial` (contributes what is known), and totals that depend on
 *    missing inputs say so via coverage counts.
 *  - Beta source: the in-repo FOSS market universe (static per-symbol betas).
 *    Symbols outside that universe have unknown beta until a live beta source
 *    is wired in; they are flagged, not assumed to be 1.0.
 */

import type { ETradeOptionChain, ETradePosition } from "../types";
import type { ETradeService } from "./etrade";
import { FOSS_MARKET_UNIVERSE } from "./fossResearch";

/** Standard equity-options contract multiplier (shares per contract). */
export const OPTION_CONTRACT_MULTIPLIER = 100;

const round2 = (n: number): number => Number(n.toFixed(2));

export function signedQuantityOf(position: ETradePosition): number {
  if (position.positionType === "SHORT") return -Math.abs(position.quantity);
  if (position.positionType === "LONG") return Math.abs(position.quantity);
  return position.quantity;
}

export function isOptionPosition(position: ETradePosition): boolean {
  return position.securityType === "OPTN" || position.optionType !== undefined;
}

/** A position with every market input the aggregator needs, resolved. */
export interface ResolvedPosition {
  position: ETradePosition;
  kind: "equity" | "option";
  signedQuantity: number;
  /** Per-share reference price: market price for equities, underlying spot for options. */
  referencePrice: number;
  /** Per-share Greeks; equities use delta 1 and zero theta/vega/gamma. Null when unresolvable. */
  greeks: { delta: number; gamma: number; theta: number; vega: number } | null;
  greeksMissingReason?: string;
  /** Underlying beta (the symbol's own beta for equities). Null when unknown. */
  beta: number | null;
}

export interface PositionRiskRow {
  symbol: string;
  kind: "equity" | "option";
  signedQuantity: number;
  /** Delta expressed in shares of the underlying (signed). */
  deltaShares: number | null;
  deltaDollars: number | null;
  betaWeightedDeltaDollars: number | null;
  /** Beta-weighted delta expressed as an equivalent SPY share count. */
  betaWeightedSpyShares: number | null;
  /** Change in delta (shares) per $1 move in the underlying. */
  gammaSharesPerDollar: number | null;
  thetaDollarsPerDay: number | null;
  /** P&L change per +1.00 (100%) move in implied volatility is NOT used;
   *  this is per +0.01 (one vol point), the industry convention. */
  vegaDollarsPerVolPoint: number | null;
  /** Standalone defined max loss in dollars; null when not defined (see undefinedRiskPositions). */
  definedMaxLoss: number | null;
}

export interface PortfolioRiskTotals {
  deltaShares: number;
  deltaDollars: number;
  /** Null when no position in the book has a known beta. */
  betaWeightedDeltaDollars: number | null;
  betaWeightedSpyShares: number | null;
  gammaSharesPerDollar: number;
  thetaDollarsPerDay: number;
  vegaDollarsPerVolPoint: number;
  /** Sum over positions whose standalone max loss is defined. */
  definedMaxLoss: number;
  definedMaxLossPctOfNav: number | null;
  /** Positions whose beta is known / total positions contributing delta. */
  betaCoverage: { covered: number; total: number };
}

export interface PortfolioRiskReport {
  asOf: string;
  nav: number;
  spyPrice: number | null;
  totals: PortfolioRiskTotals;
  rows: PositionRiskRow[];
  /** Positions that contributed nothing, with the reason. */
  excluded: Array<{ symbol: string; reason: string }>;
  /** Positions that contributed partially (e.g. raw delta yes, beta-weighted no). */
  partial: Array<{ symbol: string; reason: string }>;
  /** Symbols with undefined standalone max risk (short options, short equity). */
  undefinedRiskPositions: string[];
}

export interface AggregateOptions {
  nav: number;
  spyPrice: number | null;
  asOf: string;
}

/**
 * Pure aggregation over a resolved snapshot. Identical input → identical
 * output; all monetary/share totals rounded to 2dp at the boundary.
 */
export function aggregatePortfolioRisk(resolved: ResolvedPosition[], opts: AggregateOptions): PortfolioRiskReport {
  const rows: PositionRiskRow[] = [];
  const excluded: PortfolioRiskReport["excluded"] = [];
  const partial: PortfolioRiskReport["partial"] = [];
  const undefinedRiskPositions: string[] = [];

  let deltaShares = 0;
  let deltaDollars = 0;
  let gammaSharesPerDollar = 0;
  let thetaDollarsPerDay = 0;
  let vegaDollarsPerVolPoint = 0;
  let definedMaxLoss = 0;
  let betaWeightedDeltaDollars = 0;
  let betaCovered = 0;
  let betaTotal = 0;

  for (const r of resolved) {
    const { position, kind, signedQuantity } = r;
    const symbol = position.symbol;

    if (!r.greeks) {
      excluded.push({ symbol, reason: r.greeksMissingReason ?? "Greeks unavailable for this position" });
      continue;
    }

    const multiplier = kind === "option" ? OPTION_CONTRACT_MULTIPLIER : 1;
    const rowDeltaShares = signedQuantity * multiplier * r.greeks.delta;
    const rowDeltaDollars = rowDeltaShares * r.referencePrice;
    const rowGamma = signedQuantity * multiplier * r.greeks.gamma;
    const rowTheta = signedQuantity * multiplier * r.greeks.theta;
    const rowVega = signedQuantity * multiplier * r.greeks.vega * 0.01;

    deltaShares += rowDeltaShares;
    deltaDollars += rowDeltaDollars;
    gammaSharesPerDollar += rowGamma;
    thetaDollarsPerDay += rowTheta;
    vegaDollarsPerVolPoint += rowVega;
    betaTotal += 1;

    let rowBetaWeighted: number | null = null;
    let rowSpyShares: number | null = null;
    if (r.beta !== null) {
      rowBetaWeighted = rowDeltaDollars * r.beta;
      betaWeightedDeltaDollars += rowBetaWeighted;
      betaCovered += 1;
      if (opts.spyPrice && opts.spyPrice > 0) {
        rowSpyShares = rowBetaWeighted / opts.spyPrice;
      }
    } else {
      partial.push({ symbol, reason: "No beta available for this symbol; excluded from beta-weighted totals" });
    }

    // Standalone defined max loss.
    let rowDefinedMaxLoss: number | null = null;
    if (kind === "option") {
      if (signedQuantity > 0) {
        // Long option: worst case is the premium paid (cost basis).
        rowDefinedMaxLoss = Math.abs(position.costBasis || 0);
      } else {
        undefinedRiskPositions.push(symbol);
      }
    } else if (signedQuantity > 0) {
      // Long equity: worst case is the position's market value (to zero).
      rowDefinedMaxLoss = Math.abs(position.marketValue || signedQuantity * r.referencePrice);
    } else {
      undefinedRiskPositions.push(symbol);
    }
    if (rowDefinedMaxLoss !== null) definedMaxLoss += rowDefinedMaxLoss;

    rows.push({
      symbol,
      kind,
      signedQuantity,
      deltaShares: round2(rowDeltaShares),
      deltaDollars: round2(rowDeltaDollars),
      betaWeightedDeltaDollars: rowBetaWeighted === null ? null : round2(rowBetaWeighted),
      betaWeightedSpyShares: rowSpyShares === null ? null : round2(rowSpyShares),
      gammaSharesPerDollar: round2(rowGamma),
      thetaDollarsPerDay: round2(rowTheta),
      vegaDollarsPerVolPoint: round2(rowVega),
      definedMaxLoss: rowDefinedMaxLoss === null ? null : round2(rowDefinedMaxLoss),
    });
  }

  const betaWeightedTotal = betaCovered > 0 ? round2(betaWeightedDeltaDollars) : null;
  return {
    asOf: opts.asOf,
    nav: opts.nav,
    spyPrice: opts.spyPrice,
    totals: {
      deltaShares: round2(deltaShares),
      deltaDollars: round2(deltaDollars),
      betaWeightedDeltaDollars: betaWeightedTotal,
      betaWeightedSpyShares:
        betaWeightedTotal !== null && opts.spyPrice && opts.spyPrice > 0 ? round2(betaWeightedTotal / opts.spyPrice) : null,
      gammaSharesPerDollar: round2(gammaSharesPerDollar),
      thetaDollarsPerDay: round2(thetaDollarsPerDay),
      vegaDollarsPerVolPoint: round2(vegaDollarsPerVolPoint),
      definedMaxLoss: round2(definedMaxLoss),
      definedMaxLossPctOfNav: opts.nav > 0 ? round2((definedMaxLoss / opts.nav) * 100) : null,
      betaCoverage: { covered: betaCovered, total: betaTotal },
    },
    rows,
    excluded,
    partial,
    undefinedRiskPositions,
  };
}

/** A candidate's Greek contribution, in the same units as PortfolioRiskTotals. */
export interface CandidateGreekContribution {
  deltaShares: number;
  deltaDollars: number;
  betaWeightedDeltaDollars: number | null;
  gammaSharesPerDollar: number;
  thetaDollarsPerDay: number;
  vegaDollarsPerVolPoint: number;
  /** Candidate's own defined max loss (0 when unknown/not applicable). */
  definedMaxLoss: number;
}

/**
 * Post-trade totals: what the portfolio looks like if a candidate (e.g. a
 * recommendation's net Greeks) is added. Beta-weighted post-trade totals are
 * null when either side lacks beta coverage for the contribution.
 */
export function evaluatePostTradeTotals(
  report: PortfolioRiskReport,
  candidate: CandidateGreekContribution,
): PortfolioRiskTotals {
  const t = report.totals;
  const betaWeighted =
    t.betaWeightedDeltaDollars !== null && candidate.betaWeightedDeltaDollars !== null
      ? round2(t.betaWeightedDeltaDollars + candidate.betaWeightedDeltaDollars)
      : null;
  const definedMaxLoss = round2(t.definedMaxLoss + candidate.definedMaxLoss);
  return {
    deltaShares: round2(t.deltaShares + candidate.deltaShares),
    deltaDollars: round2(t.deltaDollars + candidate.deltaDollars),
    betaWeightedDeltaDollars: betaWeighted,
    betaWeightedSpyShares:
      betaWeighted !== null && report.spyPrice && report.spyPrice > 0 ? round2(betaWeighted / report.spyPrice) : null,
    gammaSharesPerDollar: round2(t.gammaSharesPerDollar + candidate.gammaSharesPerDollar),
    thetaDollarsPerDay: round2(t.thetaDollarsPerDay + candidate.thetaDollarsPerDay),
    vegaDollarsPerVolPoint: round2(t.vegaDollarsPerVolPoint + candidate.vegaDollarsPerVolPoint),
    definedMaxLoss,
    definedMaxLossPctOfNav: report.nav > 0 ? round2((definedMaxLoss / report.nav) * 100) : null,
    betaCoverage: t.betaCoverage,
  };
}

// ---------------------------------------------------------------------------
// Snapshot resolution (I/O): positions + live chains + beta table → resolved
// ---------------------------------------------------------------------------

export function betaForSymbol(symbol: string): number | null {
  const profile = FOSS_MARKET_UNIVERSE[symbol.toUpperCase()];
  return profile && typeof profile.beta === "number" ? profile.beta : null;
}

function findContractGreeks(
  chain: ETradeOptionChain,
  position: ETradePosition,
): { delta: number; gamma: number; theta: number; vega: number; underlyingPrice: number } | null {
  for (const pair of chain.pairs) {
    const contract = position.optionType === "CALL" ? pair.call : pair.put;
    if (!contract) continue;
    if (Math.abs(contract.strikePrice - (position.strikePrice ?? NaN)) > 0.001) continue;
    if (contract.delta === undefined || contract.theta === undefined || contract.vega === undefined) return null;
    return {
      delta: contract.delta,
      gamma: contract.gamma ?? 0,
      theta: contract.theta,
      vega: contract.vega,
      underlyingPrice: chain.underlyingPrice,
    };
  }
  return null;
}

/**
 * Resolves a broker positions snapshot into aggregator inputs using live
 * E*TRADE chains for held option contracts. Positions that cannot be
 * resolved come back with greeks: null and a named reason — the aggregator
 * lists them under `excluded` rather than treating them as zero risk.
 */
export async function resolvePositionsSnapshot(
  etrade: ETradeService,
  positions: ETradePosition[],
): Promise<ResolvedPosition[]> {
  const chainCache = new Map<string, Promise<ETradeOptionChain | null>>();
  const chainFor = (symbol: string, expirationDate: string): Promise<ETradeOptionChain | null> => {
    const key = `${symbol}|${expirationDate}`;
    if (!chainCache.has(key)) {
      const [year, month, day] = expirationDate.split("-").map(Number);
      chainCache.set(key, etrade.getOptionChains({ symbol, expiryYear: year, expiryMonth: month, expiryDay: day }));
    }
    return chainCache.get(key)!;
  };

  const resolved: ResolvedPosition[] = [];
  for (const position of positions) {
    const signedQuantity = signedQuantityOf(position);
    const beta = betaForSymbol(position.symbol);
    if (!isOptionPosition(position)) {
      resolved.push({
        position,
        kind: "equity",
        signedQuantity,
        referencePrice: position.marketPrice || position.currentPrice || 0,
        greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 },
        beta,
      });
      continue;
    }
    if (!position.optionType || position.strikePrice === undefined || !position.expirationDate) {
      resolved.push({
        position,
        kind: "option",
        signedQuantity,
        referencePrice: 0,
        greeks: null,
        greeksMissingReason: "Option position without contract detail (strike/expiry/type not reported by the source payload)",
        beta,
      });
      continue;
    }
    const chain = await chainFor(position.symbol, position.expirationDate).catch(() => null);
    const contractGreeks = chain ? findContractGreeks(chain, position) : null;
    if (!contractGreeks) {
      resolved.push({
        position,
        kind: "option",
        signedQuantity,
        referencePrice: 0,
        greeks: null,
        greeksMissingReason: `No live chain Greeks for ${position.symbol} ${position.expirationDate} ${position.strikePrice} ${position.optionType}`,
        beta,
      });
      continue;
    }
    resolved.push({
      position,
      kind: "option",
      signedQuantity,
      referencePrice: contractGreeks.underlyingPrice,
      greeks: {
        delta: contractGreeks.delta,
        gamma: contractGreeks.gamma,
        theta: contractGreeks.theta,
        vega: contractGreeks.vega,
      },
      beta,
    });
  }
  return resolved;
}

/** Full pipeline used by the HTTP endpoint: fetch, resolve, aggregate. */
export async function computePortfolioRisk(etrade: ETradeService): Promise<PortfolioRiskReport> {
  const { account, positions } = await etrade.fetchPortfolioRemote(undefined, true);
  const nav = account.netAccountValue || account.totalAccountValue || 0;
  const resolved = await resolvePositionsSnapshot(etrade, positions);
  const spyChain = await etrade.getOptionChains({ symbol: "SPY" }).catch(() => null);
  const spyPrice = spyChain?.underlyingPrice ?? null;
  return aggregatePortfolioRisk(resolved, { nav, spyPrice, asOf: new Date().toISOString() });
}
