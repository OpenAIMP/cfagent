import type { ScreenedOptionContractItem } from "../../types";

export type OptionThesis = "bullish" | "bearish" | "range_bound" | "large_move";
export type ExpectedIvDirection = "rise" | "unchanged" | "fall";
export type OptionStrategyType =
  | "long_call"
  | "long_put"
  | "call_debit_spread"
  | "put_debit_spread"
  | "long_straddle"
  | "long_strangle"
  | "iron_condor";

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
  optionType: "CALL" | "PUT";
  side: "BUY" | "SELL";
  quantity: number;
  strike: number;
  expirationDate: string;
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
}

const MULTIPLIER = 100;
const SCORE_WEIGHTS: StrategyScoreBreakdown["weights"] = {
  thesisAlignment: 0.30,
  targetRewardRisk: 0.20,
  liquidity: 0.20,
  volatilityAlignment: 0.10,
  thetaBurden: 0.05,
  freshness: 0.15,
};

const STRATEGY_LABELS: Record<OptionStrategyType, string> = {
  long_call: "Long Call",
  long_put: "Long Put",
  call_debit_spread: "Call Debit Spread",
  put_debit_spread: "Put Debit Spread",
  long_straddle: "Long Straddle",
  long_strangle: "Long Strangle",
  iron_condor: "Iron Condor",
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function toLeg(contract: ScreenedOptionContractItem, side: "BUY" | "SELL"): StrategyLeg {
  const entryPrice = side === "BUY" ? contract.ask : contract.bid;
  return {
    symbol: contract.symbol,
    optionType: contract.optionType,
    side,
    quantity: 1,
    strike: contract.strikePrice,
    expirationDate: contract.expirationDate,
    entryPrice,
    bid: contract.bid,
    ask: contract.ask,
    impliedVolatility: contract.impliedVolatility ?? 0,
    delta: contract.delta ?? 0,
    gamma: contract.gamma ?? 0,
    theta: contract.theta ?? 0,
    vega: contract.vega ?? 0,
    openInterest: contract.openInterest ?? 0,
    volume: contract.volume ?? 0,
    spreadPct: contract.spreadPct,
    quoteTimestamp: contract.quoteTimestamp || "",
    quoteAgeSeconds: contract.quoteAgeSeconds,
    quoteFreshness: contract.quoteFreshness || "UNKNOWN",
    multiplier: MULTIPLIER,
  };
}

function netDebit(legs: StrategyLeg[], fees: number): number {
  const signedEntry = legs.reduce((sum, leg) => {
    const sign = leg.side === "BUY" ? 1 : -1;
    return sum + sign * leg.entryPrice * leg.quantity * leg.multiplier;
  }, 0);
  return signedEntry + fees;
}

function expiryPnl(legs: StrategyLeg[], spot: number, fees: number): number {
  const intrinsic = legs.reduce((sum, leg) => {
    const amount = leg.optionType === "CALL"
      ? Math.max(spot - leg.strike, 0)
      : Math.max(leg.strike - spot, 0);
    const signedQuantity = leg.side === "BUY" ? leg.quantity : -leg.quantity;
    return sum + signedQuantity * amount * leg.multiplier;
  }, 0);
  return intrinsic - netDebit(legs, fees);
}

function riskProfile(legs: StrategyLeg[], fees: number, underlyingPrice: number) {
  const strikes = Array.from(new Set(legs.map((leg) => leg.strike))).sort((a, b) => a - b);
  const upper = Math.max(underlyingPrice * 2, (strikes[strikes.length - 1] || underlyingPrice) * 2, 1);
  const points = Array.from(new Set([0, ...strikes, upper])).sort((a, b) => a - b);
  const values = points.map((spot) => ({ spot, pnl: expiryPnl(legs, spot, fees) }));
  const callSlope = legs.reduce((sum, leg) => {
    if (leg.optionType !== "CALL") return sum;
    return sum + (leg.side === "BUY" ? 1 : -1) * leg.quantity * leg.multiplier;
  }, 0);
  const maxLoss = callSlope < 0 ? Infinity : Math.max(0, -Math.min(...values.map((point) => point.pnl)));
  const maxProfitUnbounded = callSlope > 0;
  const maxProfit = maxProfitUnbounded ? null : Math.max(0, ...values.map((point) => point.pnl));
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
  dte: number,
  fees: number,
  rate: number,
  dividend: number
): number {
  if (dte <= 0) return expiryPnl(legs, underlying, fees) > 0 ? 1 : 0;
  const volatility = legs.reduce((sum, leg) => sum + leg.impliedVolatility, 0) / legs.length;
  const boundaries = [0, ...breakEvenPoints.filter((point) => point > 0), Infinity].sort((a, b) => a - b);
  let probability = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const lower = boundaries[index];
    const upper = boundaries[index + 1];
    const testSpot = Number.isFinite(upper)
      ? (lower + upper) / 2
      : lower + Math.max(underlying, 1);
    if (expiryPnl(legs, testSpot, fees) > 0) {
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
  daysToExpiry: number,
  fees: number,
  rate: number,
  dividend: number,
  ivMultiplier: number
): number {
  const value = legs.reduce((sum, leg) => {
    const mark = blackScholes(leg, spot, daysToExpiry, rate, dividend, leg.impliedVolatility * ivMultiplier);
    const signedQuantity = leg.side === "BUY" ? leg.quantity : -leg.quantity;
    return sum + signedQuantity * mark * leg.multiplier;
  }, 0);
  return value - netDebit(legs, fees);
}

function daysUntil(date: string): number {
  const target = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(target.getTime())) throw new Error("targetDate must be an ISO date");
  return Math.max(0, Math.ceil((target.getTime() - Date.now()) / 86_400_000));
}

function isThesisCompatible(type: OptionStrategyType, thesis: OptionThesis): boolean {
  if (thesis === "bullish") return ["long_call", "call_debit_spread"].includes(type);
  if (thesis === "bearish") return ["long_put", "put_debit_spread"].includes(type);
  if (thesis === "range_bound") return type === "iron_condor";
  return ["long_straddle", "long_strangle"].includes(type);
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
      pnl: Number(modeledPnl(legs, underlying * (1 + priceShock), remaining, fees, rate, dividend, 1 + ivShock).toFixed(2)),
    };
  })));
}

