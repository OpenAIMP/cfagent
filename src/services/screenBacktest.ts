/**
 * Issue #1122 (epic #1096 Phase 3) — backtest-on-screen: a
 * walk-forward, portfolio-level, options-aware backtest of any
 * screen result (the OddsMaker pattern, extended past its limits:
 * options-aware, portfolio-level, walk-forward).
 *
 * The caller supplies screen candidates and a price series per
 * symbol; the timeline is split into contiguous walk-forward folds.
 * In each fold every candidate is entered at the fold's first bar
 * and exited `holdingBars` bars later. Options candidates are
 * repriced at the exit bar ONLY by researchEconomics.valueAtHorizon
 * ( IV held at entry levels, time advanced by the holding period) —
 * this module contains no pricing engine of its own, and the Phase 3
 * tests pin that at the source level. Stock candidates settle on the
 * price series directly.
 *
 * Portfolio level: each fold splits `capital` equally across the
 * candidates it trades. Options contract counts are sized from the
 * capital at risk (contractual max loss per unit; entry cost when
 * max loss is unbounded/undefined); stocks take fractional-share
 * sizing on the allocation. Costs are netted per round trip from the
 * research config snapshot (fee + slippage per contract per side —
 * the researchEconomics cost idiom); equity trades use the same flat
 * per-trade figure, which is called out in the limitations.
 *
 * Honesty: every result carries its data provenance (the marketDataResearch
 * label set) and an explicit limitations list. A candidate without
 * enough history in a fold is EXCLUDED with a reason — its P&L is
 * never fabricated, interpolated, or carried from another fold.
 */

import type { MarketDataResearchProvenance } from "../types";
import {
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchConfig,
} from "./researchConfig";
import {
  valueAtHorizon,
  type StructureEconomics,
} from "./researchEconomics";

export interface PriceBar {
  /** YYYY-MM-DD (bars are consumed in the order supplied). */
  date: string;
  close: number;
}

export interface BacktestCandidate {
  symbol: string;
  kind: "stock" | "options";
  /** Required for options candidates: the priced structure from the pipeline/discovery. */
  economics?: StructureEconomics;
  /** Optional fixed contract count; when absent, contracts are sized from capital at risk. */
  contracts?: number;
}

export interface BacktestTrade {
  symbol: string;
  kind: "stock" | "options";
  entryDate: string;
  exitDate: string;
  entrySpot: number;
  exitSpot: number;
  /** Contracts for options trades (sized or supplied); null for stock trades. */
  contracts: number | null;
  /** Shares for stock trades (fractional, allocation / entry); null for options trades. */
  shares: number | null;
  grossPnl: number;
  costs: number;
  netPnl: number;
}

export interface BacktestExclusion {
  symbol: string;
  reason: string;
}

export interface BacktestFold {
  foldIndex: number;
  startDate: string | null;
  endDate: string | null;
  trades: BacktestTrade[];
  excluded: BacktestExclusion[];
  grossPnl: number;
  costs: number;
  netPnl: number;
  /** netPnl / capital for the fold. */
  returnPct: number;
}

