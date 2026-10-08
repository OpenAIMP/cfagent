/**
 * Risk Management Engine for Options Strategies & Trades
 *
 * Provides institutional-grade risk anatomy and actionable defense playbooks
 * for ANY options strategy, single contract, institutional flow print,
 * or brokerage order/position.
 */

import { blackScholes, normalCdf } from "./blackScholes";

export interface RiskLeg {
  id?: string;
  side?: "BUY" | "SELL" | "B" | "S";
  action?: string;
  optionType?: "CALL" | "PUT" | "STOCK" | "C" | "P";
  strike?: number;
  strikePrice?: number;
  expirationDate?: string;
  quantity?: number;
  entryPrice?: number;
  bid?: number;
  ask?: number;
  iv?: number;
  impliedVolatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}

export interface RiskSubject {
  id?: string;
  title: string;
  underlyingSymbol: string;
  underlyingPrice?: number;
  strategyType?: string; // e.g. "Bull Call Spread", "Iron Condor", "Long Call", "Long Equity", etc.
  sentiment?: string; // "bullish", "bearish", "neutral", "directional"
  expirationDate?: string;
  dte?: number;
  quantity?: number;
  netDebit?: number; // positive = debit, negative = credit
  maxProfit?: number | string | null;
  maxLoss?: number | string | null;
  collateral?: number;
  chanceOfProfit?: number; // 0-100%
  breakevens?: number[];
  breakevenText?: string;
  legsText?: string;
  legs?: RiskLeg[];
  netGreeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    rho?: number;
  };
  positionType?: "EQUITY" | "OPTION" | "MULTI_LEG";
  costBasis?: number;
  unrealizedPnL?: number;
  bid?: number;
  ask?: number;
  openInterest?: number;
  volume?: number;
}

export interface RiskAnatomy {
  capitalAtRisk: number | null; // null if unlimited
  capitalAtRiskFormatted: string;
  maxProfitFormatted: string;
  riskRewardRatio: string;
  riskProfileType: "DEFINED_RISK" | "UNDEFINED_RISK" | "COVERED_RISK" | "EQUITY_RISK";
  riskScore: number; // 0 - 100
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "EXTREME";
  riskLevelColor: string;

  // Greeks & Sensitivities
  netDelta: number;
  dollarDelta: number; // Net Delta * Spot * 100 (or Spot * Qty for equities)
  directionalBias: "BULLISH" | "BEARISH" | "NEUTRAL" | "HIGH_VOLATILITY";
  netGamma: number;
  gammaRiskInterpretation: string;
  netTheta: number; // daily decay in $
  thetaInterpretation: string;
  netVega: number; // $ per 1% IV change
  vegaInterpretation: string;

  // Probabilities & Boundaries
  probabilityOfProfit: number; // 0-100
  probabilityOfTouch: number; // 0-100
  breakevens: Array<{
    price: number;
    distancePct: number; // % distance from spot
    direction: "ABOVE" | "BELOW";
  }>;

  // Tail Risks & Assignment
  earlyAssignmentRisk: {
    hasRisk: boolean;
    severity: "NONE" | "LOW" | "MODERATE" | "HIGH";
    reasons: string[];
  };
  tailShockDown10Pct: number;
  tailShockDown20Pct: number;
  tailShockUp10Pct: number;
  tailShockUp20Pct: number;

  // Liquidity & Execution
  liquidityRating: "EXCELLENT" | "MODERATE" | "POOR" | "UNKNOWN";
  bidAskSpreadPct?: number;
}

export interface RiskDefenseAdjustment {
  name: string;
  trigger: string;
  action: string;
  howItProtects: string;
}

export interface RiskDefensePlaybook {
  // Pre-Trade Sizing
  recommendedMaxAllocationPct: number; // e.g. 2% to 5%
  recommendedMaxContracts: (accountNav: number) => number;
  sizingRationale: string;

  // Profit Taking Rules
  profitTakingRule: {
    targetPct: number;
    triggerPriceOrPnl: string;
    actionText: string;
    rationale: string;
  };

  // Stop Loss Rules
  stopLossRule: {
    stopLossThreshold: string;
    triggerCondition: string;
    actionText: string;
    rationale: string;
  };

