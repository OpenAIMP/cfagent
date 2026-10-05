import type { ScreenedOptionContractItem } from "../../types";
import { defaultRegistry, buildNameLedger } from "./strategies/catalog";
import { contractKey, MULTIPLIER } from "./strategies/legs";
import { EvaluationLedger, runAcceptanceRules } from "./strategies/ledger";
import type { ChainView, NameLedgerEntry, StrategyContext, StrategyDefinition, StrategyEvaluation } from "./strategies/types";

export { contractKey };

export type OptionThesis = "bullish" | "bearish" | "range_bound" | "large_move";
export type ExpectedIvDirection = "rise" | "unchanged" | "fall";
export type OptionStrategyType = string;

export interface StrategyRequest {
  symbol: string;
  thesis: OptionThesis;
  targetPrice: number;
  targetDate: string;
  expectedIvDirection: ExpectedIvDirection;
  maxPlannedLoss: number;
  minRewardRisk: number;
  minDte?: number;
  maxDte?: number;
    minVolume?: number; // User-visible option-screen thresholds
    minOpenInterest?: number; // User-visible option-screen thresholds
    maxSpreadPct?: number; // User-visible option-screen thresholds
    maxQuoteAgeSeconds?: number; // User-visible option-screen thresholds
    contractLimit?: number; // User-visible option-screen thresholds
    candidateLimit?: number; // User-visible option-screen thresholds
      maxStrikesPerSide?: number; // User-visible option-screen thresholds
      maxIronCondors?: number; // User-visible option-screen thresholds
  allowedStrategies: OptionStrategyType[];
  eventPolicy?: "warn" | "exclude";
  riskFreeRate?: number;
  dividendYield?: number;
  feesPerContract?: number;
}

export interface StrategyLeg {
  symbol: string;
  optionType: "CALL" | "PUT" | "STOCK";
  side: "BUY" | "SELL";
  quantity: number;
  strike: number;
  expirationDate: string;
  daysToExpiration?: number;
  entryPrice: number;
  bid: number;
  ask: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  openInterest: number;
  volume: number;
  spreadPct: number;
  quoteTimestamp: string;
  quoteAgeSeconds?: number;
  quoteFreshness: "FRESH" | "STALE" | "UNKNOWN";
  multiplier: number;
}

export interface StrategyScenario {
  underlyingPrice: number;
  daysToExpiry: number;
  ivChangePct: number;
  pnl: number;
}

export interface StrategyScoreBreakdown {
  thesisAlignment: number;
  targetRewardRisk: number;
  liquidity: number;
  volatilityAlignment: number;
  thetaBurden: number;
  freshness: number;
  weights: Record<"thesisAlignment" | "targetRewardRisk" | "liquidity" | "volatilityAlignment" | "thetaBurden" | "freshness", number>;
}

export interface StrategyCandidate {
  id: string;
  rank: number;
  type: OptionStrategyType;
  label: string;
  symbol: string;
  underlyingPrice: number;
  expirationDate: string;
  dataFreshness: "FRESH" | "STALE" | "UNKNOWN";
  legs: StrategyLeg[];
  netDebit: number;
  estimatedFees: number;
  maxProfit: number | null;
  maxProfitUnbounded: boolean;
  maxLoss: number;
  breakevens: number[];
  targetPnl: number;
  targetRewardRisk: number;
  modelImpliedProbabilityOfProfit: number;
  netGreeks: { delta: number; gamma: number; theta: number; vega: number };
  liquidityScore: number;
  score: number;
  scoreBreakdown: StrategyScoreBreakdown;
  payoffCurve: Array<{ underlyingPrice: number; pnl: number }>;
  scenarios: StrategyScenario[];
  explanations: string[];
  warnings: string[];
  assumptions: string[];
}