export interface BacktestResult {
  provenance: MarketDataResearchProvenance;
  folds: BacktestFold[];
  aggregate: {
    totalTrades: number;
    totalNetPnl: number;
    totalReturnPct: number;
    /** Share of trades with netPnl > 0 (null when nothing traded). */
    winRate: number | null;
    /** Fold-end cumulative net P&L, one point per fold. */
    equityCurve: number[];
    maxDrawdown: number;
    maxDrawdownPct: number;
  };
  limitations: string[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

const BASE_LIMITATIONS: string[] = [
  "Options exits are Black-Scholes repricing at the horizon close with IV held at entry levels (constant IV, no IV path) via researchEconomics.valueAtHorizon.",
  "Fills are assumed at bar closes; intraday paths, bid/ask at exit, early assignment, and dividends are not modeled.",
  "Costs are the research config fee + slippage per contract, charged per side (round trip = 2 sides); options costs are modeled per contract, not per leg.",
  "Equity trades are charged the same flat per-trade cost figure as one options contract per side — a documented simplification.",
  "Walk-forward folds are contiguous calendar windows over the supplied series; candidates are re-entered each fold at the fold's first bar.",
];

/**
 * Backtest screen candidates walk-forward over supplied price series.
 * Pure and deterministic: no data is fetched and nothing is estimated
 * beyond the repricing rules stated in the limitations.
 */
export function backtestScreenCandidates(input: {
  candidates: BacktestCandidate[];
  prices: Record<string, PriceBar[]>;
  provenance: MarketDataResearchProvenance;
  config?: ResearchConfig;
  folds?: number;
  holdingBars?: number;
  capital?: number;
}): BacktestResult {
  const config = input.config ?? RESEARCH_CONFIG_DEFAULTS;
  const foldCount = Math.max(1, Math.floor(input.folds ?? 3));
  const holdingBars = Math.max(1, Math.floor(input.holdingBars ?? 10));
  const capital = input.capital ?? 100_000;
  const perSideCost = config.feePerContract + config.slippagePerContract;

  const limitations = [...BASE_LIMITATIONS];
  if (input.provenance !== "live") {
    limitations.push(
      `Price history provenance is "${input.provenance}", not live — results are indicative only and must not be presented as live-data backtests.`
    );
  }

  // Fold boundaries come from the longest supplied series, so folds
  // are calendar windows shared by every candidate.
  const longest = Object.values(input.prices).reduce<PriceBar[]>(
    (acc, series) => (series.length > acc.length ? series : acc),
    []
  );
  const foldSize = Math.max(1, Math.floor(longest.length / foldCount));

  const folds: BacktestFold[] = [];
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve: number[] = [];
  let totalTrades = 0;
  let winningTrades = 0;
  let totalNet = 0;

  for (let foldIndex = 0; foldIndex < foldCount; foldIndex++) {
    const foldStart = foldIndex * foldSize;
    const foldEndExclusive =
      foldIndex === foldCount - 1 ? longest.length : foldStart + foldSize;
    const trades: BacktestTrade[] = [];
    const excluded: BacktestExclusion[] = [];

    // First pass: determine which candidates can trade this fold, so
    // the fold's capital splits equally across actual trades only.
    const tradable: Array<{ candidate: BacktestCandidate; entryIdx: number; exitIdx: number }> = [];
    for (const candidate of input.candidates) {
      const series = input.prices[candidate.symbol] ?? [];
      const entryIdx = foldStart;
      const exitIdx = foldStart + holdingBars;
      if (series.length === 0) {
        excluded.push({ symbol: candidate.symbol, reason: "No price history supplied for this symbol; excluded, never fabricated." });
        continue;
      }
      // The exit bar must exist in this symbol's series AND fall
      // inside this fold's window (walk-forward: no peeking past the
      // fold boundary, no borrowing bars from a later fold).
      if (exitIdx >= series.length || exitIdx >= foldEndExclusive) {
        excluded.push({ symbol: candidate.symbol, reason: `Insufficient price history in fold ${foldIndex + 1}: exit bar ${exitIdx + 1} is outside the fold window or beyond the ${series.length} supplied bars.` });
        continue;
      }
      if (candidate.kind === "options" && !candidate.economics) {
        excluded.push({ symbol: candidate.symbol, reason: "Options candidate carries no priced economics (StructureEconomics); cannot be repriced honestly." });
        continue;
      }
      tradable.push({ candidate, entryIdx, exitIdx });
    }

    const allocation = tradable.length > 0 ? capital / tradable.length : 0;

    for (const { candidate, entryIdx, exitIdx } of tradable) {
      const series = input.prices[candidate.symbol];
      const entrySpot = series[entryIdx].close;
      const exitSpot = series[exitIdx].close;
      let grossPnl: number;
      let costs: number;
      let contracts: number | null = null;
      let shares: number | null = null;

      if (candidate.kind === "options") {
        const econ = candidate.economics!;
        const riskPerUnit =
          econ.maxLoss > 0 ? econ.maxLoss * 100 : Math.max((econ.netDebit - econ.netCredit) * 100, 1);
        contracts =
          candidate.contracts ?? Math.max(1, Math.floor(allocation / riskPerUnit));
        const pnlPerUnit = valueAtHorizon(
          econ.legs,
          econ.netDebit,
          econ.netCredit,
          exitSpot,
          0,
          holdingBars / 365,
          config.riskFreeRate,
          config.dividendYield
        );
        grossPnl = pnlPerUnit * 100 * contracts;
        costs = 2 * perSideCost * contracts;
      } else {
        shares = entrySpot > 0 ? allocation / entrySpot : 0;
        grossPnl = (exitSpot - entrySpot) * shares;
        costs = 2 * perSideCost;
      }

      const netPnl = grossPnl - costs;
      trades.push({
        symbol: candidate.symbol,
        kind: candidate.kind,
        entryDate: series[entryIdx].date,
        exitDate: series[exitIdx].date,
        entrySpot,
        exitSpot,
        contracts,
        shares,
        grossPnl: round2(grossPnl),
        costs: round2(costs),
        netPnl: round2(netPnl),
      });
      totalTrades++;
      if (netPnl > 0) winningTrades++;
    }

    const foldGross = trades.reduce((sum, t) => sum + t.grossPnl, 0);
    const foldCosts = trades.reduce((sum, t) => sum + t.costs, 0);
    const foldNet = trades.reduce((sum, t) => sum + t.netPnl, 0);
    totalNet += foldNet;
    cumulative += foldNet;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
    equityCurve.push(round2(cumulative));

    folds.push({
      foldIndex,
      startDate: longest[foldStart]?.date ?? null,
      endDate: longest[Math.min(foldEndExclusive, longest.length) - 1]?.date ?? null,
      trades,
      excluded,
      grossPnl: round2(foldGross),
      costs: round2(foldCosts),
      netPnl: round2(foldNet),
      returnPct: capital > 0 ? round4(foldNet / capital) : 0,
    });
  }

  if (totalTrades === 0) {
    limitations.push("No candidate had sufficient history to trade in any fold; the aggregate is empty, not zero-filled from other data.");
  }

  return {
    provenance: input.provenance,
    folds,
    aggregate: {
      totalTrades,
      totalNetPnl: round2(totalNet),
      totalReturnPct: capital > 0 ? round4(totalNet / capital) : 0,
      winRate: totalTrades > 0 ? round4(winningTrades / totalTrades) : null,
      equityCurve,
      maxDrawdown: round2(maxDrawdown),
      maxDrawdownPct: capital > 0 ? round4(maxDrawdown / capital) : 0,
    },
    limitations,
  };
}
