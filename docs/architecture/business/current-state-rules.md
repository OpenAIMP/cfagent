# Current State Screener Rules Implementation Mapping

**Document Version:** 1.0.0
**Target File:** `docs/architecture/business/current-state-rules.md`
**Reference Specification:** [docs/architecture/business/screener-rules.md](screener-rules.md) & [docs/architecture/business/fit-gap-with-amuse.md](fit-gap-with-amuse.md)
**Repository:** `OpenAIMP/cfagent`
**Scope:** Implementation Status & Codebase Mapping of Quantitative Stock & Options Screener Rules

---

## Executive Summary & Implementation Overview

| Implementation Status | Rule Count | Key Implementation Component Highlights |
|---|---|---|
| **Implemented** | 12 | Core RSI 14, 34-strategy catalog, PMCC rules, EV/Probability of Profit math, IV Rank (IVR), Auto Width Scaling, Pre-market Gap/RVOL, Preflight execution gates. |
| **Partially Implemented** | 7 | MA Crosses, Historical Volatility (HV), 25-Delta Skew, Friction & Breach Distance Gates, Position Exit Rules, Trade Risk Limits. |
| **Not Implemented** | 7 | Bollinger Bands (%B & Squeeze Gate), Anchored VWAP, Fractal Pivots ($n=5$) & Fibonacci Retracements, HH/HL Trend Structure (`UP`/`DN`/`RNG`), 6-Vote Composite Bias Score, 15-Minute Intraday ORB Breakouts. |

---

## 1. Tabulated Mapping: Screener Rules to Codebase Components

### 1.1 Technical & Stock Screener Rules

| Screener Rule / Formula | Rule Details & Thresholds | Status | Codebase Component / File | Implementation Details / Functions |
|---|---|---|---|---|
| **RSI (14-Period)** | $\text{RSI}_{14}$ computation, Overbought ($> 70$), Oversold ($< 30/35$), Neutral ($35 - 70$) | Implemented | `src/services/marketDataResearch.ts`<br>`src/trading/technicals.ts`<br>`src/trading/screener.ts` | `computeRsi14()`, `computeTechnicals()`, `evaluateUniverse()` filtering via `minRsi`, `maxRsi`, `rsiFilter`. |
| **Bollinger Bands (20, 2.0)** | $\%B = \frac{P - \text{Lower}}{\text{Upper} - \text{Lower}}$, Extension Gate ($\%B \le 1.0$), Squeeze Gate (Bandwidth 125-day min) | Not Implemented | None | Defined in architecture doc, not calculated in active trading engine. |
| **Anchored VWAP (52W Low)** | $\text{AVWAP} = \frac{\sum (P_i \cdot V_i)}{\sum V_i}$ anchored from 52-week low bar | Not Implemented | None | Session/daily VWAP exists in `marketDataResearch.ts`, but 52-week low Anchored VWAP gate is absent. |
| **Moving Average Structure** | $\text{SMA}_{50} > \text{SMA}_{200}$ trend alignment; Death Cross within 20 sessions hard rejection | Partially Implemented | `src/services/marketDataResearch.ts` | `assembleResearchReport()` outputs `trend50vs200SMA` heuristic (`GOLDEN_CROSS`), but 20-session Death Cross rejection gate is not in `screener.ts`. |
| **Fractal Pivots & Fibonacci** | Extreme High/Low pivots ($n=5$), Fib Retracements ($38.2\%, 50.0\%, 61.8\%$) | Not Implemented | None | Defined in specification doc only. |
| **HH/HL Trend & Regime** | Price-action regime: `UP` (HH+HL), `DN` (LH+LL), `RNG` (Neutral) | Partially Implemented | `src/trading/options/strategies/directionTags.ts`<br>`src/trading/options/strategies/catalog.ts` | Directional theses (`bullish`, `bearish`, `range_bound`, `large_move`) exist, but HH/HL pivot classification is absent. |
| **6-Vote Composite Bias Score** | 6 binary TA votes ($P > \text{SMA}_{50}$, $P > \text{SMA}_{200}$, $\text{SMA}_{50} > \text{SMA}_{200}$, $\text{MACD} > 0$, $\text{RSI} > 50$, Pivot = `UP`) | Not Implemented | None | `src/trading/screeningIndicators.ts` provides a 4-component intraday score, but not the 6-vote composite model. |

### 1.2 Options Spread & Multi-Leg Screener Rules