  // Tactical Defense & Adjustment Plays
  adjustments: RiskDefenseAdjustment[];

  // Dispatchable Prompt for AI Agent
  aiPrompt: string;
}

export interface ScenarioPoint {
  spotChangePct: number;
  spotPrice: number;
  estimatedPnL: number;
  outcomeLabel: string;
}

export interface ComprehensiveRiskProfile {
  subject: RiskSubject;
  anatomy: RiskAnatomy;
  playbook: RiskDefensePlaybook;
  scenarioMatrix: ScenarioPoint[];
}

/**
 * Normalizes leg actions and sides
 */
function normalizeLegSide(sideOrAction?: string): "BUY" | "SELL" {
  if (!sideOrAction) return "BUY";
  const upper = sideOrAction.toUpperCase();
  if (upper.startsWith("S") || upper === "SELL") return "SELL";
  return "BUY";
}

function normalizeOptionType(type?: string): "CALL" | "PUT" | "STOCK" {
  if (!type) return "CALL";
  const upper = type.toUpperCase();
  if (upper.includes("STOCK") || upper === "EQUITY") return "STOCK";
  if (upper.startsWith("P") || upper.includes("PUT")) return "PUT";
  return "CALL";
}

/**
 * Computes the complete institutional risk profile for any given strategy or trade
 */