function buildCandidate(
  type: OptionStrategyType,
  legs: StrategyLeg[],
  contractMap: Map<string, ScreenedOptionContractItem>,
  request: StrategyRequest,
  targetDays: number
): StrategyCandidate | null {
  if (legs.length < 1 || legs.length > 4) return null;
  if (new Set(legs.map((leg) => leg.expirationDate)).size !== 1) return null;
  if (legs.some((leg) => !leg.entryPrice || leg.entryPrice <= 0 || leg.impliedVolatility <= 0)) return null;

  const contracts = legs.map((leg) => contractMap.get(leg.symbol)).filter((item): item is ScreenedOptionContractItem => Boolean(item));
  if (contracts.length !== legs.length) return null;
  const freshnessStates = contracts.map((contract) => contract.quoteFreshness || "UNKNOWN");
  const dataFreshness = freshnessStates.includes("STALE")
    ? "STALE" as const
    : freshnessStates.includes("UNKNOWN") ? "UNKNOWN" as const : "FRESH" as const;
  const underlying = contracts[0].underlyingPrice;
  const dte = contracts[0].daysToExpiration;
  const fees = legs.reduce((sum, leg) => sum + leg.quantity * (request.feesPerContract ?? 0.65), 0);
  const debit = netDebit(legs, fees);
  const risk = riskProfile(legs, fees, underlying);
  if (!Number.isFinite(risk.maxLoss) || risk.maxLoss <= 0) return null;

  const rate = request.riskFreeRate ?? 0.04;
  const dividend = request.dividendYield ?? 0;
  const targetElapsed = Math.min(targetDays, dte);
  const ivMultiplier = request.expectedIvDirection === "rise" ? 1.15 : request.expectedIvDirection === "fall" ? 0.85 : 1;
  const targetPnl = modeledPnl(legs, request.targetPrice, Math.max(0, dte - targetElapsed), fees, rate, dividend, ivMultiplier);
  const targetRewardRisk = targetPnl / risk.maxLoss;
  const modelImpliedProbabilityOfProfit = impliedProbabilityOfProfit(
    legs,
    risk.breakevens,
    underlying,
    dte,
    fees,
    rate,
    dividend
  );
  const thesisAlignment = targetPnl > 0 && isThesisCompatible(type, request.thesis)
    ? clamp(50 + 25 * Math.log2(1 + Math.max(0, targetRewardRisk)))
    : isThesisCompatible(type, request.thesis) ? clamp(25 + targetRewardRisk * 10) : 10;
  const liquidityScore = contracts.reduce((sum, contract) => {
    const spread = clamp(100 - contract.spreadPct * 5);
    const activity = clamp(40 + 12 * Math.log10(Math.max(1, contract.volume ?? 0)) + 8 * Math.log10(Math.max(1, contract.openInterest ?? 0)));
    return sum + (spread * 0.7 + activity * 0.3) / contracts.length;
  }, 0);
  const netVega = legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? 1 : -1) * leg.vega * leg.multiplier * leg.quantity, 0);
  const volatilityAlignment = request.expectedIvDirection === "unchanged"
    ? 70
    : (request.expectedIvDirection === "rise" ? netVega : -netVega) >= 0 ? 100 : 20;
  const netTheta = legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? 1 : -1) * leg.theta * leg.multiplier * leg.quantity, 0);
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
  const priceRange = Array.from({ length: 41 }, (_, index) => underlying * (0.5 + index * 0.025));
  const payoffCurve = priceRange.map((spot) => ({
    underlyingPrice: Number(spot.toFixed(2)),
    pnl: Number(expiryPnl(legs, spot, fees).toFixed(2)),
  }));
  const warnings = [
    "Pre-expiry P/L is a Black-Scholes estimate, not a forecast or executable quote.",
    "Earnings and dividend dates are not connected; event risk is unverified.",
    "Early exercise, assignment, margin, and execution slippage are not modeled.",
  ];
  if (dataFreshness === "STALE") {
    const age = Math.max(...contracts.map((contract) => contract.quoteAgeSeconds ?? 0));
    warnings.unshift(`Stale quote data: oldest leg is ${Math.round(age).toLocaleString()}s old. Candidate is indicative research only.`);
  } else if (dataFreshness === "UNKNOWN") {
    warnings.unshift("Quote timestamp is unavailable for at least one leg. Freshness cannot be verified; research only.");
  }
  if (request.eventPolicy === "exclude") return null;

  const explanations = [
    `${STRATEGY_LABELS[type]} matches the ${request.thesis.replaceAll("_", " ")} thesis.`,
    `Conservative entry uses asks for buys and bids for sells; estimated fees are $${fees.toFixed(2)}.`,
    `Target-date modeled P/L is $${targetPnl.toFixed(2)} (${targetRewardRisk.toFixed(2)}x max loss).`,
  ];

  return {
    id: `${type}:${legs.map((leg) => leg.symbol).join("+")}`,
    rank: 0,
    type,
    label: STRATEGY_LABELS[type],
    symbol: request.symbol.toUpperCase(),
    expirationDate: legs[0].expirationDate,
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
      delta: legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? 1 : -1) * leg.delta * leg.multiplier * leg.quantity, 0),
      gamma: legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? 1 : -1) * leg.gamma * leg.multiplier * leg.quantity, 0),
      theta: netTheta,
      vega: netVega,
    },
    liquidityScore: Number(liquidityScore.toFixed(1)),
    score: Number(score.toFixed(1)),
    scoreBreakdown,
    payoffCurve,
    scenarios: makeScenarioGrid(legs, underlying, dte, targetDays, fees, rate, dividend),
    explanations,
    warnings,
    assumptions: [
      `Risk-free rate ${(rate * 100).toFixed(2)}%; dividend yield ${(dividend * 100).toFixed(2)}%.`,
      `Multiplier ${MULTIPLIER}; ${request.feesPerContract ?? 0.65} estimated fees per contract.`,
      `Option marks use conservative bid/ask-side entry; scenario marks use Black-Scholes.`,
    ],
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
  if (request.eventPolicy === "exclude") {
    return {
      status: "no_candidates",
      request,
      generatedAt: new Date().toISOString(),
      modelVersion: "options-risk-v1",
      dataSource: "E*TRADE option-chain snapshot",
      assumptions: ["Candidates were withheld because earnings/dividend calendar verification is unavailable."],
      scoreWeights: SCORE_WEIGHTS,
      candidates: [],
      excluded: [{ reason: "Event-risk exclusion cannot be verified without an event calendar", count: contracts.length }],
    };
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

  const contractMap = new Map(normalized.map((contract) => [contract.symbol, contract]));
  const rejected = new Map<string, number>();
  const candidates: StrategyCandidate[] = [];
  const wanted = new Set(request.allowedStrategies);
  const add = (type: OptionStrategyType, legs: StrategyLeg[]) => {
    if (!wanted.has(type)) return;
    if (!isThesisCompatible(type, request.thesis)) {
      addRejected(rejected, `${STRATEGY_LABELS[type]} conflicts with the selected ${request.thesis.replaceAll("_", " ")} thesis`);
      return;
    }
    const candidate = buildCandidate(type, legs, contractMap, request, targetDays);
    if (!candidate) {
      addRejected(rejected, `${STRATEGY_LABELS[type]} has incomplete or unsupported contract data`);
      return;
    }
    if (candidate.maxLoss > request.maxPlannedLoss) {
      addRejected(rejected, `${candidate.label} exceeds the max planned loss`);
      return;
    }
    if (candidate.targetPnl <= 0) {
      addRejected(rejected, `${candidate.label} is not profitable at the stated target under the selected assumptions`);
      return;
    }
    if (candidate.targetRewardRisk < request.minRewardRisk) {
      addRejected(rejected, `${candidate.label} is below the minimum target reward/risk`);
      return;
    }
    candidates.push(candidate);
  };

  for (const expiryContracts of byExpiry.values()) {
    const nearest = (items: ScreenedOptionContractItem[]) => items
      .sort((a, b) => Math.abs(a.strikePrice - a.underlyingPrice) - Math.abs(b.strikePrice - b.underlyingPrice))
      .slice(0, request.maxStrikesPerSide ?? items.length)
      .sort((a, b) => a.strikePrice - b.strikePrice);
    const calls = nearest(expiryContracts.filter((contract) => contract.optionType === "CALL"));
    const puts = nearest(expiryContracts.filter((contract) => contract.optionType === "PUT"));
    for (const contract of calls) add("long_call", [toLeg(contract, "BUY")]);
    for (const contract of puts) add("long_put", [toLeg(contract, "BUY")]);

    if (wanted.has("call_debit_spread")) {
      for (const long of calls) for (const short of calls) {
        if (long.strikePrice < short.strikePrice) add("call_debit_spread", [toLeg(long, "BUY"), toLeg(short, "SELL")]);
      }
    }
    if (wanted.has("put_debit_spread")) {
      for (const long of puts) for (const short of puts) {
        if (long.strikePrice > short.strikePrice) add("put_debit_spread", [toLeg(long, "BUY"), toLeg(short, "SELL")]);
      }
    }
    if (wanted.has("long_straddle")) {
      for (const call of calls) {
        const put = puts.find((item) => item.strikePrice === call.strikePrice);
        if (put) add("long_straddle", [toLeg(call, "BUY"), toLeg(put, "BUY")]);
      }
    }
    if (wanted.has("long_strangle")) {
      for (const put of puts) for (const call of calls) {
        if (put.strikePrice < call.strikePrice) add("long_strangle", [toLeg(put, "BUY"), toLeg(call, "BUY")]);
      }
    }
    if (wanted.has("iron_condor") && request.maxIronCondors !== 0) {
      const putSpreads: Array<[ScreenedOptionContractItem, ScreenedOptionContractItem]> = [];
      const callSpreads: Array<[ScreenedOptionContractItem, ScreenedOptionContractItem]> = [];
      for (const long of puts) for (const short of puts) if (long.strikePrice < short.strikePrice) putSpreads.push([long, short]);
      for (const short of calls) for (const long of calls) if (short.strikePrice < long.strikePrice) callSpreads.push([long, short]);
      let generated = 0;
      condors: for (const [longPut, shortPut] of putSpreads) for (const [longCall, shortCall] of callSpreads) {
        if (shortPut.strikePrice >= shortCall.strikePrice) continue;
        add("iron_condor", [toLeg(longPut, "BUY"), toLeg(shortPut, "SELL"), toLeg(shortCall, "SELL"), toLeg(longCall, "BUY")]);
        generated++;
        if (request.maxIronCondors !== undefined && generated >= request.maxIronCondors) break condors;
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.liquidityScore - a.liquidityScore || a.id.localeCompare(b.id));
  const selectedCandidates = limit === undefined ? candidates : candidates.slice(0, limit);
  const ranked = selectedCandidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const assumptions = [
    "Research ranking only; it is not a prediction, personalized advice, or an order instruction.",
    "Pre-expiry values use Black-Scholes with the supplied IV, risk-free rate, and dividend yield.",
    "Probability of profit is model-implied under a risk-neutral lognormal terminal-price distribution using average leg IV; it is not a forecast.",
    "No point-in-time earnings/dividend calendar or portfolio positions are connected.",
    "Event risk is unverified and should be checked before acting.",
  ];

  return {
    status: ranked.length > 0 ? "ranked_candidates" : "no_candidates",
    request,
    generatedAt: new Date().toISOString(),
    modelVersion: "options-risk-v1",
    dataSource: "E*TRADE option-chain snapshot",
    assumptions,
    scoreWeights: SCORE_WEIGHTS,
    candidates: ranked,
    excluded: Array.from(rejected, ([reason, count]) => ({ reason, count })),
  };
}