export interface StrategyRecommendationResult {
  status: "ranked_candidates" | "no_candidates";
  request: StrategyRequest;
  generatedAt: string;
  modelVersion: string;
  dataSource: string;
  assumptions: string[];
  scoreWeights: StrategyScoreBreakdown["weights"];
  candidates: StrategyCandidate[];
  excluded: Array<{ reason: string; count: number }>;
  evaluations: StrategyEvaluation[];
  nameLedger: NameLedgerEntry[];
}

const DEFAULT_RATE = 0.04;
const DEFAULT_FEE_PER_CONTRACT = 0.65;
const DEFAULT_MAX_COMBINATIONS = 150;
const DETAIL_LIMIT = 50;
const MAX_LEGS = 6;
const SCORE_WEIGHTS: StrategyScoreBreakdown["weights"] = {
  thesisAlignment: 0.30,
  targetRewardRisk: 0.20,
  liquidity: 0.20,
  volatilityAlignment: 0.10,
  thetaBurden: 0.05,
  freshness: 0.15,
};

export const ALL_STRATEGY_TYPES: OptionStrategyType[] = defaultRegistry.ids();

export function strategyLabel(type: OptionStrategyType): string {
  return defaultRegistry.get(type)?.label ?? type;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function netDebit(legs: StrategyLeg[], fees: number): number {
  const signedEntry = legs.reduce((sum, leg) => {
    const sign = leg.side === "BUY" ? 1 : -1;
    return sum + sign * leg.entryPrice * leg.quantity * leg.multiplier;
  }, 0);
  return signedEntry + fees;
}

function sideSign(leg: StrategyLeg): number {
  return leg.side === "BUY" ? 1 : -1;
}

/** Days until the earliest option leg expires; the payoff horizon for single- and multi-expiry structures. */
function horizonDays(legs: StrategyLeg[]): number {
  const days = legs.filter((leg) => leg.optionType !== "STOCK").map((leg) => leg.daysToExpiration ?? 0);
  return days.length ? Math.min(...days) : 0;
}

function legValue(leg: StrategyLeg, spot: number, elapsedDays: number, rate: number, dividend: number, ivMultiplier: number): number {
  if (leg.optionType === "STOCK") return spot;
  const remaining = Math.max(0, (leg.daysToExpiration ?? 0) - elapsedDays);
  return blackScholes(leg, spot, remaining, rate, dividend, leg.impliedVolatility * ivMultiplier);
}

/** P/L at the nearest expiry; later-dated legs are valued with Black-Scholes. */
function expiryPnl(legs: StrategyLeg[], spot: number, fees: number, rate = DEFAULT_RATE, dividend = 0): number {
  const elapsed = horizonDays(legs);
  const value = legs.reduce((sum, leg) =>
    sum + sideSign(leg) * leg.quantity * leg.multiplier * legValue(leg, spot, elapsed, rate, dividend, 1), 0);
  return value - netDebit(legs, fees);
}

function riskProfile(legs: StrategyLeg[], fees: number, underlyingPrice: number, rate: number, dividend: number) {
  const optionLegs = legs.filter((leg) => leg.optionType !== "STOCK");
  const strikes = Array.from(new Set(optionLegs.map((leg) => leg.strike))).sort((a, b) => a - b);
  const upper = Math.max(underlyingPrice * 2, (strikes[strikes.length - 1] || underlyingPrice) * 2, 1);
  const horizon = horizonDays(legs);
  const curved = optionLegs.some((leg) => (leg.daysToExpiration ?? 0) > horizon);
  const grid = curved ? Array.from({ length: 119 }, (_, index) => (upper * (index + 1)) / 120) : [];
  const points = Array.from(new Set([0, ...strikes, ...grid, upper])).sort((a, b) => a - b);
  const values = points.map((spot) => ({ spot, pnl: expiryPnl(legs, spot, fees, rate, dividend) }));
  const callSlope = legs.reduce((sum, leg) => {
    if (leg.optionType === "PUT") return sum;
    return sum + sideSign(leg) * leg.quantity * leg.multiplier;
  }, 0);
  const pnls = values.map((point) => point.pnl);
  const flat = Math.max(...pnls) - Math.min(...pnls) < 0.01;
  const maxLoss = callSlope < 0 ? Infinity : Math.max(0, -Math.min(...pnls));
  const maxProfitUnbounded = callSlope > 0;
  const maxProfit = maxProfitUnbounded ? null : Math.max(0, ...pnls);
  const breakevens: number[] = [];

  for (let index = 0; index < values.length - 1; index++) {
    const left = values[index];
    const right = values[index + 1];
    if (left.pnl === 0) breakevens.push(left.spot);
    if ((left.pnl < 0 && right.pnl > 0) || (left.pnl > 0 && right.pnl < 0)) {
      breakevens.push(left.spot + ((-left.pnl) * (right.spot - left.spot)) / (right.pnl - left.pnl));
    }
  }
  const last = values[values.length - 1];
  if (last.pnl === 0) breakevens.push(last.spot);
  else if (callSlope !== 0) {
    const tailRoot = last.spot - last.pnl / callSlope;
    if (tailRoot > last.spot) breakevens.push(tailRoot);
  }

  return {
    maxLoss,
    maxProfit,
    maxProfitUnbounded,
    flat,
    breakevens: Array.from(new Set(breakevens.map((point) => Number(point.toFixed(2))))).sort((a, b) => a - b),
  };
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function terminalPriceCdf(spot: number, underlying: number, dte: number, rate: number, dividend: number, volatility: number): number {
  if (spot <= 0) return 0;
  if (!Number.isFinite(spot)) return 1;
  const time = dte / 365;
  if (time <= 0 || volatility <= 0) return spot >= underlying ? 1 : 0;
  const z = (Math.log(spot / underlying) - (rate - dividend - volatility * volatility / 2) * time) / (volatility * Math.sqrt(time));
  return normalCdf(z);
}

function impliedProbabilityOfProfit(
  legs: StrategyLeg[],
  breakEvenPoints: number[],
  underlying: number,
  fees: number,
  rate: number,
  dividend: number
): number {
  const dte = horizonDays(legs);
  if (dte <= 0) return expiryPnl(legs, underlying, fees, rate, dividend) > 0 ? 1 : 0;
  const optionLegs = legs.filter((leg) => leg.optionType !== "STOCK");
  const volatility = optionLegs.reduce((sum, leg) => sum + leg.impliedVolatility, 0) / Math.max(1, optionLegs.length);
  const boundaries = [0, ...breakEvenPoints.filter((point) => point > 0), Infinity].sort((a, b) => a - b);
  let probability = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const lower = boundaries[index];
    const upper = boundaries[index + 1];
    const testSpot = Number.isFinite(upper)
      ? (lower + upper) / 2
      : lower + Math.max(underlying, 1);
    if (expiryPnl(legs, testSpot, fees, rate, dividend) > 0) {
      probability += terminalPriceCdf(upper, underlying, dte, rate, dividend, volatility) -
        terminalPriceCdf(lower, underlying, dte, rate, dividend, volatility);
    }
  }
  return clamp(probability, 0, 1);
}

function blackScholes(leg: StrategyLeg, spot: number, daysToExpiry: number, rate: number, dividend: number, iv: number): number {
  if (daysToExpiry <= 0 || iv <= 0 || spot <= 0) {
    return leg.optionType === "CALL" ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0);
  }
  const time = daysToExpiry / 365;
  const volatility = Math.max(0.001, iv);
  const rootTime = Math.sqrt(time);
  const d1 = (Math.log(spot / leg.strike) + (rate - dividend + volatility * volatility / 2) * time) / (volatility * rootTime);
  const d2 = d1 - volatility * rootTime;
  if (leg.optionType === "CALL") {
    return spot * Math.exp(-dividend * time) * normalCdf(d1) - leg.strike * Math.exp(-rate * time) * normalCdf(d2);
  }
  return leg.strike * Math.exp(-rate * time) * normalCdf(-d2) - spot * Math.exp(-dividend * time) * normalCdf(-d1);
}

