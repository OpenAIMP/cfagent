import { useState } from "react";
import type {
  ExpectedIvDirection,
  OptionStrategyType,
  OptionThesis,
  StrategyCandidate,
  StrategyRecommendationResult,
} from "../trading/options/strategyEngine";
import "./optionsResearch.css";

interface OptionsResearchPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}

const strategyChoices: Array<{ id: OptionStrategyType; label: string }> = [
  { id: "long_call", label: "Long call" },
  { id: "long_put", label: "Long put" },
  { id: "call_debit_spread", label: "Call debit spread" },
  { id: "put_debit_spread", label: "Put debit spread" },
  { id: "long_straddle", label: "Long straddle" },
  { id: "long_strangle", label: "Long strangle" },
  { id: "iron_condor", label: "Iron condor" },
  { id: "call_credit_spread", label: "Call credit spread" },
  { id: "put_credit_spread", label: "Put credit spread" },
];

type RiskProfile = "conservative" | "balanced" | "aggressive";

const workflowSteps = [
  {
    step: 1,
    title: "Options data and screener",
    blurb: "Find liquid single contracts (delta, DTE, volume, open interest, spread, quote age).",
    examples: ["Screen call options for NVDA with delta above 0.35, 20 to 45 DTE, volume over 50, open interest above 500, spread under 10%"],
  },
  {
    step: 2,
    title: "Strategy and risk screener",
    blurb: "Build multi-leg strategies and rank them by max loss, breakevens and probability of profit.",
    examples: [
      "Rank bullish NVDA call debit spreads and put credit spreads target $260 in 30 days max loss $500",
      "Show iron condors on SPY 20 to 45 DTE max loss $400 pop above 50%",
    ],
  },
  {
    step: 3,
    title: "Best-trade picker",
    blurb: "Rank by risk profile and pick one trade with a trade plan, confidence and blockers. Add a watchlist or a market-cap scope to scan many stocks.",
    examples: [
      "What is the best trade for NVDA bullish target $260 by 2026-11-20 max loss $500 conservative",
      "Find the best bullish option trades across my Semis watchlist max loss $500",
      "Find best bullish option opportunities across large cap stocks top 10 max loss $500 conservative",
    ],
  },
];
const nlqExamples = workflowSteps.flatMap((s) => s.examples);

interface BestTradeData {
  status: "recommended" | "research_only" | "no_trade";
  riskProfile: RiskProfile;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  best?: { candidate: StrategyCandidate; compositeScore: number };
  alternatives: Array<{ rank: number; candidate: StrategyCandidate; compositeScore: number }>;
  tradePlan?: Array<{ action: string; quantity: number; contract: string; optionType: string; strike: number; expiration: string; limitPrice: number }>;
  rationale: string[];
  blockers: string[];
  disclaimer: string;
}

