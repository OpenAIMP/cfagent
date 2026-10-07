/**
 * OptionStrat-Grade Strategy Library
 * Defines 72 pre-made options strategies covering the complete OptionStrat catalog:
 * - Bullish (18)
 * - Bearish (15)
 * - Neutral (14)
 * - Volatility & Breakout (16)
 * - Synthetics & Advanced Spreads (9)
 *
 * Each strategy includes:
 * - Unique ID and name
 * - Category and subtitle
 * - Detailed description of trading mechanics and risks
 * - Associated market sentiments
 * - Thumbnail P&L shape coordinates for visual selection
 * - Leg generator function based on spot price, DTE, and IV
 */

import type { SentimentType, StrategyLegItem } from "./strategyDiscoveryEngine";
import { blackScholes } from "./blackScholes";

export interface StrategyDefinition {
  id: string;
  name: string;
  category: "Bullish" | "Bearish" | "Neutral" | "Volatility" | "Synthetics & Spreads";
  subtitle: string;
  description: string;
  theses: SentimentType[];
  riskType: "Defined" | "Undefined" | "Covered";
  legsCount: number;
  /** SVG Path definition for the P&L curve thumbnail */
  pnlSvgPath: string;
  /** Factory to build legs for this strategy given market parameters */
  buildLegs: (spot: number, dte: number, expiryDate: string, iv: number, r?: number) => StrategyLegItem[];
}