function modeledPnl(
  legs: StrategyLeg[],
  spot: number,
  elapsedDays: number,
  fees: number,
  rate: number,
  dividend: number,
  ivMultiplier: number
): number {
  const value = legs.reduce((sum, leg) =>
    sum + sideSign(leg) * leg.quantity * leg.multiplier * legValue(leg, spot, elapsedDays, rate, dividend, ivMultiplier), 0);
  return value - netDebit(legs, fees);
}

function daysUntil(date: string): number {
  const target = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(target.getTime())) throw new Error("targetDate must be an ISO date");
  return Math.max(0, Math.ceil((target.getTime() - Date.now()) / 86_400_000));
}

function makeScenarioGrid(
  legs: StrategyLeg[],
  underlying: number,
  dte: number,
  targetDays: number,
  fees: number,
  rate: number,
  dividend: number
): StrategyScenario[] {
  const priceShocks = [-0.2, -0.1, 0, 0.1, 0.2];
  const ivShocks = [-0.3, -0.15, 0, 0.15, 0.3];
  const dates = Array.from(new Set([0, 7, 14, Math.min(targetDays, dte), dte])).sort((a, b) => a - b);
  return dates.flatMap((elapsedDays) => priceShocks.flatMap((priceShock) => ivShocks.map((ivShock) => {
    const remaining = Math.max(0, dte - elapsedDays);
    return {
      underlyingPrice: Number((underlying * (1 + priceShock)).toFixed(2)),
      daysToExpiry: remaining,
      ivChangePct: ivShock * 100,
      pnl: Number(modeledPnl(
        legs,
        underlying * (1 + priceShock),
        Math.min(elapsedDays, dte),
        fees,
        rate,
        dividend,
        1 + ivShock
      ).toFixed(2)),
    };
  })));
}