export function computeRiskProfile(subject: RiskSubject): ComprehensiveRiskProfile {
  const spot = subject.underlyingPrice && subject.underlyingPrice > 0 ? subject.underlyingPrice : 100;
  const stratName = (subject.strategyType || subject.title || "Custom Option Trade").toLowerCase();
  const dte = Math.max(0.5, subject.dte ?? 30);
  const qty = Math.max(1, subject.quantity ?? 1);

  const isEquity =
    subject.positionType === "EQUITY" ||
    stratName.includes("shares") ||
    stratName.includes("equity") ||
    (subject.legs?.length === 1 && subject.legs[0].optionType === "STOCK");

  // Determine legs
  const legs = subject.legs || [];

  // Determine Net Greeks (use provided or calculate)
  let netDelta = subject.netGreeks?.delta ?? 0;
  let netGamma = subject.netGreeks?.gamma ?? 0;
  let netTheta = subject.netGreeks?.theta ?? 0;
  let netVega = subject.netGreeks?.vega ?? 0;

  if (isEquity) {
    const isShort = stratName.includes("short") || subject.title.toLowerCase().includes("sell");
    netDelta = isShort ? -qty : qty;
    netGamma = 0;
    netTheta = 0;
    netVega = 0;
  } else if (!subject.netGreeks && legs.length > 0) {
    // Sum from legs
    let d = 0;
    let g = 0;
    let th = 0;
    let v = 0;
    for (const leg of legs) {
      const legQty = leg.quantity ?? 1;
      const isBuy = normalizeLegSide(leg.side || leg.action) === "BUY";
      const sign = isBuy ? 1 : -1;

      if (leg.delta !== undefined) {
        d += sign * leg.delta * legQty;
        g += sign * (leg.gamma ?? 0) * legQty;
        th += sign * (leg.theta ?? 0) * legQty;
        v += sign * (leg.vega ?? 0) * legQty;
      } else {
        // Black-Scholes estimate
        const strike = leg.strike ?? leg.strikePrice ?? spot;
        const oType = normalizeOptionType(leg.optionType);
        if (oType !== "STOCK") {
          const bs = blackScholes(spot, strike, dte / 365, leg.iv || leg.impliedVolatility || 0.35, 0.04, 0, oType);
          d += sign * bs.delta * legQty;
          g += sign * bs.gamma * legQty;
          th += sign * bs.theta * legQty;
          v += sign * bs.vega * legQty;
        }
      }
    }
    netDelta = Number(d.toFixed(3));
    netGamma = Number(g.toFixed(4));
    netTheta = Number(th.toFixed(2));
    netVega = Number(v.toFixed(2));
  } else if (!subject.netGreeks && legs.length === 0) {
    // Strategy heuristic estimate
    if (stratName.includes("bull call") || (stratName.includes("call") && !stratName.includes("bear") && !stratName.includes("short"))) {
      netDelta = 0.45 * qty;
      netGamma = 0.02 * qty;
      netTheta = -1.8 * qty;
      netVega = 4.2 * qty;
    } else if (stratName.includes("bear put") || (stratName.includes("put") && !stratName.includes("bull") && !stratName.includes("short"))) {
      netDelta = -0.45 * qty;
      netGamma = 0.02 * qty;
      netTheta = -1.8 * qty;
      netVega = 4.2 * qty;
    } else if (stratName.includes("iron condor")) {
      netDelta = 0.02 * qty;
      netGamma = -0.015 * qty;
      netTheta = 3.5 * qty;
      netVega = -7.5 * qty;
    } else if (stratName.includes("bull put") || stratName.includes("credit spread")) {
      netDelta = 0.28 * qty;
      netGamma = -0.01 * qty;
      netTheta = 2.2 * qty;
      netVega = -4.5 * qty;
    } else {
      netDelta = 0.1 * qty;
      netGamma = 0.005 * qty;
      netTheta = 0.5 * qty;
      netVega = 1.0 * qty;
    }
  }

  // Dollar Delta: $ change in position value per 1.00 move in underlying spot
  const dollarDelta = isEquity ? netDelta * spot : netDelta * 100;

  // Directional Bias
  let directionalBias: "BULLISH" | "BEARISH" | "NEUTRAL" | "HIGH_VOLATILITY" = "NEUTRAL";
  if (Math.abs(netDelta) < 0.15) {
    directionalBias = stratName.includes("straddle") || stratName.includes("strangle") ? "HIGH_VOLATILITY" : "NEUTRAL";
  } else if (netDelta > 0) {
    directionalBias = "BULLISH";
  } else {
    directionalBias = "BEARISH";
  }

  // Interpretations
  const gammaRiskInterpretation =
    netGamma > 0
      ? `Positive Gamma (+${netGamma.toFixed(3)}): Delta increases in your favor as spot trends. Low blowup risk, but pay theta decay.`
      : netGamma < 0
      ? `Negative Gamma (${netGamma.toFixed(3)}): Delta accelerates AGAINST you if spot moves quickly. Sharp tail moves cause accelerating losses!`
      : `Neutral Gamma: Delta remains stable with spot moves.`;

  const thetaInterpretation =
    netTheta > 0
      ? `Positive Theta (+$${Math.abs(netTheta * 100).toFixed(2)}/day): Time decay generates steady daily income. Position works in your favor every day markets stay range-bound.`
      : netTheta < 0
      ? `Negative Theta (-$${Math.abs(netTheta * 100).toFixed(2)}/day): Time decay drains capital every single day. Requires prompt underlying movement to be profitable.`
      : `Neutral Theta: Negligible time decay impact.`;

  const vegaInterpretation =
    netVega > 0
      ? `Long Volatility (+$${Math.abs(netVega * 100).toFixed(2)} per +1% IV): Position gains from volatility spikes (e.g. pre-earnings), but suffers from IV crush.`
      : netVega < 0
      ? `Short Volatility (-$${Math.abs(netVega * 100).toFixed(2)} per +1% IV): Gains from implied volatility drops (post-earnings crush), but vulnerable to unexpected market panic.`
      : `Vega Neutral: Insensitive to implied volatility fluctuations.`;

  // Determine Risk Profile Type & Capital at Risk
  let riskProfileType: "DEFINED_RISK" | "UNDEFINED_RISK" | "COVERED_RISK" | "EQUITY_RISK" = "DEFINED_RISK";
  let capitalAtRisk: number | null = null;
  let capitalAtRiskFormatted = "$0.00";
  let maxProfitFormatted = "$0.00";

  // Check undefined risk indicators
  const isNakedCall = stratName.includes("naked call") || stratName.includes("short call");
  const isNakedPut = stratName.includes("naked put") || stratName.includes("short put");
  const isStrangle = stratName.includes("strangle") && !stratName.includes("long");

  if (isEquity) {
    riskProfileType = "EQUITY_RISK";
    capitalAtRisk = spot * qty;
    capitalAtRiskFormatted = `$${capitalAtRisk.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    maxProfitFormatted = "Uncapped / Unlimited";
  } else if (isNakedCall || (isStrangle && !stratName.includes("iron"))) {
    riskProfileType = "UNDEFINED_RISK";
    capitalAtRisk = null;
    capitalAtRiskFormatted = "UNLIMITED / UNDEFINED (Extreme Margin Risk)";
    maxProfitFormatted = subject.maxProfit ? `$${Number(subject.maxProfit).toFixed(2)}` : "$ Premium Received";
  } else if (isNakedPut) {
    riskProfileType = "UNDEFINED_RISK";
    const strike = legs.find((l) => normalizeOptionType(l.optionType) === "PUT")?.strike || spot;
    capitalAtRisk = strike * 100 * qty;
    capitalAtRiskFormatted = `$${capitalAtRisk.toLocaleString(undefined, { minimumFractionDigits: 2 })} (Full Assignment Downside)`;
    maxProfitFormatted = subject.maxProfit ? `$${Number(subject.maxProfit).toFixed(2)}` : "$ Premium Received";
  } else if (stratName.includes("covered")) {
    riskProfileType = "COVERED_RISK";
    capitalAtRisk = spot * 100 * qty;
    capitalAtRiskFormatted = `$${capitalAtRisk.toLocaleString(undefined, { minimumFractionDigits: 2 })} (Covered by Underlying Shares)`;
    maxProfitFormatted = subject.maxProfit ? `$${Number(subject.maxProfit).toFixed(2)}` : "Capped at Strike";
  } else {
    // Defined risk spread or long option
    riskProfileType = "DEFINED_RISK";
    if (typeof subject.maxLoss === "number") {
      capitalAtRisk = subject.maxLoss;
    } else if (subject.collateral) {
      capitalAtRisk = subject.collateral;
    } else if (typeof subject.netDebit === "number" && subject.netDebit > 0) {
      capitalAtRisk = subject.netDebit * 100 * qty;
    } else {
      capitalAtRisk = 500 * qty;
    }
    capitalAtRiskFormatted = `$${capitalAtRisk.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (subject.maxProfit === null || subject.maxProfit === undefined) {
      maxProfitFormatted = "Unlimited";
    } else if (typeof subject.maxProfit === "number") {
      maxProfitFormatted = `$${subject.maxProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
      maxProfitFormatted = String(subject.maxProfit);
    }
  }

  // Risk Reward Ratio
  let riskRewardRatio = "1:1.0";
  if (capitalAtRisk === null) {
    riskRewardRatio = "Undefined (Asymmetric Tail Risk)";
  } else if (maxProfitFormatted === "Unlimited" || maxProfitFormatted.includes("Uncapped")) {
    riskRewardRatio = "Asymmetric / Uncapped";
  } else {
    const maxP = typeof subject.maxProfit === "number" ? subject.maxProfit : capitalAtRisk * 0.8;
    if (capitalAtRisk > 0 && maxP > 0) {
      const ratio = (maxP / capitalAtRisk).toFixed(2);
      riskRewardRatio = `1 : ${ratio}`;
    }
  }

  // Probability of Profit (POP) and Touch
  let pop = subject.chanceOfProfit ?? 55;
  if (isEquity) {
    pop = 50;
  }
  // Probability of touch is roughly 2x ITM probability (bounded at 99%)
  const probOfTouch = Math.min(99, Math.round(pop < 50 ? pop * 1.8 : (100 - pop) * 1.8 + pop * 0.5));

  // Breakevens & Cushion
  const breakevensList: Array<{ price: number; distancePct: number; direction: "ABOVE" | "BELOW" }> = [];
  if (subject.breakevens && subject.breakevens.length > 0) {
    for (const be of subject.breakevens) {
      const distPct = Number((((be - spot) / spot) * 100).toFixed(2));
      breakevensList.push({
        price: be,
        distancePct: Math.abs(distPct),
        direction: be >= spot ? "ABOVE" : "BELOW",
      });
    }
  } else if (isEquity) {
    breakevensList.push({
      price: spot,
      distancePct: 0,
      direction: "ABOVE",
    });
  } else {
    // Fallback breakeven estimation based on strategy
    const be1 = Number((spot * (netDelta >= 0 ? 1.02 : 0.98)).toFixed(2));
    const dist1 = Number((((be1 - spot) / spot) * 100).toFixed(2));
    breakevensList.push({
      price: be1,
      distancePct: Math.abs(dist1),
      direction: be1 >= spot ? "ABOVE" : "BELOW",
    });
  }

  // Early Assignment & American Option Risk
  const assignmentReasons: string[] = [];
  let assignmentSeverity: "NONE" | "LOW" | "MODERATE" | "HIGH" = "NONE";

  if (!isEquity && legs.length > 0) {
    for (const leg of legs) {
      const isShort = normalizeLegSide(leg.side || leg.action) === "SELL";
      if (!isShort) continue;

      const strike = leg.strike ?? leg.strikePrice ?? 0;
      const oType = normalizeOptionType(leg.optionType);

      // Check ITM
      const isCallITM = oType === "CALL" && spot > strike;
      const isPutITM = oType === "PUT" && spot < strike;

      if (isCallITM) {
        assignmentReasons.push(
          `Short Call Strike $${strike.toFixed(2)} is currently In-The-Money (Spot: $${spot.toFixed(2)}). Risk of early exercise prior to ex-dividend date!`
        );
        assignmentSeverity = dte <= 7 ? "HIGH" : "MODERATE";
      }

      if (isPutITM) {
        assignmentReasons.push(
          `Short Put Strike $${strike.toFixed(2)} is In-The-Money (Spot: $${spot.toFixed(2)}). May be assigned early if extrinsic value approaches $0!`
        );
        assignmentSeverity = dte <= 7 ? "HIGH" : "MODERATE";
      }
    }
  }

  if (dte <= 3 && legs.some((l) => normalizeLegSide(l.side || l.action) === "SELL")) {
    assignmentReasons.push(`Expiration within ${dte.toFixed(0)} days: Pin risk and gamma cliff on close strikes.`);
    if (assignmentSeverity === "NONE") assignmentSeverity = "LOW";
  }

  // Tail Shock Estimates (-10%, -20%, +10%, +20%)
  const capRiskVal = capitalAtRisk ?? spot * 100 * qty;
  const tailShockDown10Pct = Number(
    (isEquity
      ? -spot * 0.1 * qty
      : Math.max(-capRiskVal, dollarDelta * (-spot * 0.1) + 0.5 * netGamma * Math.pow(-spot * 0.1, 2) * 100)
    ).toFixed(2)
  );
  const tailShockDown20Pct = Number(
    (isEquity
      ? -spot * 0.2 * qty
      : Math.max(-capRiskVal, dollarDelta * (-spot * 0.2) + 0.5 * netGamma * Math.pow(-spot * 0.2, 2) * 100)
    ).toFixed(2)
  );
  const tailShockUp10Pct = Number(
    (isEquity
      ? spot * 0.1 * qty
      : Math.max(-capRiskVal, dollarDelta * (spot * 0.1) + 0.5 * netGamma * Math.pow(spot * 0.1, 2) * 100)
    ).toFixed(2)
  );
  const tailShockUp20Pct = Number(
    (isEquity
      ? spot * 0.2 * qty
      : Math.max(-capRiskVal, dollarDelta * (spot * 0.2) + 0.5 * netGamma * Math.pow(spot * 0.2, 2) * 100)
    ).toFixed(2)
  );

  // Liquidity Rating
  let liquidityRating: "EXCELLENT" | "MODERATE" | "POOR" | "UNKNOWN" = "MODERATE";
  let bidAskSpreadPct: number | undefined;
  if (subject.bid !== undefined && subject.ask !== undefined && subject.ask > 0) {
    const spread = subject.ask - subject.bid;
    const mid = (subject.ask + subject.bid) / 2;
    bidAskSpreadPct = Number(((spread / mid) * 100).toFixed(1));
    if (bidAskSpreadPct < 5) liquidityRating = "EXCELLENT";
    else if (bidAskSpreadPct < 15) liquidityRating = "MODERATE";
    else liquidityRating = "POOR";
  } else if (isEquity) {
    liquidityRating = "EXCELLENT";
  }

  // Overall Risk Score (0 - 100)
  let score = 25;
  if (riskProfileType === "UNDEFINED_RISK") score += 55;
  if (netGamma < -0.02) score += 15;
  if (dte <= 7) score += 15;
  if (assignmentSeverity === "HIGH") score += 15;
  if (assignmentSeverity === "MODERATE") score += 8;
  if (liquidityRating === "POOR") score += 10;
  if (pop < 40) score += 12;
  if (riskProfileType === "DEFINED_RISK") score = Math.min(score, 65);
  score = Math.max(10, Math.min(98, score));

  let riskLevel: "LOW" | "MODERATE" | "HIGH" | "EXTREME" = "MODERATE";
  let riskLevelColor = "#38bdf8";
  if (score < 35) {
    riskLevel = "LOW";
    riskLevelColor = "#10b981";
  } else if (score < 60) {
    riskLevel = "MODERATE";
    riskLevelColor = "#38bdf8";
  } else if (score < 80) {
    riskLevel = "HIGH";
    riskLevelColor = "#f59e0b";
  } else {
    riskLevel = "EXTREME";
    riskLevelColor = "#ef4444";
  }

  const anatomy: RiskAnatomy = {
    capitalAtRisk,
    capitalAtRiskFormatted,
    maxProfitFormatted,
    riskRewardRatio,
    riskProfileType,
    riskScore: score,
    riskLevel,
    riskLevelColor,
    netDelta,
    dollarDelta,
    directionalBias,
    netGamma,
    gammaRiskInterpretation,
    netTheta,
    thetaInterpretation,
    netVega,
    vegaInterpretation,
    probabilityOfProfit: pop,
    probabilityOfTouch: probOfTouch,
    breakevens: breakevensList,
    earlyAssignmentRisk: {
      hasRisk: assignmentReasons.length > 0,
      severity: assignmentSeverity,
      reasons: assignmentReasons,
    },
    tailShockDown10Pct,
    tailShockDown20Pct,
    tailShockUp10Pct,
    tailShockUp20Pct,
    liquidityRating,
    bidAskSpreadPct,
  };

  // Build Actionable Defense Playbook
  const playbook = buildDefensePlaybook(subject, anatomy, spot, dte, qty, isEquity);

  // Build 7-point Scenario Matrix
  const scenarioMatrix: ScenarioPoint[] = [-20, -10, -5, 0, 5, 10, 20].map((pct) => {
    const sPrice = Number((spot * (1 + pct / 100)).toFixed(2));
    let estPnL = 0;
    if (isEquity) {
      estPnL = Number((netDelta * (sPrice - spot)).toFixed(2));
    } else {
      const dS = sPrice - spot;
      const dPnl = dollarDelta * dS + 0.5 * netGamma * Math.pow(dS, 2) * 100;
      estPnL = capitalAtRisk !== null ? Math.max(-capitalAtRisk, Math.min(10000, Number(dPnl.toFixed(2)))) : Number(dPnl.toFixed(2));
    }

    let outcomeLabel = "Breakeven / Neutral";
    if (estPnL > 25) outcomeLabel = "Profitable Exit Zone 🟢";
    else if (estPnL < -25) outcomeLabel = "Drawdown / Defense Zone 🔴";

    return {
      spotChangePct: pct,
      spotPrice: sPrice,
      estimatedPnL: estPnL,
      outcomeLabel,
    };
  });

  return {
    subject,
    anatomy,
    playbook,
    scenarioMatrix,
  };
}

/**
 * Builds concrete, actionable defense rules and playbook
 */
function buildDefensePlaybook(
  subject: RiskSubject,
  anatomy: RiskAnatomy,
  spot: number,
  dte: number,
  qty: number,
  isEquity: boolean
): RiskDefensePlaybook {
  const stratName = (subject.strategyType || subject.title || "").toLowerCase();
  const capRisk = anatomy.capitalAtRisk ?? spot * 100 * qty;

  // Pre-trade Sizing
  const recommendedMaxAllocationPct = anatomy.riskScore > 75 ? 2.0 : anatomy.riskScore > 50 ? 3.5 : 5.0;
  const recommendedMaxContracts = (accountNav: number) => {
    const budget = accountNav * (recommendedMaxAllocationPct / 100);
    if (capRisk <= 0) return 1;
    return Math.max(1, Math.floor(budget / capRisk));
  };
  const sizingRationale = `Institutional Risk Rule: Allocate no more than ${recommendedMaxAllocationPct}% of total portfolio NAV to this single trade. For undefined risk, maintain 3x maintenance margin cushion.`;

  // Profit Taking Rule
  let profitRule = {
    targetPct: 50,
    triggerPriceOrPnl: "50% of Maximum Profit",
    actionText: "Close to take profit via limit order at 50% max profit.",
    rationale: "Option spreads reach 50% profit significantly faster than 100%. Closing early frees collateral and avoids gamma/tail reversal risk.",
  };

  if (isEquity) {
    profitRule = {
      targetPct: 15,
      triggerPriceOrPnl: `Spot hits $${(spot * 1.15).toFixed(2)} (+15%)`,
      actionText: "Scale out: Sell 50% of shares at +15%, trail stop on remainder.",
      rationale: "Lock in core equity gains and allow trailing stop to capture multi-month trend extension.",
    };
  } else if (stratName.includes("credit") || stratName.includes("iron condor") || stratName.includes("put spread")) {
    profitRule = {
      targetPct: 50,
      triggerPriceOrPnl: "50% Max Credit Collected",
      actionText: "Submit 'Buy to Close' GTC limit order at 50% of credit received.",
      rationale: "Historical win rate jumps from 68% to 84% when taking credit spread profits at 50% of max potential gain.",
    };
  } else if (stratName.includes("debit") || stratName.includes("bull call") || stratName.includes("bear put")) {
    profitRule = {
      targetPct: 75,
      triggerPriceOrPnl: "75% - 100% ROI on Debit Paid",
      actionText: "Close spread when position value expands to 1.75x - 2.0x of initial debit.",
      rationale: "Debit spreads exhibit diminishing risk-reward once deep ITM; roll forward or cash out.",
    };
  } else if (stratName.includes("call") || stratName.includes("put")) {
    profitRule = {
      targetPct: 100,
      triggerPriceOrPnl: "+100% Gain (Doubler)",
      actionText: "Sell half the contracts to recover 100% of initial principal (free roll).",
      rationale: "De-risks trade completely, allowing remaining contracts to capture unbounded upside.",
    };
  }

  // Stop Loss Rule
  let stopRule = {
    stopLossThreshold: "2.0x Initial Credit or 50% Debit Loss",
    triggerCondition: "Spot breaches short strike or position hits 2x loss",
    actionText: "Execute market or limit stop to close both legs simultaneously.",
    rationale: "Prevents a single bad trade from wiping out multiple previous winning cycles.",
  };

  if (isEquity) {
    stopRule = {
      stopLossThreshold: `-7.0% Drawdown ($${(spot * 0.93).toFixed(2)})`,
      triggerCondition: `Underlying drops below $${(spot * 0.93).toFixed(2)}`,
      actionText: "Sell shares to protect principal and preserve trading capital.",
      rationale: "Keeps equity drawdowns small and manageable. Cut losers promptly.",
    };
  } else if (stratName.includes("credit") || stratName.includes("iron condor")) {
    stopRule = {
      stopLossThreshold: "2.0x Net Credit Received",
      triggerCondition: "Loss reaches 2x credit collected OR spot breaches short strike",
      actionText: "Close spread immediately. Do not wait for expiration week assignment.",
      rationale: "Credit spreads have defined risk, but stopping out at 2x credit preserves 50-60% of max collateral.",
    };
  } else if (stratName.includes("debit") || stratName.includes("call") || stratName.includes("put")) {
    stopRule = {
      stopLossThreshold: "50% Premium Loss",
      triggerCondition: "Contract mid-price drops 50% below entry debit",
      actionText: "Close long options. Avoid holding to zero into expiration week.",
      rationale: "Preserving 50% of capital allows redeployment into higher probability setups.",
    };
  }

  // Defense & Adjustment Plays
  const adjustments: RiskDefenseAdjustment[] = [];

  if (isEquity) {
    adjustments.push({
      name: "Sell Covered Call (Downside Buffer)",
      trigger: `Spot stalls or pulls back 2-3%`,
      action: `Sell 1x 30-Delta Call 30-45 DTE out against 100 shares`,
      howItProtects: `Generates immediate cash premium that lowers your effective breakeven cost basis and offsets temporary dips.`,
    });
    adjustments.push({
      name: "Protective Collar (Floor Guarantee)",
      trigger: `Macro uncertainty or earnings approach`,
      action: `Buy 1x OTM Put and finance it by selling 1x OTM Call`,
      howItProtects: `Guarantees a hard minimum exit floor for zero net capital outlay.`,
    });
  } else if (stratName.includes("iron condor") || stratName.includes("strangle")) {
    adjustments.push({
      name: "Roll Untested Wing Closer to Spot",
      trigger: `One wing is tested (spot approaches short strike)`,
      action: `Close unchallenged spread and re-open 3-5 strikes closer to spot`,
      howItProtects: `Collects extra net credit, widens breakeven on tested side, and neutralizes skewed Delta exposure without adding capital.`,
    });
    adjustments.push({
      name: "Roll Tested Spread Out in Time (Duration Play)",
      trigger: `14-21 DTE remaining and short strike tested`,
      action: `Roll tested spread 30-45 DTE out to next monthly cycle for a net credit`,
      howItProtects: `Resets Gamma acceleration, buys additional time for mean reversion, and increases total credit collected.`,
    });
    adjustments.push({
      name: "Invert Spreads (Iron Condor to Inverted)",
      trigger: `Underlying breaches short strike by > 1%`,
      action: `Roll untested side past the tested side to create an inverted spread`,
      howItProtects: `Converts catastrophic tail loss into a capped, manageable scratch trade.`,
    });
  } else if (stratName.includes("credit") || stratName.includes("bull put") || stratName.includes("bear call")) {
    adjustments.push({
      name: "Roll Out in Time for Net Credit",
      trigger: `Spot touches within 1.5% of short strike with 10-14 DTE remaining`,
      action: `Buy to close current expiration, sell identical strikes 30-45 DTE out for net credit`,
      howItProtects: `Expands overall breakeven cushion and eliminates immediate expiration gamma cliff risk.`,
    });
    adjustments.push({
      name: "Add Opposing Credit Spread (Convert to Iron Condor)",
      trigger: `Market trends aggressively against your spread`,
      action: `Sell an opposite-side credit spread on the unthreatened side`,
      howItProtects: `Brings in extra credit with zero additional margin requirement (broker only margins the wider wing).`,
    });
  } else if (stratName.includes("debit") || stratName.includes("bull call") || stratName.includes("bear put")) {
    adjustments.push({
      name: "Convert to Butterfly / Calendar",
      trigger: `Spot stalls near long strike and theta is accelerating`,
      action: `Sell an additional short leg at a further strike to convert into a butterfly`,
      howItProtects: `Recovers a large portion of initial debit while maintaining centered profit peak.`,
    });
    adjustments.push({
      name: "Roll Long Strike Closer to Spot",
      trigger: `Stock consolidates after initial move`,
      action: `Roll long strike down (for calls) or up (for puts) to restore high Delta responsiveness`,
      howItProtects: `Maintains exposure while taking partial money off the table.`,
    });
  } else {
    // Single call or put
    adjustments.push({
      name: "Convert Naked Option to Vertical Spread",
      trigger: `Option loses 25-30% of value or spot consolidates`,
      action: `Sell a further OTM contract against your long contract`,
      howItProtects: `Caps theta decay immediately and locks in a reduced max loss.`,
    });
    adjustments.push({
      name: "Delta Hedge with Mini/Shares",
      trigger: `Sudden adverse intraday trend move`,
      action: `Take opposing micro/share position equal to position Delta`,
      howItProtects: `Freezes position P&L temporarily until market establishes direction.`,
    });
  }

  // AI Prompt for 1-click dispatch to Chat
  const aiPrompt =
    `Perform real-time risk assessment and defense playbook for ${subject.underlyingSymbol} ${subject.strategyType || subject.title || "strategy"}. ` +
    `Current Spot: $${spot.toFixed(2)}, Net Delta: ${anatomy.netDelta.toFixed(2)}, Max Loss: ${anatomy.capitalAtRiskFormatted}, POP: ${anatomy.probabilityOfProfit}%. ` +
    `What are the best tactical roll adjustments and exit stops if the underlying moves against the position by 5%?`;

  return {
    recommendedMaxAllocationPct,
    recommendedMaxContracts,
    sizingRationale,
    profitTakingRule: profitRule,
    stopLossRule: stopRule,
    adjustments,
    aiPrompt,
  };
}
