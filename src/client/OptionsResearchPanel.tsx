import { useContext, useEffect, useMemo, useState, createContext } from "react";
import { apiFetch as fetch } from "./apiFetch";
import type {
  ExpectedIvDirection,
  OptionStrategyType,
  OptionThesis,
  StrategyCandidate,
  StrategyLeg,
  StrategyRecommendationResult,
} from "../trading/options/strategyEngine";
import { contractKey, reviseCandidate } from "../trading/options/strategyEngine";
import { toLeg } from "../trading/options/strategies/legs";
import type { ScreenedOptionContractItem } from "../types";
import type { StrategyEvaluation } from "../trading/options/strategies/types";
import { ResearchReportActions } from "./ResearchReportActions";
import { defaultRegistry } from "../trading/options/strategies/catalog";
import "./optionsResearch.css";

interface OptionsResearchPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onPreviewTrade?: (ctx: OptionsTradeContext) => void;
  onJobStateChange?: (state: "idle" | "running" | "ready") => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

export interface OptionsTradeContext {
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  underlyingPrice?: number;
  label: string;
  legs: string[];
}

function toTradeContext(candidate: StrategyCandidate, thesis: OptionThesis, underlyingPrice?: number): OptionsTradeContext {
  return {
    symbol: candidate.symbol,
    action: thesis === "bearish" ? "SELL_SHORT" : "BUY",
    quantity: 1,
    underlyingPrice,
    label: `${candidate.label} (${candidate.expirationDate}), max loss ${candidate.maxLoss === null ? "unlimited" : `$${candidate.maxLoss}`}`,
    legs: candidate.legs.map((leg) => `${leg.side} ${leg.quantity} ${leg.symbol} @ $${leg.entryPrice.toFixed(2)}`),
  };
}

type PreviewTrade = (candidate: StrategyCandidate) => void;

function legsText(candidate?: StrategyCandidate): string {
  return candidate?.legs.map((leg) => `${leg.side} ${leg.quantity} ${leg.symbol}`).join(" / ") || "—";
}

interface LlmInputPreview {
  objective: string;
  system: string;
  instruction: string;
  request: Record<string, unknown>;
  contractCount: number;
  candidateCount: number;
  promptCharacters: number;
  contractsSample: Array<Record<string, unknown>>;
  candidatesSent: Array<Record<string, unknown>>;
}

function LlmInputPanel({ input }: { input?: LlmInputPreview }) {
  if (!input) return null;
  return (
    <div className="options-llm-input">
      <p><b>Objective:</b> {input.objective}</p>
      <details>
        <summary>Input sent to the LLM ({input.contractCount} contracts, {input.candidateCount} candidate trades, ~{input.promptCharacters.toLocaleString()} characters)</summary>
        <p><b>System prompt:</b> {input.system}</p>
        <p><b>Instruction:</b> {input.instruction}</p>
        <p><b>Request:</b></p>
        <pre>{JSON.stringify(input.request, null, 2)}</pre>
        <p><b>Candidate trades sent (all):</b></p>
        <pre>{JSON.stringify(input.candidatesSent, null, 2)}</pre>
        <p><b>Contract sample (first {input.contractsSample.length} of {input.contractCount}; full set is sent):</b></p>
        <pre>{JSON.stringify(input.contractsSample, null, 2)}</pre>
      </details>
    </div>
  );
}