type BuildOutcome = { candidate: StrategyCandidate } | { reason: string };

function buildCandidate(
  def: StrategyDefinition,
  legs: StrategyLeg[],
  contractMap: Map<string, ScreenedOptionContractItem>,
  request: StrategyRequest,
  targetDays: number
): BuildOutcome {
  const label = def.label;
  if (legs.length < 1 || legs.length > MAX_LEGS) return { reason: `${label} has an unsupported number of legs (${legs.length})` };
  const optionLegs = legs.filter((leg) => leg.optionType !== "STOCK");
  if (optionLegs.some((leg) => !leg.entryPrice || leg.entryPrice <= 0)) {
    return { reason: `${label} has incomplete or unsupported contract data (a leg has no usable bid/ask)` };
  }
  if (optionLegs.some((leg) => leg.impliedVolatility <= 0)) {
    return { reason: `${label} has incomplete or unsupported contract data (a leg has no implied volatility)` };
  }

  const contracts = optionLegs.map((leg) => contractMap.get(leg.symbol)).filter((item): item is ScreenedOptionContractItem => Boolean(item));
  if (contracts.length !== optionLegs.length || contracts.length === 0) {
    return { reason: `${label} has incomplete or unsupported contract data (leg not found in the chain)` };
  }
  const freshnessStates = contracts.map((contract) => contract.quoteFreshness || "UNKNOWN");
  const dataFreshness = freshnessStates.includes("STALE")
    ? "STALE" as const
    : freshnessStates.includes("UNKNOWN") ? "UNKNOWN" as const : "FRESH" as const;
  const underlying = contracts[0].underlyingPrice;
  const dte = horizonDays(legs);
  const feePerContract = request.feesPerContract ?? DEFAULT_FEE_PER_CONTRACT;
  const fees = optionLegs.reduce((sum, leg) => sum + leg.quantity * feePerContract, 0);
  const debit = netDebit(legs, fees);
  const rate = request.riskFreeRate ?? DEFAULT_RATE;
  const dividend = request.dividendYield ?? 0;
  const risk = riskProfile(legs, fees, underlying, rate, dividend);
  if (risk.flat) {
    const locked = expiryPnl(legs, underlying, fees, rate, dividend);
    return {
      reason: locked > 0
        ? `${label} shows an apparent riskless profit of $${locked.toFixed(2)}; this almost always means stale/crossed quotes or ignored carry, dividends, borrow and assignment risk`
        : `${label} has a locked payoff (constant $${locked.toFixed(2)} at every price): it only expresses a financing/carry rate, not a trade thesis`,
    };
  }
  if (!Number.isFinite(risk.maxLoss)) {
    return { reason: `${label} has unlimited loss potential (net short upside exposure) and is excluded from defined-risk ranking` };
  }
  if (risk.maxLoss <= 0) return { reason: `${label} shows no modeled downside, which indicates stale or crossed quotes` };
  if (request.eventPolicy === "exclude") return { reason: `${label} withheld because event risk cannot be verified` };

  const targetElapsed = Math.min(targetDays, dte);
  const ivMultiplier = request.expectedIvDirection === "rise" ? 1.15 : request.expectedIvDirection === "fall" ? 0.85 : 1;
  const targetPnl = modeledPnl(legs, request.targetPrice, targetElapsed, fees, rate, dividend, ivMultiplier);
  const targetRewardRisk = targetPnl / risk.maxLoss;
  const modelImpliedProbabilityOfProfit = impliedProbabilityOfProfit(legs, risk.breakevens, underlying, fees, rate, dividend);
  const aligned = def.theses.includes(request.thesis);
  const thesisAlignment = targetPnl > 0 && aligned
    ? clamp(50 + 25 * Math.log2(1 + Math.max(0, targetRewardRisk)))
    : aligned ? clamp(25 + targetRewardRisk * 10) : 10;
  const liquidityScore = contracts.reduce((sum, contract) => {
    const spread = clamp(100 - contract.spreadPct * 5);
    const activity = clamp(40 + 12 * Math.log10(Math.max(1, contract.volume ?? 0)) + 8 * Math.log10(Math.max(1, contract.openInterest ?? 0)));
    return sum + (spread * 0.7 + activity * 0.3) / contracts.length;
  }, 0);
  const netVega = legs.reduce((sum, leg) => sum + sideSign(leg) * leg.vega * leg.multiplier * leg.quantity, 0);
  const volatilityAlignment = request.expectedIvDirection === "unchanged"
    ? 70
    : (request.expectedIvDirection === "rise" ? netVega : -netVega) >= 0 ? 100 : 20;
  const netTheta = legs.reduce((sum, leg) => sum + sideSign(leg) * leg.theta * leg.multiplier * leg.quantity, 0);
  const thetaBurden = clamp(100 - Math.max(0, -netTheta) / Math.max(1, risk.maxLoss) * 10_000);
  const freshness = dataFreshness === "FRESH" ? 100 : dataFreshness === "STALE" ? 25 : 0;
  const rewardRiskScore = clamp(targetRewardRisk / Math.max(request.minRewardRisk, 0.25) * 70);
  const scoreBreakdown: StrategyScoreBreakdown = {
    thesisAlignment,
    targetRewardRisk: rewardRiskScore,
    liquidity: liquidityScore,
    volatilityAlignment,
    thetaBurden,
    freshness,
    weights: SCORE_WEIGHTS,
  };
  const score = Object.entries(SCORE_WEIGHTS).reduce((sum, [key, weight]) =>
    sum + scoreBreakdown[key as keyof typeof SCORE_WEIGHTS] * weight, 0);
  const warnings = [
    "Pre-expiry P/L is a Black-Scholes estimate, not a forecast or executable quote.",
    "Earnings and dividend dates are not connected; event risk is unverified.",
    "Early exercise, assignment, margin, and execution slippage are not modeled.",
  ];
  if (def.usesStock) {
    const shares = legs.find((leg) => leg.optionType === "STOCK")?.quantity ?? 0;
    warnings.unshift(`Includes ${shares} hypothetical shares at $${underlying.toFixed(2)}; verify actual holdings, margin and borrow availability.`);
  }
  if (def.multiExpiry) {
    warnings.unshift("Multi-expiry structure: payoff is shown at the nearest expiry with later legs valued by Black-Scholes; results are sensitive to the IV assumption.");
  }
  if (dataFreshness === "STALE") {
    const age = Math.max(...contracts.map((contract) => contract.quoteAgeSeconds ?? 0));
    warnings.unshift(`Stale quote data: oldest leg is ${Math.round(age).toLocaleString()}s old. Candidate is indicative research only.`);
  } else if (dataFreshness === "UNKNOWN") {
    warnings.unshift("Quote timestamp is unavailable for at least one leg. Freshness cannot be verified; research only.");
  }

  const explanations = [
    `${label} matches the ${request.thesis.replaceAll("_", " ")} thesis. ${def.description}`,
    `Conservative entry uses asks for buys and bids for sells; estimated fees are $${fees.toFixed(2)}.`,
    `Target-date modeled P/L is $${targetPnl.toFixed(2)} (${targetRewardRisk.toFixed(2)}x max loss).`,
  ];
  const nearest = optionLegs.reduce((best, leg) => ((leg.daysToExpiration ?? 0) < (best.daysToExpiration ?? 0) ? leg : best), optionLegs[0]);

  return {
    candidate: {
      id: `${def.id}:${legs.map((leg) => leg.symbol).join("+")}`,
      rank: 0,
      type: def.id,
      label,
      symbol: request.symbol.toUpperCase(),
      underlyingPrice: underlying,
      expirationDate: nearest.expirationDate,
      dataFreshness,
      legs,
      netDebit: Number(debit.toFixed(2)),
      estimatedFees: Number(fees.toFixed(2)),
      maxProfit: risk.maxProfit === null ? null : Number(risk.maxProfit.toFixed(2)),
      maxProfitUnbounded: risk.maxProfitUnbounded,
      maxLoss: Number(risk.maxLoss.toFixed(2)),
      breakevens: risk.breakevens,
      targetPnl: Number(targetPnl.toFixed(2)),
      targetRewardRisk: Number(targetRewardRisk.toFixed(2)),
      modelImpliedProbabilityOfProfit: Number(modelImpliedProbabilityOfProfit.toFixed(4)),
      netGreeks: {
        delta: legs.reduce((sum, leg) => sum + sideSign(leg) * leg.delta * leg.multiplier * leg.quantity, 0),
        gamma: legs.reduce((sum, leg) => sum + sideSign(leg) * leg.gamma * leg.multiplier * leg.quantity, 0),
        theta: netTheta,
        vega: netVega,
      },
      liquidityScore: Number(liquidityScore.toFixed(1)),
      score: Number(score.toFixed(1)),
      scoreBreakdown,
      payoffCurve: [],
      scenarios: [],
      explanations,
      warnings,
      assumptions: [
        `Risk-free rate ${(rate * 100).toFixed(2)}%; dividend yield ${(dividend * 100).toFixed(2)}%.`,
        `Multiplier ${MULTIPLIER}; ${feePerContract} estimated fees per option contract.`,
        `Option marks use conservative bid/ask-side entry; scenario marks use Black-Scholes.`,
      ],
    },
  };
}

