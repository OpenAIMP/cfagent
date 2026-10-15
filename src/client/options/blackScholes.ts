/**
 * Black-Scholes pricing, Greeks, and probability helpers for options
 * visualizers.
 *
 * SINGLE-SOURCE NOTE (issue #38, gap G5): the math itself lives in
 * src/shared/riskMath.ts — the one implementation the server engine and
 * this client both use. This module keeps the historical client-facing
 * signatures and delegates. Do not re-add local copies of these formulas
 * or local constant defaults; change them in the shared module instead.
 */

import {
  RISK_MATH,
  blackScholesGreeks,
  normalCdf,
  normalPdf,
  probabilityOfProfitFromFlags,
  type OptionGreeks,
} from "../../shared/riskMath";

export { normalCdf, normalPdf };
export type { OptionGreeks };

export function blackScholes(
  s: number,
  k: number,
  t: number,
  v: number,
  r: number = RISK_MATH.riskFreeRate,
  q: number = RISK_MATH.dividendYield,
  type: "CALL" | "PUT" = "CALL",
): OptionGreeks {
  return blackScholesGreeks(s, k, t, v, r, q, type);
}

/**
 * Calculates probability of profit (POP) at expiration for given breakevens
 * and payoff directions. Delegates to the shared segment-integration method
 * (identical to the server engine's), so any breakeven count works and
 * client/server results agree for identical inputs.
 */
export function calculateProbabilityOfProfit(
  spot: number,
  breakevens: number[],
  payoffAtLimits: { lowProfit: boolean; highProfit: boolean },
  timeToExpiryYears: number,
  volatility: number,
  riskFreeRate: number = RISK_MATH.riskFreeRate,
  dividendYield: number = RISK_MATH.dividendYield,
): number {
  return probabilityOfProfitFromFlags({
    spot,
    breakevens,
    payoffAtLimits,
    timeToExpiryYears,
    volatility,
    riskFreeRate,
    dividendYield,
  });
}

/**
 * Calculates log-normal probability distribution density points for chart overlay bell curve.
 * (Client-only visualization helper; the distribution parameters match the
 * shared POP model.)
 */
export function calculateProbabilityDensityPoints(
  spot: number,
  timeToExpiryYears: number,
  volatility: number,
  priceMin: number,
  priceMax: number,
  steps: number = 60,
  riskFreeRate: number = RISK_MATH.riskFreeRate,
): Array<{ price: number; density: number; probBelow: number }> {
  const t = Math.max(1 / 365, timeToExpiryYears);
  const vol = Math.max(0.05, volatility);
  const mu = Math.log(spot) + (riskFreeRate - 0.5 * vol * vol) * t;
  const std = vol * Math.sqrt(t);

  const stepSize = (priceMax - priceMin) / Math.max(1, steps - 1);
  const points: Array<{ price: number; density: number; probBelow: number }> = [];

  for (let i = 0; i < steps; i++) {
    const p = priceMin + i * stepSize;
    if (p <= 0.01) continue;
    const logP = Math.log(p);
    const z = (logP - mu) / std;
    const density = normalPdf(z) / (p * std);
    const probBelow = normalCdf(z);
    points.push({ price: Number(p.toFixed(2)), density, probBelow });
  }

  return points;
}

/**
 * Calculates percentage chance that stock price will be below or above target price on selected date.
 */
export function calculateProbabilityAboveBelow(
  spot: number,
  targetPrice: number,
  timeToExpiryYears: number,
  volatility: number,
  riskFreeRate: number = RISK_MATH.riskFreeRate,
): { probBelowPct: number; probAbovePct: number } {
  if (targetPrice <= 0 || spot <= 0) {
    return { probBelowPct: 50, probAbovePct: 50 };
  }
  const t = Math.max(1 / 365, timeToExpiryYears);
  const vol = Math.max(0.05, volatility);
  const mu = Math.log(spot) + (riskFreeRate - 0.5 * vol * vol) * t;
  const std = vol * Math.sqrt(t);

  const z = (Math.log(targetPrice) - mu) / std;
  const pBelow = normalCdf(z);
  const probBelowPct = Number((pBelow * 100).toFixed(1));
  const probAbovePct = Number(((1 - pBelow) * 100).toFixed(1));

  return { probBelowPct, probAbovePct };
}
