import type { ETradeOptionChain, ETradeOptionExpireDate, ETradeOptionChainContract } from "../../types";

const REFERENCE_PRICES: Record<string, number> = {
  SPY: 580,
  QQQ: 495,
  IWM: 220,
  DIA: 430,
  NVDA: 135,
  AAPL: 230,
  MSFT: 420,
  AMZN: 190,
  TSLA: 250,
  GOOGL: 170,
  META: 590,
};

function formatOsi(
  symbol: string,
  year: number,
  month: number,
  day: number,
  type: "C" | "P",
  strike: number,
): string {
  const yy = String(year % 100).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const strikeFormatted = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${symbol.toUpperCase()}${yy}${mm}${dd}${type}${strikeFormatted}`;
}

/**
 * Generates synthetic, realistic E*TRADE-compatible option chains for sandbox/testing
 * and offline fallback when the broker market data feed is unavailable.
 */
export function generateSyntheticOptionChains(
  symbolInput: string,
  referencePriceOverride?: number,
  baseDate: Date = new Date(),
): { expirations: ETradeOptionExpireDate[]; chains: ETradeOptionChain[] } {
  const symbol = symbolInput.trim().toUpperCase() || "SPY";
  const basePrice =
    referencePriceOverride && referencePriceOverride > 0
      ? referencePriceOverride
      : REFERENCE_PRICES[symbol] ?? 100;

  // Generate 3 standard expirations: Near-term (14d), Mid-term (45d), Long-term (120d)
  const horizons = [14, 45, 120];
  const expirations: ETradeOptionExpireDate[] = horizons.map((daysAhead, idx) => {
    const target = new Date(baseDate.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    // Align to Friday
    const dayOfWeek = target.getUTCDay();
    const diffToFriday = (5 - dayOfWeek + 7) % 7;
    target.setUTCDate(target.getUTCDate() + diffToFriday);

    return {
      year: target.getUTCFullYear(),
      month: target.getUTCMonth() + 1,
      day: target.getUTCDate(),
      expiryType: idx === 0 ? "WEEKLY" : "REGULAR",
    };
  });

  // Strike step size based on underlying price
  const strikeStep = basePrice > 300 ? 5 : basePrice > 100 ? 2.5 : 1;
  const atmRounded = Math.round(basePrice / strikeStep) * strikeStep;
  const strikeMultipliers = [-3, -2, -1, 0, 1, 2, 3];
  const strikes = strikeMultipliers.map((m) => Math.round((atmRounded + m * strikeStep) * 100) / 100);

  const chains: ETradeOptionChain[] = expirations.map((exp, expIdx) => {
    const dte = horizons[expIdx];
    const pairs = strikes.map((strike) => {
      const moneyness = strike / basePrice;
      const isCallItm = strike < basePrice;
      const isPutItm = strike > basePrice;

      // Realistic Call Greek & Price approximations
      const callDelta = Math.max(0.05, Math.min(0.95, 0.5 - (moneyness - 1) * 2));
      const putDelta = -(1 - callDelta);
      const iv = 0.22 + expIdx * 0.02;
      const timeValue = Math.max(0.5, (basePrice * iv * Math.sqrt(dte / 365)) * 0.4);
      const callIntrinsic = Math.max(0, basePrice - strike);
      const putIntrinsic = Math.max(0, strike - basePrice);

      const callPrice = Math.round((callIntrinsic + timeValue * (1 - Math.abs(callDelta - 0.5))) * 100) / 100;
      const putPrice = Math.round((putIntrinsic + timeValue * (1 - Math.abs(putDelta + 0.5))) * 100) / 100;

      const callSymbol = formatOsi(symbol, exp.year, exp.month, exp.day, "C", strike);
      const putSymbol = formatOsi(symbol, exp.year, exp.month, exp.day, "P", strike);

      const callContract: ETradeOptionChainContract = {
        symbol: callSymbol,
        optionType: "CALL",
        strikePrice: strike,
        bid: Math.max(0.01, Math.round((callPrice - 0.05) * 100) / 100),
        ask: Math.round((callPrice + 0.05) * 100) / 100,
        lastPrice: callPrice,
        volume: Math.floor(800 + Math.random() * 2500),
        openInterest: Math.floor(2500 + Math.random() * 8000),
        impliedVolatility: iv,
        delta: Math.round(callDelta * 100) / 100,
        gamma: Math.round((0.04 / (1 + Math.abs(moneyness - 1) * 5)) * 1000) / 1000,
        theta: Math.round((-0.05 / Math.sqrt(dte / 30)) * 1000) / 1000,
        vega: Math.round((0.15 * Math.sqrt(dte / 30)) * 100) / 100,
        rho: 0.02,
        timeStamp: Date.now(),
        adjustedFlag: false,
      };

      const putContract: ETradeOptionChainContract = {
        symbol: putSymbol,
        optionType: "PUT",
        strikePrice: strike,
        bid: Math.max(0.01, Math.round((putPrice - 0.05) * 100) / 100),
        ask: Math.round((putPrice + 0.05) * 100) / 100,
        lastPrice: putPrice,
        volume: Math.floor(600 + Math.random() * 2200),
        openInterest: Math.floor(2000 + Math.random() * 7500),
        impliedVolatility: iv,
        delta: Math.round(putDelta * 100) / 100,
        gamma: Math.round((0.04 / (1 + Math.abs(moneyness - 1) * 5)) * 1000) / 1000,
        theta: Math.round((-0.05 / Math.sqrt(dte / 30)) * 1000) / 1000,
        vega: Math.round((0.15 * Math.sqrt(dte / 30)) * 100) / 100,
        rho: -0.02,
        timeStamp: Date.now(),
        adjustedFlag: false,
      };

      return {
        call: callContract,
        put: putContract,
      };
    });

    const rawResponse = {
      nearPrice: basePrice,
      SelectedED: {
        year: exp.year,
        month: exp.month,
        day: exp.day,
      },
      OptionPair: pairs.map((pair) => ({
        Call: {
          symbol: pair.call?.symbol,
          strikePrice: pair.call?.strikePrice,
          bid: pair.call?.bid,
          ask: pair.call?.ask,
          lastPrice: pair.call?.lastPrice,
          volume: pair.call?.volume,
          openInterest: pair.call?.openInterest,
          OptionGreeks: {
            delta: pair.call?.delta,
            gamma: pair.call?.gamma,
            theta: pair.call?.theta,
            vega: pair.call?.vega,
            rho: pair.call?.rho,
            iv: pair.call?.impliedVolatility,
          },
        },
        Put: {
          symbol: pair.put?.symbol,
          strikePrice: pair.put?.strikePrice,
          bid: pair.put?.bid,
          ask: pair.put?.ask,
          lastPrice: pair.put?.lastPrice,
          volume: pair.put?.volume,
          openInterest: pair.put?.openInterest,
          OptionGreeks: {
            delta: pair.put?.delta,
            gamma: pair.put?.gamma,
            theta: pair.put?.theta,
            vega: pair.put?.vega,
            rho: pair.put?.rho,
            iv: pair.put?.impliedVolatility,
          },
        },
      })),
    };

    return {
      symbol,
      underlyingPrice: basePrice,
      quoteTime: Date.now(),
      selectedExpiry: exp,
      pairs,
      raw: rawResponse,
    };
  });

  return { expirations, chains };
}