/** Payoff curve and scenario grid are costly, so they are computed only for the candidates that are returned. */
function attachDetail(candidate: StrategyCandidate, request: StrategyRequest, targetDays: number): StrategyCandidate {
  const rate = request.riskFreeRate ?? DEFAULT_RATE;
  const dividend = request.dividendYield ?? 0;
  const underlying = candidate.underlyingPrice;
  const fees = candidate.estimatedFees;
  // Strikes and breakevens are included so the kinks of the payoff line are exact.
  const keyPoints = [...candidate.breakevens, ...candidate.legs.filter((leg) => leg.optionType !== "STOCK").map((leg) => leg.strike)]
    .filter((price) => price >= underlying * 0.5 && price <= underlying * 1.5);
  const priceRange = Array.from(new Set([
    ...Array.from({ length: 41 }, (_, index) => Number((underlying * (0.5 + index * 0.025)).toFixed(2))),
    ...keyPoints.map((price) => Number(price.toFixed(2))),
  ])).sort((a, b) => a - b);
  return {
    ...candidate,
    payoffCurve: priceRange.map((spot) => ({
      underlyingPrice: Number(spot.toFixed(2)),
      pnl: Number(expiryPnl(candidate.legs, spot, fees, rate, dividend).toFixed(2)),
    })),
    scenarios: makeScenarioGrid(candidate.legs, underlying, horizonDays(candidate.legs), targetDays, fees, rate, dividend),
  };
}

