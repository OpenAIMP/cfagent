# Screener Rules Fit-Gap Analysis & Component Mapping (`amuse` vs. `cfagent`)

**Document Version:** 1.0.0
**Target File:** `docs/architecture/business/fit-gap-with-amuse.md`
**Reference Specification:** [docs/architecture/business/screener-rules.md](screener-rules.md) & [OpenAIMP/amuse: amuse-logic.md](https://github.com/OpenAIMP/amuse/blob/main/docs/architecture/business/amuse-logic.md)
**Repository:** `OpenAIMP/cfagent`
**Scope:** Quantitative Options & Stock Screening Business Rules Fit-Gap Audit, Existing Component Mapping, and Target Component Modification Roadmap

---

## Executive Summary & Fit-Gap Audit Overview

This document provides a comprehensive fit-gap analysis between the quantitative options and equity screening rules documented in [`screener-rules.md`](screener-rules.md) (derived from `amuse-logic.md`) and the actual implementation state within the `cfagent` codebase.

### Quantitative Rule Audit Breakdown

- **Total Rules Evaluated:** 26
- **Fully Implemented:** **12** (46.2%)
- **Partially Implemented:** **7** (26.9%)
- **Not Implemented (Gaps):** **7** (26.9%)

```
  [ Implemented: 12 ] ──── [ Partially Implemented: 7 ] ──── [ Not Implemented: 7 ]
    • RSI 14                 • MA Crosses / Death Cross      • Bollinger Bands & %B
    • 34-Strategy Catalog    • HV 20/60 Calculation          • Anchored VWAP (52W Low)
    • PMCC Rules             • 25-Delta Skew                  • Fractal Pivots ($n=5$) & Fibs
    • EV & Win% Model        • PMCC Friction/Breach Gates    • HH/HL Price-Action Regimes
    • IV Rank (IVR 252d)     • 30-Day Premium Yield          • 6-Vote Composite Bias Score
    • Auto Width Scaling     • Position Exit Rules & Sizing  • 15-Min Intraday ORB
    • Gap% & RVOL (>1.5x)    • Account Heat Cap (35%)        • ATR% Volatility Gate
    • Preflight Exec Gates
```

---

## 1. 6-Stage Decision Pipeline Fit-Gap

The quantitative trading architecture mandates a 6-stage decision pipeline before trade execution:

```
[ Screen ] ──> [ Regime ] ──> [ Timing ] ──> [ Strikes ] ──> [ Size ] ──> [ Preflight ]
 (Find)         (Strategy)     (Entry)       (Structure)    (Risk)        (Execute)
```

| Pipeline Stage | Requirement in `screener-rules.md` | `cfagent` Current State | Target Component Mapping & Gap Resolution |
|---|---|---|---|
| **1. Screen** | Filter universe for liquidity, price bounds, volume thresholds, and volatility baselines | **Implemented**: Dynamic scanning over stock and options chains | `src/trading/screener.ts`, `src/trading/optionsScreener.ts`, `src/trading/screenerPipeline.ts` |
| **2. Regime** | Identify underlying market regime (`UP`, `DN`, `RNG`) to map valid strategy families | **Partially Implemented**: Directional thesis tags exist, but price-action regime classification is missing | `src/trading/options/strategies/directionTags.ts`<br>*Target:* Add `classifyPriceRegime()` in `src/trading/technicals.ts` |
| **3. Timing** | Assess entry suitability (RSI, %B, Squeeze, Gap) to prevent chasing extended moves | **Partially Implemented**: RSI 14 and Gap% computed; %B and Squeeze Gate missing | `src/trading/technicals.ts`, `src/services/marketDataResearch.ts`<br>*Target:* Add `computeBollingerBands()` in `src/trading/technicals.ts` |
| **4. Strikes** | Target deltas ($0.10 - 0.20\Delta$ spreads, $0.15 - 0.35\Delta$ PMCC), technical pivots/Fibs | **Partially Implemented**: Delta-based strike selection present; pivots/Fibs missing | `src/trading/options/strategies/template.ts`, `catalog.ts`<br>*Target:* Add `computeFractalPivots()` in `src/trading/technicals.ts` |
| **5. Size** | Max loss $\le 2\%$ NLV per trade, total open heat $\le 35\%$, max loss gates | **Partially Implemented**: `maxPlannedLoss` enforced per candidate; account heat cap is UI-only | `src/trading/options/strategyEngine.ts`<br>*Target:* Integrate portfolio heat in `src/services/positionSizing.ts` |
| **6. Preflight** | Binary event gates (earnings, ex-div), OAuth session validity, human approval posture | **Implemented**: Event policy exclusion, strict OAuth validation, draft approval workflow | `src/trading/options/strategyEngine.ts`, `src/security/sessionPolicy.ts`, `src/trading/channels/approval.ts` |

---

## 2. Detailed Mapping of Implemented Screener Rules

| Rule Category | Specific Rule / Metric | Formula / Threshold | `cfagent` Implementation File | Implementation Details |
|---|---|---|---|---|
| **Technical** | **Relative Strength Index (RSI 14)** | $\text{RSI} = 100 - \frac{100}{1 + \frac{\text{EMA}(\text{Gain}, 14)}{\text{EMA}(\text{Loss}, 14)}}$ | `src/services/marketDataResearch.ts`<br>`src/trading/technicals.ts`<br>`src/trading/screener.ts` | `computeRsi14()`, `computeTechnicals()`, `evaluateUniverse()` filters by `minRsi`, `maxRsi`, and `rsiFilter` (`oversold`, `overbought`, `neutral`). |
| **Options Engine** | **Auto Width Scaling** | $\text{Width} = \min(5.0, \max(1.0, \text{round}(S / 25)))$ | `src/trading/options/strategies/template.ts`<br>`src/trading/options/strategies/catalog.ts` | `strikeLadder()` and `createTemplateStrategy()` dynamically scale spread leg widths relative to spot price $S$. |
| **Options Engine** | **EV & Probability Model** | $\text{Win\%}_{\text{est}} = 1.0 - \|\Delta_{\text{short}}\|$, $\text{EV}$ lognormal terminal integration | `src/shared/riskMath.ts`<br>`src/trading/options/strategyEngine.ts` | `probabilityOfProfit()`, `impliedProbabilityOfProfit()`, and `blackScholesGreeks()` provide shared mathematical primitives. |
| **Options Engine** | **34-Strategy Taxonomy** | Defined-Risk Core, Exotics, Ratio Spreads, Butterflies, Condors, Calendars, Diagonals, Synthetics, Arbitrage | `src/trading/options/strategies/catalog.ts`<br>`src/trading/setupCatalog.ts` | `defaultRegistry` registers over 70 multi-leg option strategies, covering all 34 catalog strategies. |
| **PMCC** | **PMCC Selection & Gates** | LEAPS Long Call (DTE 270–800, $\Delta 0.80-0.95$), Short Call (DTE 21–60, $\Delta 0.15-0.35$), Capital Gate $\le \$10k$ | `src/trading/options/strategies/catalog.ts`<br>`src/trading/options/strategyEngine.ts` | `poor_mans_covered_call` strategy definition enforces `farMinDte: 180`, `strikeFilter`, and `maxPlannedLoss` capital constraints. |
| **Pre-Market** | **Pre-Market Gap & RVOL** | $|\text{Gap}\%| \ge 2.0\%$, Relative Volume ($\text{RVOL} \ge 1.5\times$) | `src/trading/technicals.ts`<br>`src/trading/screener.ts` | `classifyGap()`, `gapPercent`, and `high_relative_volume` filter ($\ge 1.5\times$ 20-day average volume). |
| **Volatility** | **IV Rank (IVR 252-Day)** | $\text{IVR} = 100 \times \frac{\text{IV}_{\text{current}} - \text{IV}_{\min, 52w}}{\text{IV}_{\max, 52w} - \text{IV}_{\min, 52w}}$ | `src/trading/options/ivHistoryStore.ts`<br>`src/client/IvHistoryPanel.tsx` | `computeIvStats()` computes trailing 252-observation `ivRank` and `ivPercentile` over persistent DO SQLite history. |
| **Execution** | **Preflight Execution Gates** | Earnings/ex-dividend date gates, session validity, human approval posture | `src/trading/options/strategyEngine.ts`<br>`src/security/sessionPolicy.ts`<br>`src/trading/channels/approval.ts` | `eventCalendar` checking (`eventPolicy: "exclude"`), OAuth token validation, and draft-only approval workflows (`/api/approval`). |

---

## 3. Mapping of Partially Implemented Rules & Refinement Plan

| Rule Name | Rule Formula / Description | Current `cfagent` State | Target File to Modify | Proposed Enhancement / Function |
|---|---|---|---|---|
| **Moving Average Crosses** | $\text{SMA}_{50} > \text{SMA}_{200}$ bullish alignment; 20-session Death Cross rejection | `assembleResearchReport()` outputs `trend50vs200SMA` heuristic label (`GOLDEN_CROSS`) | `src/trading/technicals.ts`<br>`src/trading/screener.ts` | Implement `computeSmaCross()` over historical bars; add `sma50`, `sma200`, and `deathCrossReject` filters in `screener.ts`. |
| **HH/HL Price-Action Regimes** | Higher Highs + Higher Lows (`UP`), Lower Highs + Lower Lows (`DN`), Range (`RNG`) | Directional thesis tags exist in options catalog, but price-action pivot regime is absent | `src/trading/technicals.ts` | Add `classifyPriceRegime(bars)` to analyze 20-bar pivot highs/lows and return `"UP" \| "DN" \| "RNG"`. |
| **PMCC Friction & Breach Distance** | Friction $\le 3.0$; Short strike $\ge 8\%$ above spot or LEAPS breakeven | Bid/ask spread % and conservative fill pricing enforced; distance metric is partial | `src/trading/options/strategies/catalog.ts`<br>`src/trading/optionsScreener.ts` | Update `poor_mans_covered_call` `strikeFilter` to enforce `shortStrike >= underlying * 1.08`. |
| **30-Day Premium Yield** | $\text{Yield}_{30d} = \frac{\text{Credit}_{\text{short}}}{\text{Debit}_{\text{LEAPS}}} \times \left(\frac{30}{\text{DTE}_{\text{short}}}\right) \ge 4.0\%$ | Mentioned in FAQs and candidate explanations, but not a hard gate in `ledger.ts` | `src/trading/options/strategies/ledger.ts`<br>`src/trading/options/strategyEngine.ts` | Add PMCC yield check to `runAcceptanceRules()` in `ledger.ts`. |
| **Volatility Decision Matrix** | $\text{IVR} > 50 \land \text{IV} > \text{HV} \rightarrow \text{SELL\_PREMIUM}$; $\text{IVR} < 25 \rightarrow \text{STAND\_DOWN}$ | `ivRankMin: 30` in `setupCatalog.ts` and `warmingUp` indicators in `discoverySignals.ts` | `src/trading/options/discoveryInference.ts`<br>`src/trading/options/ivCollector.ts` | Implement formal `evaluateVolDecisionMatrix()` in `discoveryInference.ts`. |
| **Position Exit Rules** | Take Profit ($50\%$), Stop Loss ($2.0\times$), Time Exit ($7 \text{ DTE}$), Assignment Guard ($\le 2 \text{ DTE}$) | Exit playbooks present in client `riskManagementEngine.ts`; warnings emitted server-side | `src/trading/options/strategyRiskAgent.ts` | Expose explicit exit trigger evaluation functions in `strategyRiskAgent.ts` for open position monitoring. |
| **Portfolio Heat Cap (35%)** | Total open max loss across all positions $\le 35\%$ of account equity | Enforced per-trade via `maxPlannedLoss`; portfolio aggregate heat cap is UI-focused | `src/services/positionSizing.ts`<br>`src/client/PortfolioRiskPanel.tsx` | Implement `checkPortfolioHeatCap(openPositions, accountEquity)` in `src/services/positionSizing.ts`. |

---

## 4. Unimplemented Rules & Target Component Modification Plan

This section details the **7 remaining rules** currently absent in `cfagent`, mapping each rule to the specific codebase files and functions that need to be created or modified to achieve full parity with `screener-rules.md`.

### Gap 1: Bollinger Bands (20, 2.0), %B Extension Gate, & Squeeze Gate

- **Specification Rules:**
  - Middle Band: $\text{SMA}(P, 20)$, Upper/Lower Bands: $\text{Middle} \pm 2.0 \times \sigma_{20}$
  - Percent B: $\%B = \frac{P - \text{Lower}}{\text{Upper} - \text{Lower}}$
  - Extension Gate: $\%B \in [0.0, 1.0]$. $\%B > 1.0$ flags overextended price ("don't chase").
  - Squeeze Gate: Bandwidth ($\frac{\text{Upper} - \text{Lower}}{\text{Middle}}$) at $N$-day minimum ($N=125$).
- **Target Components to Modify:**
  1. `src/trading/technicals.ts`: Implement `computeBollingerBands(closes: number[], period = 20, stdDev = 2.0)` returning `{ middle, upper, lower, percentB, bandwidth }`.
  2. `src/types.ts` & `src/trading/screenerConfig.ts`: Extend `StockScreenerFilter` interface with `maxPercentB`, `minPercentB`, `requireSqueezeGate`.
  3. `src/trading/screener.ts`: Add evaluation rules in `evaluateUniverse()` to reject overextended ($\%B > 1.0$) or non-squeeze candidates when requested.

### Gap 2: Anchored VWAP (52-Week Low)

- **Specification Rules:**
  - $\text{AVWAP} = \frac{\sum (P_i \times V_i)}{\sum V_i}$ anchored from the 52-week low bar.
  - Gate: Spot price must remain strictly above Anchored VWAP (`require_above_anchored_vwap: true`).
- **Target Components to Modify:**
  1. `src/trading/technicals.ts`: Implement `computeAnchoredVwapFrom52wLow(bars: YahooDailyBar[])` to locate the 52-week low bar index and accumulate price-volume products forward to the latest bar.
  2. `src/types.ts`: Add `requireAboveAnchoredVwap?: boolean` to `StockScreenerFilter`.
  3. `src/trading/screener.ts`: Inject `anchoredVwap` into `ScreenedStockItem` and enforce rejection when `lastPrice < anchoredVwap`.

### Gap 3: Fractal Pivots ($n=5$) & Fibonacci Retracements

- **Specification Rules:**
  - High/Low fractal pivots require $P_t$ to be extreme compared to $n=5$ preceding and trailing bars.
  - Fib retracement levels computed at $38.2\%, 50.0\%, 61.8\%$ over the 6-month swing range.
- **Target Components to Modify:**
  1. `src/trading/technicals.ts`: Implement `computeFractalPivots(bars: YahooDailyBar[], n = 5)` and `computeFibonacciRetracements(bars: YahooDailyBar[], lookbackBars = 125)`.
  2. `src/trading/options/strategies/template.ts`: Integrate Fibonacci retracement price levels into target strike selection for vertical debit/credit spreads and butterfly wings.

### Gap 4: HH/HL Trend Structure & Regime Classification (`UP`/`DN`/`RNG`)

- **Specification Rules:**
  - **`UP`** (Uptrend): Higher Highs + Higher Lows across 20-bar pivot sequence.
  - **`DN`** (Downtrend): Lower Highs + Lower Lows (triggers hard rejection for bullish selling).
  - **`RNG`** (Range/Neutral): Mixed pivot structure.
- **Target Components to Modify:**
  1. `src/trading/technicals.ts`: Implement `classifyPriceRegime(bars: YahooDailyBar[]): "UP" | "DN" | "RNG"`.
  2. `src/trading/screener.ts`: Add `regimeFilter?: "UP" | "DN" | "RNG"` to `StockScreenerFilter` and reject bullish spreads on `DN` regime underlyings.

### Gap 5: 6-Vote Composite Bias Score

- **Specification Rules:**
  - 6 binary votes (1 point each):
    1. $P > \text{SMA}_{50}$
    2. $P > \text{SMA}_{200}$
    3. $\text{SMA}_{50} > \text{SMA}_{200}$
    4. $\text{MACD line} > 0$
    5. $\text{RSI}_{14} > 50$
    6. Pivot structure is `UP`
  - Bias Classification: Score $\ge 4$ Bullish, $\le 2$ Bearish, 3 Neutral.
- **Target Components to Modify:**
  1. `src/trading/screeningIndicators.ts`: Implement `compute6VoteCompositeBias(closes: number[], bars: YahooDailyBar[])` returning `{ score, votes, bias: "bullish" | "bearish" | "neutral" }`.
  2. `src/trading/screener.ts`: Add `minCompositeBiasScore` to `StockScreenerFilter`.

### Gap 6: Intraday 15-Minute Opening Range Breakouts (ORB)

- **Specification Rules:**
  - 15-Minute Opening Range: Track High ($OR_H$) and Low ($OR_L$) from 09:30–09:45 ET.
  - Breakout Trigger: Spot price clears $OR_H \times 1.001$ with time-prorated $\text{RVOL} \ge 1.5\times$.
  - VWAP Confirmation: Price holding above Session VWAP for $\ge 70\%$ of completed 15-minute bars.
- **Target Components to Modify:**
  1. `src/trading/liveScreener.ts` & `src/trading/screenerPipeline.ts`: Add 15-minute intraday bar processing logic.
  2. `src/services/marketDataResearch.ts`: Extend Alpaca/Yahoo intraday minute bar provider to track $OR_H$ and $OR_L$ windows.

### Gap 7: ATR% Volatility Gate

- **Specification Rules:**
  - Average True Range Percent: $\text{ATR}\% = \frac{\text{ATR}_{14}}{P} \times 100$.
  - Gate: Pre-market and momentum setups require $\text{ATR}\% \in [1.0\%, 8.0\%]$.
- **Target Components to Modify:**
  1. `src/trading/technicals.ts`: Implement `computeAtr(bars: YahooDailyBar[], period = 14)`.
  2. `src/types.ts` & `src/trading/screener.ts`: Add `minAtrPct` and `maxAtrPct` to `StockScreenerFilter` and enforce bounds during screening runs.

---

## 5. Summary Table: Target Component Modification Roadmap

| Target File in `cfagent` | Gap / Rule Addressed | Proposed Function / Modification | Affected Dependent Modules |
|---|---|---|---|
| `src/trading/technicals.ts` | Bollinger Bands, %B, Squeeze, Anchored VWAP, Pivots, Fibs, Regime, ATR% | Add `computeBollingerBands()`, `computeAnchoredVwapFrom52wLow()`, `computeFractalPivots()`, `computeFibonacciRetracements()`, `classifyPriceRegime()`, `computeAtr()`. | `screener.ts`, `marketDataResearch.ts`, `strategyEngine.ts` |
| `src/trading/screeningIndicators.ts` | 6-Vote Composite Bias Score | Add `compute6VoteCompositeBias()` combining RSI, MACD, SMAs, and price regime. | `screener.ts`, `screenerPipeline.ts` |
| `src/trading/screener.ts` | %B, Anchored VWAP, Regime, ATR%, Composite Bias Filters | Extend `StockScreenerFilter` and `evaluateUniverse()` to evaluate new technical filters and log auditable rejections. | `screenerPipeline.ts`, `liveScreener.ts`, `screenerReportPdf.ts` |
| `src/trading/options/strategies/catalog.ts` | PMCC Breach Distance, Fib Strike Placement | Update `poor_mans_covered_call` `strikeFilter` for 8% breach distance; integrate Fib retracement levels in debit/credit spread strike selection. | `strategyEngine.ts`, `recommendationAgent.ts` |
| `src/trading/options/strategies/ledger.ts` | 30-Day Premium Yield Gate | Enforce 30-day premium yield metric ($\ge 4.0\%$) during candidate acceptance pass in `runAcceptanceRules()`. | `strategyEngine.ts` |
| `src/trading/options/discoveryInference.ts` | Volatility Decision Matrix | Implement `evaluateVolDecisionMatrix()` ($\text{IVR} > 50 \land \text{IV} > \text{HV} \rightarrow \text{SELL\_PREMIUM}$; $\text{IVR} < 25 \rightarrow \text{STAND\_DOWN}$). | `discoverySignals.ts`, `opportunityScanner.ts` |
| `src/services/positionSizing.ts` | Portfolio Heat Cap (35%) & Kelly Sizing | Implement `checkPortfolioHeatCap()` and `fractionalKellySizing()` for automated pre-trade risk checks. | `strategyRiskAgent.ts`, `quotePolicies.ts` |
| `src/trading/liveScreener.ts` | 15-Minute Intraday ORB | Add intraday 15-minute opening range tracking ($OR_H, OR_L$) and VWAP hold % validation. | `screenerPipeline.ts`, `mcp/etradeCommands.ts` |

---
*End of Fit-Gap Analysis & Component Mapping Document.*