const strategyGroups = defaultRegistry.list().reduce<Record<string, Array<{ id: OptionStrategyType; label: string }>>>((groups, def) => {
  (groups[def.category] ||= []).push({ id: def.id, label: def.label });
  return groups;
}, {});

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
    title: "Strategy universe",
    blurb: "See every strategy in the catalog that was evaluated, as a sortable ledger with passed/failed verdicts and reasons.",
    examples: ["list all strategies evaluated for NVDA bullish target $260"],
  },
  {
    step: 4,
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

interface ComparisonData {
  llmInput?: LlmInputPreview;
  quantStrategyPool?: Array<{ type: string; label: string; generated: number; bestScore: number }>;
  quant: {
    ranked: Array<{ rank: number; compositeScore: number; candidate: StrategyCandidate }>;
    scoreWeights: StrategyRecommendationResult["scoreWeights"];
    candidateCount: number;
  };
  llm: {
    status: "complete" | "error";
    model?: string;
    error?: string;
    ranked?: Array<{ candidateId: string; rank?: number; score: number; rationale: string; risks: string[] }>;
  };
}

function BestTradeCard({ pick, onPreview }: { pick: BestTradeData; onPreview?: PreviewTrade }) {
  return (
    <section className={`options-best-trade options-best-trade-${pick.status}`} role="region" aria-label="Best trade">
      <header className="options-results-header">
        <h2>{pick.status === "no_trade" ? "No qualifying trade" : `Best trade: ${pick.best?.candidate.label}`}</h2>
        <span>{pick.status.replace("_", " ").toUpperCase()} · {pick.confidence} confidence · {pick.riskProfile} profile</span>
        {pick.best && onPreview && <button type="button" onClick={() => onPreview(pick.best!.candidate)}>⚡ Open in Fast Order Ticket</button>}
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
      {pick.best && <StrategyCard candidate={pick.best.candidate} onPreview={onPreview} />}
      {pick.alternatives.length > 0 && (
        <details className="options-excluded">
          <summary>{pick.alternatives.length} runner-up trades</summary>
          <div className="options-scenario-table-wrap">
            <table className="options-scenario-table">
              <thead><tr><th>#</th><th>Strategy</th><th>Expiry</th><th>Max loss</th><th>POP</th><th>Score</th></tr></thead>
              <tbody>{pick.alternatives.map((alt) => (
                <tr key={alt.candidate.id} className={onPreview ? "options-clickable-row" : undefined} onClick={() => onPreview?.(alt.candidate)} title="Open in Fast Order Ticket">
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

function RecommendationComparison({ data, onPreview }: { data: ComparisonData; onPreview?: PreviewTrade }) {
  const llmById = new Map((data.llm.ranked || []).map((item) => [item.candidateId, item]));

  return (
    <section className="options-comparison" aria-label="Quant and LLM recommendation comparison">
      <header className="options-results-header">
        <h2>Quant vs. LLM ranking</h2>
        <span>{data.llm.model || "Configured Workers AI model"} · {data.quant.candidateCount} shared candidates</span>
      </header>
      <LlmInputPanel input={data.llmInput} />
      {data.quantStrategyPool && data.quantStrategyPool.length > 0 && (
        <details className="options-excluded">
          <summary>{data.quantStrategyPool.length} strategy types evaluated by the quant engine</summary>
          <ul>{data.quantStrategyPool.map((s) => <li key={s.type}>{s.label}: {s.generated} trades generated, best score {s.bestScore.toFixed(1)}</li>)}</ul>
        </details>
      )}
      <p className="options-comparison-note">
        Both rank the same quant-generated, risk-screened trades from the same option-chain snapshot. The LLM score is a subjective assessment, not a pricing model or forecast.
      </p>
      {data.llm.status === "error" && <div className="options-error" role="alert">Quant results are available, but the LLM ranking failed: {data.llm.error}</div>}
      {data.quant.ranked.length === 0 ? <p>No quant candidates passed the request constraints.</p> : (
        <div className="options-table-scroll">
          <table className="options-comparison-table">
            <thead><tr><th>Strategy</th><th>Trade (legs)</th><th>Quant rank</th><th>Quant score</th><th>LLM rank</th><th>LLM score</th><th>LLM rationale</th><th>LLM risks</th></tr></thead>
            <tbody>{data.quant.ranked.map((item) => {
              const judgment = llmById.get(item.candidate.id);
              return (
                <tr key={item.candidate.id} className={onPreview ? "options-clickable-row" : undefined} onClick={() => onPreview?.(item.candidate)} title="Open in Fast Order Ticket">
                  <td>{item.candidate.label}</td>
                  <td>{legsText(item.candidate)}</td>
                  <td>{item.rank}</td>
                  <td>{item.compositeScore.toFixed(2)}</td>
                  <td>{judgment?.rank ?? "—"}</td>
                  <td>{judgment ? judgment.score.toFixed(0) : "—"}</td>
                  <td>{judgment?.rationale || "—"}</td>
                  <td>{judgment?.risks.join("; ") || "—"}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {data.llm.status === "complete" && (data.llm.ranked || []).length === 0 && data.quant.ranked.length > 0 && (
        <p>The LLM returned no ranking for this candidate set.</p>
      )}
      <p className="options-assumptions">Research comparison only; neither ranking is personalized financial advice or an instruction to trade. Verify live quotes and all assumptions before acting.</p>
    </section>
  );
}

function defaultTargetDate(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dollars(value: number | null): string {
  return value === null ? "Unlimited" : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedDollars(value: number): string {
  const text = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? "-" : ""}$${text}`;
}

function breakevenText(candidate: StrategyCandidate): string {
  if (!candidate.breakevens.length) return "None";
  const price = (value: number) => `$${value.toFixed(2)}`;
  if (candidate.breakevens.length === 1) {
    const curve = candidate.payoffCurve;
    const profitsAbove = curve.length > 0 && curve[curve.length - 1].pnl > curve[0].pnl;
    return `${profitsAbove ? "Above" : "Below"} ${price(candidate.breakevens[0])}`;
  }
  return candidate.breakevens.map(price).join(" · ");
}

/** Margin is only estimable for defined-risk strategies, where the broker requirement equals the maximum loss. */
function estimatedMargin(candidate: StrategyCandidate): string {
  return Number.isFinite(candidate.maxLoss) && candidate.maxLoss !== null ? dollars(candidate.maxLoss) : "Broker-defined";
}

function niceTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => min + index * step);
}

function PayoffGraph({ candidate }: { candidate: StrategyCandidate }) {
  const [rangePct, setRangePct] = useState(15);
  const [hoverSpot, setHoverSpot] = useState<number | null>(null);
  const width = 720;
  const height = 280;
  const left = 56;
  const right = 16;
  const top = 18;
  const bottom = 30;
  const spot = candidate.underlyingPrice;
  const curve = candidate.payoffCurve;
  if (curve.length < 2) return null;

  const lo = spot * (1 - rangePct / 100);
  const hi = spot * (1 + rangePct / 100);
  const pnlAt = (price: number) => {
    if (price <= curve[0].underlyingPrice) return curve[0].pnl;
    for (let index = 1; index < curve.length; index++) {
      const a = curve[index - 1];
      const b = curve[index];
      if (price <= b.underlyingPrice) {
        const span = b.underlyingPrice - a.underlyingPrice || 1;
        return a.pnl + ((price - a.underlyingPrice) / span) * (b.pnl - a.pnl);
      }
    }
    return curve[curve.length - 1].pnl;
  };

  const inside = curve.filter((point) => point.underlyingPrice > lo && point.underlyingPrice < hi);
  const points = [{ underlyingPrice: lo, pnl: pnlAt(lo) }, ...inside, { underlyingPrice: hi, pnl: pnlAt(hi) }];
  const pnls = points.map((point) => point.pnl);
  const yMin = Math.min(...pnls, 0);
  const yMax = Math.max(...pnls, 0);
  const pad = Math.max(1, (yMax - yMin) * 0.08);
  const y0 = yMin - pad;
  const y1 = yMax + pad;
  const toX = (price: number) => left + ((price - lo) / (hi - lo)) * (width - left - right);
  const toY = (value: number) => top + ((y1 - value) / (y1 - y0)) * (height - top - bottom);
  const zeroY = toY(0);
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${toX(point.underlyingPrice).toFixed(1)},${toY(point.pnl).toFixed(1)}`).join(" ");
  const area = `${line} L${toX(hi).toFixed(1)},${zeroY.toFixed(1)} L${toX(lo).toFixed(1)},${zeroY.toFixed(1)} Z`;
  const id = candidate.id.replace(/[^a-zA-Z0-9]/g, "");
  const marker = hoverSpot ?? spot;
  const markerPnl = pnlAt(marker);
  const visibleBreakevens = candidate.breakevens.filter((price) => price > lo && price < hi);

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * width;
    const ratio = Math.min(1, Math.max(0, (x - left) / (width - left - right)));
    setHoverSpot(lo + ratio * (hi - lo));
  };

  return (
    <div className="options-payoff-wrap">
      <svg
        className="options-payoff-graph"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${candidate.label} profit and loss at expiration`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverSpot(null)}
      >
        <defs>
          <linearGradient id={`${id}-gain`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={`${id}-loss`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id={`${id}-above`}><rect x={left} y={top} width={width - left - right} height={Math.max(0, zeroY - top)} /></clipPath>
          <clipPath id={`${id}-below`}><rect x={left} y={zeroY} width={width - left - right} height={Math.max(0, height - bottom - zeroY)} /></clipPath>
        </defs>
        {niceTicks(y0, y1, 6).map((tick) => (
          <g key={`y${tick}`}>
            <line x1={left} x2={width - right} y1={toY(tick)} y2={toY(tick)} className="options-grid-line" />
            <text x={left - 6} y={toY(tick) + 3} textAnchor="end" className="options-axis-label">{signedDollars(Math.round(tick))}</text>
          </g>
        ))}
        {niceTicks(lo, hi, 7).map((tick) => (
          <text key={`x${tick}`} x={toX(tick)} y={height - 10} textAnchor="middle" className="options-axis-label">${tick.toFixed(2)}</text>
        ))}
        <path d={area} fill={`url(#${id}-gain)`} clipPath={`url(#${id}-above)`} />
        <path d={area} fill={`url(#${id}-loss)`} clipPath={`url(#${id}-below)`} />
        <line x1={left} x2={width - right} y1={zeroY} y2={zeroY} className="options-zero-line" />
        <path d={line} className="options-payoff-line" clipPath={`url(#${id}-above)`} stroke="#22c55e" />
        <path d={line} className="options-payoff-line" clipPath={`url(#${id}-below)`} stroke="#ef4444" />
        <line x1={toX(spot)} x2={toX(spot)} y1={top} y2={height - bottom} className="options-spot-line" />
        <text x={toX(spot)} y={top - 5} textAnchor="middle" className="options-spot-label">${spot.toFixed(2)}</text>
        {visibleBreakevens.map((price) => (
          <g key={`be${price}`}>
            <line x1={toX(price)} x2={toX(price)} y1={top} y2={height - bottom} className="options-breakeven-line" />
            <text x={toX(price)} y={height - bottom - 4} textAnchor="middle" className="options-breakeven-label">BE ${price.toFixed(2)}</text>
          </g>
        ))}
        <line x1={toX(marker)} x2={toX(marker)} y1={top} y2={height - bottom} className="options-marker-line" />
        <circle cx={toX(marker)} cy={toY(markerPnl)} r={4} className="options-marker-dot" />
        <text
          x={Math.min(width - right - 4, Math.max(left + 4, toX(marker) + 8))}
          y={Math.max(top + 12, toY(markerPnl) - 8)}
          className={markerPnl >= 0 ? "options-marker-label gain" : "options-marker-label loss"}
        >
          {`$${marker.toFixed(2)}: ${signedDollars(markerPnl)}`}
        </text>
      </svg>
      <label className="options-range-control">
        <span>Range ±{rangePct}%</span>
        <input type="range" min={2} max={50} step={1} value={rangePct} onChange={(event) => setRangePct(Number(event.target.value))} />
      </label>
    </div>
  );
}

interface ChainContextValue {
  contracts: ScreenedOptionContractItem[];
  version: number;
  refreshing: boolean;
  refreshedAt: string | null;
  refreshError: string;
  refresh: () => Promise<void>;
  target: { targetPrice?: number; targetDate?: string; expectedIvDirection?: ExpectedIvDirection };
}

const ChainContext = createContext<ChainContextValue | null>(null);

function LegEditor({ legs, original, contracts, onChange }: {
  legs: StrategyLeg[];
  original: StrategyLeg[];
  contracts: ScreenedOptionContractItem[];
  onChange: (legs: StrategyLeg[]) => void;
}) {
  const replaceLeg = (index: number, contract: ScreenedOptionContractItem) => {
    const next = legs.slice();
    next[index] = toLeg(contract, legs[index].side, legs[index].quantity);
    onChange(next);
  };
  const changed = legs.some((leg, index) => leg.symbol !== original[index]?.symbol);

  return (
    <div className="options-leg-editor">
      {legs.map((leg, index) => {
        if (leg.optionType === "STOCK") {
          return <div className="options-leg-edit" key={`${leg.symbol}:${index}`}><strong>{leg.side} {leg.quantity} shares</strong></div>;
        }
        const sameType = contracts.filter((contract) => contract.optionType === leg.optionType);
        const expiries = Array.from(new Set([...sameType.map((contract) => contract.expirationDate), leg.expirationDate])).sort();
        const strikes = Array.from(new Set(sameType.filter((contract) => contract.expirationDate === leg.expirationDate).map((contract) => contract.strikePrice))).sort((a, b) => a - b);
        if (!strikes.includes(leg.strike)) strikes.push(leg.strike);
        strikes.sort((a, b) => a - b);
        const position = strikes.indexOf(leg.strike);
        const pick = (expiry: string, strike: number) => {
          const pool = sameType.filter((contract) => contract.expirationDate === expiry);
          if (!pool.length) return;
          const best = pool.reduce((nearest, contract) => (Math.abs(contract.strikePrice - strike) < Math.abs(nearest.strikePrice - strike) ? contract : nearest), pool[0]);
          replaceLeg(index, best);
        };
        return (
          <div className="options-leg-edit" key={`${index}:${leg.optionType}:${leg.side}`}>
            <strong>{leg.side} {leg.quantity} {leg.optionType}</strong>
            <label>
              <span>Expiry</span>
              <select value={leg.expirationDate} onChange={(event) => pick(event.target.value, leg.strike)}>
                {expiries.map((expiry) => <option key={expiry} value={expiry}>{expiry}</option>)}
              </select>
            </label>
            <label className="options-leg-strike">
              <span>Strike ${leg.strike}</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, strikes.length - 1)}
                step={1}
                value={Math.max(0, position)}
                disabled={strikes.length < 2}
                onChange={(event) => pick(leg.expirationDate, strikes[Number(event.target.value)])}
              />
            </label>
            <span>Entry ${leg.entryPrice.toFixed(2)} <small>({leg.side === "BUY" ? "ask" : "bid"} {leg.bid.toFixed(2)} / {leg.ask.toFixed(2)})</small></span>
          </div>
        );
      })}
      {changed && <button type="button" className="options-leg-reset" onClick={() => onChange(original)}>Reset to suggested legs</button>}
    </div>
  );
}

function StrategyCard({ candidate: suggested, onPreview }: { candidate: StrategyCandidate; onPreview?: PreviewTrade }) {
  const chain = useContext(ChainContext);
  const [legs, setLegs] = useState<StrategyLeg[]>(suggested.legs);
  const [underlying, setUnderlying] = useState(suggested.underlyingPrice);
  const [missingLegs, setMissingLegs] = useState(0);

  useEffect(() => {
    setLegs(suggested.legs);
    setUnderlying(suggested.underlyingPrice);
    setMissingLegs(0);
  }, [suggested]);

  const chainVersion = chain?.version ?? 0;
  const contracts = chain?.contracts;
  useEffect(() => {
    if (!chainVersion || !contracts?.length) return;
    const byKey = new Map(contracts.map((contract) => [contractKey(contract), contract]));
    let missing = 0;
    setLegs((current) => current.map((leg) => {
      if (leg.optionType === "STOCK") return leg;
      const fresh = byKey.get(leg.symbol);
      if (!fresh) {
        missing += 1;
        return leg;
      }
      return toLeg(fresh, leg.side, leg.quantity);
    }));
    setMissingLegs(missing);
    const price = contracts.find((contract) => typeof contract.underlyingPrice === "number")?.underlyingPrice;
    if (price) setUnderlying(price);
  }, [chainVersion, contracts]);

  const candidate = useMemo(() => {
    if (legs === suggested.legs && underlying === suggested.underlyingPrice) return suggested;
    try {
      return reviseCandidate(suggested, legs, { underlyingPrice: underlying, ...chain?.target });
    } catch {
      return suggested;
    }
  }, [legs, underlying, suggested, chain?.target?.targetPrice, chain?.target?.targetDate, chain?.target?.expectedIvDirection]);
  const modified = candidate !== suggested;
  const scenarioValues = candidate.scenarios.filter((scenario) => scenario.ivChangePct === 0);
  const valuationDays = Math.min(...scenarioValues.map((scenario) => scenario.daysToExpiry));
  const targetScenarios = scenarioValues.filter((scenario) => scenario.daysToExpiry === valuationDays);

  return (
    <article className="options-candidate">
      <header className="options-candidate-header">
        <div>
          <div className="options-rank">RESEARCH CANDIDATE {candidate.rank}</div>
          <h3>{candidate.label}</h3>
          <p>{candidate.symbol} ${candidate.underlyingPrice.toFixed(2)} · Expiry {candidate.expirationDate} · Ranked score {candidate.score.toFixed(1)}/100</p>
        </div>
        <div className="options-candidate-badges">
          <span className={`options-freshness-tag ${candidate.dataFreshness.toLowerCase()}`}>
            {candidate.dataFreshness === "FRESH" ? "Fresh quotes" : candidate.dataFreshness === "STALE" ? "Stale quotes" : "Quote age unknown"}
          </span>
          <div className="options-risk-tag">Max loss {dollars(candidate.maxLoss)}</div>
          {onPreview && <button type="button" onClick={() => onPreview(candidate)}>⚡ Open in Fast Order Ticket</button>}
          {chain && (
            <button type="button" disabled={chain.refreshing} onClick={() => void chain.refresh()}>
              {chain.refreshing ? "Refreshing…" : "↻ Refresh option prices"}
            </button>
          )}
        </div>
      </header>
      {chain?.refreshedAt && <p className="options-assumptions">Prices refreshed at {chain.refreshedAt}.{missingLegs > 0 ? ` ${missingLegs} leg(s) are no longer in the refreshed chain and keep their previous prices.` : ""}</p>}
      {chain?.refreshError && <p className="options-error" role="alert">{chain.refreshError}</p>}
      {modified && <p className="options-assumptions">Showing your adjusted legs (suggested ranking score and explanations refer to the original legs).</p>}

      <LegEditor legs={legs} original={suggested.legs} contracts={contracts ?? []} onChange={setLegs} />

      <div className="options-summary-strip">
        <div><span>{candidate.netDebit >= 0 ? "NET DEBIT" : "NET CREDIT"}</span><strong>{dollars(Math.abs(candidate.netDebit))}</strong></div>
        <div><span>EST. MARGIN</span><strong>{estimatedMargin(candidate)}</strong></div>
        <div><span>MAX LOSS</span><strong className="options-negative">{dollars(candidate.maxLoss)}</strong></div>
        <div><span>MAX PROFIT</span><strong className="options-positive">{candidate.maxProfitUnbounded ? "Unlimited" : dollars(candidate.maxProfit)}</strong></div>
        <div><span>CHANCE OF PROFIT</span><strong>{(candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}% <small>model</small></strong></div>
        <div><span>BREAKEVEN</span><strong>{breakevenText(candidate)}</strong></div>
      </div>

      <PayoffGraph candidate={candidate} />

      <div className="options-risk-grid">
        <div><span>Target-date modeled P/L</span><strong className={candidate.targetPnl >= 0 ? "options-positive" : "options-negative"}>{dollars(candidate.targetPnl)}</strong></div>
        <div><span>Target reward / risk</span><strong>{candidate.targetRewardRisk.toFixed(2)}x</strong></div>
        <div><span>Liquidity score</span><strong>{candidate.liquidityScore.toFixed(1)}/100</strong></div>
      </div>

      <details className="options-detail">
        <summary>Scenarios, Greeks, and score</summary>
        <div className="options-detail-content">
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

type NlqResultView = {
  summary?: string;
  validationError?: string;
  count?: number;
  rows?: Array<Record<string, unknown>>;
  rejections?: Array<{ contractSymbol?: string; reason?: string }>;
  provenance?: { bestTrade?: BestTradeData };
};

export function OptionsResearchPanel({ activeEnv, userLogin, onPreviewTrade, onJobStateChange, onSendPrompt }: OptionsResearchPanelProps) {
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
  const [allowedStrategies, setAllowedStrategies] = useState<OptionStrategyType[]>(["all"]);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>("balanced");
  const [bestTrade, setBestTrade] = useState<BestTradeData | null>(null);
  const [evaluations, setEvaluations] = useState<StrategyEvaluation[]>([]);
  const [result, setResult] = useState<StrategyRecommendationResult | null>(null);
  const [comparison, setComparison] = useState<ComparisonData | null>(null);
  const [screenMeta, setScreenMeta] = useState<any>(null);
  const [screenedContracts, setScreenedContracts] = useState<Array<Record<string, unknown>>>([]);
  const [excludedContracts, setExcludedContracts] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nlqQuery, setNlqQuery] = useState("");
  const [nlqMaxUnderlyings, setNlqMaxUnderlyings] = useState("25");
  const [nlqQuoteAgeSeconds, setNlqQuoteAgeSeconds] = useState("60");
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqError, setNlqError] = useState("");
  const [nlqResult, setNlqResult] = useState<NlqResultView | null>(null);
  const [chainVersion, setChainVersion] = useState(0);
  const [chainRefreshing, setChainRefreshing] = useState(false);
  const [chainRefreshedAt, setChainRefreshedAt] = useState<string | null>(null);
  const [chainRefreshError, setChainRefreshError] = useState("");

  const refreshChain = async () => {
    setChainRefreshing(true);
    setChainRefreshError("");
    try {
      const response = await fetch("/api/trading/options/screen", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          underlyingSymbols: [symbol.trim().toUpperCase()],
          contractType: "BOTH",
          minDte: Number(minDte),
          maxDte: Number(maxDte),
          minVolume: minVolume.trim() ? Number(minVolume) : undefined,
          minOpenInterest: minOpenInterest.trim() ? Number(minOpenInterest) : undefined,
          maxSpreadPct: maxSpreadPct.trim() ? Number(maxSpreadPct) : undefined,
          maxQuoteAgeSeconds: Number(maxQuoteAgeSeconds),
          limit: Number(contractLimit),
        }),
      });
      const data = await response.json() as { contracts?: Array<Record<string, unknown>>; error?: string; validationError?: string };
      if (!response.ok || data.error || data.validationError) throw new Error(data.error || data.validationError || "Price refresh failed");
      if (!data.contracts?.length) throw new Error("The refreshed option chain was empty.");
      setScreenedContracts(data.contracts);
      setChainVersion((version) => version + 1);
      setChainRefreshedAt(new Date().toLocaleTimeString());
    } catch (cause) {
      setChainRefreshError(cause instanceof Error ? cause.message : "Price refresh failed");
    } finally {
      setChainRefreshing(false);
    }
  };
  const canRun = allowedStrategies.length > 0 && Boolean(symbol.trim()) && Boolean(targetPrice) && /^\d{4}-\d{2}-\d{2}$/.test(targetDate);
  const hasResults = Boolean(bestTrade || comparison || result || nlqResult);
  useEffect(() => {
    onJobStateChange?.(loading ? "running" : hasResults ? "ready" : "idle");
  }, [loading, hasResults, onJobStateChange]);

  const previewTrade: PreviewTrade | undefined = onPreviewTrade
    ? (candidate) => onPreviewTrade(toTradeContext(
      candidate,
      thesis,
      Number(screenedContracts.find((c) => typeof c.underlyingPrice === "number")?.underlyingPrice) || undefined,
    ))
    : undefined;

  const loadExample = (example: string) => {
    setNlqQuery(example);
    const ticker = example.match(/\b(?:for|on)\s+([A-Z]{1,5})\b/)?.[1];
    const target = example.match(/target\s+\$?(\d+(?:\.\d+)?)/i)?.[1];
    const loss = example.match(/max loss\s+\$?(\d+)/i)?.[1];
    if (ticker) setSymbol(ticker);
    if (target) setTargetPrice(target);
    if (loss) setMaxPlannedLoss(loss);
    if (/\bbearish\b/i.test(example)) setThesis("bearish");
    else if (/\bbullish\b/i.test(example)) setThesis("bullish");
  };

  const toggleStrategy = (strategy: OptionStrategyType) => {
    setAllowedStrategies((current) => {
      const base = current.filter((item) => item !== "all");
      return base.includes(strategy) ? base.filter((item) => item !== strategy) : [...base, strategy];
    });
  };

  const run = async (mode: "rank" | "best" | "compare") => {
    setLoading(true);
    setError("");
    setResult(null);
    setBestTrade(null);
    setEvaluations([]);
    setComparison(null);
    setScreenedContracts([]);
    try {
      const endpoint = mode === "best"
        ? "/api/trading/options/best-trade"
        : mode === "compare"
          ? "/api/trading/options/compare"
          : "/api/trading/options/recommend";
      const response = await fetch(endpoint, {
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
          ...(mode === "best" || mode === "compare" ? { riskProfile, alternatives: 3 } : {}),
        }),
      });
      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.error || "Strategy research request failed");
      if (mode === "compare") {
        setComparison(data as ComparisonData);
        setScreenMeta(data.screen);
        setScreenedContracts(data.contracts || []);
        return;
      }
      if (mode === "best") {
        setBestTrade(data.bestTrade as BestTradeData);
        setEvaluations((data.evaluations || []) as StrategyEvaluation[]);
      }
      else setResult(data as StrategyRecommendationResult);
      setScreenMeta(data.screen);
      setScreenedContracts(data.contracts || []);
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

  const logChatActivity = (id: string, text: string) => {
    void fetch("/api/chat-activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, source: "E*TRADE · Auto Options Research", text }),
    }).catch(() => undefined);
  };

  const submitNaturalLanguage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!nlqQuery.trim() || nlqLoading) return;
    const prompt = [
      nlqQuery.trim(),
      `scan up to ${Number(nlqMaxUnderlyings)} underlyings`,
      `quote age reference ${Number(nlqQuoteAgeSeconds)} seconds`,
    ].join("; ");
    const activityId = crypto.randomUUID();
    setNlqLoading(true);
    setNlqError("");
    setNlqResult(null);
    logChatActivity(activityId, `Request submitted to the options agent: ${prompt}`);
    try {
      const response = await fetch("/api/nlq", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ query: prompt }),
      });
      const data = await response.json() as NlqResultView;
      if (!response.ok) throw new Error((data as { error?: string }).error || "Options request failed");
      setNlqResult(data);
      logChatActivity(activityId, `Options agent completed: ${prompt}\n${data.summary || `${data.count ?? 0} result(s)`}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Options request failed";
      setNlqError(message);
      logChatActivity(activityId, `Options agent failed: ${prompt}\n${message}`);
    } finally {
      setNlqLoading(false);
    }
  };

  const chainValue: ChainContextValue = {
    contracts: screenedContracts as unknown as ScreenedOptionContractItem[],
    version: chainVersion,
    refreshing: chainRefreshing,
    refreshedAt: chainRefreshedAt,
    refreshError: chainRefreshError,
    refresh: refreshChain,
    target: { targetPrice: Number(targetPrice) || undefined, targetDate, expectedIvDirection },
  };

  return (
    <ChainContext.Provider value={chainValue}>
    <section className="trading-section options-research-section">
      <header className="options-research-heading">
        <div>
          <p className="options-eyebrow">AUTO OPTIONS RESEARCH · PAPER ONLY</p>
          <h2>Auto Options Research</h2>
          <p>Run an options-screening request in the background, or configure the thesis and constraints below to run the dedicated screen, ranking, or comparison workflow. Requests are logged to the shared Chat without leaving this tab. No orders are placed.</p>
        </div>
        {screenMeta && <div className="options-scan-meta">{screenMeta.contractsEvaluated} contracts evaluated · {screenMeta.contractsMatched} eligible · {result?.request.minDte ?? 14}–{result?.request.maxDte ?? 60} DTE</div>}
      </header>
      {screenMeta?.validationError && <p className="options-error" role="alert">{screenMeta.validationError}</p>}
      {Array.isArray(screenMeta?.fetchErrors) && screenMeta.fetchErrors.length > 0 && (
        <p className="options-error" role="alert">Option chain data problem: {screenMeta.fetchErrors.map((item: { symbol?: string; reason?: string }) => `${item.symbol ?? ""} ${item.reason ?? ""}`.trim()).join("; ")}</p>
      )}
      <details className="options-workflow-drawer">
        <summary>Workflow guide &amp; example requests</summary>
        <div className="options-workflow" aria-label="Options research workflow">
          {workflowSteps.map((s) => (
            <div className="options-workflow-step" key={s.step}>
              <h4><span className="options-workflow-num">{s.step}</span> {s.title}</h4>
              <p>{s.blurb}</p>
              <div className="options-nlq-examples">
                {s.examples.map((example) => (
                  <span className="options-example-row" key={example}>
                    <button type="button" onClick={() => loadExample(example)}>{example}</button>
                    {onSendPrompt && <button type="button" className="options-example-chat" title="Send this request to the shared Chat" onClick={() => onSendPrompt(example, "E*TRADE · Auto Options Research")}>💬 Chat</button>}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <p className="options-workflow-hint">Click an example to load it into the screen fields, or use 💬 Chat to send it to the shared Chat.</p>
        </div>
      </details>
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
        <button type="submit" disabled={!nlqQuery.trim() || nlqLoading}>
          {nlqLoading ? "Running…" : "Run options screen"}
        </button>
      </form>
      {nlqError && <p className="options-error" role="alert">{nlqError}</p>}
      {nlqResult && (
        <div className="options-nlq-result" role="status">
          <strong>{nlqResult.count ?? 0} result rows</strong>
          <p>{nlqResult.validationError || nlqResult.summary}</p>
          {nlqResult.provenance?.bestTrade && <BestTradeCard pick={nlqResult.provenance.bestTrade} onPreview={previewTrade} />}
          {Array.isArray(nlqResult.rows) && nlqResult.rows.length > 0 && Array.isArray(nlqResult.rows[0]?.candidateStrategies) && (
            <StrategyLedgerTable rows={nlqResult.rows} />
          )}
          {Array.isArray(nlqResult.rows) && nlqResult.rows.length > 0 && !Array.isArray(nlqResult.rows[0]?.candidateStrategies) && (
            <div className="options-scenario-table-wrap">
              <table className={`options-scenario-table${Object.prototype.hasOwnProperty.call(nlqResult.rows[0], "reason") ? " options-evaluation-ledger-table" : ""}`}>
                <thead><tr>{Object.keys(nlqResult.rows[0]).map((key) => <th key={key}>{key}</th>)}</tr></thead>
                <tbody>{nlqResult.rows.map((row: Record<string, unknown>, index: number) => (
                  <tr key={`${row.contractSymbol || row.symbol || "row"}:${index}`}>
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
          <h3>Or declare a thesis and constraints</h3>
          <p>Underlying, thesis, target price and at least one strategy are required before the action buttons unlock. Candidates are ranked with visible assumptions.</p>
        </div>
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
          <span>Target date (type YYYY-MM-DD or pick)</span>
          <div className="options-date-row">
            <input
              required
              type="text"
              inputMode="numeric"
              pattern="\d{4}-\d{2}-\d{2}"
              placeholder="YYYY-MM-DD"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
            />
            <input type="date" aria-label="Pick target date" value={/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? targetDate : ""} onChange={(event) => event.target.value && setTargetDate(event.target.value)} />
          </div>
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
          <label>
            <input type="checkbox" checked={allowedStrategies.includes("all")} onChange={() => setAllowedStrategies(allowedStrategies.includes("all") ? [] : ["all"])} />
            <span><strong>All strategies ({defaultRegistry.ids().length})</strong></span>
          </label>
          {!allowedStrategies.includes("all") && Object.entries(strategyGroups).map(([category, choices]) => (
            <details key={category}>
              <summary>{category.replace(/_/g, " ")} ({choices.length})</summary>
              <div className="options-strategy-options">
                {choices.map((choice) => (
                  <label key={choice.id}>
                    <input type="checkbox" checked={allowedStrategies.includes(choice.id)} onChange={() => toggleStrategy(choice.id)} />
                    <span>{choice.label}</span>
                  </label>
                ))}
              </div>
            </details>
          ))}
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
          {!canRun && (
            <p className="options-error" role="status">
              Buttons unlock once you enter: {[!symbol.trim() && "Underlying", !targetPrice && "Target price", allowedStrategies.length === 0 && "at least one strategy"].filter(Boolean).join(", ")}.
            </p>
          )}
          <button type="submit" disabled={loading || !canRun}>
            {loading ? "Evaluating candidates…" : "Rank research candidates"}
          </button>
          <button type="button" disabled={loading || !canRun} onClick={() => void run("best")}>
            {loading ? "Evaluating…" : "Pick best trade"}
          </button>
          <button type="button" disabled={loading || !canRun} onClick={() => void run("compare")}>
            {loading ? "Comparing…" : "Compare Quant vs LLM"}
          </button>
        </div>
      </form>

      {error && <div className="options-error" role="alert">{error}</div>}
      {bestTrade && <BestTradeCard pick={bestTrade} onPreview={previewTrade} />}
      {comparison && <RecommendationComparison data={comparison} onPreview={previewTrade} />}
      {(result?.evaluations || evaluations).length > 0 && <EvaluationTable evaluations={result?.evaluations || evaluations} />}
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
          {result.candidates.map((candidate) => <StrategyCard key={candidate.id} candidate={candidate} onPreview={previewTrade} />)}
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
      <ResearchReportActions
        title={`${symbol || "options"} strategy research`}
        query={nlqQuery || `Rank ${thesis} ${symbol || "NVDA"} option strategies${targetPrice ? ` target $${targetPrice}` : ""} by ${targetDate} max loss $${maxPlannedLoss} ${riskProfile}`}
        userLogin={userLogin}
        sheets={[
          { name: "Options data", rows: screenedContracts },
          { name: "Options screen", rows: screenMeta ? [{ ...screenMeta, symbol: symbol.toUpperCase(), excludedContracts: excludedContracts.length }] : [] },
          { name: "Option rejections", rows: excludedContracts as Array<Record<string, unknown>> },
          { name: "Strategy evaluations", rows: (result?.evaluations || evaluations) as unknown as Array<Record<string, unknown>> },
          { name: "Strategy candidates", rows: (result?.candidates || []).map((candidate) => ({ ...candidate })) },
          { name: "Recommendations", rows: [
            ...(bestTrade?.best ? [{ ...bestTrade.best.candidate, rank: 1, score: bestTrade.best.compositeScore, status: bestTrade.status }] : []),
            ...(bestTrade?.alternatives || []).map((item) => ({ ...item.candidate, rank: item.rank + 1, score: item.compositeScore })),
            ...(result?.candidates || []).map((candidate) => ({ ...candidate, rank: candidate.rank, score: candidate.score })),
          ] },
          { name: "Quant LLM ranking", rows: (comparison?.quant.ranked || []).map((item) => ({
            quantRank: item.rank, quantScore: item.compositeScore, ...item.candidate,
            llmJudgment: comparison?.llm.ranked?.find((entry) => entry.candidateId === item.candidate.id),
          })) },
          { name: "Options NLQ", rows: (nlqResult?.rows || []) as Array<Record<string, unknown>> },
        ]}
      />
    </section>
    </ChainContext.Provider>
  );
}

interface LedgerCandidate {
  id: string;
  name: string;
  status: "accepted" | "rejected" | "skipped";
  why: string;
  description?: string;
  score?: number;
}

type LedgerSortKey = "category" | "score" | "passed" | "failed" | "reason" | "candidateStrategies";

const ledgerColumns: Array<{ key: LedgerSortKey; label: string }> = [
  { key: "category", label: "Category" },
  { key: "score", label: "Score" },
  { key: "passed", label: "Passed" },
  { key: "failed", label: "Failed" },
  { key: "reason", label: "Reason" },
  { key: "candidateStrategies", label: "Candidate strategies" },
];

function StrategyLedgerTable({ rows }: { rows: Array<Record<string, any>> }) {
  const [sortKey, setSortKey] = useState<LedgerSortKey>("score");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  const sorted = [...rows].sort((a, b) => {
    const left = sortKey === "candidateStrategies" ? (a[sortKey] as LedgerCandidate[]).length : a[sortKey];
    const right = sortKey === "candidateStrategies" ? (b[sortKey] as LedgerCandidate[]).length : b[sortKey];
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
    return direction === "asc" ? order : -order;
  });

  const sortBy = (key: LedgerSortKey) => {
    if (key === sortKey) setDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDirection(key === "category" || key === "reason" ? "asc" : "desc");
    }
  };

  return (
    <div className="options-scenario-table-wrap">
      <table className="options-scenario-table options-evaluation-ledger-table strategy-ledger-table">
        <thead>
          <tr>
            {ledgerColumns.map((column) => (
              <th key={column.key} aria-sort={sortKey === column.key ? (direction === "asc" ? "ascending" : "descending") : "none"}>
                <button type="button" className="ledger-sort" onClick={() => sortBy(column.key)}>
                  {column.label}{sortKey === column.key ? (direction === "asc" ? " ▲" : " ▼") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={String(row.category)}>
              <td>{String(row.category)}</td>
              <td>{Number(row.score ?? 0).toFixed(1)}</td>
              <td>{String(row.passed)}</td>
              <td>{String(row.failed)}</td>
              <td>{String(row.reason)}</td>
              <td>
                <ul className="ledger-candidates">
                  {(row.candidateStrategies as LedgerCandidate[]).map((candidate) => (
                    <li key={candidate.id} className={`ledger-candidate ledger-${candidate.status}`}>
                      <a
                        href={`/strategies/${candidate.id}.html`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={candidate.description || candidate.name}
                      >
                        {candidate.name}
                      </a>
                      <span className="ledger-verdict">{candidate.status === "accepted" ? "PASSED" : candidate.status === "rejected" ? "FAILED" : "SKIPPED"}</span>
                      <span className="ledger-why">{candidate.why}</span>
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvaluationTable({ evaluations }: { evaluations: StrategyEvaluation[] }) {
  const counts = evaluations.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] || 0) + 1 }), {} as Record<string, number>);
  return (
    <details className="options-excluded" open>
      <summary>
        Strategies evaluated: {evaluations.length} ({counts.accepted || 0} accepted, {counts.rejected || 0} rejected, {counts.skipped || 0} skipped)
      </summary>
      <div className="options-table-scroll">
        <table>
          <thead><tr><th>Strategy</th><th>Category</th><th>Status</th><th>Built</th><th>Accepted</th><th>Reason</th></tr></thead>
          <tbody>
            {evaluations.map((e) => (
              <tr key={e.id}>
                <td>{e.label}</td><td>{e.category}</td><td>{e.status.toUpperCase()}</td><td>{e.generated}</td><td>{e.accepted}</td><td>{e.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}