import { blackScholes, calculateProbabilityOfProfit, normalCdf } from "./blackScholes";

export type SentimentType =
  | "very_bearish"
  | "bearish"
  | "neutral"
  | "directional"
  | "bullish"
  | "very_bullish";

export interface StrategyLegItem {
  id: string;
  side: "BUY" | "SELL";
  optionType: "CALL" | "PUT" | "STOCK";
  strike: number;
  quantity: number;
  expirationDate: string;
  dte: number;
  entryPrice: number;
  bid: number;
  ask: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface StrategyEvaluationFactors {
  /** Return on Risk / Target Profit score (0 - 100) */
  returnScore: number;
  /** Probability of Profit score (0 - 100) */
  chanceScore: number;
  /** Breakeven safety buffer % vs current spot */
  cushionPct: number;
  /** Margin of safety / cushion score (0 - 100) */
  cushionScore: number;
  /** Capital efficiency score (0 - 100) */
  capitalEfficiencyScore: number;
  /** Overall composite match score (0 - 100) given the active bias */
  compositeScore: number;
}

export interface StrategyDiscoveryConfig {
  riskFreeRate?: number;
  feePerContract?: number;
  maxCombinations?: number;
  detailLimit?: number;
  maxLegs?: number;
}

export interface OptimizationBiasFactors {
  /** Weight applied to Return & Leverage (0 - 100) */
  returnWeight: number;
  /** Weight applied to Probability of Profit (0 - 100) */
  chanceWeight: number;
  /** Weight applied to Breakeven Safety Cushion (0 - 100) */
  safetyWeight: number;
  /** Weight applied to Capital Efficiency (0 - 100) */
  capitalWeight: number;
  /** Optimization regime descriptor */
  regime: "Max Return (High Leverage / OTM)" | "Balanced EV (Risk-Adjusted)" | "Max Chance (High Win-Rate / ITM)";
  regimeDescription: string;
}

export interface DiscoveredStrategy {
  id: string;
  name: string;
  category: string;
  subtitle: string;
  theses: SentimentType[];
  legs: StrategyLegItem[];
  netDebit: number; // positive = debit, negative = credit
  estMargin: number;
  maxProfit: number | null; // null = unlimited
  maxLoss: number | null; // null = infinite
  targetProfit: number;
  riskOrCollateral: number;
  returnOnRiskPct: number | null;
  returnOnCollateralPct: number | null;
  chanceOfProfit: number; // 0 to 100
  breakevens: number[];
  breakevenText: string;
  miniPayoffPoints: Array<{ price: number; pnl: number }>;
  expirationDate: string;
  dte: number;
  description: string;
  tag?: string;
  factors?: StrategyEvaluationFactors;
}

export interface ExpirationOption {
  date: string;
  label: string;
  monthGroup?: string;
  dayLabel: string;
  dte: number;
  isStandardMonthly?: boolean;
}

/**
 * Generates standard option expiration schedule starting from now.
 */
export function generateExpirations(referenceDate: Date = new Date()): ExpirationOption[] {
  const result: ExpirationOption[] = [];
  const start = new Date(referenceDate);

  // Near-term cycles (days / weeks)
  const daysOffsets = [0.5, 2, 4, 7, 9, 11, 18, 25, 32, 39, 46, 60, 90, 120, 180, 270, 365, 450, 540, 720];
  const seenDates = new Set<string>();

  for (const offset of daysOffsets) {
    const d = new Date(start.getTime() + offset * 24 * 60 * 60 * 1000);
    // Align to Friday if > 14 days
    if (offset > 7 && d.getDay() !== 5) {
      const diffToFriday = (5 - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + diffToFriday);
    }
    const iso = d.toISOString().slice(0, 10);
    if (seenDates.has(iso)) continue;
    seenDates.add(iso);

    const monthShort = d.toLocaleString("en-US", { month: "short" });
    const day = d.getDate();
    const year = d.getFullYear();
    const isNextYears = year > start.getFullYear();
    const yearLabel = isNextYears ? ` '${String(year).slice(-2)}` : "";
    const group = isNextYears ? `${monthShort}${yearLabel}` : monthShort;

    result.push({
      date: iso,
      label: `${monthShort} ${day}${yearLabel}`,
      monthGroup: group,
      dayLabel: String(day),
      dte: Math.max(0.5, Math.round(offset)),
    });
  }

  return result;
}

/**
 * Calculates standard strike ladder around underlying price.
 */
export function generateStrikeLadder(spot: number): number[] {
  let step = 1;
  if (spot > 500) step = 10;
  else if (spot > 200) step = 5;
  else if (spot > 100) step = 2.5;
  else if (spot > 50) step = 1;
  else if (spot > 20) step = 0.5;
  else step = 0.25;

  const center = Math.round(spot / step) * step;
  const count = 28;
  const strikes: number[] = [];
  for (let i = -count; i <= count; i++) {
    const strike = Number((center + i * step).toFixed(2));
    if (strike > 0) strikes.push(strike);
  }
  return strikes;
}

/**
 * Computes PnL at price `s` for a collection of legs at time `tRemainingYears`.
 * When tRemainingYears === 0, evaluates exact expiration payoff.
 */
export function evaluateStrategyPnL(
  legs: StrategyLegItem[],
  price: number,
  tRemainingYears: number,
  volatility: number,
  r: number = 0.04
): number {
  let totalPnL = 0;

  for (const leg of legs) {
    if (leg.optionType === "STOCK") {
      const perSharePnL = price - leg.entryPrice;
      const legPnL = (leg.side === "BUY" ? 1 : -1) * leg.quantity * perSharePnL;
      totalPnL += legPnL;
      continue;
    }

    const multiplier = 100;
    const vol = leg.impliedVolatility || volatility;

    let currentOptionValue: number;
    if (tRemainingYears <= 0.0001) {
      // Expiration intrinsic value
      currentOptionValue =
        leg.optionType === "CALL" ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price);
    } else {
      // Black-Scholes theoretical value
      const bs = blackScholes(price, leg.strike, tRemainingYears, vol, r, 0, leg.optionType);
      currentOptionValue = bs.price;
    }

    const perContractPnL =
      leg.side === "BUY"
        ? (currentOptionValue - leg.entryPrice) * multiplier
        : (leg.entryPrice - currentOptionValue) * multiplier;

    totalPnL += perContractPnL * leg.quantity;
  }

