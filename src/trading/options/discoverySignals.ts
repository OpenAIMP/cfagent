/**
 * Discovery (issue #14) — name characterization + signal catalog v1.
 *
 * Pure: bars + IV stats + chain aggregates in, a feature vector and
 * the evaluated catalog out. No fetches, no stores — callers gather
 * inputs (daily bars, the #15 IV history store, a chain snapshot) and
 * hand them in, which keeps every rule fixture-testable.
 *
 * Honesty rules, mirroring the rest of the discovery design:
 *  - A feature that cannot be computed from the supplied inputs is
 *    null, never zero and never guessed; signals that need it abstain
 *    (fired: false) with the reason in their evidence line.
 *  - IV signals run in warming-up mode (Decision 3 on #13): a short
 *    IV history still produces rank/percentile values (#15 reports
 *    them qualified by its warmingUp flag), and the evidence line
 *    carries that qualification verbatim instead of hiding it.
 *  - Every signal — fired or not — carries a human-readable evidence
 *    line with the numbers that decided it. Later surfaces quote the
 *    fired lines as the setup's mandatory evidence.
 *
 * Thresholds all come from the discovery config section
 * (getDiscoveryConfig); nothing here hard-codes a bar.
 */

import type { EtapiDiscoveryConfig } from "../../config/etapiConfig";
import type { YahooDailyBar } from "../technicals";
import type { IvStats } from "./ivHistoryStore";
import type { EventCalendarInfo } from "./strategyEngine";

export type DiscoverySignalType =
  | "IV_EXPENSIVE"
  | "IV_CHEAP"
  | "TREND_UP"
  | "TREND_DOWN"
  | "RANGE_PINNED"
  | "BREAKOUT_WATCH"
  | "EVENT_NEAR"
  | "MOVE_UNDERPRICED"
  | "FLOW_BULLISH"
  | "FLOW_BEARISH"
  | "LIQUIDITY_OK";

/** Chain aggregates the characterization needs — computed by the
 *  caller from a snapshot so this module never touches contract
 *  types. atmIv is the snapshot's ATM IV when the caller derived one. */
export interface ChainAggregates {
  contractCount: number;
  totalOpenInterest: number;
  totalVolume: number;
  medianSpreadPct: number | null;
  atmIv: number | null;
}

export interface DiscoveryNameInputs {
  symbol: string;
  bars: readonly YahooDailyBar[];
  ivStats: IvStats | null;
  chain: ChainAggregates | null;
  /** Phase 2 (issue #18): the name's #16 event calendar, when the
   *  caller fetched one. Absent or uncovered, the event signals
   *  abstain — an unknown catalyst calendar is not "no catalyst". */
  eventCalendar?: EventCalendarInfo | null;
  /** Phase 2 (issue #18): the name's flow aggregates, built by
   *  flowAggregatesFromItems from flowService items. Absent, the
   *  FLOW_* signals abstain. */
  flow?: FlowAggregates | null;
}

/** The structural subset of a flowService LiveFlowItem the flow
 *  aggregator reads. */
export interface FlowItemLike {
  provenance: "chain-derived" | "static" | "generated";
  sentiment: "bullish" | "bearish" | "neutral";
  premium: number;
}

/** Directional flow premium over CHAIN-DERIVED records only.
 *
 *  THE GUARDRAIL (issue #18 acceptance): flowService merges live
 *  flow with seed rows (`static` fixtures, `generated` samples) to
 *  complete its leaderboards. Discovery signals must never read
 *  those rows — this aggregator filters on provenance BEFORE
 *  anything sums, and reports how much it excluded so the evidence
 *  line can say so. Seeded premium cannot fire a signal, tilt a
 *  share, or pad the record count. */
export interface FlowAggregates {
  bullishPremium: number;
  bearishPremium: number;
  /** Chain-derived records aggregated (all sentiments). */
  derivedCount: number;
  /** Records excluded by the provenance filter. */
  excludedCount: number;
}

export function flowAggregatesFromItems(items: readonly FlowItemLike[]): FlowAggregates {
  let bullishPremium = 0;
  let bearishPremium = 0;
  let derivedCount = 0;
  let excludedCount = 0;
  for (const item of items) {
    if (item.provenance !== "chain-derived") {
      excludedCount++;
      continue;
    }
    derivedCount++;
    if (item.sentiment === "bullish") bullishPremium += item.premium;
    else if (item.sentiment === "bearish") bearishPremium += item.premium;
  }
  return { bullishPremium, bearishPremium, derivedCount, excludedCount };
}