function addRejected(reasons: Map<string, number>, reason: string): void {
  reasons.set(reason, (reasons.get(reason) || 0) + 1);
}

export function recommendOptionStrategies(
  contracts: ScreenedOptionContractItem[],
  request: StrategyRequest,
  limit?: number
): StrategyRecommendationResult {
  if (!request.symbol.trim()) throw new Error("symbol is required");
  if (!Number.isFinite(request.targetPrice) || request.targetPrice <= 0) throw new Error("targetPrice must be positive");
  if (!Number.isFinite(request.maxPlannedLoss) || request.maxPlannedLoss <= 0) throw new Error("maxPlannedLoss must be positive");
  if (!Number.isFinite(request.minRewardRisk) || request.minRewardRisk < 0) throw new Error("minRewardRisk must be non-negative");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("candidate limit must be a positive whole number");
  if (request.maxStrikesPerSide !== undefined && (!Number.isInteger(request.maxStrikesPerSide) || request.maxStrikesPerSide < 1)) throw new Error("maxStrikesPerSide must be a positive whole number");
  if (request.maxIronCondors !== undefined && (!Number.isInteger(request.maxIronCondors) || request.maxIronCondors < 0)) throw new Error("maxIronCondors must be a non-negative whole number");
  const minDte = request.minDte ?? 0;
  const maxDte = request.maxDte ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(minDte) || minDte < 0 || !Number.isInteger(maxDte) || maxDte < minDte) {
    throw new Error("DTE range must use whole days with a maximum greater than or equal to minimum");
  }
  const registry = defaultRegistry;
  const ledger = new EvaluationLedger(registry.list());
  const wanted = new Set(registry.resolveMany(request.allowedStrategies).ids);
  const finish = (partial: Omit<StrategyRecommendationResult, "evaluations" | "nameLedger">): StrategyRecommendationResult => {
    const evaluations = ledger.report();
    return { ...partial, evaluations, nameLedger: buildNameLedger(evaluations) };
  };

  if (request.eventPolicy === "exclude") {
    registry.list().forEach((def) => ledger.onSkipped(def, "Skipped: event-risk exclusion cannot be verified without an event calendar."));
    return finish({
      status: "no_candidates",
      request,
      generatedAt: new Date().toISOString(),
      modelVersion: "options-risk-v2",
      dataSource: "E*TRADE option-chain snapshot",
      assumptions: ["Candidates were withheld because earnings/dividend calendar verification is unavailable."],
      scoreWeights: SCORE_WEIGHTS,
      candidates: [],
      excluded: [{ reason: "Event-risk exclusion cannot be verified without an event calendar", count: contracts.length }],
    });
  }
  const targetDays = daysUntil(request.targetDate);
  const normalized = contracts.filter((contract) =>
    contract.underlyingSymbol.toUpperCase() === request.symbol.toUpperCase() &&
    contract.daysToExpiration >= minDte && contract.daysToExpiration <= maxDte
  );
  const byExpiry = new Map<string, ScreenedOptionContractItem[]>();
  for (const contract of normalized) {
    byExpiry.set(contract.expirationDate, [...(byExpiry.get(contract.expirationDate) || []), contract]);
  }
  const closest = (items: ScreenedOptionContractItem[]) => items
    .sort((a, b) => Math.abs(a.strikePrice - a.underlyingPrice) - Math.abs(b.strikePrice - b.underlyingPrice))
    .slice(0, request.maxStrikesPerSide ?? items.length);
  const chains: ChainView[] = Array.from(byExpiry.entries()).map(([expiration, items]) => ({
    expiration,
    dte: items[0].daysToExpiration,
    calls: new Map(closest(items.filter((item) => item.optionType === "CALL")).map((item) => [item.strikePrice, item])),
    puts: new Map(closest(items.filter((item) => item.optionType === "PUT")).map((item) => [item.strikePrice, item])),
  })).sort((a, b) => a.dte - b.dte);
  const context: StrategyContext = {
    request,
    symbol: request.symbol.toUpperCase(),
    underlying: normalized[0]?.underlyingPrice ?? 0,
    chains,
    stockShares: 100,
  };

  const contractMap = new Map(normalized.map((contract) => [contractKey(contract), contract]));
  const rejected = new Map<string, number>();
  const candidates: StrategyCandidate[] = [];

  for (const def of registry.list()) {
    if (!wanted.has(def.id)) {
      ledger.onSkipped(def, "Skipped: not selected in this request.");
      continue;
    }
    if (!def.theses.includes(request.thesis)) {
      const reason = `${def.label} conflicts with the selected ${request.thesis.replaceAll("_", " ")} thesis`;
      ledger.onSkipped(def, `Skipped: ${reason}.`);
      addRejected(rejected, reason);
      continue;
    }
    if (chains.length === 0) {
      ledger.onSkipped(def, `Skipped: no ${context.symbol} option contracts are available inside the DTE window.`);
      continue;
    }
    if (def.id === "iron_condor" && request.maxIronCondors === 0) {
      ledger.onSkipped(def, "Skipped: iron condor generation is disabled (maxIronCondors = 0).");
      continue;
    }
    const cap = def.id === "iron_condor" && request.maxIronCondors !== undefined ? request.maxIronCondors : DEFAULT_MAX_COMBINATIONS;
    const generated = def.generate(context, cap);
    ledger.onGenerated(def, generated.sets.length, generated.truncated, generated.skipReason);
    for (const legs of generated.sets) {
      const outcome = buildCandidate(def, legs, contractMap, request, targetDays);
      const reason = "candidate" in outcome ? runAcceptanceRules(outcome.candidate, request) : outcome.reason;
      if (reason) {
        ledger.onRejected(def, reason);
        addRejected(rejected, reason);
        continue;
      }
      if ("candidate" in outcome) {
        ledger.onAccepted(def, outcome.candidate);
        candidates.push(outcome.candidate);
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.liquidityScore - a.liquidityScore || a.id.localeCompare(b.id));
  const selectedCandidates = limit === undefined ? candidates : candidates.slice(0, limit);
  const ranked = selectedCandidates.map((candidate, index) => {
    const withRank = { ...candidate, rank: index + 1 };
    return index < DETAIL_LIMIT ? attachDetail(withRank, request, targetDays) : withRank;
  });
  const assumptions = [
    "Research ranking only; it is not a prediction, personalized advice, or an order instruction.",
    "Pre-expiry values use Black-Scholes with the supplied IV, risk-free rate, and dividend yield.",
    "Probability of profit is model-implied under a risk-neutral lognormal terminal-price distribution using average leg IV; it is not a forecast.",
    "Stock-based strategies assume 100 hypothetical shares; actual holdings, margin and borrow are not connected.",
    "No point-in-time earnings/dividend calendar or portfolio positions are connected.",
    "Event risk is unverified and should be checked before acting.",
  ];

  return finish({
    status: ranked.length > 0 ? "ranked_candidates" : "no_candidates",
    request,
    generatedAt: new Date().toISOString(),
    modelVersion: "options-risk-v2",
    dataSource: "E*TRADE option-chain snapshot",
    assumptions,
    scoreWeights: SCORE_WEIGHTS,
    candidates: ranked,
    excluded: Array.from(rejected, ([reason, count]) => ({ reason, count })),
  });
}
