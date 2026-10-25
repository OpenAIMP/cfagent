/**
 * Market setup catalog (issue #435).
 *
 * A setup is a market condition that a screener can look for — distinct from
 * a strategy (what you trade once the setup appears). The catalog starts
 * with four families that fit the existing stock and options tools; more
 * families are added over time (regime, catalysts, vol/liquidity, risk
 * checks combine with these).
 *
 * Each setup declares:
 *  - the market signature it looks for (indicators, price/volume behavior)
 *  - which strategies it pairs with (ids from the strategy catalog)
 *  - the risk notes that always travel with it
 */

export type SetupFamily =
  | "trend_breakout"
  | "pullback_reversion"
  | "defined_risk_spread"
  | "pmcc";

export interface SetupSignature {
  /** Human-readable market signature, e.g. "price above rising 50-day, volume expanding". */
  description: string;
  /** Indicator keys from the screener gates that define the signature. */
  indicators: string[];
  /** Optional numeric guardrails, e.g. { rsiMax: 70 }. */
  guardrails?: Record<string, number>;
}

export interface MarketSetup {
  id: SetupFamily;
  label: string;
  description: string;
  /** Stock, options, or both. */
  assetClass: "stock" | "options" | "both";
  signature: SetupSignature;
  /** Strategy catalog ids that pair with this setup. */
  pairedStrategies: string[];
  riskNotes: string[];
}

const SETUPS: MarketSetup[] = [
  {
    id: "trend_breakout",
    label: "Stock Trend / Breakout",
    description:
      "Price and volume moving with the prevailing trend — new highs on expanding volume.",
    assetClass: "stock",
    signature: {
      description: "Price above rising 50-day SMA with volume above its 20-day average.",
      indicators: ["sma50", "volume_ratio", "high_52w_distance"],
      guardrails: { volumeRatioMin: 1.2 },
    },
    pairedStrategies: ["long_call", "call_debit_spread", "bull_call_spread"],
    riskNotes: [
      "Breakouts fail — size for the false-breakout case, not the continuation.",
      "Check earnings and catalysts inside the holding window before entry.",
    ],
  },
  {
    id: "pullback_reversion",
    label: "Stock Pullback / Mean Reversion",
    description:
      "A possible reversal or rebound after a sharp move — price stretched from its mean.",
    assetClass: "stock",
    signature: {
      description: "Price below a falling short-term average but above long-term support; RSI washed out.",
      indicators: ["rsi", "sma20_distance", "sma50"],
      guardrails: { rsiMax: 30 },
    },
    pairedStrategies: ["cash_secured_put", "put_credit_spread", "long_call"],
    riskNotes: [
      "Catching a falling knife — the trend is down until it isn't; define the invalidation first.",
      "Mean reversion needs a catalyst or support level, not just an oversold reading.",
    ],
  },
  {
    id: "defined_risk_spread",
    label: "Defined-Risk Options Spreads",
    description:
      "Call spreads for bullish setups and put spreads for bearish ones — defined max loss, net credit or small debit.",
    assetClass: "options",
    signature: {
      description: "Liquid options chain, IV rank elevated enough to sell premium, trend-aligned outlook.",
      indicators: ["iv_rank", "option_volume", "bid_ask_spread"],
      guardrails: { ivRankMin: 30 },
    },
    pairedStrategies: [
      "call_debit_spread",
      "put_debit_spread",
      "call_credit_spread",
      "put_credit_spread",
    ],
    riskNotes: [
      "Defined risk is not low risk — the max loss is real and reachable.",
      "Wide bid/ask spreads erase the edge; check liquidity before pricing.",
    ],
  },
  {
    id: "pmcc",
    label: "PMCC (Poor Man's Covered Call)",
    description:
      "A longer-dated call paired with a shorter-dated short call — stock-like exposure for less capital.",
    assetClass: "options",
    signature: {
      description: "Bullish outlook, liquid LEAPS chain plus a liquid near-term chain on the same underlying.",
      indicators: ["iv_rank", "option_volume", "trend"],
    },
    pairedStrategies: ["poor_mans_covered_call"],
    riskNotes: [
      "The long call decays too — the short call income must outpace LEAPS theta.",
      "Assignment on the short leg leaves a naked long call; have a roll plan.",
    ],
  },
];

export function listSetups(): MarketSetup[] {
  return [...SETUPS];
}

export function getSetup(id: SetupFamily): MarketSetup | null {
  return SETUPS.find((s) => s.id === id) ?? null;
}