/** The per-name feature vector (spec §6.1), computed from inputs. */
export interface NameCharacterization {
  symbol: string;
  /** Last close, or null with no bars. */
  spot: number | null;
  smaFast: number | null;
  smaSlow: number | null;
  /** Return over the fast trend window, %. */
  returnFastPct: number | null;
  /** (max high − min low) / spot over the range window, %. */
  rangeWidthPct: number | null;
  /** Return over the range window, %. */
  rangeReturnPct: number | null;
  /** Highest high / lowest low over the breakout lookback, EXCLUDING
   *  the last bar (what "prior" means for a breakout). */
  priorHigh: number | null;
  priorLow: number | null;
  /** (priorHigh − spot) / priorHigh × 100 — positive while the close
   *  is below the prior high, negative once through it. */
  distanceToPriorHighPct: number | null;
  /** ATM IV: the chain's when present, else the IV store's latest. */
  atmIv: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  ivWarmingUp: boolean;
  ivObservations: number;
  liquidity: {
    totalOpenInterest: number;
    totalVolume: number;
    medianSpreadPct: number | null;
  } | null;
  contractCount: number;
  /** Phase 2 (issue #18): whether the #16 calendar covers this name
   *  at all (false = the event signals must abstain). */
  eventCovered: boolean;
  earningsDate: string | null;
  daysToEarnings: number | null;
  /** Annualized realized volatility (decimal) from close-to-close
   *  log returns over the slow trend window; null under 10 returns.
   *  The yardstick MOVE_UNDERPRICED measures the implied move
   *  against. */
  realizedVol: number | null;
  /** Phase 2 (issue #18): chain-derived flow aggregates for the
   *  name, or null when the caller supplied no flow data. */
  flow: FlowAggregates | null;
}