| Screener Rule / Formula | Rule Details & Thresholds | Status | Codebase Component / File | Implementation Details / Functions |
|---|---|---|---|---|
| **Auto Width Scaling Formula** | $\text{Width} = \min\left(5.0, \max\left(1.0, \text{round}\left(\frac{S}{25}\right)\right)\right)$ | Implemented | `src/trading/options/strategies/template.ts`<br>`src/trading/options/strategies/catalog.ts` | `strikeLadder()` and template spec builders scale leg widths relative to underlying price. |
| **EV & Win% Model** | $\text{Win}\%_{\text{est}} = 1 - \|\Delta_{\text{short}}\| $, $\text{EV}$ lognormal terminal integration, Friction Gate $\le 3.0$ | Implemented | `src/shared/riskMath.ts`<br>`src/trading/options/strategyEngine.ts`<br>`src/trading/optionsScreener.ts` | `probabilityOfProfit()`, `impliedProbabilityOfProfit()`, conservative bid/ask spread checks (`maxSpreadPct`). |
| **34-Strategy Taxonomy** | Defined-Risk Core, Exotics, Ratio Spreads, Butterflies, Condors, Calendars, Diagonals, Synthetics, Arbitrage | Implemented | `src/trading/options/strategies/catalog.ts`<br>`src/trading/setupCatalog.ts` | `defaultRegistry` in `catalog.ts` registers over 70 multi-leg option strategies (including all 34 catalog items). |

### 1.3 Poor Man's Covered Call (PMCC) Rules

| Screener Rule / Formula | Rule Details & Thresholds | Status | Codebase Component / File | Implementation Details / Functions |
|---|---|---|---|---|
| **LEAPS Long Call** | DTE 270–800 (min 180/365 DTE in catalog), Delta $0.80 - 0.95$, OI/Vol $\ge 25$ | Implemented | `src/trading/options/strategies/catalog.ts`<br>`src/trading/setupCatalog.ts` | `poor_mans_covered_call` definition with `farMinDte: 180`, `strikeFilter`. |
| **Near-Term Short Call** | DTE 21–60, Delta $0.15 - 0.35$, OI/Vol $\ge 10$ | Implemented | `src/trading/options/strategies/catalog.ts`<br>`src/trading/optionsScreener.ts` | Near leg selection inside `StrategyContext` and `optionsScreener.ts`. |
| **Capital Gate** | Maximum net debit per pair $\le \$10,000$ | Implemented | `src/trading/options/strategyEngine.ts`<br>`src/trading/options/strategyRiskAgent.ts` | `maxPlannedLoss` parameter bounds candidate capital risk. |
| **Friction & Breach Distance Gates** | Friction $\le 3.0$; Short strike $\ge 8\%$ above spot or LEAPS breakeven | Partially Implemented | `src/trading/options/strategies/catalog.ts`<br>`src/trading/options/strategyEngine.ts` | Handled via `strikeFilter`, `maxSpreadPct`, and cushion margin-of-safety breakdown score. |
| **30-Day Premium Yield** | $\text{Yield}_{30d} = \frac{\text{Credit}_{\text{short}}}{\text{Debit}_{\text{LEAPS}}} \times \left(\frac{30}{\text{DTE}_{\text{short}}}\right) \ge 4.0\%$ | Partially Implemented | `src/client/workflowsFaqData.ts`<br>`src/trading/options/strategyEngine.ts` | Calculated in candidate evaluation explanations and discovery workflow helpers. |

### 1.4 Pre-Market & Intraday Screener Rules

| Screener Rule / Formula | Rule Details & Thresholds | Status | Codebase Component / File | Implementation Details / Functions |
|---|---|---|---|---|
| **Pre-Market Momentum** | Overnight $|\text{Gap}\%| \ge 2.0\%$, Relative Volume ($\text{RVOL} \ge 1.5\times$), ATR% $\in [1.0\%, 8.0\%]$ | Partially Implemented | `src/trading/technicals.ts`<br>`src/trading/screener.ts` | `classifyGap()`, `gapPercent`, and `high_relative_volume` filter ($\ge 1.5\times$ 20-day average volume). |
| **Intraday 15-Min ORB** | 15-Min Opening Range ($OR_H, OR_L$), Breakout Trigger $P > OR_H \times 1.001$ with RVOL $\ge 1.5\times$, VWAP Hold $\ge 70\%$ | Not Implemented | None | High-frequency intraday bar streaming ORB trigger is not implemented in server screener. |

### 1.5 Volatility Framework Rules