  return totalPnL;
}

/**
 * Helper to build a standard single leg with Black-Scholes pricing.
 */
function makeLeg(
  side: "BUY" | "SELL",
  optionType: "CALL" | "PUT",
  strike: number,
  spot: number,
  dte: number,
  expirationDate: string,
  iv: number,
  quantity: number = 1,
  r: number = 0.04
): StrategyLegItem {
  const t = Math.max(0.5, dte) / 365;
  const bs = blackScholes(spot, strike, t, iv, r, 0, optionType);
  const mid = bs.price;
  const spreadHalf = Math.max(0.05, mid * 0.03);
  const bid = Math.max(0.01, Number((mid - spreadHalf).toFixed(2)));
  const ask = Number((mid + spreadHalf).toFixed(2));
  const entryPrice = side === "BUY" ? ask : bid;

  return {
    id: `${optionType}_${strike}_${side}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    side,
    optionType,
    strike,
    quantity,
    expirationDate,
    dte,
    entryPrice,
    bid,
    ask,
    impliedVolatility: iv,
    delta: bs.delta,
    gamma: bs.gamma,
    theta: bs.theta,
    vega: bs.vega,
  };
}

function makeStockLeg(
  side: "BUY" | "SELL",
  spot: number,
  quantity: number = 100,
  expirationDate: string = "",
  dte: number = 0
): StrategyLegItem {
  return {
    id: `STOCK_${side}_${quantity}`,
    side,
    optionType: "STOCK",
    strike: spot,
    quantity,
    expirationDate,
    dte,
    entryPrice: spot,
    bid: spot - 0.02,
    ask: spot + 0.02,
    impliedVolatility: 0,
    delta: side === "BUY" ? 1 : -1,
    gamma: 0,
    theta: 0,
    vega: 0,
  };
}

/**
 * Dynamic factor weightings evaluated by the ← Max Return | Max Chance → optimizer.
 */
export function getOptimizationFactors(optimizationBias: number = 50): OptimizationBiasFactors {
  const biasPct = Math.max(0, Math.min(100, optimizationBias));
  const chanceRatio = biasPct / 100; // 0 to 1
  const returnRatio = 1 - chanceRatio; // 1 to 0

  const returnWeight = Math.round(10 + returnRatio * 50); // 10% to 60%
  const chanceWeight = Math.round(10 + chanceRatio * 50); // 10% to 60%
  const safetyWeight = Math.round(10 + chanceRatio * 15); // 10% to 25%
  const capitalWeight = Math.round(10 + returnRatio * 10); // 10% to 20%

  let regime: OptimizationBiasFactors["regime"] = "Balanced EV (Risk-Adjusted)";
  let regimeDescription = "Balancing win-rate probability with risk/reward payoff multiplier.";

  if (biasPct < 35) {
    regime = "Max Return (High Leverage / OTM)";
    regimeDescription =
      "Prioritizing maximum Return-on-Risk (RoR%), leverage, and asymmetric upside multiple at the target price.";
  } else if (biasPct > 65) {
    regime = "Max Chance (High Win-Rate / ITM)";
    regimeDescription =
      "Prioritizing high Probability of Profit (POP > 70%), maximizing breakeven margin of safety and downside buffer.";
  }

  return {
    returnWeight,
    chanceWeight,
    safetyWeight,
    capitalWeight,
    regime,
    regimeDescription,
  };
}

/**
 * Recomputes pricing and Greeks for a single leg when its strike price slider moves in Builder.
 */
export function updateLegStrike(
  leg: StrategyLegItem,
  newStrike: number,
  spot: number,
  dte: number,
  iv: number,
  r: number = 0.04
): StrategyLegItem {
  if (leg.optionType === "STOCK") {
    return { ...leg, strike: spot, entryPrice: spot };
  }
  const t = Math.max(0.5, dte) / 365;
  const bs = blackScholes(spot, newStrike, t, iv, r, 0, leg.optionType);
  const mid = bs.price;
  const spreadHalf = Math.max(0.05, mid * 0.03);
  const bid = Math.max(0.01, Number((mid - spreadHalf).toFixed(2)));
  const ask = Number((mid + spreadHalf).toFixed(2));
  const entryPrice = leg.side === "BUY" ? ask : bid;

  return {
    ...leg,
    strike: newStrike,
    entryPrice,
    bid,
    ask,
    delta: bs.delta,
    gamma: bs.gamma,
    theta: bs.theta,
    vega: bs.vega,
  };
}

/**
 * Recomputes pricing and Greeks for all legs when a different expiration date is selected in Builder.
 */
export function updateLegsExpiration(
  legs: StrategyLegItem[],
  newDte: number,
  newExpirationDate: string,
  spot: number,
  iv: number,
  r: number = 0.04
): StrategyLegItem[] {
  return legs.map((leg) => {
    if (leg.optionType === "STOCK") {
      return { ...leg, expirationDate: newExpirationDate, dte: newDte };
    }
    const t = Math.max(0.5, newDte) / 365;
    const bs = blackScholes(spot, leg.strike, t, iv, r, 0, leg.optionType);
    const mid = bs.price;
    const spreadHalf = Math.max(0.05, mid * 0.03);
    const bid = Math.max(0.01, Number((mid - spreadHalf).toFixed(2)));
    const ask = Number((mid + spreadHalf).toFixed(2));
    const entryPrice = leg.side === "BUY" ? ask : bid;

    return {
      ...leg,
      expirationDate: newExpirationDate,
      dte: newDte,
      entryPrice,
      bid,
      ask,
      delta: bs.delta,
      gamma: bs.gamma,
      theta: bs.theta,
      vega: bs.vega,
    };
  });
}

/**
 * Derives comprehensive metrics and payoff curves for any set of legs.
 */
export function analyzeStrategy(
  name: string,
  category: string,
  subtitle: string,
  theses: SentimentType[],
  legs: StrategyLegItem[],
  spot: number,
  targetPrice: number,
  dte: number,
  expirationDate: string,
  volatility: number,
  description: string = "",
  optimizationBias: number = 50,
  config?: Partial<StrategyDiscoveryConfig>
): DiscoveredStrategy {
  const r = config?.riskFreeRate ?? 0.04;
  const tExpiryYears = Math.max(0.5, dte) / 365;

  // Generate range of prices for payoff curve (e.g. from spot * 0.2 to spot * 1.8)
  const minPrice = Math.max(0.01, spot * 0.2);
  const maxPrice = spot * 2.0;
  const stepCount = 50;
  const priceStep = (maxPrice - minPrice) / (stepCount - 1);

  const miniPayoffPoints: Array<{ price: number; pnl: number }> = [];
  const breakevens: number[] = [];

  let prevPnl: number | null = null;
  let prevPrice: number | null = null;
  let minPnl = Infinity;
  let maxPnl = -Infinity;

  for (let i = 0; i < stepCount; i++) {
    const p = Number((minPrice + i * priceStep).toFixed(2));
    const pnl = evaluateStrategyPnL(legs, p, 0, volatility);
    miniPayoffPoints.push({ price: p, pnl: Number(pnl.toFixed(2)) });

    if (pnl < minPnl) minPnl = pnl;
    if (pnl > maxPnl) maxPnl = pnl;

    // Detect zero-crossing for breakevens
    if (prevPnl !== null && prevPrice !== null) {
      if ((prevPnl < 0 && pnl >= 0) || (prevPnl >= 0 && pnl < 0)) {
        const be = prevPrice + (0 - prevPnl) * ((p - prevPrice) / (pnl - prevPnl));
        breakevens.push(Number(be.toFixed(2)));
      }
    }
    prevPnl = pnl;
    prevPrice = p;
  }

  // Net debit / credit
  let netCost = 0;
  for (const leg of legs) {
    const mult = leg.optionType === "STOCK" ? 1 : 100;
    const sign = leg.side === "BUY" ? 1 : -1;
    netCost += sign * leg.entryPrice * mult * leg.quantity;
  }
  const netDebit = Number(netCost.toFixed(2));

  // Modeled target profit at targetPrice
  const targetProfit = Number(evaluateStrategyPnL(legs, targetPrice, 0, volatility).toFixed(2));

  const lowPayoff = miniPayoffPoints[0]?.pnl ?? 0;
  const highPayoff = miniPayoffPoints[miniPayoffPoints.length - 1]?.pnl ?? 0;

  // Determine Max Loss & Max Profit using asymptotic exposure
  let netHighSlope = 0;
  for (const leg of legs) {
    if (leg.optionType === "CALL") {
      netHighSlope += (leg.side === "BUY" ? 1 : -1) * leg.quantity * 100;
    } else if (leg.optionType === "STOCK") {
      netHighSlope += (leg.side === "BUY" ? 1 : -1) * leg.quantity;
    }
  }

  const hasUnboundedGain = netHighSlope > 0;
  const hasInfiniteLoss = netHighSlope < 0;

  const maxLoss = hasInfiniteLoss ? null : Math.abs(Math.min(0, minPnl));
  const maxProfit = hasUnboundedGain ? null : Math.max(0, maxPnl);

  // Est Margin / Collateral
  let estMargin = 0;
  const isCreditSpread = netDebit < 0;
  if (hasInfiniteLoss) {
    estMargin = spot * 0.2 * 100; // standard approx for naked options
  } else if (maxLoss !== null) {
    estMargin = Math.max(Math.abs(netDebit), maxLoss);
  }

  // Check specific strategies for collateral conventions
  const hasShortPutOnly = legs.length === 1 && legs[0].optionType === "PUT" && legs[0].side === "SELL";
  const hasCoveredCall = legs.some((l) => l.optionType === "STOCK") && legs.some((l) => l.optionType === "CALL");

  if (hasShortPutOnly) {
    estMargin = legs[0].strike * 100;
  } else if (hasCoveredCall) {
    estMargin = spot * 100;
  }

  // Risk or collateral stat
  const riskOrCollateral = maxLoss !== null && maxLoss > 0 ? maxLoss : estMargin;

  // Returns on risk and collateral
  let returnOnRiskPct: number | null = null;
  let returnOnCollateralPct: number | null = null;

  if (riskOrCollateral > 0) {
    const gainToMeasure = targetProfit > 0 ? targetProfit : (maxProfit ?? 0);
    const ret = (gainToMeasure / riskOrCollateral) * 100;
    if (hasShortPutOnly || hasCoveredCall || isCreditSpread) {
      returnOnCollateralPct = Number(ret.toFixed(1));
    } else {
      returnOnRiskPct = Number(ret.toFixed(0));
    }
  }

  // POP Chance of profit
  const lowProfit = lowPayoff > 0;
  const highProfit = highPayoff > 0;
  const pop = calculateProbabilityOfProfit(spot, breakevens, { lowProfit, highProfit }, tExpiryYears, volatility);
  const chanceOfProfit = Math.round(pop * 100);

  // Breakeven text
  let breakevenText = "None";
  if (breakevens.length === 1) {
    const be = breakevens[0];
    const pctDiff = (((be - spot) / spot) * 100).toFixed(0);
    const sign = Number(pctDiff) >= 0 ? `+${pctDiff}%` : `${pctDiff}%`;
    breakevenText = highProfit ? `Above $${be.toFixed(2)} (${sign})` : `Below $${be.toFixed(2)} (${sign})`;
  } else if (breakevens.length >= 2) {
    breakevenText = breakevens.map((b) => `$${b.toFixed(2)}`).join(" · ");
  }

  // Factors evaluation
  const cushionPct = breakevens.length > 0
    ? Number(((Math.min(...breakevens.map((b) => Math.abs(b - spot))) / spot) * 100).toFixed(1))
    : 0;

  const retVal = returnOnRiskPct ?? returnOnCollateralPct ?? 25;
  const returnScore = Math.min(100, Math.max(5, Math.round((retVal / 250) * 100)));
  const chanceScore = Math.min(100, Math.max(5, chanceOfProfit));
  const cushionScore = Math.min(100, Math.max(5, Math.round(cushionPct * 4)));
  const capitalEfficiencyScore = riskOrCollateral > 0
    ? Math.min(100, Math.max(10, Math.round((targetProfit / Math.max(100, riskOrCollateral)) * 100)))
    : 50;

  const optFactors = getOptimizationFactors(optimizationBias);
  const compositeScore = Math.round(
    (returnScore * optFactors.returnWeight +
      chanceScore * optFactors.chanceWeight +
      cushionScore * optFactors.safetyWeight +
      capitalEfficiencyScore * optFactors.capitalWeight) /
      100
  );

  const factors: StrategyEvaluationFactors = {
    returnScore,
    chanceScore,
    cushionPct,
    cushionScore,
    capitalEfficiencyScore,
    compositeScore,
  };

  return {
    id: `${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${Date.now()}`,
    name,
    category,
    subtitle,
    theses,
    legs,
    netDebit,
    estMargin: Math.round(estMargin),
    maxProfit: maxProfit !== null ? Number(maxProfit.toFixed(2)) : null,
    maxLoss: maxLoss !== null ? Number(maxLoss.toFixed(2)) : null,
    targetProfit,
    riskOrCollateral: Math.round(riskOrCollateral),
    returnOnRiskPct,
    returnOnCollateralPct,
    chanceOfProfit,
    breakevens,
    breakevenText,
    miniPayoffPoints,
    expirationDate,
    dte,
    description,
    factors,
  };
}

/**
 * Master Strategy Discovery Generator: builds the exact strategies seen in OptionStrat
 * based on ticker, current price, sentiment, target price, budget, expiration, and optimization slider.
 */
export function discoverStrategies(options: {
  symbol: string;
  currentPrice: number;
  sentiment: SentimentType;
  targetPrice: number;
  budget?: number | null;
  expiration: ExpirationOption;
  optimizationBias: number; // 0 = Max Return (OTM), 100 = Max Chance (ITM)
  baseIv?: number;
  config?: Partial<StrategyDiscoveryConfig>;
}): DiscoveredStrategy[] {
  const { symbol, currentPrice: spot, sentiment, targetPrice, expiration, optimizationBias, baseIv = 0.442, config } = options;
  const dte = expiration.dte;
  const expiryDate = expiration.date;
  const strikes = generateStrikeLadder(spot);
  const r = config?.riskFreeRate ?? 0.04;

  // Find ATM strike index
  let atmIndex = 0;
  let minDiff = Infinity;
  strikes.forEach((k, idx) => {
    const diff = Math.abs(k - spot);
    if (diff < minDiff) {
      minDiff = diff;
      atmIndex = idx;
    }
  });

  // Shift strikes based on optimizationBias (0 to 100)
  // Max Return (0) -> pushes further OTM
  // Max Chance (100) -> pushes ITM / safer
  const biasShift = Math.round(((50 - optimizationBias) / 50) * 3);

  const getStrike = (offset: number) => {
    const idx = Math.max(0, Math.min(strikes.length - 1, atmIndex + offset + biasShift));
    return strikes[idx];
  };

  const results: DiscoveredStrategy[] = [];

  // ==========================================
  // BULLISH & VERY BULLISH STRATEGIES
  // ==========================================
  if (sentiment === "bullish" || sentiment === "very_bullish") {
    // 1. Long Call
    const callStrike = sentiment === "very_bullish" ? getStrike(-4) : getStrike(-2); // deep in the money or near-ATM
    const longCallLeg = makeLeg("BUY", "CALL", callStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Long Call",
        "Single Leg",
        `Buy ${callStrike}C`,
        ["bullish", "very_bullish"],
        [longCallLeg],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Direct leveraged call option; unlimited upside potential with strictly defined capital risk."
      )
    );

    // 2. Covered Call
    const covCallStrike = getStrike(4);
    const stockLeg = makeStockLeg("BUY", spot, 100, expiryDate, dte);
    const shortCallLeg = makeLeg("SELL", "CALL", covCallStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Covered Call",
        "Stock + Option",
        `Own the underlying, Sell ${covCallStrike}C`,
        ["bullish"],
        [stockLeg, shortCallLeg],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Generate cash yield against stock holdings with buffered downside."
      )
    );

    // 3. Cash-Secured Put
    const cspStrike = getStrike(-6);
    const cspLeg = makeLeg("SELL", "PUT", cspStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Cash-Secured Put",
        "Single Leg",
        `Sell ${cspStrike}P, Have cash to buy shares if assigned`,
        ["bullish"],
        [cspLeg],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Collect premium while setting a discounted target purchase price for the stock."
      )
    );

    // 4. Short Put
    results.push(
      analyzeStrategy(
        "Short Put",
        "Single Leg",
        `Sell ${cspStrike}P`,
        ["bullish"],
        [cspLeg],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "High probability of profit option writing benefiting from theta decay."
      )
    );

    // 5. Bull Call Spread (Call Debit Spread)
    const bcsBuyStrike = getStrike(-1);
    const bcsSellStrike = getStrike(6);
    const bcsBuy = makeLeg("BUY", "CALL", bcsBuyStrike, spot, dte, expiryDate, baseIv);
    const bcsSell = makeLeg("SELL", "CALL", bcsSellStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Bull Call Spread",
        "Vertical Spread",
        `Buy ${bcsBuyStrike}C, Sell ${bcsSellStrike}C`,
        ["bullish", "very_bullish"],
        [bcsBuy, bcsSell],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Defined-risk bullish vertical spread reducing entry cost via sold upside call."
      )
    );

    // 6. Bull Put Spread (Put Credit Spread)
    const bpsSellStrike = getStrike(-2);
    const bpsBuyStrike = getStrike(-8);
    const bpsSell = makeLeg("SELL", "PUT", bpsSellStrike, spot, dte, expiryDate, baseIv);
    const bpsBuy = makeLeg("BUY", "PUT", bpsBuyStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Bull Put Spread",
        "Vertical Spread",
        `Buy ${bpsBuyStrike}P, Sell ${bpsSellStrike}P`,
        ["bullish"],
        [bpsBuy, bpsSell],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Collect upfront net credit that expires worthless if stock stays above the short strike."
      )
    );

    // 7. Synthetic Long Future / Stock
    const synStrike = getStrike(0);
    const synCall = makeLeg("BUY", "CALL", synStrike, spot, dte, expiryDate, baseIv);
    const synPut = makeLeg("SELL", "PUT", synStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Long Synthetic Future",
        "Synthetic",
        `Buy ${synStrike}C, Sell ${synStrike}P`,
        ["very_bullish"],
        [synCall, synPut],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Replicates 100 delta long stock performance with minimal upfront capital."
      )
    );
  }

  // ==========================================
  // BEARISH & VERY BEARISH STRATEGIES
  // ==========================================
  else if (sentiment === "bearish" || sentiment === "very_bearish") {
    // 1. Long Put
    const putStrike = sentiment === "very_bearish" ? getStrike(4) : getStrike(1);
    const longPutLeg = makeLeg("BUY", "PUT", putStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Long Put",
        "Single Leg",
        `Buy ${putStrike}P`,
        ["bearish", "very_bearish"],
        [longPutLeg],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Direct bearish option capitalizing on underlying price drops and rising volatility."
      )
    );

    // 2. Bear Put Spread (Put Debit Spread)
    const bdsBuyStrike = getStrike(1);
    const bdsSellStrike = getStrike(-5);
    const bdsBuy = makeLeg("BUY", "PUT", bdsBuyStrike, spot, dte, expiryDate, baseIv);
    const bdsSell = makeLeg("SELL", "PUT", bdsSellStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Bear Put Spread",
        "Vertical Spread",
        `Buy ${bdsBuyStrike}P, Sell ${bdsSellStrike}P`,
        ["bearish", "very_bearish"],
        [bdsBuy, bdsSell],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Defined-risk downside play selling a lower put to fund the higher put purchase."
      )
    );

    // 3. Bear Call Spread (Call Credit Spread)
    const bcsSellStrike = getStrike(1);
    const bcsBuyStrike = getStrike(6);
    const bcsSell = makeLeg("SELL", "CALL", bcsSellStrike, spot, dte, expiryDate, baseIv);
    const bcsBuy = makeLeg("BUY", "CALL", bcsBuyStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Bear Call Spread",
        "Vertical Spread",
        `Sell ${bcsSellStrike}C, Buy ${bcsBuyStrike}C`,
        ["bearish"],
        [bcsSell, bcsBuy],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Credit vertical profiting from downward movement, stagnation, or modest rise."
      )
    );

    // 4. Short Call
    const shortCallStrike = getStrike(4);
    const shortCallLeg = makeLeg("SELL", "CALL", shortCallStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Short Call",
        "Single Leg",
        `Sell ${shortCallStrike}C`,
        ["bearish"],
        [shortCallLeg],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Naked call collection benefiting from stock decline or time decay; infinite upside risk."
      )
    );

    // 5. Short Synthetic Future
    const synStrike = getStrike(0);
    const synPut = makeLeg("BUY", "PUT", synStrike, spot, dte, expiryDate, baseIv);
    const synCall = makeLeg("SELL", "CALL", synStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Short Synthetic Future",
        "Synthetic",
        `Buy ${synStrike}P, Sell ${synStrike}C`,
        ["very_bearish"],
        [synPut, synCall],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Simulates short stock position using long put and short call at identical strikes."
      )
    );

    // 6. Covered Put
    const covPutStrike = getStrike(-4);
    const stockShort = makeStockLeg("SELL", spot, 100, expiryDate, dte);
    const covPutLeg = makeLeg("SELL", "PUT", covPutStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Covered Put",
        "Stock + Option",
        `Short the underlying, Sell ${covPutStrike}P`,
        ["bearish"],
        [stockShort, covPutLeg],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Bearish income strategy shorting shares while harvesting put premium."
      )
    );
  }

  // ==========================================
  // NEUTRAL STRATEGIES (Range-Bound / Low Vol)
  // ==========================================
  else if (sentiment === "neutral") {
    // 1. Iron Condor
    const icPutBuy = makeLeg("BUY", "PUT", getStrike(-7), spot, dte, expiryDate, baseIv);
    const icPutSell = makeLeg("SELL", "PUT", getStrike(-3), spot, dte, expiryDate, baseIv);
    const icCallSell = makeLeg("SELL", "CALL", getStrike(3), spot, dte, expiryDate, baseIv);
    const icCallBuy = makeLeg("BUY", "CALL", getStrike(7), spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Iron Condor",
        "Condor",
        `Sell ${icPutSell.strike}P/${icCallSell.strike}C Wings ${icPutBuy.strike}P/${icCallBuy.strike}C`,
        ["neutral"],
        [icPutBuy, icPutSell, icCallSell, icCallBuy],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Premier range-bound strategy collecting maximum premium within a defined price corridor."
      )
    );

    // 2. Iron Butterfly
    const ibPutBuy = makeLeg("BUY", "PUT", getStrike(-5), spot, dte, expiryDate, baseIv);
    const ibPutSell = makeLeg("SELL", "PUT", getStrike(0), spot, dte, expiryDate, baseIv);
    const ibCallSell = makeLeg("SELL", "CALL", getStrike(0), spot, dte, expiryDate, baseIv);
    const ibCallBuy = makeLeg("BUY", "CALL", getStrike(5), spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Iron Butterfly",
        "Butterfly",
        `ATM Straddle at ${getStrike(0)}, Wings ±${getStrike(5) - getStrike(0)}`,
        ["neutral"],
        [ibPutBuy, ibPutSell, ibCallSell, ibCallBuy],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Targeted pinpoint pin play capitalizing on low volatility and maximum time decay."
      )
    );

    // 3. Short Straddle
    const ssAtm = getStrike(0);
    const ssCall = makeLeg("SELL", "CALL", ssAtm, spot, dte, expiryDate, baseIv);
    const ssPut = makeLeg("SELL", "PUT", ssAtm, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Short Straddle",
        "Volatility",
        `Sell ${ssAtm}C & ${ssAtm}P`,
        ["neutral"],
        [ssCall, ssPut],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "High credit income strategy profiting from volatility collapse near current price."
      )
    );

    // 4. Short Strangle
    const ssPutOtm = makeLeg("SELL", "PUT", getStrike(-3), spot, dte, expiryDate, baseIv);
    const ssCallOtm = makeLeg("SELL", "CALL", getStrike(3), spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Short Strangle",
        "Volatility",
        `Sell ${ssPutOtm.strike}P, Sell ${ssCallOtm.strike}C`,
        ["neutral"],
        [ssPutOtm, ssCallOtm],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Wider profit zone short strangle capturing dual-side theta premium decay."
      )
    );

    // 5. Calendar Spread
    const calStrike = getStrike(0);
    const calShort = makeLeg("SELL", "CALL", calStrike, spot, Math.max(7, Math.round(dte * 0.4)), expiryDate, baseIv);
    const calLong = makeLeg("BUY", "CALL", calStrike, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Call Calendar Spread",
        "Time Spread",
        `Sell Near ${calStrike}C, Buy Far ${calStrike}C`,
        ["neutral"],
        [calShort, calLong],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Exploits accelerated theta decay on front-month contract while retaining back-month value."
      )
    );
  }

  // ==========================================
  // DIRECTIONAL / HIGH VOLATILITY STRATEGIES
  // ==========================================
  else if (sentiment === "directional") {
    // 1. Long Straddle
    const lsAtm = getStrike(0);
    const lsCall = makeLeg("BUY", "CALL", lsAtm, spot, dte, expiryDate, baseIv);
    const lsPut = makeLeg("BUY", "PUT", lsAtm, spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Long Straddle",
        "Volatility",
        `Buy ${lsAtm}C & ${lsAtm}P`,
        ["directional"],
        [lsCall, lsPut],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Pure volatility play profiting from explosive expansion in either direction."
      )
    );

    // 2. Long Strangle
    const lStranglePut = makeLeg("BUY", "PUT", getStrike(-3), spot, dte, expiryDate, baseIv);
    const lStrangleCall = makeLeg("BUY", "CALL", getStrike(3), spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Long Strangle",
        "Volatility",
        `Buy ${lStranglePut.strike}P, Buy ${lStrangleCall.strike}C`,
        ["directional"],
        [lStranglePut, lStrangleCall],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Cost-efficient volatility breakout structure with unbounded profit potential."
      )
    );

    // 3. Reverse Iron Condor
    const ricPutSell = makeLeg("SELL", "PUT", getStrike(-7), spot, dte, expiryDate, baseIv);
    const ricPutBuy = makeLeg("BUY", "PUT", getStrike(-3), spot, dte, expiryDate, baseIv);
    const ricCallBuy = makeLeg("BUY", "CALL", getStrike(3), spot, dte, expiryDate, baseIv);
    const ricCallSell = makeLeg("SELL", "CALL", getStrike(7), spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Reverse Iron Condor",
        "Condor",
        `Buy inner ${ricPutBuy.strike}P/${ricCallBuy.strike}C, Sell outer wings`,
        ["directional"],
        [ricPutSell, ricPutBuy, ricCallBuy, ricCallSell],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "Defined-risk breakout structure for major moves while hedging tail risk."
      )
    );

    // 4. Reverse Iron Butterfly
    const ribPutSell = makeLeg("SELL", "PUT", getStrike(-5), spot, dte, expiryDate, baseIv);
    const ribPutBuy = makeLeg("BUY", "PUT", getStrike(0), spot, dte, expiryDate, baseIv);
    const ribCallBuy = makeLeg("BUY", "CALL", getStrike(0), spot, dte, expiryDate, baseIv);
    const ribCallSell = makeLeg("SELL", "CALL", getStrike(5), spot, dte, expiryDate, baseIv);
    results.push(
      analyzeStrategy(
        "Reverse Iron Butterfly",
        "Butterfly",
        `Buy ATM Straddle at ${getStrike(0)}, Sell wings`,
        ["directional"],
        [ribPutSell, ribPutBuy, ribCallBuy, ribCallSell],
        spot,
        targetPrice,
        dte,
        expiryDate,
        baseIv,
        "High-leverage breakout trade on volatile events like earnings announcements."
      )
    );
  }

  let finalResults = results;
  // Filter by budget if provided
  if (options.budget && options.budget > 0) {
    finalResults = results.filter((s) => s.riskOrCollateral <= options.budget!);
  }

  // Sort by composite score to match user's optimization bias
  return finalResults.sort((a, b) => (b.factors?.compositeScore ?? 0) - (a.factors?.compositeScore ?? 0));
}
