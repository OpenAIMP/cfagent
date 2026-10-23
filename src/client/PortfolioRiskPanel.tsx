/**
 * Portfolio Risk panel (issue #63) — surfaces the portfolio-risk backends
 * in the E*TRADE positions view:
 *   aggregates (#34), hedge drafts (#54), correlation flags (#35),
 *   portfolio-aware sizing (#36), recommendation bundles (#1135).
 *
 * The panel is a pure display/input layer: it renders what the server
 * computes — including provenance and unavailable states — and hands
 * hedge drafts to the hub's existing HITL order-ticket flow via
 * onPreviewHedge. It never previews or executes an order itself.
 */

import { useCallback, useEffect, useState } from "react";
import {
  buildEvaluateCandidate,
  bundleCandidateTextState,
  exampleBundleCandidateJson,
  fetchBundle,
  fetchConcentration,
  fetchEvaluate,
  fetchHedgeAnalysis,
  fetchPortfolioRisk,
  fetchRepairAnalysis,
  fetchSizing,
  fetchThinkVerdict,
  fmtNumber,
  fmtSignedUsd,
  fmtUsd,
  hedgeProposalToTradeContext,
  parseBundleCandidate,
  repairProposalToTradeContext,
  positionRowToEvalForm,
  sizingToEvalForm,
  type ConcentrationReport,
  type EvaluateResult,
  type HedgeAnalysis,
  type RecommendationBundle,
  type RepairAnalysis,
  type ThinkTradeValidationResult,
  type PortfolioRiskReport,
  type SizingCandidate,
  type SizingResult,
} from "./portfolioRiskApi";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import "./portfolioRiskPanel.css";

interface PortfolioRiskPanelProps {
  activeEnv: string;
  onPreviewHedge: (ctx: TradeOrderContext) => void;
}