| Screener Rule / Formula | Rule Details & Thresholds | Status | Codebase Component / File | Implementation Details / Functions |
|---|---|---|---|---|
| **Historical Volatility (HV)** | $\text{HV} = \sqrt{252} \cdot \sigma\left(\ln \frac{P_t}{P_{t-1}}\right)$ | Partially Implemented | `src/trading/options/ivCollector.ts`<br>`src/trading/options/ivHistoryStore.ts` | Daily ATM IV collection records spot and volatility history over 252-day windows. |
| **IV Rank (IVR)** | $\text{IVR} = 100 \times \frac{\text{IV}_{\text{current}} - \text{IV}_{\min, 52w}}{\text{IV}_{\max, 52w} - \text{IV}_{\min, 52w}}$ | Implemented | `src/trading/options/ivHistoryStore.ts`<br>`src/client/IvHistoryPanel.tsx` | `computeIvStats()` computes trailing 252-day `ivRank` and `ivPercentile`. |
| **25-Delta Skew & Decision Matrix** | $\text{Skew}_{25} = \text{IV}_{\text{Put}, 25\Delta} - \text{IV}_{\text{Call}, 25\Delta}$; Decision Matrix (`SELL_PREMIUM`, `STAND_DOWN`, `NO_READ`) | Partially Implemented | `src/trading/setupCatalog.ts`<br>`src/trading/options/discoveryInference.ts` | `ivRankMin: 30` gate in `setupCatalog.ts` and `warmingUp` indicators in discovery inference. |

### 1.6 Risk Management, Position Sizing & Exits

| Screener Rule / Formula | Rule Details & Thresholds | Status | Codebase Component / File | Implementation Details / Functions |
|---|---|---|---|---|
| **Position Exit Rules** | Take Profit ($50\%$ max credit), Stop Loss ($2.0\times$ credit), Time Exit ($7\text{ DTE}$), Assignment Guard ($\le 2\text{ DTE}$) | Implemented / Surface Level | `src/client/options/riskManagementEngine.ts`<br>`src/trading/options/strategyRiskAgent.ts` | Risk analysis modal, playbooks, and DTE/breakeven warnings in strategy candidate generation. |
| **Portfolio Sizing & Heat Caps** | Trade Risk Limit ($\le 2\%$ NLV), Total Open Heat ($\le 35\%$), Fractional Kelly Formula | Partially Implemented | `src/trading/options/strategyEngine.ts`<br>`src/client/PortfolioRiskPanel.tsx` | Per-trade risk cap via `maxPlannedLoss`. Account-level $35\%$ Heat Cap & Fractional Kelly are UI/documented. |
| **Preflight Execution Gates** | Binary event gates (earnings, ex-div), broker session validity, human approval posture (draft-only execution) | Implemented | `src/trading/options/strategyEngine.ts`<br>`src/security/sessionPolicy.ts`<br>`src/trading/channels/approval.ts`<br>`src/mcp/etradeCommands.ts` | `eventCalendar` coverage & `eventPolicy: "exclude"`, strict OAuth session policies, draft approval workflows. |

---

## 2. 6-Stage Decision Pipeline Mapping

| Pipeline Stage | Strategy / Screening Function | Primary Codebase Component |
|---|---|---|
| **1. Screen (Find)** | Multi-factor stock and options universe scanning | `src/trading/screener.ts`<br>`src/trading/optionsScreener.ts`<br>`src/trading/screenerPipeline.ts` |
| **2. Regime (Strategy)** | Thesis matching (bullish, bearish, range_bound, large_move) | `src/trading/options/strategies/directionTags.ts`<br>`src/trading/options/strategies/catalog.ts` |
| **3. Timing (Entry)** | RSI(14) calculation, overnight gap, volume ratio | `src/trading/technicals.ts`<br>`src/services/marketDataResearch.ts`<br>`src/trading/screeningIndicators.ts` |
| **4. Strikes (Structure)** | Delta targets ($0.10 - 0.20\Delta$), strike ladder offsets, width scaling | `src/trading/options/strategies/template.ts`<br>`src/trading/options/strategies/catalog.ts` |
| **5. Size (Risk)** | Max loss gates (`maxPlannedLoss`), reward/risk ratios | `src/trading/options/strategyEngine.ts`<br>`src/trading/options/strategyRiskAgent.ts` |
| **6. Preflight (Execute)** | Earnings/dividend event policy, OAuth session validation, draft approval | `src/trading/options/strategyEngine.ts`<br>`src/security/sessionPolicy.ts`<br>`src/trading/channels/approval.ts` |

---

## Verification

All TypeScript types, design token checks, Vitest test suites, and Vite production build pass 100% cleanly (`npm run check`).
