import { createTemplateStrategy, type LegTemplate, type TemplateSpec } from "./template";
import { StrategyRegistry, normalizeStrategyName } from "./registry";
import type { NameLedgerEntry, StrategyDefinition, StrategyEvaluation } from "./types";

type Side = "BUY" | "SELL";

const call = (side: Side, k = 0, qty = 1, expiry?: "near" | "far"): LegTemplate => ({ type: "CALL", side, k, qty, expiry });
const put = (side: Side, k = 0, qty = 1, expiry?: "near" | "far"): LegTemplate => ({ type: "PUT", side, k, qty, expiry });
const stock = (side: Side): LegTemplate => ({ type: "STOCK", side });
const spec = (strikes: number, legs: LegTemplate[], extra: Partial<TemplateSpec> = {}): TemplateSpec => ({ strikes, legs, ...extra });
const flip = (legs: LegTemplate[]): LegTemplate[] => legs.map((leg) => ({ ...leg, side: leg.side === "BUY" ? "SELL" : "BUY" }));

const ALL_THESES = ["bullish", "bearish", "range_bound", "large_move"] as const;

const DEFINITIONS: StrategyDefinition[] = [
  // Single-leg
  createTemplateStrategy({ id: "long_call", label: "Long Call", category: "single", description: "Buy one call; defined risk, unlimited upside.", theses: ["bullish"], specs: [spec(1, [call("BUY")])] }),
  createTemplateStrategy({ id: "long_put", label: "Long Put", category: "single", description: "Buy one put; defined risk, large downside payoff.", theses: ["bearish"], specs: [spec(1, [put("BUY")])] }),
  createTemplateStrategy({ id: "short_call", label: "Short Call", category: "single", description: "Sell one naked call; unlimited upside risk.", aliases: ["Naked Call"], theses: ["bearish", "range_bound"], specs: [spec(1, [call("SELL")])] }),
  createTemplateStrategy({ id: "cash_secured_put", label: "Cash-Secured Put", category: "single", description: "Sell one put backed by cash for assignment; risk is strike minus premium.", aliases: ["Short Put", "Naked Put"], theses: ["bullish", "range_bound"], specs: [spec(1, [put("SELL")])] }),
  createTemplateStrategy({ id: "leaps_call", label: "LEAPS Call", category: "single", description: "Long call with at least 365 DTE (stock replacement).", theses: ["bullish"], specs: [spec(1, [call("BUY")], { minDte: 365 })] }),
  createTemplateStrategy({ id: "leaps_put", label: "LEAPS Put", category: "single", description: "Long put with at least 365 DTE.", theses: ["bearish"], specs: [spec(1, [put("BUY")], { minDte: 365 })] }),

  // Stock plus options (100 hypothetical shares per structure)
  createTemplateStrategy({ id: "covered_call", label: "Covered Call", category: "stock", description: "Long 100 shares plus one short call.", aliases: ["Buy-Write", "Synthetic Short Put"], theses: ["bullish", "range_bound"], specs: [spec(1, [stock("BUY"), call("SELL")])] }),
  createTemplateStrategy({ id: "covered_put", label: "Covered Put", category: "stock", description: "Short 100 shares plus one short put; unlimited upside risk.", aliases: ["Synthetic Short Call"], theses: ["bearish", "range_bound"], specs: [spec(1, [stock("SELL"), put("SELL")])] }),
  createTemplateStrategy({ id: "protective_put", label: "Protective Put", category: "stock", description: "Long 100 shares plus one long put.", aliases: ["Married Put", "Synthetic Long Call"], theses: ["bullish"], specs: [spec(1, [stock("BUY"), put("BUY")])] }),
  createTemplateStrategy({ id: "protective_call", label: "Protective Call", category: "stock", description: "Short 100 shares plus one long call.", aliases: ["Synthetic Long Put"], theses: ["bearish"], specs: [spec(1, [stock("SELL"), call("BUY")])] }),
  createTemplateStrategy({ id: "protective_collar", label: "Protective Collar", category: "stock", description: "Long 100 shares, long put below, short call above.", aliases: ["Collar", "Fence"], theses: ["bullish", "range_bound"], specs: [spec(2, [stock("BUY"), put("BUY", 0), call("SELL", 1)])] }),
  createTemplateStrategy({ id: "covered_strangle", label: "Covered Strangle", category: "stock", description: "Long 100 shares, short put below, short call above.", aliases: ["Covered Combination"], theses: ["range_bound", "bullish"], specs: [spec(2, [stock("BUY"), put("SELL", 0), call("SELL", 1)])] }),
  createTemplateStrategy({ id: "call_ratio_write", label: "Call Ratio Write", category: "stock", description: "Long 100 shares plus two short calls; one call is uncovered.", theses: ["range_bound"], specs: [spec(1, [stock("BUY"), call("SELL", 0, 2)])] }),
  createTemplateStrategy({ id: "put_ratio_write", label: "Put Ratio Write", category: "stock", description: "Short 100 shares plus two short puts.", theses: ["range_bound"], specs: [spec(1, [stock("SELL"), put("SELL", 0, 2)])] }),

  // Verticals
  createTemplateStrategy({ id: "call_debit_spread", label: "Call Debit Spread", category: "vertical", description: "Buy lower call, sell higher call.", aliases: ["Bull Call Spread", "Bull Call Debit Spread", "Long Call Vertical Spread"], theses: ["bullish"], specs: [spec(2, [call("BUY", 0), call("SELL", 1)])] }),
  createTemplateStrategy({ id: "put_debit_spread", label: "Put Debit Spread", category: "vertical", description: "Buy higher put, sell lower put.", aliases: ["Bear Put Spread", "Bear Put Debit Spread", "Long Put Vertical Spread"], theses: ["bearish"], specs: [spec(2, [put("BUY", 1), put("SELL", 0)])] }),
  createTemplateStrategy({ id: "call_credit_spread", label: "Call Credit Spread", category: "vertical", description: "Sell lower call, buy higher call.", aliases: ["Bear Call Spread", "Bear Call Credit Spread", "Short Call Vertical Spread"], theses: ["bearish"], specs: [spec(2, [call("SELL", 0), call("BUY", 1)])] }),
  createTemplateStrategy({ id: "put_credit_spread", label: "Put Credit Spread", category: "vertical", description: "Sell higher put, buy lower put.", aliases: ["Bull Put Spread", "Bull Put Credit Spread", "Short Put Vertical Spread"], theses: ["bullish"], specs: [spec(2, [put("SELL", 1), put("BUY", 0)])] }),

  // Volatility
  createTemplateStrategy({ id: "long_straddle", label: "Long Straddle", category: "volatility", description: "Buy call and put at the same strike.", theses: ["large_move"], specs: [spec(1, [call("BUY"), put("BUY")])] }),
  createTemplateStrategy({ id: "short_straddle", label: "Short Straddle", category: "volatility", description: "Sell call and put at the same strike; unlimited risk.", theses: ["range_bound"], specs: [spec(1, [call("SELL"), put("SELL")])] }),
  createTemplateStrategy({ id: "long_strangle", label: "Long Strangle", category: "volatility", description: "Buy lower put and higher call.", theses: ["large_move"], specs: [spec(2, [put("BUY", 0), call("BUY", 1)])] }),
  createTemplateStrategy({ id: "short_strangle", label: "Short Strangle", category: "volatility", description: "Sell lower put and higher call; unlimited risk.", theses: ["range_bound"], specs: [spec(2, [put("SELL", 0), call("SELL", 1)])] }),
  createTemplateStrategy({ id: "long_guts", label: "Long Guts", category: "volatility", description: "Buy in-the-money call and put (call strike below put strike).", theses: ["large_move"], specs: [spec(2, [call("BUY", 0), put("BUY", 1)])] }),
  createTemplateStrategy({ id: "short_guts", label: "Short Guts", category: "volatility", description: "Sell in-the-money call and put; unlimited risk.", theses: ["range_bound"], specs: [spec(2, [call("SELL", 0), put("SELL", 1)])] }),

  // Butterflies
  createTemplateStrategy({ id: "long_call_butterfly", label: "Long Call Butterfly", category: "butterfly", description: "Buy 1 / sell 2 / buy 1 calls with equal wings.", theses: ["range_bound"], specs: [spec(3, [call("BUY", 0), call("SELL", 1, 2), call("BUY", 2)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "short_call_butterfly", label: "Short Call Butterfly", category: "butterfly", description: "Sell 1 / buy 2 / sell 1 calls with equal wings.", theses: ["large_move"], specs: [spec(3, [call("SELL", 0), call("BUY", 1, 2), call("SELL", 2)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "long_put_butterfly", label: "Long Put Butterfly", category: "butterfly", description: "Buy 1 / sell 2 / buy 1 puts with equal wings.", theses: ["range_bound"], specs: [spec(3, [put("BUY", 0), put("SELL", 1, 2), put("BUY", 2)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "short_put_butterfly", label: "Short Put Butterfly", category: "butterfly", description: "Sell 1 / buy 2 / sell 1 puts with equal wings.", theses: ["large_move"], specs: [spec(3, [put("SELL", 0), put("BUY", 1, 2), put("SELL", 2)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "iron_butterfly", label: "Iron Butterfly", category: "butterfly", description: "Short straddle with long wings (equal widths).", theses: ["range_bound"], specs: [spec(3, [put("BUY", 0), put("SELL", 1), call("SELL", 1), call("BUY", 2)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "reverse_iron_butterfly", label: "Reverse Iron Butterfly", category: "butterfly", description: "Long straddle with short wings (equal widths).", theses: ["large_move"], specs: [spec(3, [put("SELL", 0), put("BUY", 1), call("BUY", 1), call("SELL", 2)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "broken_wing_butterfly", label: "Broken-Wing Butterfly", category: "butterfly", description: "1 / -2 / 1 butterfly with unequal wings (call and put forms).", theses: ["range_bound", "bullish", "bearish"], specs: [
    spec(3, [call("BUY", 0), call("SELL", 1, 2), call("BUY", 2)], { wings: "broken" }),
    spec(3, [put("BUY", 0), put("SELL", 1, 2), put("BUY", 2)], { wings: "broken" }),
  ] }),
  createTemplateStrategy({ id: "skip_strike_butterfly", label: "Skip-Strike Butterfly", category: "butterfly", description: "Butterfly where one wing skips a strike (one wing is exactly twice the other).", theses: ["range_bound", "bullish", "bearish"], specs: [
    spec(3, [call("BUY", 0), call("SELL", 1, 2), call("BUY", 2)], { wings: "skip" }),
    spec(3, [put("BUY", 0), put("SELL", 1, 2), put("BUY", 2)], { wings: "skip" }),
  ] }),
  createTemplateStrategy({ id: "unbalanced_butterfly", label: "Unbalanced Butterfly", category: "butterfly", description: "Ratio butterfly with uneven quantities: 1 / -3 / 2 (call and put forms).", aliases: ["Ratio Butterfly"], theses: ["range_bound"], specs: [
    spec(3, [call("BUY", 0), call("SELL", 1, 3), call("BUY", 2, 2)], { wings: "equal" }),
    spec(3, [put("BUY", 0, 2), put("SELL", 1, 3), put("BUY", 2)], { wings: "equal" }),
  ] }),

  // Condors
  createTemplateStrategy({ id: "long_call_condor", label: "Long Call Condor", category: "condor", description: "Buy outer calls, sell inner calls, equal wings.", theses: ["range_bound"], specs: [spec(4, [call("BUY", 0), call("SELL", 1), call("SELL", 2), call("BUY", 3)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "short_call_condor", label: "Short Call Condor", category: "condor", description: "Sell outer calls, buy inner calls, equal wings.", theses: ["large_move"], specs: [spec(4, [call("SELL", 0), call("BUY", 1), call("BUY", 2), call("SELL", 3)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "long_put_condor", label: "Long Put Condor", category: "condor", description: "Buy outer puts, sell inner puts, equal wings.", theses: ["range_bound"], specs: [spec(4, [put("BUY", 0), put("SELL", 1), put("SELL", 2), put("BUY", 3)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "short_put_condor", label: "Short Put Condor", category: "condor", description: "Sell outer puts, buy inner puts, equal wings.", theses: ["large_move"], specs: [spec(4, [put("SELL", 0), put("BUY", 1), put("BUY", 2), put("SELL", 3)], { wings: "equal" })] }),
  createTemplateStrategy({ id: "iron_condor", label: "Iron Condor", category: "condor", description: "Put credit spread plus call credit spread.", theses: ["range_bound"], specs: [spec(4, [put("BUY", 0), put("SELL", 1), call("SELL", 2), call("BUY", 3)])] }),
  createTemplateStrategy({ id: "reverse_iron_condor", label: "Reverse Iron Condor", category: "condor", description: "Put debit spread plus call debit spread.", theses: ["large_move"], specs: [spec(4, flip([put("BUY", 0), put("SELL", 1), call("SELL", 2), call("BUY", 3)]))] }),
  createTemplateStrategy({ id: "unbalanced_condor", label: "Unbalanced Condor", category: "condor", description: "Condor with unequal wing widths (call and put forms).", aliases: ["Broken-Wing Condor"], theses: ["range_bound"], specs: [
    spec(4, [call("BUY", 0), call("SELL", 1), call("SELL", 2), call("BUY", 3)], { wings: "unequal" }),
    spec(4, [put("BUY", 0), put("SELL", 1), put("SELL", 2), put("BUY", 3)], { wings: "unequal" }),
  ] }),

  // Time-based (two expirations)
  createTemplateStrategy({ id: "call_calendar", label: "Call Calendar Spread", category: "time", description: "Sell near call, buy far call at the same strike.", aliases: ["Call Time Spread", "Call Horizontal Spread"], theses: ["range_bound", "bullish"], specs: [spec(1, [call("SELL", 0, 1, "near"), call("BUY", 0, 1, "far")])] }),
  createTemplateStrategy({ id: "put_calendar", label: "Put Calendar Spread", category: "time", description: "Sell near put, buy far put at the same strike.", aliases: ["Put Time Spread", "Put Horizontal Spread"], theses: ["range_bound", "bearish"], specs: [spec(1, [put("SELL", 0, 1, "near"), put("BUY", 0, 1, "far")])] }),
  createTemplateStrategy({ id: "double_calendar", label: "Double Calendar Spread", category: "time", description: "Put calendar below plus call calendar above.", theses: ["range_bound"], specs: [spec(2, [put("SELL", 0, 1, "near"), put("BUY", 0, 1, "far"), call("SELL", 1, 1, "near"), call("BUY", 1, 1, "far")])] }),
  createTemplateStrategy({ id: "call_diagonal", label: "Call Diagonal Spread", category: "time", description: "Buy far call at lower strike, sell near call at higher strike.", theses: ["bullish"], specs: [spec(2, [call("BUY", 0, 1, "far"), call("SELL", 1, 1, "near")])] }),
  createTemplateStrategy({ id: "put_diagonal", label: "Put Diagonal Spread", category: "time", description: "Buy far put at higher strike, sell near put at lower strike.", theses: ["bearish"], specs: [spec(2, [put("BUY", 1, 1, "far"), put("SELL", 0, 1, "near")])] }),
  createTemplateStrategy({ id: "double_diagonal", label: "Double Diagonal Spread", category: "time", description: "Put diagonal below plus call diagonal above.", theses: ["range_bound"], specs: [spec(4, [put("BUY", 0, 1, "far"), put("SELL", 1, 1, "near"), call("SELL", 2, 1, "near"), call("BUY", 3, 1, "far")])] }),
  createTemplateStrategy({ id: "poor_mans_covered_call", label: "Poor Man's Covered Call", category: "time", description: "Deep ITM far-dated call (180+ DTE) financed by a near-dated OTM short call.", aliases: ["PMCC"], theses: ["bullish", "range_bound"], specs: [spec(2, [call("BUY", 0, 1, "far"), call("SELL", 1, 1, "near")], { farMinDte: 180, strikeFilter: (ks, underlying) => ks[0] < underlying && ks[1] >= underlying })] }),
  createTemplateStrategy({ id: "poor_mans_covered_put", label: "Poor Man's Covered Put", category: "time", description: "Deep ITM far-dated put (180+ DTE) financed by a near-dated OTM short put.", aliases: ["PMCP"], theses: ["bearish", "range_bound"], specs: [spec(2, [put("BUY", 1, 1, "far"), put("SELL", 0, 1, "near")], { farMinDte: 180, strikeFilter: (ks, underlying) => ks[1] > underlying && ks[0] <= underlying })] }),

  // Ratio, backspread, ladder
  createTemplateStrategy({ id: "call_ratio_spread", label: "Ratio Call Spread", category: "ratio", description: "Buy 1 lower call, sell 2 higher calls; unlimited upside risk.", theses: ["bullish", "range_bound"], specs: [spec(2, [call("BUY", 0), call("SELL", 1, 2)])] }),
  createTemplateStrategy({ id: "put_ratio_spread", label: "Ratio Put Spread", category: "ratio", description: "Buy 1 higher put, sell 2 lower puts.", theses: ["bearish", "range_bound"], specs: [spec(2, [put("BUY", 1), put("SELL", 0, 2)])] }),
  createTemplateStrategy({ id: "call_backspread", label: "Call Backspread", category: "ratio", description: "Sell 1 lower call, buy 2 higher calls.", theses: ["bullish", "large_move"], specs: [spec(2, [call("SELL", 0), call("BUY", 1, 2)])] }),
  createTemplateStrategy({ id: "put_backspread", label: "Put Backspread", category: "ratio", description: "Sell 1 higher put, buy 2 lower puts.", theses: ["bearish", "large_move"], specs: [spec(2, [put("SELL", 1), put("BUY", 0, 2)])] }),
  createTemplateStrategy({ id: "call_ladder", label: "Call Ladder", category: "ratio", description: "Buy lower call, sell two higher calls at different strikes; unlimited upside risk.", aliases: ["Bull Call Ladder"], theses: ["bullish"], specs: [spec(3, [call("BUY", 0), call("SELL", 1), call("SELL", 2)])] }),
  createTemplateStrategy({ id: "put_ladder", label: "Put Ladder", category: "ratio", description: "Buy higher put, sell two lower puts at different strikes.", aliases: ["Bear Put Ladder"], theses: ["bearish"], specs: [spec(3, [put("BUY", 2), put("SELL", 1), put("SELL", 0)])] }),

  // Multi-structure
  createTemplateStrategy({ id: "jade_lizard", label: "Jade Lizard", category: "multi", description: "Short put plus short call spread above.", theses: ["bullish", "range_bound"], specs: [spec(3, [put("SELL", 0), call("SELL", 1), call("BUY", 2)])] }),
  createTemplateStrategy({ id: "big_lizard", label: "Big Lizard", category: "multi", description: "Short straddle plus long OTM call above.", theses: ["bullish", "range_bound"], specs: [spec(2, [put("SELL", 0), call("SELL", 0), call("BUY", 1)])] }),
  createTemplateStrategy({ id: "seagull", label: "Seagull", category: "multi", description: "Bullish seagull: long call spread financed by a short put below.", aliases: ["Bullish Seagull"], theses: ["bullish"], specs: [spec(3, [put("SELL", 0), call("BUY", 1), call("SELL", 2)])] }),

  // Synthetics and arbitrage-style structures
  createTemplateStrategy({ id: "synthetic_long_stock", label: "Synthetic Long Stock", category: "synthetic", description: "Long call plus short put at the same strike.", aliases: ["Long Combo", "Synthetic Long"], theses: ["bullish"], specs: [spec(1, [call("BUY"), put("SELL")])] }),
  createTemplateStrategy({ id: "synthetic_short_stock", label: "Synthetic Short Stock", category: "synthetic", description: "Short call plus long put at the same strike; unlimited upside risk.", aliases: ["Short Combo", "Synthetic Short"], theses: ["bearish"], specs: [spec(1, [call("SELL"), put("BUY")])] }),
  createTemplateStrategy({ id: "risk_reversal", label: "Risk Reversal", category: "synthetic", description: "Bullish form: short OTM put financing a long OTM call.", theses: ["bullish"], specs: [spec(2, [put("SELL", 0), call("BUY", 1)])] }),
  createTemplateStrategy({ id: "box_spread", label: "Box Spread", category: "arbitrage", description: "Bull call spread plus bear put spread on the same strikes (long box).", aliases: ["Long Box Spread", "Long Box"], theses: [...ALL_THESES], specs: [spec(2, [call("BUY", 0), call("SELL", 1), put("BUY", 1), put("SELL", 0)])] }),
  createTemplateStrategy({ id: "short_box_spread", label: "Short Box Spread", category: "arbitrage", description: "Reverse of the long box (synthetic borrowing).", aliases: ["Short Box"], theses: [...ALL_THESES], specs: [spec(2, flip([call("BUY", 0), call("SELL", 1), put("BUY", 1), put("SELL", 0)]))] }),
  createTemplateStrategy({ id: "conversion", label: "Conversion", category: "arbitrage", description: "Long 100 shares, long put, short call at the same strike.", theses: [...ALL_THESES], specs: [spec(1, [stock("BUY"), put("BUY"), call("SELL")])] }),
  createTemplateStrategy({ id: "reverse_conversion", label: "Reverse Conversion", category: "arbitrage", description: "Short 100 shares, short put, long call at the same strike.", aliases: ["Reversal"], theses: [...ALL_THESES], specs: [spec(1, [stock("SELL"), put("SELL"), call("BUY")])] }),
];

export const defaultRegistry = new StrategyRegistry();
DEFINITIONS.forEach((def) => defaultRegistry.register(def));

/** Generic names that intentionally expand to several concrete strategies. */
defaultRegistry
  .alias("Vertical Spread", "call_debit_spread", "put_debit_spread", "call_credit_spread", "put_credit_spread")
  .alias("Horizontal Spread", "call_calendar", "put_calendar")
  .alias("Time Spread", "call_calendar", "put_calendar")
  .alias("Diagonal Spread", "call_diagonal", "put_diagonal")
  .alias("Bull Call Credit Spread", "call_credit_spread")
  .alias("Bull Put Debit Spread", "put_debit_spread")
  .alias("Bear Call Debit Spread", "call_debit_spread")
  .alias("Bear Put Credit Spread", "put_credit_spread");

/** Every strategy name the user asked about (duplicates removed), in the order supplied. */
export const REQUESTED_STRATEGY_NAMES: string[] = [
  "Long Call", "Long Put", "Covered Call", "Covered Put", "Protective Put", "Protective Collar", "Cash-Secured Put", "Married Put",
  "Bull Call Debit Spread", "Bull Put Credit Spread", "Bull Put Debit Spread", "Bull Call Credit Spread",
  "Bear Put Debit Spread", "Bear Call Credit Spread", "Bear Call Debit Spread", "Bear Put Credit Spread",
  "Long Call Vertical Spread", "Short Call Vertical Spread", "Long Put Vertical Spread", "Short Put Vertical Spread",
  "Long Straddle", "Short Straddle", "Long Strangle", "Short Strangle",
  "Long Call Butterfly", "Short Call Butterfly", "Long Put Butterfly", "Short Put Butterfly", "Iron Butterfly", "Reverse Iron Butterfly",
  "Long Call Condor", "Short Call Condor", "Long Put Condor", "Short Put Condor", "Iron Condor", "Reverse Iron Condor",
  "Call Calendar Spread", "Put Calendar Spread", "Double Calendar Spread", "Call Diagonal Spread", "Put Diagonal Spread", "Double Diagonal Spread",
  "Ratio Call Spread", "Ratio Put Spread", "Call Backspread", "Put Backspread", "Call Ladder", "Put Ladder",
  "Jade Lizard", "Big Lizard", "Seagull", "Skip-Strike Butterfly", "Broken-Wing Butterfly", "Unbalanced Butterfly", "Unbalanced Condor",
  "Synthetic Long Stock", "Synthetic Short Stock", "Synthetic Long Call", "Synthetic Long Put", "Synthetic Short Call", "Synthetic Short Put",
  "Box Spread", "Long Box Spread", "Short Box Spread", "Conversion", "Reverse Conversion", "Reversal", "Risk Reversal",
  "Call Ratio Write", "Put Ratio Write", "Covered Strangle", "Covered Combination", "Collar", "Fence",
  "Short Call", "Short Put", "Call Debit Spread", "Call Credit Spread", "Put Debit Spread", "Put Credit Spread",
  "LEAPS Call", "LEAPS Put", "Poor Man’s Covered Call", "Poor Man’s Covered Put", "Call Time Spread", "Put Time Spread",
  "Horizontal Spread", "Vertical Spread", "Diagonal Spread", "Long Guts", "Short Guts", "Long Combo", "Short Combo",
];

const NAME_NOTES: Record<string, string> = {
  bullputdebitspread: "Contradictory name: a put debit spread is bearish. Evaluated as Put Debit Spread under its real (bearish) thesis.",
  bullcallcreditspread: "Contradictory name: a call credit spread is bearish. Evaluated as Call Credit Spread under its real (bearish) thesis.",
  bearcalldebitspread: "Contradictory name: a call debit spread is bullish. Evaluated as Call Debit Spread under its real (bullish) thesis.",
  bearputcreditspread: "Contradictory name: a put credit spread is bullish. Evaluated as Put Credit Spread under its real (bullish) thesis.",
  shortput: "Same payoff as a Cash-Secured Put; margin/collateral is not modeled, so cash-secured risk (strike minus premium) is assumed.",
  verticalspread: "Generic name: expands to all four vertical spreads (call/put, debit/credit).",
  horizontalspread: "Generic name: expands to call and put calendar spreads.",
  timespread: "Generic name: expands to call and put calendar spreads.",
  diagonalspread: "Generic name: expands to call and put diagonal spreads (bullish call form, bearish put form).",
  boxspread: "Long box evaluated; the short box is registered separately.",
  reversal: "Alias of Reverse Conversion (short stock, short put, long call).",
  longcombo: "Alias of Synthetic Long Stock.",
  shortcombo: "Alias of Synthetic Short Stock.",
  collar: "Alias of Protective Collar.",
  fence: "Alias of Protective Collar.",
  coveredcombination: "Alias of Covered Strangle.",
  marriedput: "Same payoff as Protective Put (stock bought together with the put).",
  syntheticlongcall: "Equivalent to Protective Put (long stock plus long put).",
  syntheticlongput: "Equivalent to Protective Call (short stock plus long call).",
  syntheticshortcall: "Equivalent to Covered Put (short stock plus short put).",
  syntheticshortput: "Equivalent to Covered Call (long stock plus short call).",
};

export function buildNameLedger(evaluations: StrategyEvaluation[]): NameLedgerEntry[] {
  const byId = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));
  const rank: Record<string, number> = { accepted: 3, rejected: 2, skipped: 1 };
  return REQUESTED_STRATEGY_NAMES.map((name) => {
    const ids = defaultRegistry.resolve(name);
    if (ids.length === 0) return { name, resolvesTo: [], status: "unresolved", note: "No matching strategy is registered." };
    const evals = ids.map((id) => byId.get(id)).filter((item): item is StrategyEvaluation => Boolean(item));
    const best = evals.sort((a, b) => rank[b.status] - rank[a.status])[0];
    const labels = ids.map((id) => defaultRegistry.get(id)!.label);
    const explicit = NAME_NOTES[normalizeStrategyName(name)];
    const canonical = ids.length === 1 && normalizeStrategyName(defaultRegistry.get(ids[0])!.label) === normalizeStrategyName(name);
    const aliasNote = explicit ?? (canonical ? "" : `Alias of ${labels.join(" / ")}.`);
    const outcome = best ? best.summary : "Not evaluated.";
    return { name, resolvesTo: labels, status: best?.status ?? "skipped", note: [aliasNote, outcome].filter(Boolean).join(" ") };
  });
}