export function PortfolioRiskPanel({ activeEnv, onPreviewHedge }: PortfolioRiskPanelProps) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [report, setReport] = useState<PortfolioRiskReport | null>(null);
  const [hedge, setHedge] = useState<HedgeAnalysis | null>(null);
  const [repair, setRepair] = useState<RepairAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [corrSymbol, setCorrSymbol] = useState("");
  const [concentration, setConcentration] = useState<ConcentrationReport | null>(null);
  const [corrLoading, setCorrLoading] = useState(false);
  const [corrError, setCorrError] = useState("");

  const [sizeSymbol, setSizeSymbol] = useState("");
  const [sizeDelta, setSizeDelta] = useState("");
  const [sizeBetaDelta, setSizeBetaDelta] = useState("");
  const [sizeMaxLoss, setSizeMaxLoss] = useState("");
  const [sizeRiskScore, setSizeRiskScore] = useState("");
  const [sizeRequested, setSizeRequested] = useState("");
  const [sizeCorr, setSizeCorr] = useState("");
  const [sizing, setSizing] = useState<SizingResult | null>(null);
  const [sizeLoading, setSizeLoading] = useState(false);
  const [sizeError, setSizeError] = useState("");

  // Post-trade evaluator (#34 endpoint, surfaced by #67)
  const [evalForm, setEvalForm] = useState<Record<string, string>>({});
  const [evaluation, setEvaluation] = useState<EvaluateResult | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState("");

  // Think-harness guardrail check (#37 service, HTTP route added by #67)
  const [thinkSymbol, setThinkSymbol] = useState("");
  const [thinkAction, setThinkAction] = useState<"BUY" | "SELL">("BUY");
  const [thinkQuantity, setThinkQuantity] = useState("");
  const [thinkOrderType, setThinkOrderType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [thinkPrice, setThinkPrice] = useState("");
  const [verdict, setVerdict] = useState<ThinkTradeValidationResult | null>(null);
  const [thinkLoading, setThinkLoading] = useState(false);
  const [thinkError, setThinkError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [riskResult, hedgeResult, repairResult] = await Promise.allSettled([fetchPortfolioRisk(activeEnv), fetchHedgeAnalysis(activeEnv), fetchRepairAnalysis(activeEnv)]);
      if (riskResult.status === "fulfilled") setReport(riskResult.value);
      else setError(riskResult.reason?.message || "Failed to load portfolio risk");
      if (hedgeResult.status === "fulfilled") setHedge(hedgeResult.value);
      if (repairResult.status === "fulfilled") setRepair(repairResult.value);
    } finally {
      setLoading(false);
    }
  }, [activeEnv]);

  useEffect(() => {
    void load();
  }, [load]);

  const runCorrelation = async () => {
    setCorrLoading(true);
    setCorrError("");
    try {
      setConcentration(await fetchConcentration(activeEnv, corrSymbol.trim() || undefined));
    } catch (err: any) {
      setCorrError(err?.message || "Correlation assessment failed");
    } finally {
      setCorrLoading(false);
    }
  };

  const [lastSizingCandidate, setLastSizingCandidate] = useState<SizingCandidate | null>(null);

  const runSizing = async () => {
    setSizeLoading(true);
    setSizeError("");
    try {
      const candidate: SizingCandidate = {
        symbol: sizeSymbol.trim().toUpperCase(),
        perContract: {
          deltaDollars: Number(sizeDelta) || 0,
          betaWeightedDeltaDollars: sizeBetaDelta.trim() === "" ? null : Number(sizeBetaDelta),
          definedMaxLoss: sizeMaxLoss.trim() === "" ? null : Number(sizeMaxLoss),
        },
        riskScore: sizeRiskScore.trim() === "" ? undefined : Number(sizeRiskScore),
        requestedContracts: sizeRequested.trim() === "" ? undefined : Number(sizeRequested),
        maxMeasuredCorrelation: sizeCorr.trim() === "" ? null : Number(sizeCorr),
      };
      const result = await fetchSizing(activeEnv, candidate);
      setLastSizingCandidate(candidate);
      setSizing(result);
    } catch (err: any) {
      setSizeError(err?.message || "Sizing failed");
    } finally {
      setSizeLoading(false);
    }
  };

  // Recommendation Bundle — Best Trade v2 (#1135): candidate JSON in,
  // bundle out. The panel renders the server-computed bundle verbatim.
  const [bundleJson, setBundleJson] = useState("");
  const [bundleBeta, setBundleBeta] = useState("");
  const [bundle, setBundle] = useState<RecommendationBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleError, setBundleError] = useState("");

  // Issue #1205: the box's state is always explained next to it — an
  // empty or invalid candidate says why Build is unavailable instead of
  // leaving a silently dead button under a placeholder that looks like
  // pre-filled input.
  const bundleTextState = bundleCandidateTextState(bundleJson);

  const insertExampleBundleCandidate = () => {
    setBundleJson(exampleBundleCandidateJson());
    setBundleError("");
    setBundle(null);
  };

  const runBundle = async () => {
    setBundleLoading(true);
    setBundleError("");
    try {
      const candidate = parseBundleCandidate(bundleJson);
      setBundle(await fetchBundle(activeEnv, {
        candidate,
        beta: bundleBeta.trim() === "" ? null : Number(bundleBeta),
      }));
    } catch (err: any) {
      setBundleError(err?.message || "Bundle build failed");
    } finally {
      setBundleLoading(false);
    }
  };

  const runEvaluate = async () => {
    const candidate = buildEvaluateCandidate(evalForm);
    if (!candidate) {
      setEvalError("All fields except β-weighted Δ are required and must be numeric.");
      return;
    }
    setEvalLoading(true);
    setEvalError("");
    try {
      setEvaluation(await fetchEvaluate(activeEnv, candidate));
    } catch (err: any) {
      setEvalError(err?.message || "Evaluation failed");
    } finally {
      setEvalLoading(false);
    }
  };

  const runThink = async () => {
    setThinkLoading(true);
    setThinkError("");
    try {
      const result = await fetchThinkVerdict(activeEnv, {
        symbol: thinkSymbol.trim().toUpperCase(),
        action: thinkAction,
        quantity: Number(thinkQuantity) || 0,
        orderType: thinkOrderType,
        price: thinkPrice.trim() === "" ? undefined : Number(thinkPrice),
      });
      setVerdict(result);
    } catch (err: any) {
      setThinkError(err?.message || "Guardrail check failed");
    } finally {
      setThinkLoading(false);
    }
  };

  const totals = report?.totals;
  const coverage = totals?.betaCoverage;

  return (
    <section className="prp-panel" id="section-portfolio-risk" style={{ scrollMarginTop: 80 }}>
      <div className="prp-header">
        <button type="button" className="prp-collapse" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen}>
          {panelOpen ? "▾" : "▸"} Portfolio Risk
        </button>
        {report && <span className="prp-asof">as of {new Date(report.asOf).toLocaleString()}</span>}
        <button type="button" className="prp-refresh" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>
      {panelOpen && (
      <>

      {error && <div className="prp-error">{error}</div>}
      {!report && !error && <div className="prp-muted">Loading portfolio risk…</div>}

      {report && totals && (
        <>
          <div className="prp-grid">
            <div className="prp-card"><span>Delta</span><strong>{fmtSignedUsd(totals.deltaDollars)}</strong><em>{fmtNumber(totals.deltaShares, 0)} shares equiv.</em></div>
            <div className="prp-card"><span>Beta-weighted Delta</span><strong>{fmtSignedUsd(totals.betaWeightedDeltaDollars)}</strong><em>{totals.betaWeightedSpyShares === null ? "SPY equiv. unavailable" : `${fmtNumber(totals.betaWeightedSpyShares, 1)} SPY shares equiv.`}</em></div>
            <div className="prp-card"><span>Gamma</span><strong>{fmtNumber(totals.gammaSharesPerDollar, 1)}</strong><em>shares per $1 move</em></div>
            <div className="prp-card"><span>Theta</span><strong>{fmtSignedUsd(totals.thetaDollarsPerDay)}</strong><em>per day</em></div>
            <div className="prp-card"><span>Vega</span><strong>{fmtSignedUsd(totals.vegaDollarsPerVolPoint)}</strong><em>per +1 vol point</em></div>
            <div className="prp-card"><span>Rho</span><strong>{fmtSignedUsd(totals.rhoDollarsPerRatePoint)}</strong><em>per +1% rates</em></div>
            <div className="prp-card"><span>Defined max loss</span><strong>{fmtUsd(totals.definedMaxLoss)}</strong><em>{totals.definedMaxLossPctOfNav === null ? "% of NAV unavailable" : `${fmtNumber(totals.definedMaxLossPctOfNav, 1)}% of NAV`}</em></div>
            <div className="prp-card"><span>NAV</span><strong>{fmtUsd(report.nav)}</strong><em>SPY {report.spyPrice ? fmtUsd(report.spyPrice, 2) : "—"}</em></div>
          </div>

          {coverage && (
            <div className="prp-note">
              Beta coverage: {coverage.covered}/{coverage.total} positions — {coverage.computedLive} computed live, {coverage.staticFallback} static fallback
              {coverage.covered < coverage.total ? `, ${coverage.total - coverage.covered} unavailable (excluded from beta-weighted totals, never assumed)` : ""}
            </div>
          )}

          {report.rows.length > 0 && (
            <table className="prp-table">
              <thead><tr><th>Symbol</th><th>Type</th><th>Δ $</th><th>β-weighted Δ $</th><th>Beta</th><th>Defined max loss</th><th></th></tr></thead>
              <tbody>
                {report.rows.map((row, i) => (
                  <tr key={`${row.symbol}-${i}`}>
                    <td>{row.symbol}</td>
                    <td>{row.kind}</td>
                    <td>{fmtSignedUsd(row.deltaDollars)}</td>
                    <td>{fmtSignedUsd(row.betaWeightedDeltaDollars)}</td>
                    <td>{row.beta === null ? "—" : fmtNumber(row.beta)} <span className={`prp-badge prp-badge-${row.betaSource}`}>{row.betaSource}</span></td>
                    <td>{row.definedMaxLoss === null ? "undefined" : fmtUsd(row.definedMaxLoss)}</td>
                    <td><button type="button" className="prp-mini-btn" title="Prefill the Post-Trade Evaluator with this position's Greek contribution" onClick={() => { setEvalForm(positionRowToEvalForm(row)); document.getElementById("section-portfolio-risk")?.scrollIntoView({ behavior: "smooth" }); }}>→ Evaluator</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {report.excluded.length > 0 && (
            <div className="prp-note prp-warn">Excluded from totals: {report.excluded.map((e) => `${e.symbol} (${e.reason})`).join("; ")}</div>
          )}
          {report.partial.length > 0 && (
            <div className="prp-note prp-warn">Partial coverage: {report.partial.map((e) => `${e.symbol} (${e.reason})`).join("; ")}</div>
          )}
          {report.undefinedRiskPositions.length > 0 && (
            <div className="prp-note prp-warn">Undefined-risk positions (excluded from defined max loss): {report.undefinedRiskPositions.join(", ")}</div>
          )}
        </>
      )}

      {/* Hedge drafts (#54) */}
      <div className="prp-subhead">Hedge Proposals <span className="prp-badge prp-badge-draft">DRAFT — HITL review only</span></div>
      {hedge?.status === "within-tolerance" && <div className="prp-note">{hedge.reason}</div>}
      {hedge?.status === "unavailable" && <div className="prp-note prp-warn">{hedge.reason}</div>}
      {hedge && hedge.symbolsMissingBeta.length > 0 && (
        <div className="prp-note prp-warn">Sized on covered exposure only — no beta for: {hedge.symbolsMissingBeta.join(", ")}</div>
      )}
      {hedge?.proposals.map((proposal, i) => (
        <div className="prp-hedge-card" key={`${proposal.instrument}-${i}`}>
          <div className="prp-hedge-main">
            <div className="prp-card-title-row">
              <strong>{proposal.side} {proposal.quantity} {proposal.instrument === "SPY_SHARES" ? "SPY shares" : `SPY ${proposal.strike} PUT ${proposal.expirationDate}`}</strong>
              {proposal.executableOrder?.isExecutable && (
                <span className="prp-badge prp-badge-executable">Executable Ticket Ready</span>
              )}
            </div>
            <span>Est. {proposal.estimatedCost >= 0 ? "cost" : "credit"} {fmtUsd(Math.abs(proposal.estimatedCost), 2)} · β-weighted Δ {fmtSignedUsd(proposal.preHedgeBetaWeightedDeltaDollars)} → {fmtSignedUsd(proposal.postHedgeBetaWeightedDeltaDollars)} {proposal.withinToleranceAfterHedge ? "(within tolerance)" : "(residual above tolerance)"}</span>
            {proposal.executableOrder && (
              <div className="prp-exec-details">
                ⚡ <strong>Order:</strong> {proposal.executableOrder.action} {proposal.executableOrder.quantity} {proposal.executableOrder.symbol} {proposal.executableOrder.assetClass === "options" ? "Options" : "Shares"} · Limit: ${proposal.executableOrder.limitPrice.toFixed(2)} {proposal.executableOrder.strategyNetDebit !== undefined ? `· Net: ${proposal.executableOrder.strategyNetDebit < 0 ? "Credit" : "Debit"} $${(Math.abs(proposal.executableOrder.strategyNetDebit) / 100).toFixed(2)}` : ""}
              </div>
            )}
            <p>{proposal.rationale}</p>
          </div>
          <button type="button" className="prp-preview-btn" onClick={() => onPreviewHedge(hedgeProposalToTradeContext(proposal, report?.spyPrice ?? null))}>
            ⚡ Preview in Order Ticket →
          </button>
        </div>
      ))}

      {/* Repair drafts (#355) */}
      <div className="prp-subhead">Repair Proposals <span className="prp-badge prp-badge-draft">DRAFT — HITL review only</span></div>
      {repair?.status === "not-underwater" && <div className="prp-note">{repair.reason}</div>}
      {repair?.status === "unavailable" && <div className="prp-note prp-warn">{repair.reason}</div>}
      {repair && repair.symbolsUnavailable.length > 0 && (
        <div className="prp-note prp-warn">No repair proposed for: {repair.symbolsUnavailable.map((s) => `${s} (${repair.unavailableReasons[s]})`).join("; ")}</div>
      )}
      {repair?.proposals.map((proposal, i) => (
        <div className="prp-hedge-card" key={`${proposal.symbol}-${i}`}>
          <div className="prp-hedge-main">
            <div className="prp-card-title-row">
              <strong>{proposal.symbol} 1×2 call ratio — buy {proposal.legLong.strike}C, sell 2× {proposal.legShort.strike}C ({proposal.legLong.expirationDate})</strong>
              {proposal.executableOrder?.isExecutable && (
                <span className="prp-badge prp-badge-executable">Executable Ticket Ready</span>
              )}
            </div>
            <span>{proposal.netDebitPerUnit <= 0 ? "Credit" : "Debit"} {fmtUsd(Math.abs(proposal.netDebitPerUnit), 2)}/unit · recover at {fmtUsd(proposal.breakevenAtExpiry, 2)} · capped above {fmtUsd(proposal.upsideCappedAbove, 2)} · <em>no downside protection</em></span>
            {proposal.executableOrder && (
              <div className="prp-exec-details">
                ⚡ <strong>Order:</strong> {proposal.executableOrder.quantity} unit(s) · Buy 1x {proposal.legLong.strike}C / Sell 2x {proposal.legShort.strike}C exp {proposal.legLong.expirationDate} · Limit: ${proposal.executableOrder.limitPrice.toFixed(2)} ({proposal.netDebitPerUnit <= 0 ? "Credit" : "Debit"})
              </div>
            )}
            <p>{proposal.rationale}</p>
          </div>
          <button type="button" className="prp-preview-btn" onClick={() => onPreviewHedge(repairProposalToTradeContext(proposal))}>
            ⚡ Preview in Order Ticket →
          </button>
        </div>
      ))}

      {/* Correlation & concentration (#35) */}
      <div className="prp-subhead">Correlation &amp; Concentration</div>
      <div className="prp-form-row">
        <input value={corrSymbol} onChange={(e) => setCorrSymbol(e.target.value)} placeholder="Candidate symbol (optional)" />
        <button type="button" onClick={() => void runCorrelation()} disabled={corrLoading}>{corrLoading ? "Assessing…" : "Assess"}</button>
      </div>
      {corrError && <div className="prp-error">{corrError}</div>}
      {concentration && (
        <>
          {concentration.sectorShares.length > 0 && (
            <div className="prp-sectors">
              {concentration.sectorShares.map((s) => (
                <div className="prp-sector" key={s.sector}>
                  <span>{s.sector} — {s.symbols.join(", ")}</span>
                  <div className="prp-bar"><div style={{ width: `${Math.min(100, s.sharePct)}%` }} /></div>
                  <strong>{fmtNumber(s.sharePct, 1)}%</strong>
                </div>
              ))}
            </div>
          )}
          {concentration.candidateAssessment && (
            <div>
              <div className="prp-note">
                Candidate {concentration.candidateAssessment.symbol}: {concentration.candidateAssessment.flags.length === 0 ? "no concentration flags" : `${concentration.candidateAssessment.flags.length} flag(s)`}
                {concentration.candidateAssessment.status === "partial-unknown" ? " · some correlations unknown (shown as unknown, never treated as zero)" : ""}
              </div>
              {concentration.candidateAssessment.flags.map((flag, i) => (
                <div className="prp-flag" key={i}>⚠ {flag.message}</div>
              ))}
              <button type="button" className="prp-size-btn" onClick={() => setSizeSymbol(concentration.candidateAssessment!.symbol)}>
                Size this candidate ↓
              </button>
            </div>
          )}
          {concentration.heldCorrelations.length > 0 && (
            <table className="prp-table">
              <thead><tr><th>Pair</th><th>Correlation</th><th>Source</th><th>Observations</th></tr></thead>
              <tbody>
                {concentration.heldCorrelations.map((pair, i) => (
                  <tr key={i}><td>{pair.a} / {pair.b}</td><td>{pair.value === null ? "—" : fmtNumber(pair.value)}</td><td><span className={`prp-badge prp-badge-${pair.source}`}>{pair.source}</span></td><td>{pair.observations || "—"}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {/* Portfolio-aware sizing (#36) */}
      <div className="prp-subhead">Portfolio-Aware Sizing</div>
      <div className="prp-form-grid">
        <label>Symbol<input value={sizeSymbol} onChange={(e) => setSizeSymbol(e.target.value)} placeholder="ACME" /></label>
        <label>Δ $ / contract<input value={sizeDelta} onChange={(e) => setSizeDelta(e.target.value)} placeholder="500" inputMode="decimal" /></label>
        <label>β-weighted Δ $ / contract<input value={sizeBetaDelta} onChange={(e) => setSizeBetaDelta(e.target.value)} placeholder="600 (blank = unknown)" inputMode="decimal" /></label>
        <label>Defined max loss $ / contract<input value={sizeMaxLoss} onChange={(e) => setSizeMaxLoss(e.target.value)} placeholder="200 (blank = undefined risk)" inputMode="decimal" /></label>
        <label>Risk score 0–100<input value={sizeRiskScore} onChange={(e) => setSizeRiskScore(e.target.value)} placeholder="optional" inputMode="decimal" /></label>
        <label>Requested contracts<input value={sizeRequested} onChange={(e) => setSizeRequested(e.target.value)} placeholder="optional" inputMode="numeric" /></label>
        <label>Max measured correlation<input value={sizeCorr} onChange={(e) => setSizeCorr(e.target.value)} placeholder="e.g. 0.85 (optional)" inputMode="decimal" /></label>
      </div>
      <button type="button" className="prp-size-btn" onClick={() => void runSizing()} disabled={sizeLoading || !sizeSymbol.trim()}>
        {sizeLoading ? "Sizing…" : "Size against portfolio"}
      </button>
      {sizeError && <div className="prp-error">{sizeError}</div>}
      {sizing && (
        <div className="prp-sizing-result">
          <div className="prp-note"><strong>{sizing.recommendedContracts} contract(s)</strong> — bound by <strong>{sizing.bindingConstraint}</strong> · NAV band {fmtNumber(sizing.navBandPctApplied, 1)}% · delta basis: {sizing.deltaBudgetBasis}{sizing.correlationSurchargeApplied ? " · correlation surcharge applied" : ""}</div>
          <p className="prp-rationale">{sizing.rationale}</p>
          <table className="prp-table">
            <thead><tr><th>Constraint</th><th>Max contracts</th><th>Detail</th></tr></thead>
            <tbody>
              {sizing.constraints.map((c) => (
                <tr key={c.name} className={c.name === sizing.bindingConstraint ? "prp-binding" : undefined}>
                  <td>{c.name}</td><td>{Number.isFinite(c.maxContracts) ? c.maxContracts : "∞"}</td><td>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="prp-note">Post-trade: Δ {fmtSignedUsd(sizing.postTradeTotals.deltaDollars)} · β-weighted Δ {fmtSignedUsd(sizing.postTradeTotals.betaWeightedDeltaDollars)} · defined max loss {fmtUsd(sizing.postTradeTotals.definedMaxLoss)}</div>
          {lastSizingCandidate && (
            <button type="button" className="prp-size-btn" onClick={() => setEvalForm(sizingToEvalForm(lastSizingCandidate, sizing))}>
              Send sized candidate to Evaluator ↓
            </button>
          )}
        </div>
      )}

      {/* Recommendation Bundle — Best Trade v2 (#1135, Phase 4 of #1096) */}
      <div className="prp-subhead">Recommendation Bundle (Best Trade v2)</div>
      <div className="prp-note">Paste a strategy candidate (strategy-engine JSON) to build its full bundle against the live book: trade + falsification + post-trade risk + optimizer verdict + hedge/repair plans + alternatives including no-trade. Draft only — human approval is required for any order.</div>
      <div className="prp-form-grid">
        <label>Symbol beta (blank = unknown)<input value={bundleBeta} onChange={(e) => setBundleBeta(e.target.value)} placeholder="e.g. 1.1" inputMode="decimal" /></label>
      </div>
      <textarea
        className="prp-bundle-json"
        value={bundleJson}
        onChange={(e) => setBundleJson(e.target.value)}
        placeholder='{"id": "…", "symbol": "XYZ", "underlyingPrice": 200, "legs": [ … ], "netGreeks": {"delta": 0.5, "gamma": 0.02, "theta": -0.02, "vega": 0.05}, …}'
        rows={5}
        style={{ width: "100%" }}
      />
      {bundleTextState.status === "empty" && <div className="prp-note">{bundleTextState.message}</div>}
      {bundleTextState.status === "invalid" && <div className="prp-error">{bundleTextState.message}</div>}
      <button type="button" className="prp-size-btn" onClick={insertExampleBundleCandidate}>
        Insert example candidate
      </button>
      <button type="button" className="prp-size-btn" onClick={() => void runBundle()} disabled={bundleLoading || bundleTextState.status !== "valid"}>
        {bundleLoading ? "Building…" : "Build bundle"}
      </button>
      {bundleError && <div className="prp-error">{bundleError}</div>}
      {bundle && (
        <div className="prp-sizing-result">
          <div className="prp-note">
            <strong>{bundle.decision === "trade" ? bundle.trade?.label : "No trade"}</strong>
            {" "}· status {bundle.status} · qualification <strong>{bundle.qualification}</strong> · confidence {bundle.confidence}
            {" "}· optimizer verdict <strong>{bundle.optimizer.verdict}</strong> (score {fmtNumber(bundle.optimizer.score, 1)}, expected P/L {fmtSignedUsd(bundle.optimizer.expectedPnl)}, CVaR {fmtSignedUsd(bundle.optimizer.cvarPnl)})
          </div>
          <p className="prp-rationale">{bundle.rationale.join(" ")}</p>
          {bundle.optimizer.evidence.map((e, i) => <div key={i} className="prp-note">{e}</div>)}
          {bundle.optimizer.breaches.map((b, i) => <div key={i} className="prp-error">Breach: {b}</div>)}
          <div className="prp-note">
            Hedging: {bundle.hedging.status}{bundle.hedging.options.length ? ` — top: ${bundle.hedging.options[0].label} (cost ${fmtUsd(bundle.hedging.options[0].estimatedCost)}, removes ${fmtUsd(bundle.hedging.options[0].riskRemovedDollars)} β-weighted Δ)` : ""}
            {" "}· Repairs: {bundle.repairs.status}{bundle.repairs.options.length ? ` — top: ${bundle.repairs.options[0].label}` : ""}
          </div>
          <div className="prp-note">Alternatives: {bundle.alternatives.map((a) => `${a.label} (score ${fmtNumber(a.score, 1)})`).join("; ")}</div>
          {bundle.limitations.map((l, i) => <div key={i} className="prp-note">Limitation: {l}</div>)}
          <div className="prp-note">Human approval required. {bundle.disclaimer}</div>
        </div>
      )}

      {/* Post-trade evaluator (#34 endpoint, surfaced by #67) */}
      <div className="prp-subhead">Post-Trade Evaluator</div>
      <div className="prp-note">Enter a candidate position's TOTAL Greek contribution (all contracts combined) to see current vs post-trade portfolio totals.</div>
      <div className="prp-form-grid">
        {([
          ["deltaShares", "Δ shares"], ["deltaDollars", "Δ $"], ["betaWeightedDeltaDollars", "β-weighted Δ $ (blank = unknown)"],
          ["gammaSharesPerDollar", "Γ shares/$"], ["thetaDollarsPerDay", "Θ $/day"], ["vegaDollarsPerVolPoint", "Vega $/vol pt"],
          ["rhoDollarsPerRatePoint", "Rho $/1%"], ["definedMaxLoss", "Defined max loss $"],
        ] as Array<[string, string]>).map(([key, label]) => (
          <label key={key}>{label}<input value={evalForm[key] ?? ""} onChange={(e) => setEvalForm({ ...evalForm, [key]: e.target.value })} inputMode="decimal" /></label>
        ))}
      </div>
      <button type="button" className="prp-size-btn" onClick={() => void runEvaluate()} disabled={evalLoading}>{evalLoading ? "Evaluating…" : "Evaluate post-trade"}</button>
      {evalError && <div className="prp-error">{evalError}</div>}
      {evaluation && (
        <table className="prp-table">
          <thead><tr><th>Total</th><th>Current</th><th>Post-trade</th></tr></thead>
          <tbody>
            {([
              ["Delta $", "deltaDollars"], ["Beta-weighted Δ $", "betaWeightedDeltaDollars"], ["Gamma (shares/$)", "gammaSharesPerDollar"],
              ["Theta $/day", "thetaDollarsPerDay"], ["Vega $/vol pt", "vegaDollarsPerVolPoint"], ["Rho $/1%", "rhoDollarsPerRatePoint"], ["Defined max loss $", "definedMaxLoss"],
            ] as Array<[string, string]>).map(([label, key]) => (
              <tr key={key}>
                <td>{label}</td>
                <td>{fmtSignedUsd((evaluation.current.totals as unknown as Record<string, number | null>)[key])}</td>
                <td>{fmtSignedUsd((evaluation.postTradeTotals as unknown as Record<string, number | null>)[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Think-harness guardrail check (#37, surfaced by #67) */}
      <div className="prp-subhead">Trade Guardrail Check</div>
      <div className="prp-note">Runs the think harness on live account state. It fails closed — when price, balance, or spread cannot be resolved from the broker, the verdict is INPUTS_UNAVAILABLE and no draft is produced.</div>
      <div className="prp-form-grid">
        <label>Symbol<input value={thinkSymbol} onChange={(e) => setThinkSymbol(e.target.value)} placeholder="ACME" /></label>
        <label>Action
          <select value={thinkAction} onChange={(e) => setThinkAction(e.target.value as "BUY" | "SELL")}>
            <option value="BUY">BUY</option><option value="SELL">SELL</option>
          </select>
        </label>
        <label>Quantity<input value={thinkQuantity} onChange={(e) => setThinkQuantity(e.target.value)} inputMode="numeric" /></label>
        <label>Order type
          <select value={thinkOrderType} onChange={(e) => setThinkOrderType(e.target.value as "MARKET" | "LIMIT" | "STOP")}>
            <option value="MARKET">MARKET</option><option value="LIMIT">LIMIT</option><option value="STOP">STOP</option>
          </select>
        </label>
        <label>Price (optional)<input value={thinkPrice} onChange={(e) => setThinkPrice(e.target.value)} inputMode="decimal" /></label>
      </div>
      <button type="button" className="prp-size-btn" onClick={() => void runThink()} disabled={thinkLoading || !thinkSymbol.trim() || !thinkQuantity.trim()}>
        {thinkLoading ? "Checking…" : "Run guardrail check"}
      </button>
      {thinkError && <div className="prp-error">{thinkError}</div>}
      {verdict && (
        <div className="prp-sizing-result">
          <div className="prp-note">
            <span className={`prp-badge prp-badge-${verdict.recommendation === "PROCEED_TO_HITL" ? "measured" : verdict.recommendation === "REVISE_PARAMETERS" ? "proxy-sector" : "unknown"}`}>{verdict.recommendation}</span>
            {" "}approved: {verdict.approved ? "yes" : "no"} · confidence {fmtNumber(verdict.overallConfidence, 2)}
          </div>
          <p className="prp-rationale">{verdict.reason}</p>
          <div className="prp-note">
            Inputs — price: <span className="prp-badge">{verdict.inputSources.price}</span> balance: <span className="prp-badge">{verdict.inputSources.accountBalance}</span> spread: <span className="prp-badge">{verdict.inputSources.spread}</span>
            {verdict.proposedDraft ? " · a draft was produced for HITL review in the order flow" : " · no draft produced"}
          </div>
        </div>
      )}
      </>
      )}
    </section>
  );
}
