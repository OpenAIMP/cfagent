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
];

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
        <div className="options-risk-tag">Max loss {dollars(candidate.maxLoss)}</div>
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
  const [eventPolicy, setEventPolicy] = useState<"warn" | "exclude">("warn");
  const [allowedStrategies, setAllowedStrategies] = useState<OptionStrategyType[]>(["long_call", "call_debit_spread"]);
  const [result, setResult] = useState<StrategyRecommendationResult | null>(null);
  const [screenMeta, setScreenMeta] = useState<any>(null);
  const [excludedContracts, setExcludedContracts] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nlqQuery, setNlqQuery] = useState("");
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqResult, setNlqResult] = useState<any>(null);
  const [nlqError, setNlqError] = useState("");

  const toggleStrategy = (strategy: OptionStrategyType) => {
    setAllowedStrategies((current) => current.includes(strategy)
      ? current.filter((item) => item !== strategy)
      : [...current, strategy]);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/trading/options/recommend", {
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
          allowedStrategies,
          eventPolicy,
        }),
      });
      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.error || "Strategy research request failed");
      setResult(data as StrategyRecommendationResult);
      setScreenMeta(data.screen);
      setExcludedContracts(data.contractRejections || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy research request failed");
    } finally {
      setLoading(false);
    }
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
        body: JSON.stringify({ query: nlqQuery.trim() }),
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
            placeholder="Screen liquid call options with delta above 0.35 and 20 to 45 DTE"
          />
        </label>
        <button type="submit" disabled={nlqLoading || !nlqQuery.trim()}>
          {nlqLoading ? "Screening…" : "Screen contracts"}
        </button>
      </form>
      {nlqError && <div className="options-error" role="alert">{nlqError}</div>}
      {nlqResult && (
        <div className="options-nlq-result" role="status">
          <strong>{nlqResult.count ?? 0} option contracts matched</strong>
          <p>{nlqResult.summary}</p>
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

        <div className="options-form-footer">
          <p>Uses your DTE range with minimum 50 volume, 500 open interest, ≤10% spread, and ≤60s quote age.</p>
          <button type="submit" disabled={loading || allowedStrategies.length === 0 || !symbol.trim() || !targetPrice}>
            {loading ? "Evaluating candidates…" : "Rank research candidates"}
          </button>
        </div>
      </form>

      {error && <div className="options-error" role="alert">{error}</div>}
      {result && (
        <div className="options-results">
          <div className="options-results-header">
            <h2>{result.candidates.length ? `${result.candidates.length} ranked candidates` : "No candidates pass the constraints"}</h2>
            <span>{result.modelVersion} · {new Date(result.generatedAt).toLocaleString()}</span>
          </div>
          <div className="options-score-policy">
            Score weights: thesis {result.scoreWeights.thesisAlignment * 100}% · target R/R {result.scoreWeights.targetRewardRisk * 100}% · liquidity {result.scoreWeights.liquidity * 100}% · IV {result.scoreWeights.volatilityAlignment * 100}% · theta {result.scoreWeights.thetaBurden * 100}%
          </div>
          {result.candidates.length === 0 && screenMeta?.quoteQuality?.staleContractsRejected > 0 && (
            <div className="options-stale-banner" role="alert">
              <strong>No fresh contracts passed the quote-age gate.</strong>
              <span>
                {screenMeta.quoteQuality.staleContractsRejected} contracts were rejected as stale. The freshest was {Math.round(screenMeta.quoteQuality.freshestRejectedAgeSeconds || 0).toLocaleString()} seconds old; the limit is {screenMeta.quoteQuality.maxAgeSeconds ?? 60} seconds. Stale quotes are not used for strategy ranking. Retry when the market data feed updates.
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