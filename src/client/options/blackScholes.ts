/**
 * High-performance Black-Scholes pricing and Greeks engine for options visualizers.
 * Supports exact pricing, Greeks, and intermediate date payoff curves.
 */

export interface OptionGreeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

// Standard normal cumulative distribution function (Abramowitz & Stegun approximation)
export function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

// Standard normal probability density function
export function normalPdf(x: number): number {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

/**
 * Calculates Black-Scholes price and Greeks for European/American options approximation.
 * @param s Current underlying stock price
 * @param k Option strike price
 * @param t Time to expiration in years (e.g. 30 days = 30/365)
 * @param v Implied volatility as a decimal (e.g. 0.442 for 44.2%)
 * @param r Risk-free interest rate (e.g. 0.045 for 4.5%)
 * @param q Continuous dividend yield (default 0)
 * @param type "CALL" or "PUT"
 */
export function blackScholes(
  s: number,
  k: number,
  t: number,
  v: number,
  r: number = 0.04,
  q: number = 0,
  type: "CALL" | "PUT" = "CALL"
): OptionGreeks {
  // Edge cases: expiration or zero time
  if (t <= 0.0001) {
    const intrinsic = type === "CALL" ? Math.max(0, s - k) : Math.max(0, k - s);
    const delta = type === "CALL" ? (s > k ? 1 : 0) : (s < k ? -1 : 0);
    return {
      price: intrinsic,
      delta,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
    };
  }

  // Ensure volatility is positive
  const vol = Math.max(0.01, v);
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + 0.5 * vol * vol) * t) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;

  const expRt = Math.exp(-r * t);
  const expQt = Math.exp(-q * t);
  const pdfD1 = normalPdf(d1);

  if (type === "CALL") {
    const cdfD1 = normalCdf(d1);
    const cdfD2 = normalCdf(d2);
    const price = s * expQt * cdfD1 - k * expRt * cdfD2;
    const delta = expQt * cdfD1;
    const gamma = (expQt * pdfD1) / (s * vol * sqrtT);
    const thetaYears = -((s * vol * expQt * pdfD1) / (2 * sqrtT)) - r * k * expRt * cdfD2 + q * s * expQt * cdfD1;
    const theta = thetaYears / 365; // per day
    const vega = (s * expQt * sqrtT * pdfD1) / 100; // per 1% IV change
    const rho = (k * t * expRt * cdfD2) / 100;

    return {
      price: Math.max(0, price),
      delta,
      gamma,
      theta,
      vega,
      rho,
    };
  } else {
    const cdfNegD1 = normalCdf(-d1);
    const cdfNegD2 = normalCdf(-d2);
    const price = k * expRt * cdfNegD2 - s * expQt * cdfNegD1;
    const delta = -expQt * cdfNegD1;
    const gamma = (expQt * pdfD1) / (s * vol * sqrtT);
    const thetaYears = -((s * vol * expQt * pdfD1) / (2 * sqrtT)) + r * k * expRt * cdfNegD2 - q * s * expQt * cdfNegD1;
    const theta = thetaYears / 365; // per day
    const vega = (s * expQt * sqrtT * pdfD1) / 100;
    const rho = (-k * t * expRt * cdfNegD2) / 100;

    return {
      price: Math.max(0, price),
      delta,
      gamma,
      theta,
      vega,
      rho,
    };
  }
}

/**
 * Calculates probability of profit (POP) at expiration for given breakevens and payoff directions.
 */
export function calculateProbabilityOfProfit(
  spot: number,
  breakevens: number[],
  payoffAtLimits: { lowProfit: boolean; highProfit: boolean },
  timeToExpiryYears: number,
  volatility: number,
  riskFreeRate: number = 0.045
): number {
  if (breakevens.length === 0) {
    return payoffAtLimits.lowProfit && payoffAtLimits.highProfit ? 1.0 : 0.0;
  }

  const vol = Math.max(0.05, volatility);
  const t = Math.max(1 / 365, timeToExpiryYears);
  const mu = Math.log(spot) + (riskFreeRate - 0.5 * vol * vol) * t;
  const std = vol * Math.sqrt(t);

  const probBelow = (price: number) => normalCdf((Math.log(price) - mu) / std);

  if (breakevens.length === 1) {
    const be = breakevens[0];
    const pBelow = probBelow(be);
    return payoffAtLimits.highProfit ? 1 - pBelow : pBelow;
  }

  if (breakevens.length === 2) {
    const be1 = Math.min(breakevens[0], breakevens[1]);
    const be2 = Math.max(breakevens[0], breakevens[1]);
    const pBetween = Math.max(0, probBelow(be2) - probBelow(be1));
    return payoffAtLimits.lowProfit ? 1 - pBetween : pBetween;
  }

  // Multi-breakeven fallback
  return 0.5;
}

/**
 * Calculates log-normal probability distribution density points for chart overlay bell curve.
 */
export function calculateProbabilityDensityPoints(
  spot: number,
  timeToExpiryYears: number,
  volatility: number,
  priceMin: number,
  priceMax: number,
  steps: number = 60,
  riskFreeRate: number = 0.04
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
  riskFreeRate: number = 0.04
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