export interface DiscoverySignal {
  type: DiscoverySignalType;
  fired: boolean;
  /** The numbers that decided it, in one line. */
  evidence: string;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sma(closes: readonly number[], window: number): number | null {
  if (closes.length < window || window <= 0) return null;
  return mean(closes.slice(closes.length - window));
}

function windowReturnPct(closes: readonly number[], window: number): number | null {
  if (closes.length <= window) return null;
  const base = closes[closes.length - 1 - window];
  if (!(base > 0)) return null;
  return (closes[closes.length - 1] / base - 1) * 100;
}

/** Annualized realized volatility (decimal) from close-to-close log
 *  returns over the last `window` returns; null when the history is
 *  too short to mean anything. */
function realizedVolatility(closes: readonly number[], window: number): number | null {
  const usable = closes.slice(Math.max(0, closes.length - (window + 1)));
  const returns: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    if (usable[i] > 0 && usable[i - 1] > 0) returns.push(Math.log(usable[i] / usable[i - 1]));
  }
  if (returns.length < 10) return null;
  const m = mean(returns);
  const variance = returns.reduce((acc, r) => acc + (r - m) * (r - m), 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

export function characterizeName(
  inputs: DiscoveryNameInputs,
  config: EtapiDiscoveryConfig,
): NameCharacterization {
  const symbol = inputs.symbol.toUpperCase().trim();
  const bars = inputs.bars;
  const closes = bars.map((b) => b.close);
  const spot = closes.length > 0 ? closes[closes.length - 1] : null;

  const rangeBars = bars.slice(Math.max(0, bars.length - config.rangeWindowDays));
  let rangeWidthPct: number | null = null;
  if (spot !== null && spot > 0 && rangeBars.length >= 2) {
    const hi = Math.max(...rangeBars.map((b) => b.high));
    const lo = Math.min(...rangeBars.map((b) => b.low));
    rangeWidthPct = ((hi - lo) / spot) * 100;
  }

  // Prior high/low: the lookback bars before the last one.
  let priorHigh: number | null = null;
  let priorLow: number | null = null;
  if (bars.length >= 2) {
    const prior = bars.slice(Math.max(0, bars.length - 1 - config.breakoutLookbackDays), bars.length - 1);
    if (prior.length > 0) {
      priorHigh = Math.max(...prior.map((b) => b.high));
      priorLow = Math.min(...prior.map((b) => b.low));
    }
  }
  const distanceToPriorHighPct =
    spot !== null && priorHigh !== null && priorHigh > 0
      ? ((priorHigh - spot) / priorHigh) * 100
      : null;

  const iv = inputs.ivStats;
  return {
    symbol,
    spot,
    smaFast: sma(closes, config.trendFastWindow),
    smaSlow: sma(closes, config.trendSlowWindow),
    returnFastPct: windowReturnPct(closes, config.trendFastWindow),
    rangeWidthPct,
    rangeReturnPct: windowReturnPct(closes, config.rangeWindowDays),
    priorHigh,
    priorLow,
    distanceToPriorHighPct,
    atmIv: inputs.chain?.atmIv ?? iv?.latest?.atmIv ?? null,
    ivRank: iv?.ivRank ?? null,
    ivPercentile: iv?.ivPercentile ?? null,
    ivWarmingUp: iv?.warmingUp ?? false,
    ivObservations: iv?.observations ?? 0,
    liquidity:
      inputs.chain === null
        ? null
        : {
            totalOpenInterest: inputs.chain.totalOpenInterest,
            totalVolume: inputs.chain.totalVolume,
            medianSpreadPct: inputs.chain.medianSpreadPct,
          },
    contractCount: inputs.chain?.contractCount ?? 0,
    eventCovered: inputs.eventCalendar?.covered ?? false,
    earningsDate: inputs.eventCalendar?.earningsDate ?? null,
    daysToEarnings: inputs.eventCalendar?.daysToEarnings ?? null,
    realizedVol: realizedVolatility(closes, config.trendSlowWindow),
    flow: inputs.flow ?? null,
  };
}

function ivEvidence(c: NameCharacterization, config: EtapiDiscoveryConfig, kind: "expensive" | "cheap"): string {
  if (c.ivRank === null) {
    return c.ivObservations === 0
      ? `no IV history for ${c.symbol} — IV signals abstain`
      : `IV rank unavailable over ${c.ivObservations} observations — IV signals abstain`;
  }
  const threshold = kind === "expensive" ? config.ivExpensiveRank : config.ivCheapRank;
  const cmp = kind === "expensive" ? "≥" : "≤";
  const base = `IV rank ${fmt(c.ivRank, 0)} (${cmp} ${threshold} threshold) across ${c.ivObservations} observations`;
  return c.ivWarmingUp ? `${base} — warming up, interpret with care` : base;
}

export function detectSignals(
  c: NameCharacterization,
  config: EtapiDiscoveryConfig,
): DiscoverySignal[] {
  const signals: DiscoverySignal[] = [];

  // --- IV (warming-up mode: values fire, evidence qualifies) ---
  signals.push({
    type: "IV_EXPENSIVE",
    fired: c.ivRank !== null && c.ivRank >= config.ivExpensiveRank,
    evidence: ivEvidence(c, config, "expensive"),
  });
  signals.push({
    type: "IV_CHEAP",
    fired: c.ivRank !== null && c.ivRank <= config.ivCheapRank,
    evidence: ivEvidence(c, config, "cheap"),
  });

  // --- Trend (SMA alignment + fast-window return) ---
  const trendKnown = c.spot !== null && c.smaFast !== null && c.smaSlow !== null && c.returnFastPct !== null;
  const trendEvidence = trendKnown
    ? `close ${fmt(c.spot!)} vs SMA${config.trendFastWindow} ${fmt(c.smaFast!)} vs SMA${config.trendSlowWindow} ${fmt(c.smaSlow!)}; ${config.trendFastWindow}d return ${c.returnFastPct! >= 0 ? "+" : ""}${fmt(c.returnFastPct!)}%`
    : `insufficient price history for trend (needs ${config.trendSlowWindow} sessions)`;
  signals.push({
    type: "TREND_UP",
    fired:
      trendKnown &&
      c.spot! > c.smaFast! &&
      c.smaFast! > c.smaSlow! &&
      c.returnFastPct! >= config.trendMinReturnPct,
    evidence: trendEvidence,
  });
  signals.push({
    type: "TREND_DOWN",
    fired:
      trendKnown &&
      c.spot! < c.smaFast! &&
      c.smaFast! < c.smaSlow! &&
      c.returnFastPct! <= -config.trendMinReturnPct,
    evidence: trendEvidence,
  });

  // --- Range pinned (tight width, no drift) ---
  const rangeKnown = c.rangeWidthPct !== null && c.rangeReturnPct !== null;
  signals.push({
    type: "RANGE_PINNED",
    fired:
      rangeKnown &&
      c.rangeWidthPct! <= config.rangePinMaxWidthPct &&
      Math.abs(c.rangeReturnPct!) <= config.rangePinMaxDriftPct,
    evidence: rangeKnown
      ? `${config.rangeWindowDays}d range width ${fmt(c.rangeWidthPct!)}% (≤ ${config.rangePinMaxWidthPct}%) with drift ${c.rangeReturnPct! >= 0 ? "+" : ""}${fmt(c.rangeReturnPct!)}% (≤ ±${config.rangePinMaxDriftPct}%)`
      : `insufficient price history for range (${config.rangeWindowDays} sessions)`,
  });

  // --- Breakout watch (close at/below, but within proximity of, the prior high) ---
  const boKnown = c.distanceToPriorHighPct !== null && c.priorHigh !== null && c.spot !== null;
  signals.push({
    type: "BREAKOUT_WATCH",
    fired:
      boKnown && c.distanceToPriorHighPct! >= 0 && c.distanceToPriorHighPct! <= config.breakoutProximityPct,
    evidence: boKnown
      ? `close ${fmt(c.spot!)} sits ${fmt(c.distanceToPriorHighPct!)}% below the ${config.breakoutLookbackDays}d prior high ${fmt(c.priorHigh!)} (watch band ≤ ${config.breakoutProximityPct}%)`
      : "insufficient price history for breakout watch",
  });

  // --- Event proximity (Phase 2, #18): a covered calendar with
  // earnings inside the window makes the name earnings-adjacent —
  // the label rides this evidence line onto every setup card.
  const eventNear =
    c.eventCovered && c.daysToEarnings !== null && c.daysToEarnings >= 0 && c.daysToEarnings <= config.eventNearDays;
  signals.push({
    type: "EVENT_NEAR",
    fired: eventNear,
    evidence: !c.eventCovered
      ? `event calendar not covered for ${c.symbol} — EVENT_NEAR abstains`
      : c.daysToEarnings === null
        ? `no earnings scheduled on the covered calendar for ${c.symbol}`
        : eventNear
          ? `earnings-adjacent: earnings ${c.earningsDate} in ${c.daysToEarnings}d (≤ ${config.eventNearDays}d window)`
          : `earnings ${c.earningsDate} in ${c.daysToEarnings}d — outside the ${config.eventNearDays}d near window`,
  });

  // --- Move underpriced (Phase 2, #18): into a near event, the
  // implied move (ATM IV) is a small fraction of what the name
  // habitually delivers (realized vol). The horizon cancels in the
  // ratio (both scale by sqrt(days)), so the raw IV / realized-vol
  // ratio is the honest comparison. Never fires without the event:
  // a cheap move with no catalyst is just cheap options.
  const moveKnown = c.atmIv !== null && c.realizedVol !== null && c.realizedVol > 0;
  const moveRatio = moveKnown ? c.atmIv! / c.realizedVol! : null;
  signals.push({
    type: "MOVE_UNDERPRICED",
    fired: eventNear && moveRatio !== null && moveRatio <= config.moveUnderpricedMaxRatio,
    evidence: !eventNear
      ? "no near event — no catalyst for the move to be underpriced against"
      : !moveKnown
        ? "implied or realized volatility unavailable — MOVE_UNDERPRICED abstains"
        : `implied move (ATM IV ${fmt(c.atmIv! * 100, 0)}%) is ${fmt(moveRatio!, 2)}× the realized vol ${fmt(c.realizedVol! * 100, 0)}% (≤ ${config.moveUnderpricedMaxRatio}× = underpriced)`,
  });

  // --- Flow direction (Phase 2, #18): chain-derived records only
  // (the aggregator enforced it); one side must dominate the
  // directional premium across at least the minimum record count.
  // Flow confirms or opposes a view in inference — it is never a
  // view by itself, and the two sides are mutually exclusive by
  // construction (a share cannot be ≥ the dominance bar both ways).
  const flow = c.flow;
  const directionalPremium = flow ? flow.bullishPremium + flow.bearishPremium : 0;
  const bullShare = flow && directionalPremium > 0 ? flow.bullishPremium / directionalPremium : null;
  const flowKnown = flow !== null && flow.derivedCount >= config.flowMinRecords && bullShare !== null;
  const flowEvidence =
    flow === null
      ? `no flow data supplied for ${c.symbol} — FLOW signals abstain`
      : flow.derivedCount === 0
        ? `0 chain-derived flow records for ${c.symbol} (${flow.excludedCount} seeded rows excluded) — FLOW signals abstain`
        : `chain-derived flow over ${flow.derivedCount} records (${flow.excludedCount} seeded rows excluded): ` +
          `bullish $${Math.round(flow.bullishPremium).toLocaleString("en-US")} vs bearish $${Math.round(flow.bearishPremium).toLocaleString("en-US")}` +
          (bullShare !== null ? ` — bullish share ${fmt(bullShare, 2)} (dominance ≥ ${config.flowDominanceShare})` : "");
  signals.push({
    type: "FLOW_BULLISH",
    fired: flowKnown && bullShare! >= config.flowDominanceShare,
    evidence: flowEvidence,
  });
  signals.push({
    type: "FLOW_BEARISH",
    fired: flowKnown && bullShare! <= 1 - config.flowDominanceShare,
    evidence: flowEvidence,
  });

  // --- Liquidity gate ---
  if (c.liquidity === null) {
    signals.push({
      type: "LIQUIDITY_OK",
      fired: false,
      evidence: "no chain snapshot — liquidity unverified",
    });
  } else {
    const { totalOpenInterest, totalVolume, medianSpreadPct } = c.liquidity;
    const failures: string[] = [];
    if (totalOpenInterest < config.minOpenInterest) {
      failures.push(`open interest ${totalOpenInterest} < ${config.minOpenInterest}`);
    }
    if (totalVolume < config.minVolume) {
      failures.push(`volume ${totalVolume} < ${config.minVolume}`);
    }
    if (medianSpreadPct === null || medianSpreadPct > config.maxMedianSpreadPct) {
      failures.push(
        medianSpreadPct === null
          ? "median spread unavailable"
          : `median spread ${fmt(medianSpreadPct)}% > ${config.maxMedianSpreadPct}%`,
      );
    }
    signals.push({
      type: "LIQUIDITY_OK",
      fired: failures.length === 0,
      evidence:
        failures.length === 0
          ? `open interest ${totalOpenInterest}, volume ${totalVolume}, median spread ${fmt(medianSpreadPct!)}% — clears the liquidity gate`
          : `liquidity gate failed: ${failures.join("; ")}`,
    });
  }

  return signals;
}

/** The optionability pre-screen (spec §6.1): runs BEFORE any
 *  truncation so coverage counts stay honest — a name with no usable
 *  chain is screened out here, with the reason, and never reaches
 *  signal detection. */
export function prescreenOptionability(
  inputs: DiscoveryNameInputs,
  config: EtapiDiscoveryConfig,
): { optionable: boolean; reason: string } {
  if (inputs.chain === null) {
    return { optionable: false, reason: `no chain snapshot for ${inputs.symbol.toUpperCase().trim()}` };
  }
  if (inputs.chain.contractCount < config.minContractsForOptionable) {
    return {
      optionable: false,
      reason: `only ${inputs.chain.contractCount} contracts in chain (< ${config.minContractsForOptionable} minimum)`,
    };
  }
  return { optionable: true, reason: `${inputs.chain.contractCount} contracts in chain` };
}

/** The structural subset of a screened chain contract the
 *  aggregator reads (ScreenedOptionContractItem satisfies it). */
export interface ChainContractLike {
  strikePrice: number;
  openInterest?: number | null;
  volume?: number | null;
  spreadPct?: number | null;
  impliedVolatility?: number | null;
}

/** Aggregate one snapshot's contracts into the ChainAggregates the
 *  characterization consumes. The IV and spread aggregates stay
 *  null when no contract reports them — an absent aggregate is
 *  unknown, never invented; the totals follow the ChainAggregates
 *  contract (plain numbers, summing what is reported). The ATM IV
 *  is the IV of the contract whose strike is nearest the spot. */
export function chainAggregatesFromContracts(
  contracts: readonly ChainContractLike[],
  spot: number | null,
): ChainAggregates {
  const finite = (v: number | null | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v);
  const sum = (pick: (c: ChainContractLike) => number | null | undefined): number => {
    let total = 0;
    for (const c of contracts) {
      const v = pick(c);
      if (finite(v)) total += v;
    }
    return total;
  };
  const spreads = contracts.map((c) => c.spreadPct).filter(finite).sort((a, b) => a - b);
  const medianSpreadPct =
    spreads.length === 0
      ? null
      : spreads.length % 2 === 1
        ? spreads[(spreads.length - 1) / 2]
        : (spreads[spreads.length / 2 - 1] + spreads[spreads.length / 2]) / 2;
  let atmIv: number | null = null;
  if (spot !== null) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const c of contracts) {
      const iv = c.impliedVolatility;
      if (!finite(iv) || iv <= 0 || !finite(c.strikePrice)) continue;
      const distance = Math.abs(c.strikePrice - spot);
      if (distance < bestDistance) {
        bestDistance = distance;
        atmIv = iv;
      }
    }
  }
  return {
    contractCount: contracts.length,
    totalOpenInterest: sum((c) => c.openInterest),
    totalVolume: sum((c) => c.volume),
    medianSpreadPct,
    atmIv,
  };
}