// Helper to make a standardized option leg
function createLeg(
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
    id: `${optionType}_${strike}_${side}_${Math.random().toString(36).slice(2, 7)}`,
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

function createStockLeg(
  side: "BUY" | "SELL",
  spot: number,
  quantity: number = 100,
  expirationDate: string = "",
  dte: number = 0
): StrategyLegItem {
  return {
    id: `STOCK_${side}_${quantity}_${Math.random().toString(36).slice(2, 7)}`,
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

// Strike rounding helper based on underlying price
function roundStrike(price: number, step: number): number {
  return Math.round(price / step) * step;
}

function getStrikeStep(spot: number): number {
  if (spot > 500) return 10;
  if (spot > 200) return 5;
  if (spot > 100) return 2.5;
  if (spot > 50) return 1;
  if (spot > 20) return 0.5;
  return 0.25;
}

export const STRATEGY_LIBRARY: StrategyDefinition[] = [
  // ==========================================
  // BULLISH STRATEGIES (14)
  // ==========================================
  {
    id: "long_call",
    name: "Long Call",
    category: "Bullish",
    subtitle: "Buy 1 Call",
    description: "Direct leveraged call purchase. Profits if stock rises above strike plus premium paid. Strictly defined risk.",
    theses: ["bullish", "very_bullish"],
    riskType: "Defined",
    legsCount: 1,
    pnlSvgPath: "M 0 35 L 45 35 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 1.02, step);
      return [createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 1, r)];
    },
  },
  {
    id: "covered_call",
    name: "Covered Call",
    category: "Bullish",
    subtitle: "Long 100 Shares + Sell 1 OTM Call",
    description: "Own 100 shares of stock and sell an out-of-the-money call for cash income. Caps upside while providing slight downside buffer.",
    theses: ["bullish"],
    riskType: "Covered",
    legsCount: 2,
    pnlSvgPath: "M 0 45 L 60 15 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const callStrike = roundStrike(spot * 1.05, step);
      return [
        createStockLeg("BUY", spot, 100, exp, dte),
        createLeg("SELL", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "cash_secured_put",
    name: "Cash-Secured Put",
    category: "Bullish",
    subtitle: "Sell 1 OTM Put",
    description: "Sell an out-of-the-money put with collateral held to purchase shares. High probability income or acquire stock at discount.",
    theses: ["bullish"],
    riskType: "Defined",
    legsCount: 1,
    pnlSvgPath: "M 0 45 L 40 15 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 0.95, step);
      return [createLeg("SELL", "PUT", strike, spot, dte, exp, iv, 1, r)];
    },
  },
  {
    id: "short_put",
    name: "Short Put",
    category: "Bullish",
    subtitle: "Sell 1 OTM Put (Naked)",
    description: "Sell an out-of-the-money put for upfront credit. High probability of profit with substantial assignment risk.",
    theses: ["bullish"],
    riskType: "Undefined",
    legsCount: 1,
    pnlSvgPath: "M 0 45 L 40 15 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 0.95, step);
      return [createLeg("SELL", "PUT", strike, spot, dte, exp, iv, 1, r)];
    },
  },
  {
    id: "bull_call_spread",
    name: "Bull Call Spread",
    category: "Bullish",
    subtitle: "Buy Lower Call + Sell Higher Call",
    description: "Debit vertical spread. Selling higher call reduces entry cost of long call while capping maximum profit at higher strike.",
    theses: ["bullish", "very_bullish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 38 L 30 38 L 65 10 L 90 10",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.98, step);
      const k2 = roundStrike(spot * 1.06, step);
      return [
        createLeg("BUY", "CALL", k1, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", k2, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "bull_put_spread",
    name: "Bull Put Spread",
    category: "Bullish",
    subtitle: "Sell Higher Put + Buy Lower Put",
    description: "Credit vertical spread. Earns upfront credit if stock stays above short put. Defined risk protected by long put wing.",
    theses: ["bullish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 40 L 30 40 L 60 12 L 90 12",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const kShort = roundStrike(spot * 0.97, step);
      const kLong = roundStrike(spot * 0.90, step);
      return [
        createLeg("SELL", "PUT", kShort, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", kLong, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "call_ratio_front_spread",
    name: "Call Ratio Spread",
    category: "Bullish",
    subtitle: "Buy 1 ITM Call + Sell 2 OTM Calls",
    description: "Modest bullish trade with peak profit at short strikes. Extra sold call finances position; carries upside risk beyond peak.",
    theses: ["bullish"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 30 L 35 30 L 60 5 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.98, step);
      const k2 = roundStrike(spot * 1.05, step);
      return [
        createLeg("BUY", "CALL", k1, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", k2, spot, dte, exp, iv, 2, r),
      ];
    },
  },
  {
    id: "call_ratio_backspread",
    name: "Call Ratio Backspread",
    category: "Bullish",
    subtitle: "Sell 1 ITM Call + Buy 2 OTM Calls",
    description: "Aggressive bullish breakout play with unlimited upside. Financed by selling 1 ITM call, with dead zone in the middle.",
    theses: ["very_bullish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 25 L 35 25 L 55 42 L 90 0",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.97, step);
      const k2 = roundStrike(spot * 1.04, step);
      return [
        createLeg("SELL", "CALL", k1, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", k2, spot, dte, exp, iv, 2, r),
      ];
    },
  },
  {
    id: "bull_calendar_spread",
    name: "Bull Calendar Spread",
    category: "Bullish",
    subtitle: "Sell Near OTM Call + Buy Far OTM Call",
    description: "Horizontal time decay spread targeting upside price node with front month expiring worthless.",
    theses: ["bullish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 35 L 35 35 L 60 8 L 85 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 1.05, step);
      const nearDte = Math.max(7, Math.round(dte * 0.4));
      return [
        createLeg("SELL", "CALL", strike, spot, nearDte, exp, iv, 1, r),
        createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "bull_diagonal_spread",
    name: "Diagonal Call Spread",
    category: "Bullish",
    subtitle: "Buy Far ITM Call + Sell Near OTM Call",
    description: "Poor Man's Covered Call. Deep ITM long-dated LEAPS call acts as synthetic stock, selling near-term monthly calls for income.",
    theses: ["bullish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 40 L 50 15 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const longStrike = roundStrike(spot * 0.85, step);
      const shortStrike = roundStrike(spot * 1.04, step);
      const nearDte = Math.max(7, Math.round(dte * 0.3));
      return [
        createLeg("BUY", "CALL", longStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", shortStrike, spot, nearDte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "synthetic_long_stock",
    name: "Synthetic Long Stock",
    category: "Bullish",
    subtitle: "Buy ATM Call + Sell ATM Put",
    description: "Replicates 100 delta long stock behavior with near-zero upfront debit. Carries equivalent downside risk to owning shares.",
    theses: ["very_bullish"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 45 L 45 25 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "protective_collar",
    name: "Collar",
    category: "Bullish",
    subtitle: "Long 100 Shares + Buy OTM Put + Sell OTM Call",
    description: "Protects stock investment against large declines by buying put, funded by selling an out-of-the-money call.",
    theses: ["bullish"],
    riskType: "Covered",
    legsCount: 3,
    pnlSvgPath: "M 0 35 L 35 35 L 65 15 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.92, step);
      const callStrike = roundStrike(spot * 1.08, step);
      return [
        createStockLeg("BUY", spot, 100, exp, dte),
        createLeg("BUY", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "covered_strangle",
    name: "Covered Strangle",
    category: "Bullish",
    subtitle: "Long 100 Shares + Sell OTM Call + Sell OTM Put",
    description: "Harvests dual premium against long stock holdings. Generates elevated cash yield with willingness to buy more shares.",
    theses: ["bullish"],
    riskType: "Covered",
    legsCount: 3,
    pnlSvgPath: "M 0 45 L 35 25 L 70 10 L 90 10",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.92, step);
      const callStrike = roundStrike(spot * 1.08, step);
      return [
        createStockLeg("BUY", spot, 100, exp, dte),
        createLeg("SELL", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "risk_reversal_bull",
    name: "Risk Reversal (Bullish)",
    category: "Bullish",
    subtitle: "Sell OTM Put + Buy OTM Call",
    description: "Finances upside call purchase by selling downside put. Extremely capital-efficient bullish expression with assignment risk.",
    theses: ["bullish", "very_bullish"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 45 L 35 25 L 60 25 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.93, step);
      const callStrike = roundStrike(spot * 1.07, step);
      return [
        createLeg("SELL", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "long_call_butterfly_bull",
    name: "Bullish Call Butterfly",
    category: "Bullish",
    subtitle: "Buy 1 Call, Sell 2 Calls, Buy 1 Call (Skewed)",
    description: "High return-on-risk butterfly pinned slightly above current spot price.",
    theses: ["bullish"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 35 L 35 35 L 60 8 L 85 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot * 1.06, step);
      const width = step * 4;
      return [
        createLeg("BUY", "CALL", center - width, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", center, spot, dte, exp, iv, 2, r),
        createLeg("BUY", "CALL", center + width, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "protective_put",
    name: "Protective Put",
    category: "Bullish",
    subtitle: "Long 100 Shares + Buy 1 OTM Put",
    description: "Own 100 shares of stock and purchase an out-of-the-money put to establish a strict downside loss floor with unlimited upside.",
    theses: ["bullish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 35 L 45 35 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.94, step);
      return [
        createStockLeg("BUY", spot, 100, exp, dte),
        createLeg("BUY", "PUT", putStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "covered_short_straddle",
    name: "Covered Short Straddle",
    category: "Bullish",
    subtitle: "Long 100 Shares + Sell ATM Straddle",
    description: "Own 100 shares of stock and sell an ATM call and ATM put to maximize total premium collected.",
    theses: ["bullish"],
    riskType: "Covered",
    legsCount: 3,
    pnlSvgPath: "M 0 45 L 45 10 L 90 10",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createStockLeg("BUY", spot, 100, exp, dte),
        createLeg("SELL", "CALL", strike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "bull_call_ladder",
    name: "Bull Call Ladder",
    category: "Bullish",
    subtitle: "Buy 1 ITM Call + Sell 1 ATM Call + Sell 1 OTM Call",
    description: "Bull call spread plus an extra sold higher call. Financed entry with downside buffer, but upside risk beyond top strike.",
    theses: ["bullish"],
    riskType: "Undefined",
    legsCount: 3,
    pnlSvgPath: "M 0 35 L 30 35 L 60 10 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.96, step);
      const k2 = roundStrike(spot * 1.02, step);
      const k3 = roundStrike(spot * 1.08, step);
      return [
        createLeg("BUY", "CALL", k1, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", k2, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", k3, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "poor_mans_covered_call",
    name: "Poor Man's Covered Call",
    category: "Bullish",
    subtitle: "Buy Far ITM Call (LEAPS) + Sell Near OTM Call",
    description: "Deep in-the-money long-dated call functions as synthetic stock, selling near-term monthly calls for consistent income.",
    theses: ["bullish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 40 L 50 15 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const longStrike = roundStrike(spot * 0.85, step);
      const shortStrike = roundStrike(spot * 1.05, step);
      const nearDte = Math.max(7, Math.round(dte * 0.3));
      return [
        createLeg("BUY", "CALL", longStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", shortStrike, spot, nearDte, exp, iv, 1, r),
      ];
    },
  },

  // ==========================================
  // BEARISH STRATEGIES
  // ==========================================
  {
    id: "long_put",
    name: "Long Put",
    category: "Bearish",
    subtitle: "Buy 1 Put",
    description: "Direct bearish leverage. Profits from stock declines and rising volatility. Risk limited to premium paid.",
    theses: ["bearish", "very_bearish"],
    riskType: "Defined",
    legsCount: 1,
    pnlSvgPath: "M 0 5 L 45 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 0.98, step);
      return [createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 1, r)];
    },
  },
  {
    id: "bear_put_spread",
    name: "Bear Put Spread",
    category: "Bearish",
    subtitle: "Buy Higher Put + Sell Lower Put",
    description: "Debit vertical spread. Lower sold put offsets long put cost. Defined risk and defined maximum gain.",
    theses: ["bearish", "very_bearish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 10 L 35 10 L 70 38 L 90 38",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const kHigh = roundStrike(spot * 1.02, step);
      const kLow = roundStrike(spot * 0.94, step);
      return [
        createLeg("BUY", "PUT", kHigh, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", kLow, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "bear_call_spread",
    name: "Bear Call Spread",
    category: "Bearish",
    subtitle: "Sell Lower Call + Buy Higher Call",
    description: "Credit vertical spread. Earns upfront credit if stock stays below short call strike. High win probability.",
    theses: ["bearish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 12 L 30 12 L 60 40 L 90 40",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const kShort = roundStrike(spot * 1.03, step);
      const kLong = roundStrike(spot * 1.10, step);
      return [
        createLeg("SELL", "CALL", kShort, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", kLong, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "covered_put",
    name: "Covered Put",
    category: "Bearish",
    subtitle: "Short 100 Shares + Sell 1 OTM Put",
    description: "Short stock position combined with short put sale. Generates premium while creating obligation to buy back at strike.",
    theses: ["bearish"],
    riskType: "Covered",
    legsCount: 2,
    pnlSvgPath: "M 0 15 L 45 15 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 0.95, step);
      return [
        createStockLeg("SELL", spot, 100, exp, dte),
        createLeg("SELL", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "short_call",
    name: "Short Call",
    category: "Bearish",
    subtitle: "Sell 1 OTM Call (Naked)",
    description: "Harvests upfront call premium expecting stagnation or downward movement. Carries undefined upside risk.",
    theses: ["bearish"],
    riskType: "Undefined",
    legsCount: 1,
    pnlSvgPath: "M 0 15 L 50 15 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 1.05, step);
      return [createLeg("SELL", "CALL", strike, spot, dte, exp, iv, 1, r)];
    },
  },
  {
    id: "put_ratio_front_spread",
    name: "Put Ratio Spread",
    category: "Bearish",
    subtitle: "Buy 1 ITM Put + Sell 2 OTM Puts",
    description: "Targeted bearish structure with peak profit at short puts. Extra sold put finances trade; downside risk below lower breakeven.",
    theses: ["bearish"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 45 L 30 5 L 65 30 L 90 30",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 1.02, step);
      const k2 = roundStrike(spot * 0.95, step);
      return [
        createLeg("BUY", "PUT", k1, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", k2, spot, dte, exp, iv, 2, r),
      ];
    },
  },
  {
    id: "put_ratio_backspread",
    name: "Put Ratio Backspread",
    category: "Bearish",
    subtitle: "Sell 1 ITM Put + Buy 2 OTM Puts",
    description: "Aggressive crash leverage play profiting from catastrophic drops and volatility spikes.",
    theses: ["very_bearish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 0 L 35 42 L 55 25 L 90 25",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 1.03, step);
      const k2 = roundStrike(spot * 0.96, step);
      return [
        createLeg("SELL", "PUT", k1, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", k2, spot, dte, exp, iv, 2, r),
      ];
    },
  },
  {
    id: "bear_calendar_spread",
    name: "Bear Calendar Spread",
    category: "Bearish",
    subtitle: "Sell Near OTM Put + Buy Far OTM Put",
    description: "Time decay calendar with bearish downside target node.",
    theses: ["bearish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 35 L 25 8 L 50 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 0.95, step);
      const nearDte = Math.max(7, Math.round(dte * 0.4));
      return [
        createLeg("SELL", "PUT", strike, spot, nearDte, exp, iv, 1, r),
        createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "bear_diagonal_spread",
    name: "Diagonal Put Spread",
    category: "Bearish",
    subtitle: "Buy Far ITM Put + Sell Near OTM Put",
    description: "Poor Man's Covered Put. Deep ITM long-dated put acts as synthetic short stock, selling monthly puts against it.",
    theses: ["bearish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 15 L 45 15 L 90 40",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const longStrike = roundStrike(spot * 1.15, step);
      const shortStrike = roundStrike(spot * 0.96, step);
      const nearDte = Math.max(7, Math.round(dte * 0.3));
      return [
        createLeg("BUY", "PUT", longStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", shortStrike, spot, nearDte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "synthetic_short_stock",
    name: "Synthetic Short Stock",
    category: "Bearish",
    subtitle: "Buy ATM Put + Sell ATM Call",
    description: "Replicates short 100 shares delta. Uncapped risk if stock rallies.",
    theses: ["very_bearish"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 5 L 45 25 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "risk_reversal_bear",
    name: "Risk Reversal (Bearish)",
    category: "Bearish",
    subtitle: "Sell OTM Call + Buy OTM Put",
    description: "Finances downside put purchase by selling upside call.",
    theses: ["bearish", "very_bearish"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 5 L 35 25 L 60 25 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const callStrike = roundStrike(spot * 1.07, step);
      const putStrike = roundStrike(spot * 0.93, step);
      return [
        createLeg("SELL", "CALL", callStrike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", putStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "long_put_butterfly_bear",
    name: "Bearish Put Butterfly",
    category: "Bearish",
    subtitle: "Buy 1 Put, Sell 2 Puts, Buy 1 Put (Skewed)",
    description: "High return-on-risk butterfly targeting downside price target.",
    theses: ["bearish"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 35 L 25 8 L 50 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot * 0.94, step);
      const width = step * 4;
      return [
        createLeg("BUY", "PUT", center - width, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", center, spot, dte, exp, iv, 2, r),
        createLeg("BUY", "PUT", center + width, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "synthetic_put",
    name: "Synthetic Put",
    category: "Bearish",
    subtitle: "Short 100 Shares + Buy 1 OTM Call",
    description: "Replicates a long put payoff by shorting 100 shares and capping upside risk with a long call.",
    theses: ["bearish", "very_bearish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 5 L 45 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot * 1.05, step);
      return [
        createStockLeg("SELL", spot, 100, exp, dte),
        createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "bear_put_ladder",
    name: "Bear Put Ladder",
    category: "Bearish",
    subtitle: "Buy 1 ITM Put + Sell 1 ATM Put + Sell 1 OTM Put",
    description: "Bear put spread plus an additional sold lower put. Downside assignment risk below lowest strike.",
    theses: ["bearish"],
    riskType: "Undefined",
    legsCount: 3,
    pnlSvgPath: "M 0 45 L 35 10 L 65 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.92, step);
      const k2 = roundStrike(spot * 0.98, step);
      const k3 = roundStrike(spot * 1.04, step);
      return [
        createLeg("BUY", "PUT", k3, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", k2, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", k1, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "poor_mans_covered_put",
    name: "Poor Man's Covered Put",
    category: "Bearish",
    subtitle: "Buy Far ITM Put (LEAPS) + Sell Near OTM Put",
    description: "Synthetic covered put using a deep ITM long-dated put to finance monthly short put premium collection.",
    theses: ["bearish"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 15 L 45 15 L 90 40",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const longStrike = roundStrike(spot * 1.15, step);
      const shortStrike = roundStrike(spot * 0.95, step);
      const nearDte = Math.max(7, Math.round(dte * 0.3));
      return [
        createLeg("BUY", "PUT", longStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", shortStrike, spot, nearDte, exp, iv, 1, r),
      ];
    },
  },

  // ==========================================
  // NEUTRAL / RANGE-BOUND STRATEGIES
  // ==========================================
  {
    id: "iron_condor",
    name: "Iron Condor",
    category: "Neutral",
    subtitle: "Sell OTM Put Spread + Sell OTM Call Spread",
    description: "Premier neutral credit trade. Collects premium across wide corridor. Defined risk on both wings.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 40 L 25 40 L 40 12 L 60 12 L 75 40 L 90 40",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putLong = roundStrike(spot * 0.88, step);
      const putShort = roundStrike(spot * 0.94, step);
      const callShort = roundStrike(spot * 1.06, step);
      const callLong = roundStrike(spot * 1.12, step);
      return [
        createLeg("BUY", "PUT", putLong, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", putShort, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callShort, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callLong, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "iron_butterfly",
    name: "Iron Butterfly",
    category: "Neutral",
    subtitle: "Sell ATM Straddle + Buy OTM Wings",
    description: "Maximum credit collection pinned directly at current price. High reward-to-risk ratio.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 40 L 25 40 L 50 8 L 75 40 L 90 40",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot, step);
      const width = step * 6;
      return [
        createLeg("BUY", "PUT", center - width, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", center, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", center, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", center + width, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "short_straddle",
    name: "Short Straddle",
    category: "Neutral",
    subtitle: "Sell ATM Call + Sell ATM Put",
    description: "Sells maximum extrinsic value at current spot price. Profiting from time decay and implied volatility collapse.",
    theses: ["neutral"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 45 L 50 5 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createLeg("SELL", "CALL", strike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "short_strangle",
    name: "Short Strangle",
    category: "Neutral",
    subtitle: "Sell OTM Put + Sell OTM Call",
    description: "Wide neutral profit zone harvesting dual theta decay. Undefined tail risk if stock makes outsized move.",
    theses: ["neutral"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 45 L 35 12 L 65 12 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.94, step);
      const callStrike = roundStrike(spot * 1.06, step);
      return [
        createLeg("SELL", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "call_calendar",
    name: "Calendar Call Spread",
    category: "Neutral",
    subtitle: "Sell Near ATM Call + Buy Far ATM Call",
    description: "Capitalizes on front month time decay while preserving back-month long call asset.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 35 L 30 35 L 50 8 L 70 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      const nearDte = Math.max(7, Math.round(dte * 0.4));
      return [
        createLeg("SELL", "CALL", strike, spot, nearDte, exp, iv, 1, r),
        createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "put_calendar",
    name: "Calendar Put Spread",
    category: "Neutral",
    subtitle: "Sell Near ATM Put + Buy Far ATM Put",
    description: "Neutral-to-slight-bearish time decay structure using puts.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 35 L 30 35 L 50 8 L 70 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      const nearDte = Math.max(7, Math.round(dte * 0.4));
      return [
        createLeg("SELL", "PUT", strike, spot, nearDte, exp, iv, 1, r),
        createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "long_call_butterfly",
    name: "Long Call Butterfly",
    category: "Neutral",
    subtitle: "Buy 1 Call, Sell 2 Calls, Buy 1 Call",
    description: "Pin trade centered at current market price. High win payout for very modest debit.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 35 L 30 35 L 50 8 L 70 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot, step);
      const width = step * 4;
      return [
        createLeg("BUY", "CALL", center - width, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", center, spot, dte, exp, iv, 2, r),
        createLeg("BUY", "CALL", center + width, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "long_put_butterfly",
    name: "Long Put Butterfly",
    category: "Neutral",
    subtitle: "Buy 1 Put, Sell 2 Puts, Buy 1 Put",
    description: "Neutral pin structure constructed with puts.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 35 L 30 35 L 50 8 L 70 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot, step);
      const width = step * 4;
      return [
        createLeg("BUY", "PUT", center - width, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", center, spot, dte, exp, iv, 2, r),
        createLeg("BUY", "PUT", center + width, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "double_calendar",
    name: "Double Calendar",
    category: "Neutral",
    subtitle: "Put Calendar + Call Calendar",
    description: "Combines two calendars at OTM strikes creating an extra wide profit zone.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 35 L 20 35 L 35 10 L 50 20 L 65 10 L 80 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.94, step);
      const callStrike = roundStrike(spot * 1.06, step);
      const nearDte = Math.max(7, Math.round(dte * 0.4));
      return [
        createLeg("SELL", "PUT", putStrike, spot, nearDte, exp, iv, 1, r),
        createLeg("BUY", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callStrike, spot, nearDte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "double_diagonal",
    name: "Double Diagonal",
    category: "Neutral",
    subtitle: "Near OTM Strangle Short + Far OTM Strangle Long",
    description: "Double diagonal calendar capturing theta decay across wide range.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 35 L 25 35 L 40 12 L 60 12 L 75 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putShort = roundStrike(spot * 0.95, step);
      const putLong = roundStrike(spot * 0.90, step);
      const callShort = roundStrike(spot * 1.05, step);
      const callLong = roundStrike(spot * 1.10, step);
      const nearDte = Math.max(7, Math.round(dte * 0.35));
      return [
        createLeg("BUY", "PUT", putLong, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", putShort, spot, nearDte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callShort, spot, nearDte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callLong, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "jade_lizard",
    name: "Jade Lizard",
    category: "Neutral",
    subtitle: "Sell OTM Put + Bear Call Spread",
    description: "Credit structure configured so that credit collected exceeds width of call spread, eliminating upside risk completely.",
    theses: ["neutral"],
    riskType: "Undefined",
    legsCount: 3,
    pnlSvgPath: "M 0 45 L 35 12 L 70 12 L 90 20",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.92, step);
      const callShort = roundStrike(spot * 1.05, step);
      const callLong = roundStrike(spot * 1.09, step);
      return [
        createLeg("SELL", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callShort, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callLong, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "reverse_jade_lizard",
    name: "Reverse Jade Lizard",
    category: "Neutral",
    subtitle: "Sell OTM Call + Bull Put Spread",
    description: "Credit structure eliminating downside risk completely when credit exceeds put spread width.",
    theses: ["neutral"],
    riskType: "Undefined",
    legsCount: 3,
    pnlSvgPath: "M 0 20 L 25 12 L 65 12 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putLong = roundStrike(spot * 0.91, step);
      const putShort = roundStrike(spot * 0.95, step);
      const callShort = roundStrike(spot * 1.08, step);
      return [
        createLeg("BUY", "PUT", putLong, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", putShort, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callShort, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "long_call_condor",
    name: "Long Call Condor",
    category: "Neutral",
    subtitle: "Buy 1 Call, Sell 1 Call, Sell 1 Call, Buy 1 Call",
    description: "4-strike all-call condor offering a flat plateau of maximum profit.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 35 L 25 35 L 40 10 L 60 10 L 75 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.94, step);
      const k2 = roundStrike(spot * 0.98, step);
      const k3 = roundStrike(spot * 1.02, step);
      const k4 = roundStrike(spot * 1.06, step);
      return [
        createLeg("BUY", "CALL", k1, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", k2, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", k3, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", k4, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "long_put_condor",
    name: "Long Put Condor",
    category: "Neutral",
    subtitle: "Buy 1 Put, Sell 1 Put, Sell 1 Put, Buy 1 Put",
    description: "4-strike all-put condor with defined plateau profit.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 35 L 25 35 L 40 10 L 60 10 L 75 35 L 90 35",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.94, step);
      const k2 = roundStrike(spot * 0.98, step);
      const k3 = roundStrike(spot * 1.02, step);
      const k4 = roundStrike(spot * 1.06, step);
      return [
        createLeg("BUY", "PUT", k1, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", k2, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", k3, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", k4, spot, dte, exp, iv, 1, r),
      ];
    },
  },

  // ==========================================
  // VOLATILITY & BREAKOUT STRATEGIES (10)
  // ==========================================
  {
    id: "long_straddle",
    name: "Straddle",
    category: "Volatility",
    subtitle: "Buy ATM Call + Buy ATM Put",
    description: "Pure volatility expansion play. Unlimited profit if stock breaks out aggressively in either direction.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 5 L 45 42 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "long_strangle",
    name: "Strangle",
    category: "Volatility",
    subtitle: "Buy OTM Put + Buy OTM Call",
    description: "Lower entry debit volatility breakout trade requiring larger movement to reach profitability.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 5 L 35 42 L 65 42 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.95, step);
      const callStrike = roundStrike(spot * 1.05, step);
      return [
        createLeg("BUY", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "reverse_iron_condor",
    name: "Inverse Iron Condor",
    category: "Volatility",
    subtitle: "Buy Inner OTM Wings + Sell Outer Wings",
    description: "Defined-risk breakout structure profiting from sharp moves beyond either side.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 12 L 25 12 L 40 40 L 60 40 L 75 12 L 90 12",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putLong = roundStrike(spot * 0.95, step);
      const putShort = roundStrike(spot * 0.90, step);
      const callLong = roundStrike(spot * 1.05, step);
      const callShort = roundStrike(spot * 1.10, step);
      return [
        createLeg("SELL", "PUT", putShort, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", putLong, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callLong, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callShort, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "reverse_iron_butterfly",
    name: "Inverse Iron Butterfly",
    category: "Volatility",
    subtitle: "Buy ATM Straddle + Sell OTM Wings",
    description: "High leverage breakout trade with defined risk capped by outer wings.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 10 L 25 10 L 50 42 L 75 10 L 90 10",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot, step);
      const width = step * 6;
      return [
        createLeg("SELL", "PUT", center - width, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", center, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", center, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", center + width, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "strip_strategy",
    name: "Strip",
    category: "Volatility",
    subtitle: "Buy 1 ATM Call + Buy 2 ATM Puts",
    description: "Volatility play with distinct bearish bias. Double leverage on downside move.",
    theses: ["bearish", "directional"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 0 L 45 42 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 2, r),
      ];
    },
  },
  {
    id: "strap_strategy",
    name: "Strap",
    category: "Volatility",
    subtitle: "Buy 2 ATM Calls + Buy 1 ATM Put",
    description: "Volatility play with distinct bullish bias. Double leverage on upside move.",
    theses: ["bullish", "directional"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 15 L 45 42 L 90 0",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 2, r),
        createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "gut_strangle_long",
    name: "Guts",
    category: "Volatility",
    subtitle: "Buy ITM Put + Buy ITM Call",
    description: "Deep delta in-the-money strangle offering high immediate sensitivity to underlying moves.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 2,
    pnlSvgPath: "M 0 5 L 40 30 L 60 30 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 1.05, step);
      const callStrike = roundStrike(spot * 0.95, step);
      return [
        createLeg("BUY", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "gut_strangle_short",
    name: "Short Guts",
    category: "Volatility",
    subtitle: "Sell ITM Put + Sell ITM Call",
    description: "Deep delta in-the-money short strangle collecting substantial intrinsic + extrinsic value.",
    theses: ["neutral"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 45 L 40 20 L 60 20 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 1.05, step);
      const callStrike = roundStrike(spot * 0.95, step);
      return [
        createLeg("SELL", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "short_call_butterfly",
    name: "Short Call Butterfly",
    category: "Volatility",
    subtitle: "Sell 1 Call, Buy 2 Calls, Sell 1 Call",
    description: "Inverted butterfly profiting if stock breaks cleanly away from central strike.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 15 L 30 15 L 50 42 L 70 15 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot, step);
      const width = step * 4;
      return [
        createLeg("SELL", "CALL", center - width, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", center, spot, dte, exp, iv, 2, r),
        createLeg("SELL", "CALL", center + width, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "short_put_butterfly",
    name: "Short Put Butterfly",
    category: "Volatility",
    subtitle: "Sell 1 Put, Buy 2 Puts, Sell 1 Put",
    description: "Inverted put butterfly with defined maximum loss at center and maximum gain on either side.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 15 L 30 15 L 50 42 L 70 15 L 90 15",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot, step);
      const width = step * 4;
      return [
        createLeg("SELL", "PUT", center - width, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", center, spot, dte, exp, iv, 2, r),
        createLeg("SELL", "PUT", center + width, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "short_call_condor",
    name: "Short Call Condor",
    category: "Volatility",
    subtitle: "Sell Outer Calls + Buy Inner Calls",
    description: "Inverted 4-strike call condor with defined risk. Profits from explosive volatility moves away from center.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 10 L 25 10 L 40 38 L 60 38 L 75 10 L 90 10",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.94, step);
      const k2 = roundStrike(spot * 0.98, step);
      const k3 = roundStrike(spot * 1.02, step);
      const k4 = roundStrike(spot * 1.06, step);
      return [
        createLeg("SELL", "CALL", k1, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", k2, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", k3, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", k4, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "short_put_condor",
    name: "Short Put Condor",
    category: "Volatility",
    subtitle: "Sell Outer Puts + Buy Inner Puts",
    description: "Inverted 4-strike put condor with defined risk. Maximum gain achieved outside outer strikes.",
    theses: ["directional"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 10 L 25 10 L 40 38 L 60 38 L 75 10 L 90 10",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.94, step);
      const k2 = roundStrike(spot * 0.98, step);
      const k3 = roundStrike(spot * 1.02, step);
      const k4 = roundStrike(spot * 1.06, step);
      return [
        createLeg("SELL", "PUT", k1, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", k2, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", k3, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", k4, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "bear_call_ladder",
    name: "Bear Call Ladder",
    category: "Volatility",
    subtitle: "Sell 1 ITM Call + Buy 1 ATM Call + Buy 1 OTM Call",
    description: "Call ladder backspread profiting from explosive upside breakouts funded by the short call.",
    theses: ["directional", "bullish"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 20 L 35 20 L 60 40 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.96, step);
      const k2 = roundStrike(spot * 1.02, step);
      const k3 = roundStrike(spot * 1.08, step);
      return [
        createLeg("SELL", "CALL", k1, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", k2, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", k3, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "bull_put_ladder",
    name: "Bull Put Ladder",
    category: "Volatility",
    subtitle: "Buy 1 Lower Put + Buy 1 Middle Put + Sell 1 ITM Put",
    description: "Put ladder backspread profiting from severe downward drops and implied volatility spikes.",
    theses: ["directional", "bearish"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 5 L 35 40 L 60 20 L 90 20",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.92, step);
      const k2 = roundStrike(spot * 0.98, step);
      const k3 = roundStrike(spot * 1.04, step);
      return [
        createLeg("BUY", "PUT", k1, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", k2, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", k3, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "inverse_call_broken_wing",
    name: "Inverse Call Broken Wing",
    category: "Volatility",
    subtitle: "Sell K1, Buy 2x K2, Sell K3 (Unequal Calls)",
    description: "Inverted broken wing call butterfly designed to capture directional momentum with asymmetric risk.",
    theses: ["directional", "bullish"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 20 L 35 20 L 55 42 L 80 10 L 90 10",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot * 1.04, step);
      const lowerWidth = step * 3;
      const upperWidth = step * 6;
      return [
        createLeg("SELL", "CALL", center - lowerWidth, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", center, spot, dte, exp, iv, 2, r),
        createLeg("SELL", "CALL", center + upperWidth, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "inverse_put_broken_wing",
    name: "Inverse Put Broken Wing",
    category: "Volatility",
    subtitle: "Sell K1, Buy 2x K2, Sell K3 (Unequal Puts)",
    description: "Inverted broken wing put butterfly profiting from market selloffs and volatility expansion.",
    theses: ["directional", "bearish"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 10 L 20 10 L 45 42 L 65 20 L 90 20",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot * 0.96, step);
      const lowerWidth = step * 6;
      const upperWidth = step * 3;
      return [
        createLeg("SELL", "PUT", center - lowerWidth, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", center, spot, dte, exp, iv, 2, r),
        createLeg("SELL", "PUT", center + upperWidth, spot, dte, exp, iv, 1, r),
      ];
    },
  },

  // ==========================================
  // SYNTHETICS & ADVANCED SPREADS
  // ==========================================
  {
    id: "box_spread",
    name: "Box Spread",
    category: "Synthetics & Spreads",
    subtitle: "Bull Call Spread + Bear Put Spread",
    description: "Four-leg arbitrage/lending trade locking in fixed terminal value equal to strike difference.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 25 L 90 25",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const k1 = roundStrike(spot * 0.95, step);
      const k2 = roundStrike(spot * 1.05, step);
      return [
        createLeg("BUY", "CALL", k1, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", k2, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", k2, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", k1, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "jelly_roll",
    name: "Jelly Roll",
    category: "Synthetics & Spreads",
    subtitle: "Calendar Synthetic Spread",
    description: "Long synthetic stock in front month + Short synthetic stock in back month to capture interest rate/dividend differentials.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 25 L 90 25",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      const nearDte = Math.max(7, Math.round(dte * 0.4));
      return [
        createLeg("BUY", "CALL", strike, spot, nearDte, exp, iv, 1, r),
        createLeg("SELL", "PUT", strike, spot, nearDte, exp, iv, 1, r),
        createLeg("SELL", "CALL", strike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "iron_condor_unbalanced",
    name: "Unbalanced Iron Condor",
    category: "Synthetics & Spreads",
    subtitle: "Skewed Width Wings Condor",
    description: "Asymmetric iron condor with wider put wing or wider call wing aligned with macro drift.",
    theses: ["neutral", "bullish"],
    riskType: "Defined",
    legsCount: 4,
    pnlSvgPath: "M 0 42 L 20 42 L 35 15 L 65 15 L 80 32 L 90 32",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putLong = roundStrike(spot * 0.85, step);
      const putShort = roundStrike(spot * 0.93, step);
      const callShort = roundStrike(spot * 1.06, step);
      const callLong = roundStrike(spot * 1.10, step);
      return [
        createLeg("BUY", "PUT", putLong, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", putShort, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callShort, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callLong, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "call_broken_wing_butterfly",
    name: "Call Broken Wing",
    category: "Synthetics & Spreads",
    subtitle: "Skip Strike Call Butterfly",
    description: "Skipped outer strike creates a net credit butterfly with zero risk to the downside.",
    theses: ["bullish"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 25 L 35 25 L 55 5 L 80 40 L 90 40",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot * 1.04, step);
      const lowerWidth = step * 3;
      const upperWidth = step * 6; // broken wing width
      return [
        createLeg("BUY", "CALL", center - lowerWidth, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", center, spot, dte, exp, iv, 2, r),
        createLeg("BUY", "CALL", center + upperWidth, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "put_broken_wing_butterfly",
    name: "Put Broken Wing",
    category: "Synthetics & Spreads",
    subtitle: "Skip Strike Put Butterfly",
    description: "Skipped lower strike creates a net credit butterfly with zero risk to the upside.",
    theses: ["bearish"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 40 L 20 40 L 45 5 L 65 25 L 90 25",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const center = roundStrike(spot * 0.96, step);
      const lowerWidth = step * 6; // broken wing width
      const upperWidth = step * 3;
      return [
        createLeg("BUY", "PUT", center - lowerWidth, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "PUT", center, spot, dte, exp, iv, 2, r),
        createLeg("BUY", "PUT", center + upperWidth, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "long_combo",
    name: "Long Combo",
    category: "Synthetics & Spreads",
    subtitle: "Sell OTM Put + Buy OTM Call",
    description: "Replicates synthetic long stock with zero or minimal upfront debit. Unlimited downside risk.",
    theses: ["bullish"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 45 L 35 25 L 65 25 L 90 5",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.95, step);
      const callStrike = roundStrike(spot * 1.05, step);
      return [
        createLeg("SELL", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "short_combo",
    name: "Short Combo",
    category: "Synthetics & Spreads",
    subtitle: "Buy OTM Put + Sell OTM Call",
    description: "Replicates synthetic short stock position. Uncapped upside risk.",
    theses: ["bearish"],
    riskType: "Undefined",
    legsCount: 2,
    pnlSvgPath: "M 0 5 L 35 25 L 65 25 L 90 45",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const putStrike = roundStrike(spot * 0.95, step);
      const callStrike = roundStrike(spot * 1.05, step);
      return [
        createLeg("BUY", "PUT", putStrike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", callStrike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "conversion",
    name: "Conversion",
    category: "Synthetics & Spreads",
    subtitle: "Long Stock + Long Put + Short Call",
    description: "Classic options arbitrage locking in a risk-free payoff equal to strike minus net cost basis.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 25 L 90 25",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createStockLeg("BUY", spot, 100, exp, dte),
        createLeg("BUY", "PUT", strike, spot, dte, exp, iv, 1, r),
        createLeg("SELL", "CALL", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
  {
    id: "reverse_conversion",
    name: "Reverse Conversion",
    category: "Synthetics & Spreads",
    subtitle: "Short Stock + Short Put + Long Call",
    description: "Reversal arbitrage locking in synthetic short stock matched against actual short shares.",
    theses: ["neutral"],
    riskType: "Defined",
    legsCount: 3,
    pnlSvgPath: "M 0 25 L 90 25",
    buildLegs: (spot, dte, exp, iv, r) => {
      const step = getStrikeStep(spot);
      const strike = roundStrike(spot, step);
      return [
        createStockLeg("SELL", spot, 100, exp, dte),
        createLeg("SELL", "PUT", strike, spot, dte, exp, iv, 1, r),
        createLeg("BUY", "CALL", strike, spot, dte, exp, iv, 1, r),
      ];
    },
  },
];
