/**
 * Portfolio Risk panel (issue #63) — surfaces the portfolio-risk backends
 * in the E*TRADE positions view:
 *   aggregates (#34), hedge drafts (#54), correlation flags (#35),
 *   portfolio-aware sizing (#36).
 *
 * The panel is a pure display/input layer: it renders what the server
 * computes — including provenance and unavailable states — and hands
 * hedge drafts to the hub's existing HITL order-ticket flow via
 * onPreviewHedge. It never previews or executes an order itself.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchConcentration,
  fetchHedgeAnalysis,
  fetchPortfolioRisk,
  fetchSizing,
  fmtNumber,
  fmtSignedUsd,
  fmtUsd,
  hedgeProposalToTradeContext,
  type ConcentrationReport,
  type HedgeAnalysis,
  type PortfolioRiskReport,
  type SizingResult,
} from "./portfolioRiskApi";
import type { OptionsTradeContext } from "./options/OptionsResearchPanel";
import "./portfolioRiskPanel.css";

interface PortfolioRiskPanelProps {
  activeEnv: string;
  onPreviewHedge: (ctx: OptionsTradeContext) => void;
}

export function PortfolioRiskPanel({ activeEnv, onPreviewHedge }: PortfolioRiskPanelProps) {
  const [report, setReport] = useState<PortfolioRiskReport | null>(null);
  const [hedge, setHedge] = useState<HedgeAnalysis | null>(null);
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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [riskResult, hedgeResult] = await Promise.allSettled([fetchPortfolioRisk(activeEnv), fetchHedgeAnalysis(activeEnv)]);
      if (riskResult.status === "fulfilled") setReport(riskResult.value);
      else setError(riskResult.reason?.message || "Failed to load portfolio risk");
      if (hedgeResult.status === "fulfilled") setHedge(hedgeResult.value);
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

  const runSizing = async () => {
    setSizeLoading(true);
    setSizeError("");
    try {
      const result = await fetchSizing(activeEnv, {
        symbol: sizeSymbol.trim().toUpperCase(),
        perContract: {
          deltaDollars: Number(sizeDelta) || 0,
          betaWeightedDeltaDollars: sizeBetaDelta.trim() === "" ? null : Number(sizeBetaDelta),
          definedMaxLoss: sizeMaxLoss.trim() === "" ? null : Number(sizeMaxLoss),
        },
        riskScore: sizeRiskScore.trim() === "" ? undefined : Number(sizeRiskScore),
        requestedContracts: sizeRequested.trim() === "" ? undefined : Number(sizeRequested),
        maxMeasuredCorrelation: sizeCorr.trim() === "" ? null : Number(sizeCorr),
      });
      setSizing(result);
    } catch (err: any) {
      setSizeError(err?.message || "Sizing failed");
    } finally {
      setSizeLoading(false);
    }
  };

  const totals = report?.totals;
  const coverage = totals?.betaCoverage;

  return (
    <section className="prp-panel">
      <div className="prp-header">
        <h3>Portfolio Risk</h3>
        {report && <span className="prp-asof">as of {new Date(report.asOf).toLocaleString()}</span>}
        <button type="button" className="prp-refresh" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

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
              <thead><tr><th>Symbol</th><th>Type</th><th>Δ $</th><th>β-weighted Δ $</th><th>Beta</th><th>Defined max loss</th></tr></thead>
              <tbody>
                {report.rows.map((row, i) => (
                  <tr key={`${row.symbol}-${i}`}>
                    <td>{row.symbol}</td>
                    <td>{row.kind}</td>
                    <td>{fmtSignedUsd(row.deltaDollars)}</td>
                    <td>{fmtSignedUsd(row.betaWeightedDeltaDollars)}</td>
                    <td>{row.beta === null ? "—" : fmtNumber(row.beta)} <span className={`prp-badge prp-badge-${row.betaSource}`}>{row.betaSource}</span></td>
                    <td>{row.definedMaxLoss === null ? "undefined" : fmtUsd(row.definedMaxLoss)}</td>
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
            <strong>{proposal.side} {proposal.quantity} {proposal.instrument === "SPY_SHARES" ? "SPY shares" : `SPY ${proposal.strike} PUT ${proposal.expirationDate}`}</strong>
            <span>Est. {proposal.estimatedCost >= 0 ? "cost" : "credit"} {fmtUsd(Math.abs(proposal.estimatedCost), 2)} · β-weighted Δ {fmtSignedUsd(proposal.preHedgeBetaWeightedDeltaDollars)} → {fmtSignedUsd(proposal.postHedgeBetaWeightedDeltaDollars)} {proposal.withinToleranceAfterHedge ? "(within tolerance)" : "(residual above tolerance)"}</span>
            <p>{proposal.rationale}</p>
          </div>
          <button type="button" className="prp-preview-btn" onClick={() => onPreviewHedge(hedgeProposalToTradeContext(proposal, report?.spyPrice ?? null))}>
            Preview in Order Ticket →
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
        </div>
      )}
    </section>
  );
}