function BestTradeCard({ pick }: { pick: BestTradeData }) {
  return (
    <section className={`options-best-trade options-best-trade-${pick.status}`} role="region" aria-label="Best trade">
      <header className="options-results-header">
        <h2>{pick.status === "no_trade" ? "No qualifying trade" : `Best trade: ${pick.best?.candidate.label}`}</h2>
        <span>{pick.status.replace("_", " ").toUpperCase()} · {pick.confidence} confidence · {pick.riskProfile} profile</span>
      </header>
      <ul className="options-explanations">{pick.rationale.map((line) => <li key={line}>{line}</li>)}</ul>
      {pick.blockers.length > 0 && <ul className="options-warnings">{pick.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      {pick.tradePlan && pick.tradePlan.length > 0 && (
        <div className="options-scenario-table-wrap">
          <h4>Trade plan (preview only, requires your approval)</h4>
          <table className="options-scenario-table">
            <thead><tr><th>Action</th><th>Qty</th><th>Contract</th><th>Type</th><th>Strike</th><th>Expiration</th><th>Limit</th></tr></thead>
            <tbody>{pick.tradePlan.map((leg) => (
              <tr key={`${leg.contract}:${leg.action}`}>
                <td>{leg.action}</td><td>{leg.quantity}</td><td>{leg.contract}</td><td>{leg.optionType}</td>
                <td>${leg.strike}</td><td>{leg.expiration}</td><td>${leg.limitPrice.toFixed(2)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {pick.best && <StrategyCard candidate={pick.best.candidate} />}
      {pick.alternatives.length > 0 && (
        <details className="options-excluded">
          <summary>{pick.alternatives.length} runner-up trades</summary>
          <div className="options-scenario-table-wrap">
            <table className="options-scenario-table">
              <thead><tr><th>#</th><th>Strategy</th><th>Expiry</th><th>Max loss</th><th>POP</th><th>Score</th></tr></thead>
              <tbody>{pick.alternatives.map((alt) => (
                <tr key={alt.candidate.id}>
                  <td>{alt.rank}</td><td>{alt.candidate.label}</td><td>{alt.candidate.expirationDate}</td>
                  <td>{dollars(alt.candidate.maxLoss)}</td>
                  <td>{(alt.candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%</td>
                  <td>{alt.compositeScore.toFixed(1)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
      <p className="options-assumptions">{pick.disclaimer}</p>
    </section>
  );
}

function defaultTargetDate(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dollars(value: number | null): string {
  return value === null ? "Unlimited" : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function PayoffGraph({ candidate }: { candidate: StrategyCandidate }) {
  const width = 640;
  const height = 190;
  const pad = 20;
  const values = candidate.payoffCurve.map((point) => point.pnl);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = Math.max(1, max - min);
  const toX = (index: number) => pad + index * (width - pad * 2) / Math.max(1, candidate.payoffCurve.length - 1);
  const toY = (value: number) => pad + (max - value) * (height - pad * 2) / range;
  const path = candidate.payoffCurve.map((point, index) => `${index === 0 ? "M" : "L"}${toX(index)},${toY(point.pnl)}`).join(" ");
  const zeroY = toY(0);

  return (
    <svg className="options-payoff-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${candidate.label} expiration payoff graph`}>
      <line x1={pad} y1={zeroY} x2={width - pad} y2={zeroY} className="options-zero-line" />
      <path d={path} className="options-payoff-line" />
      <text x={pad} y={height - 2} className="options-axis-label">50% spot</text>
      <text x={width - pad} y={height - 2} textAnchor="end" className="options-axis-label">150% spot</text>
    </svg>
  );
}

function StrategyCard({ candidate }: { candidate: StrategyCandidate }) {
  const scenarioValues = candidate.scenarios.filter((scenario) => scenario.ivChangePct === 0);
  const valuationDays = Math.min(...scenarioValues.map((scenario) => scenario.daysToExpiry));
  const targetScenarios = scenarioValues.filter((scenario) => scenario.daysToExpiry === valuationDays);

  return (
    <article className="options-candidate">
      <header className="options-candidate-header">
        <div>
          <div className="options-rank">RESEARCH CANDIDATE {candidate.rank}</div>
          <h3>{candidate.symbol} · {candidate.label}</h3>
          <p>Expiry {candidate.expirationDate} · Ranked score {candidate.score.toFixed(1)}/100</p>
        </div>
        <div className="options-candidate-badges">
          <span className={`options-freshness-tag ${candidate.dataFreshness.toLowerCase()}`}>
            {candidate.dataFreshness === "FRESH" ? "Fresh quotes" : candidate.dataFreshness === "STALE" ? "Stale quotes" : "Quote age unknown"}
          </span>
          <div className="options-risk-tag">Max loss {dollars(candidate.maxLoss)}</div>
        </div>
      </header>

      <div className="options-leg-list">
        {candidate.legs.map((leg) => (
          <div className="options-leg" key={`${candidate.id}:${leg.symbol}:${leg.side}`}>
            <strong>{leg.side} {leg.quantity}</strong>
            <span>{leg.symbol}</span>
            <span>{leg.expirationDate}</span>
            <span>${leg.strike} {leg.optionType}</span>
            <span>Entry ${leg.entryPrice.toFixed(2)}</span>
          </div>
        ))}
      </div>

      <div className="options-risk-grid">
        <div><span>Net debit / credit</span><strong>{candidate.netDebit >= 0 ? dollars(candidate.netDebit) : `${dollars(-candidate.netDebit)} credit`}</strong></div>
        <div><span>Max profit</span><strong>{candidate.maxProfitUnbounded ? "Unlimited" : dollars(candidate.maxProfit)}</strong></div>
        <div><span>Break-even(s)</span><strong>{candidate.breakevens.length ? candidate.breakevens.map((point) => `$${point.toFixed(2)}`).join(", ") : "None"}</strong></div>
        <div><span>Target-date modeled P/L</span><strong className={candidate.targetPnl >= 0 ? "options-positive" : "options-negative"}>{dollars(candidate.targetPnl)}</strong></div>
        <div><span>Target reward / risk</span><strong>{candidate.targetRewardRisk.toFixed(2)}x</strong></div>
        <div><span>Model-implied POP</span><strong>{(candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}% · model</strong></div>
        <div><span>Liquidity score</span><strong>{candidate.liquidityScore.toFixed(1)}/100</strong></div>
      </div>

      <details className="options-detail">
        <summary>Payoff, scenarios, Greeks, and score</summary>
        <div className="options-detail-content">
          <PayoffGraph candidate={candidate} />
          <div className="options-greeks">
            <span>Net Δ {candidate.netGreeks.delta.toFixed(2)}</span>
            <span>Γ {candidate.netGreeks.gamma.toFixed(3)}</span>
            <span>Θ {candidate.netGreeks.theta.toFixed(2)}/day</span>
            <span>Vega {candidate.netGreeks.vega.toFixed(2)}</span>
          </div>
          <div className="options-score-grid">
            <span>Thesis alignment <b>{candidate.scoreBreakdown.thesisAlignment.toFixed(0)}</b></span>
            <span>Target reward/risk <b>{candidate.scoreBreakdown.targetRewardRisk.toFixed(0)}</b></span>
            <span>Liquidity <b>{candidate.scoreBreakdown.liquidity.toFixed(0)}</b></span>
            <span>IV alignment <b>{candidate.scoreBreakdown.volatilityAlignment.toFixed(0)}</b></span>
            <span>Theta burden <b>{candidate.scoreBreakdown.thetaBurden.toFixed(0)}</b></span>
            <span>Quote freshness <b>{candidate.scoreBreakdown.freshness.toFixed(0)}</b></span>
          </div>
          {targetScenarios.length > 0 && (
            <div className="options-scenario-table-wrap">
              <h4>Modeled P/L near target date · IV unchanged</h4>
              <table className="options-scenario-table">
                <thead><tr><th>Underlying</th><th>Modeled P/L</th></tr></thead>
                <tbody>{targetScenarios.map((scenario) => (
                  <tr key={`${scenario.underlyingPrice}:${scenario.daysToExpiry}`}>
                    <td>${scenario.underlyingPrice.toFixed(2)}</td>
                    <td>{dollars(scenario.pnl)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <ul className="options-explanations">{candidate.explanations.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <ul className="options-warnings">{candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <p className="options-assumptions">{candidate.assumptions.join(" ")}</p>
        </div>
      </details>
    </article>
  );
}

export function OptionsResearchPanel({ activeEnv, userLogin }: OptionsResearchPanelProps) {
  const [symbol, setSymbol] = useState("");
  const [thesis, setThesis] = useState<OptionThesis>("bullish");
  const [targetPrice, setTargetPrice] = useState("");
  const [targetDate, setTargetDate] = useState(defaultTargetDate);
  const [expectedIvDirection, setExpectedIvDirection] = useState<ExpectedIvDirection>("unchanged");
  const [maxPlannedLoss, setMaxPlannedLoss] = useState("500");
  const [minRewardRisk, setMinRewardRisk] = useState("1.5");
  const [minDte, setMinDte] = useState("14");
  const [maxDte, setMaxDte] = useState("60");
  const [minVolume, setMinVolume] = useState("50");
  const [minOpenInterest, setMinOpenInterest] = useState("500");
  const [maxSpreadPct, setMaxSpreadPct] = useState("10");
  const [maxQuoteAgeSeconds, setMaxQuoteAgeSeconds] = useState("60");
  const [contractLimit, setContractLimit] = useState("500");
  const [candidateLimit, setCandidateLimit] = useState("10");
  const [maxStrikesPerSide, setMaxStrikesPerSide] = useState("12");
  const [maxIronCondors, setMaxIronCondors] = useState("100");
  const [eventPolicy, setEventPolicy] = useState<"warn" | "exclude">("warn");
  const [allowedStrategies, setAllowedStrategies] = useState<OptionStrategyType[]>(["long_call", "call_debit_spread"]);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>("balanced");
  const [bestTrade, setBestTrade] = useState<BestTradeData | null>(null);
  const [result, setResult] = useState<StrategyRecommendationResult | null>(null);
  const [screenMeta, setScreenMeta] = useState<any>(null);
  const [excludedContracts, setExcludedContracts] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nlqQuery, setNlqQuery] = useState("");
  const [nlqMaxUnderlyings, setNlqMaxUnderlyings] = useState("25");
  const [nlqQuoteAgeSeconds, setNlqQuoteAgeSeconds] = useState("60");
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqResult, setNlqResult] = useState<any>(null);
  const [nlqError, setNlqError] = useState("");

  const toggleStrategy = (strategy: OptionStrategyType) => {
    setAllowedStrategies((current) => current.includes(strategy)
      ? current.filter((item) => item !== strategy)
      : [...current, strategy]);
  };

  const run = async (mode: "rank" | "best") => {
    setLoading(true);
    setError("");
    setResult(null);
    setBestTrade(null);
    try {
      const response = await fetch(mode === "best" ? "/api/trading/options/best-trade" : "/api/trading/options/recommend", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          symbol: symbol.trim().toUpperCase(),
          thesis,
          targetPrice: Number(targetPrice),
          targetDate,
          expectedIvDirection,
          maxPlannedLoss: Number(maxPlannedLoss),
          minRewardRisk: Number(minRewardRisk),
          minDte: Number(minDte),
          maxDte: Number(maxDte),
          minVolume: minVolume.trim() ? Number(minVolume) : undefined,
          minOpenInterest: minOpenInterest.trim() ? Number(minOpenInterest) : undefined,
          maxSpreadPct: maxSpreadPct.trim() ? Number(maxSpreadPct) : undefined,
          maxQuoteAgeSeconds: Number(maxQuoteAgeSeconds),
          contractLimit: Number(contractLimit),
          candidateLimit: Number(candidateLimit),
          maxStrikesPerSide: Number(maxStrikesPerSide),
          maxIronCondors: Number(maxIronCondors),
          allowedStrategies,
          eventPolicy,
          ...(mode === "best" ? { riskProfile, alternatives: 3 } : {}),
        }),
      });
      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.error || "Strategy research request failed");
      if (mode === "best") setBestTrade(data.bestTrade as BestTradeData);
      else setResult(data as StrategyRecommendationResult);
      setScreenMeta(data.screen);
      setExcludedContracts(data.contractRejections || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy research request failed");
    } finally {
      setLoading(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run("rank");
  };

  const submitNaturalLanguage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!nlqQuery.trim() || nlqLoading) return;
    setNlqLoading(true);
    setNlqError("");
    setNlqResult(null);
    try {
      const response = await fetch("/api/nlq", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          query: [
            nlqQuery.trim(),
            nlqMaxUnderlyings.trim() && !/\bunderlyings?\b/i.test(nlqQuery)
              ? `scan up to ${Number(nlqMaxUnderlyings)} underlyings`
              : "",
            nlqQuoteAgeSeconds.trim() && !/\bquote\s*age\b/i.test(nlqQuery)
              ? `quote age under ${Number(nlqQuoteAgeSeconds)} seconds`
              : "",
          ].filter(Boolean).join(" "),
        }),
      });
      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.error || "Natural-language options screen failed");
      setNlqResult(data);
    } catch (cause) {
      setNlqError(cause instanceof Error ? cause.message : "Natural-language options screen failed");
    } finally {
      setNlqLoading(false);
    }
  };

  return (
    <section className="trading-section options-research-section">
      <form className="options-nlq-form" onSubmit={submitNaturalLanguage}>
        <label className="options-field">
          <span>Natural-language options screen</span>
          <input
            value={nlqQuery}
            onChange={(event) => setNlqQuery(event.target.value)}
            placeholder="Screen call options with 20 to 45 DTE"
            list="options-nlq-examples"
          />
          <datalist id="options-nlq-examples">{nlqExamples.map((example) => <option key={example} value={example} />)}</datalist>
        </label>
        <label className="options-field">
          <span>Maximum underlyings to scan</span>
          <input
            type="number"
            min="1"
            step="1"
            value={nlqMaxUnderlyings}
            onChange={(event) => setNlqMaxUnderlyings(event.target.value)}
            placeholder="No cap"
          />
        </label>
        <label className="options-field">
          <span>Quote-age reference (seconds; older quotes are marked stale)</span>
          <input
            type="number"
            min="0"
            step="1"
            required
            value={nlqQuoteAgeSeconds}
            onChange={(event) => setNlqQuoteAgeSeconds(event.target.value)}
            placeholder="No limit"
          />
        </label>
        <button type="submit" disabled={nlqLoading || !nlqQuery.trim()}>
          {nlqLoading ? "Screening…" : "Ask"}
        </button>
      </form>
      <div className="options-workflow" aria-label="Three-step options workflow">
        {workflowSteps.map((s) => (
          <div className="options-workflow-step" key={s.step}>
            <h4><span className="options-workflow-num">{s.step}</span> {s.title}</h4>
            <p>{s.blurb}</p>
            <div className="options-nlq-examples">
              {s.examples.map((example) => (
                <button type="button" key={example} onClick={() => setNlqQuery(example)}>{example}</button>
              ))}
            </div>
          </div>
        ))}
        <p className="options-workflow-hint">Click an example to load it, then press Ask. Or use the form below: <b>Rank research candidates</b> (step 2) or <b>Pick best trade</b> (step 3).</p>
      </div>
      {nlqError && <div className="options-error" role="alert">{nlqError}</div>}
      {nlqResult && (
        <div className="options-nlq-result" role="status">
          <strong>{nlqResult.count ?? 0} result rows</strong>
          <p>{nlqResult.validationError || nlqResult.summary}</p>
          {Array.isArray(nlqResult.rows) && nlqResult.rows.length > 0 && (
            <div className="options-scenario-table-wrap">
              <table className="options-scenario-table">
                <thead><tr>{Object.keys(nlqResult.rows[0]).map((key) => <th key={key}>{key}</th>)}</tr></thead>
                <tbody>{nlqResult.rows.map((row: Record<string, unknown>, index: number) => (
                  <tr key={`${row.contractSymbol || row.symbol || "contract"}:${index}`}>
                    {Object.values(row).map((value, column) => <td key={column}>{String(value ?? "N/A")}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {Array.isArray(nlqResult.rejections) && nlqResult.rejections.length > 0 && (
            <details className="options-excluded">
              <summary>View quote and filter rejections</summary>
              <ul>{nlqResult.rejections.slice(0, 8).map((rejection: any, index: number) => (
                <li key={`${rejection.contractSymbol}:${index}`}>{rejection.contractSymbol}: {rejection.reason}</li>
              ))}</ul>
            </details>
          )}
        </div>
      )}

      <header className="options-research-heading">
        <div>
          <p className="options-eyebrow">DETERMINISTIC RESEARCH · PAPER ONLY</p>
          <h2>Options Strategy Research</h2>
          <p>Declare a thesis and constraints. Candidates are ranked with visible assumptions; no orders are placed.</p>
        </div>
        {screenMeta && <div className="options-scan-meta">{screenMeta.contractsEvaluated} contracts evaluated · {screenMeta.contractsMatched} eligible · {result?.request.minDte ?? 14}–{result?.request.maxDte ?? 60} DTE</div>}
      </header>

      <form className="options-request-form" onSubmit={submit}>
        <label className="options-field">
          <span>Underlying</span>
          <input required maxLength={10} value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="Ticker" />
        </label>
        <label className="options-field">
          <span>Thesis</span>
          <select value={thesis} onChange={(event) => setThesis(event.target.value as OptionThesis)}>
            <option value="bullish">Bullish</option>
            <option value="bearish">Bearish</option>
            <option value="range_bound">Range-bound</option>
            <option value="large_move">Large move, direction unknown</option>
          </select>
        </label>
        <label className="options-field">
          <span>Target price</span>
          <input required type="number" min="0.01" step="0.01" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} placeholder="Price at target date" />
        </label>
        <label className="options-field">
          <span>Target date</span>
          <input required type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Expected IV</span>
          <select value={expectedIvDirection} onChange={(event) => setExpectedIvDirection(event.target.value as ExpectedIvDirection)}>
            <option value="rise">Rise</option>
            <option value="unchanged">Unchanged</option>
            <option value="fall">Fall</option>
          </select>
        </label>
        <label className="options-field">
          <span>Maximum planned loss ($)</span>
          <input required type="number" min="1" step="1" value={maxPlannedLoss} onChange={(event) => setMaxPlannedLoss(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Minimum target reward/risk</span>
          <input required type="number" min="0" step="0.1" value={minRewardRisk} onChange={(event) => setMinRewardRisk(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Minimum DTE</span>
          <input required type="number" min="1" step="1" value={minDte} onChange={(event) => setMinDte(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Maximum DTE</span>
          <input required type="number" min={minDte || 1} step="1" value={maxDte} onChange={(event) => setMaxDte(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Minimum contract volume</span>
          <input type="number" min="0" step="1" value={minVolume} onChange={(event) => setMinVolume(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Minimum open interest</span>
          <input type="number" min="0" step="1" value={minOpenInterest} onChange={(event) => setMinOpenInterest(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Maximum bid/ask spread (%)</span>
          <input type="number" min="0" step="0.1" value={maxSpreadPct} onChange={(event) => setMaxSpreadPct(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Quote-age reference (seconds)</span>
          <input required type="number" min="0" step="1" value={maxQuoteAgeSeconds} onChange={(event) => setMaxQuoteAgeSeconds(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Contracts to evaluate</span>
          <input type="number" min="1" step="1" value={contractLimit} onChange={(event) => setContractLimit(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Ranked candidates to show</span>
          <input type="number" min="1" step="1" value={candidateLimit} onChange={(event) => setCandidateLimit(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Strike candidates per side</span>
          <input type="number" min="1" step="1" value={maxStrikesPerSide} onChange={(event) => setMaxStrikesPerSide(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Iron condor combinations</span>
          <input type="number" min="0" step="1" value={maxIronCondors} onChange={(event) => setMaxIronCondors(event.target.value)} />
        </label>
        <label className="options-field">
          <span>Earnings/dividend policy</span>
          <select value={eventPolicy} onChange={(event) => setEventPolicy(event.target.value as "warn" | "exclude")}>
            <option value="warn">Warn if event data unavailable</option>
            <option value="exclude">Exclude until event data can be checked</option>
          </select>
        </label>

        <fieldset className="options-strategy-picker">
          <legend>Allowed strategy templates</legend>
          <div className="options-strategy-options">
            {strategyChoices.map((choice) => (
              <label key={choice.id}>
                <input type="checkbox" checked={allowedStrategies.includes(choice.id)} onChange={() => toggleStrategy(choice.id)} />
                <span>{choice.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="options-field">
          <span>Best-trade risk profile</span>
          <select value={riskProfile} onChange={(event) => setRiskProfile(event.target.value as RiskProfile)}>
            <option value="conservative">Conservative (favor probability and capital safety)</option>
            <option value="balanced">Balanced</option>
            <option value="aggressive">Aggressive (favor reward/risk)</option>
          </select>
        </label>

        <div className="options-form-footer">
          <p>All thresholds and search/result limits are set above. Stale/unknown quote ages are labeled and scored, not excluded on age alone. Zero-bid, crossed, and adjusted contracts are excluded as invalid/non-standard instruments.</p>
          <button type="submit" disabled={loading || allowedStrategies.length === 0 || !symbol.trim() || !targetPrice}>
            {loading ? "Evaluating candidates…" : "Rank research candidates"}
          </button>
          <button type="button" disabled={loading || allowedStrategies.length === 0 || !symbol.trim() || !targetPrice} onClick={() => void run("best")}>
            {loading ? "Evaluating…" : "Pick best trade"}
          </button>
        </div>
      </form>

      {error && <div className="options-error" role="alert">{error}</div>}
      {bestTrade && <BestTradeCard pick={bestTrade} />}
      {result && (
        <div className="options-results">
          <div className="options-results-header">
            <h2>{result.candidates.length ? `${result.candidates.length} ranked candidates` : "No candidates pass the constraints"}</h2>
            <span>{result.modelVersion} · {new Date(result.generatedAt).toLocaleString()}</span>
          </div>
          <div className="options-score-policy">
            Score weights: thesis {result.scoreWeights.thesisAlignment * 100}% · target R/R {result.scoreWeights.targetRewardRisk * 100}% · liquidity {result.scoreWeights.liquidity * 100}% · IV {result.scoreWeights.volatilityAlignment * 100}% · theta {result.scoreWeights.thetaBurden * 100}% · freshness {result.scoreWeights.freshness * 100}%
          </div>
          {(screenMeta?.quoteQuality?.staleContractsReturned > 0 || screenMeta?.quoteQuality?.unknownFreshnessContracts > 0) && (
            <div className="options-stale-banner" role="alert">
              <strong>Quote freshness warning: returned contracts remain visible.</strong>
              <span>
                {screenMeta.quoteQuality.staleContractsReturned} stale and {screenMeta.quoteQuality.unknownFreshnessContracts} timestamp-unknown contracts are shown. The freshest stale quote is {Math.round(screenMeta.quoteQuality.freshestStaleQuoteAgeSeconds || 0).toLocaleString()} seconds old; {screenMeta.quoteQuality.maxAgeSeconds ?? 60}s is the freshness reference. Strategy scores are reduced for stale or unknown data; verify current quotes before acting.
              </span>
            </div>
          )}
          {result.candidates.map((candidate) => <StrategyCard key={candidate.id} candidate={candidate} />)}
          {result.excluded.length > 0 && (
            <details className="options-excluded">
              <summary>{result.excluded.reduce((sum, entry) => sum + entry.count, 0)} strategy combinations excluded</summary>
              <ul>{result.excluded.slice(0, 12).map((entry) => <li key={entry.reason}>{entry.reason} ({entry.count})</li>)}</ul>
            </details>
          )}
          {excludedContracts.length > 0 && (
            <details className="options-excluded">
              <summary>{excludedContracts.length} option contracts failed screening</summary>
              <ul>{excludedContracts.slice(0, 12).map((entry) => <li key={`${entry.contractSymbol}:${entry.reason}`}>{entry.contractSymbol}: {entry.reason}</li>)}</ul>
            </details>
          )}
          <ul className="options-result-assumptions">{result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
        </div>
      )}
    </section>
  );
}