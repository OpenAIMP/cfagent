import React, { useMemo, useState, useEffect } from "react";
import {
  computeRiskProfile,
  type RiskSubject,
  type ComprehensiveRiskProfile,
} from "./riskManagementEngine";
import "./riskAnalysis.css";

export interface RiskAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  subject: RiskSubject | null;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

export function RiskAnalysisModal({
  isOpen,
  onClose,
  subject,
  onSendPrompt,
}: RiskAnalysisModalProps) {
  const [activeTab, setActiveTab] = useState<"anatomy" | "playbook" | "scenarios" | "ai">("anatomy");
  const [accountNav, setAccountNav] = useState<number>(25000);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const profile: ComprehensiveRiskProfile | null = useMemo(() => {
    if (!subject) return null;
    return computeRiskProfile(subject);
  }, [subject]);

  if (!isOpen || !subject || !profile) return null;

  const { anatomy, playbook, scenarioMatrix } = profile;
  const spot = subject.underlyingPrice ?? 100;
  const recommendedContracts = playbook.recommendedMaxContracts(accountNav);

  const handleCopyPrompt = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(playbook.aiPrompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2500);
    }
  };

  const handleSendToAiChat = (customPrompt?: string) => {
    const promptToSend = customPrompt || playbook.aiPrompt;
    if (onSendPrompt) {
      onSendPrompt(promptToSend, "options-risk");
      onClose();
    } else {
      handleCopyPrompt();
    }
  };

  return (
    <div className="risk-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="risk-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="risk-modal-header">
          <div className="risk-modal-title-group">
            <span className="risk-modal-icon-shield">🛡️</span>
            <div className="risk-modal-titles">
              <h2 className="risk-modal-h2">
                <span className="risk-symbol-badge">{subject.underlyingSymbol}</span>
                {subject.title || subject.strategyType || "Risk Management & Analysis"}
              </h2>
              <span className="risk-modal-subtitle">
                Spot: ${spot.toFixed(2)} • {subject.dte ? `${subject.dte.toFixed(0)} DTE` : "Active Trade"} • {subject.sentiment ? subject.sentiment.toUpperCase() : "Directional"}
              </span>
            </div>
          </div>

          <div className="risk-modal-header-actions">
            <span
              className="risk-level-badge"
              style={{
                background: `${anatomy.riskLevelColor}22`,
                color: anatomy.riskLevelColor,
                border: `1px solid ${anatomy.riskLevelColor}55`,
              }}
            >
              Risk Score: {anatomy.riskScore}/100 • {anatomy.riskLevel}
            </span>
            <button
              type="button"
              className="risk-modal-close-btn"
              onClick={onClose}
              title="Close Risk Analysis (Esc)"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="risk-tabs-nav">
          <button
            type="button"
            className={`risk-tab-btn ${activeTab === "anatomy" ? "active" : ""}`}
            onClick={() => setActiveTab("anatomy")}
          >
            📊 What is Involved (Risk Anatomy)
          </button>
          <button
            type="button"
            className={`risk-tab-btn ${activeTab === "playbook" ? "active" : ""}`}
            onClick={() => setActiveTab("playbook")}
          >
            🛡️ How to Manage (Defense Playbook)
          </button>
          <button
            type="button"
            className={`risk-tab-btn ${activeTab === "scenarios" ? "active" : ""}`}
            onClick={() => setActiveTab("scenarios")}
          >
            📉 Stress Tests & Tail Shocks
          </button>
          <button
            type="button"
            className={`risk-tab-btn ${activeTab === "ai" ? "active" : ""}`}
            onClick={() => setActiveTab("ai")}
          >
            🤖 AI Risk Manager (Chat)
          </button>
        </div>

        {/* Body Content */}
        <div className="risk-modal-body">
          {/* Top Key Metrics Banner */}
          <div className="risk-stat-cards-grid">
            <div className={`risk-stat-card ${anatomy.riskProfileType === "UNDEFINED_RISK" ? "danger" : ""}`}>
              <span className="risk-stat-label">Capital at Risk / Max Loss</span>
              <span className="risk-stat-value" style={{ color: anatomy.riskProfileType === "UNDEFINED_RISK" ? "#f87171" : "#f1f5f9" }}>
                {anatomy.capitalAtRiskFormatted}
              </span>
              <span className="risk-stat-sub">{anatomy.riskProfileType.replace("_", " ")}</span>
            </div>

            <div className="risk-stat-card highlight">
              <span className="risk-stat-label">Max Potential Profit</span>
              <span className="risk-stat-value" style={{ color: "#34d399" }}>
                {anatomy.maxProfitFormatted}
              </span>
              <span className="risk-stat-sub">R:R Ratio {anatomy.riskRewardRatio}</span>
            </div>

            <div className="risk-stat-card">
              <span className="risk-stat-label">Probability of Profit (POP)</span>
              <span className="risk-stat-value" style={{ color: anatomy.probabilityOfProfit >= 50 ? "#38bdf8" : "#fbbf24" }}>
                {anatomy.probabilityOfProfit.toFixed(1)}%
              </span>
              <span className="risk-stat-sub">Touch Prob: ~{anatomy.probabilityOfTouch}%</span>
            </div>

            <div className="risk-stat-card">
              <span className="risk-stat-label">Directional Bias</span>
              <span className="risk-stat-value" style={{ fontSize: "1.1rem" }}>
                {anatomy.directionalBias}
              </span>
              <span className="risk-stat-sub">
                Δ {anatomy.netDelta >= 0 ? "+" : ""}{anatomy.netDelta.toFixed(2)} (${anatomy.dollarDelta.toFixed(0)}/pt)
              </span>
            </div>
          </div>

          {/* TAB 1: WHAT IS INVOLVED (ANATOMY) */}
          {activeTab === "anatomy" && (
            <>
              {/* Greeks Sensitivity Matrix */}
              <div className="risk-section-box">
                <div className="risk-section-header">
                  <h3 className="risk-section-title">
                    <span>⚡ Institutional Greeks Sensitivity Matrix</span>
                  </h3>
                  <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    Values per 1 unit contract lot
                  </span>
                </div>

                <div className="risk-greeks-grid">
                  <div className="risk-greek-item">
                    <div className="risk-greek-top">
                      <span className="risk-greek-name">DELTA (Δ)</span>
                      <span className="risk-greek-val" style={{ color: anatomy.netDelta >= 0 ? "#4ade80" : "#f87171" }}>
                        {anatomy.netDelta >= 0 ? "+" : ""}{anatomy.netDelta.toFixed(2)}
                      </span>
                    </div>
                    <div className="risk-greek-interpretation">
                      ${Math.abs(anatomy.dollarDelta).toFixed(2)} P&L drift for each $1 move in underlying spot.
                    </div>
                  </div>

                  <div className="risk-greek-item">
                    <div className="risk-greek-top">
                      <span className="risk-greek-name">GAMMA (Γ)</span>
                      <span className="risk-greek-val" style={{ color: anatomy.netGamma >= 0 ? "#38bdf8" : "#f59e0b" }}>
                        {anatomy.netGamma >= 0 ? "+" : ""}{anatomy.netGamma.toFixed(3)}
                      </span>
                    </div>
                    <div className="risk-greek-interpretation">
                      {anatomy.gammaRiskInterpretation}
                    </div>
                  </div>

                  <div className="risk-greek-item">
                    <div className="risk-greek-top">
                      <span className="risk-greek-name">THETA (Θ)</span>
                      <span className="risk-greek-val" style={{ color: anatomy.netTheta >= 0 ? "#4ade80" : "#f87171" }}>
                        {anatomy.netTheta >= 0 ? "+" : ""}${Math.abs(anatomy.netTheta * 100).toFixed(2)}/d
                      </span>
                    </div>
                    <div className="risk-greek-interpretation">
                      {anatomy.thetaInterpretation}
                    </div>
                  </div>

                  <div className="risk-greek-item">
                    <div className="risk-greek-top">
                      <span className="risk-greek-name">VEGA (ν)</span>
                      <span className="risk-greek-val" style={{ color: anatomy.netVega >= 0 ? "#c084fc" : "#cbd5e1" }}>
                        {anatomy.netVega >= 0 ? "+" : ""}${Math.abs(anatomy.netVega * 100).toFixed(2)}/1% IV
                      </span>
                    </div>
                    <div className="risk-greek-interpretation">
                      {anatomy.vegaInterpretation}
                    </div>
                  </div>
                </div>
              </div>

              {/* Breakeven Safety Boundaries */}
              <div className="risk-section-box">
                <div className="risk-section-header">
                  <h3 className="risk-section-title">
                    <span>🎯 Breakeven Safety Cushions</span>
                  </h3>
                  <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                    Spot: ${spot.toFixed(2)}
                  </span>
                </div>

                <div className="risk-breakevens-list">
                  {anatomy.breakevens.map((be, idx) => (
                    <div key={idx} className="risk-breakeven-pill">
                      <span>Breakeven #{idx + 1}:</span>
                      <span className="risk-be-price">${be.price.toFixed(2)}</span>
                      <span className={`risk-be-buffer ${be.direction.toLowerCase()}`}>
                        {be.direction === "ABOVE" ? `+${be.distancePct}% above spot` : `-${be.distancePct}% below spot`}
                      </span>
                    </div>
                  ))}
                  {subject.breakevenText && (
                    <div style={{ width: "100%", fontSize: "0.82rem", color: "#94a3b8", marginTop: "0.3rem" }}>
                      Notes: {subject.breakevenText}
                    </div>
                  )}
                </div>
              </div>

              {/* Early Assignment & Pin Risk Warning */}
              {anatomy.earlyAssignmentRisk.hasRisk && (
                <div className={`risk-warning-callout ${anatomy.earlyAssignmentRisk.severity.toLowerCase()}`}>
                  <div className="risk-warning-title">
                    <span>⚠️ American Option Early Assignment &amp; Dividend Alert</span>
                    <span style={{ fontSize: "0.75rem", textTransform: "uppercase", marginLeft: "auto", fontWeight: 800 }}>
                      Severity: {anatomy.earlyAssignmentRisk.severity}
                    </span>
                  </div>
                  <ul className="risk-warning-list">
                    {anatomy.earlyAssignmentRisk.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {/* TAB 2: HOW TO MANAGE (DEFENSE PLAYBOOK) */}
          {activeTab === "playbook" && (
            <>
              {/* Dynamic Position Sizing Calculator */}
              <div className="risk-sizing-calculator">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <h4 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700, color: "#f8fafc" }}>
                      📐 Risk-Budgeted Position Sizing Calculator
                    </h4>
                    <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                      {playbook.sizingRationale}
                    </span>
                  </div>
                </div>

                <div className="risk-sizing-input-row">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontSize: "0.85rem", color: "#cbd5e1" }}>Account Portfolio NAV:</span>
                    <div className="risk-sizing-input-wrap">
                      <span>$</span>
                      <input
                        type="number"
                        min="1000"
                        step="1000"
                        value={accountNav}
                        onChange={(e) => setAccountNav(Math.max(500, Number(e.target.value) || 0))}
                      />
                    </div>
                  </div>

                  <div className="risk-sizing-result">
                    <span style={{ fontSize: "0.85rem", color: "#cbd5e1" }}>Max Recommended Size:</span>
                    <span className="risk-sizing-contracts-val">
                      {recommendedContracts} contract{recommendedContracts > 1 ? "s" : ""}
                    </span>
                    <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                      (≤{playbook.recommendedMaxAllocationPct}% risk budget = ${(accountNav * (playbook.recommendedMaxAllocationPct / 100)).toFixed(0)})
                    </span>
                  </div>
                </div>
              </div>

              {/* Profit & Stop Loss Rules Grid */}
              <div className="risk-playbook-cards">
                <div className="risk-rule-card profit">
                  <div className="risk-rule-header">
                    <span className="risk-rule-tag profit">🟢 Profit Taking Rule</span>
                    <span style={{ fontSize: "0.78rem", color: "#34d399", fontWeight: 700 }}>
                      Target: {playbook.profitTakingRule.targetPct}%
                    </span>
                  </div>
                  <div className="risk-rule-trigger">
                    {playbook.profitTakingRule.triggerPriceOrPnl}
                  </div>
                  <div className="risk-rule-action">
                    {playbook.profitTakingRule.actionText}
                  </div>
                  <div className="risk-rule-rationale">
                    💡 {playbook.profitTakingRule.rationale}
                  </div>
                </div>

                <div className="risk-rule-card stop">
                  <div className="risk-rule-header">
                    <span className="risk-rule-tag stop">🔴 Capital Preservation Stop-Loss</span>
                    <span style={{ fontSize: "0.78rem", color: "#f87171", fontWeight: 700 }}>
                      Defense Trigger
                    </span>
                  </div>
                  <div className="risk-rule-trigger">
                    {playbook.stopLossRule.stopLossThreshold}
                  </div>
                  <div className="risk-rule-action">
                    {playbook.stopLossRule.actionText}
                  </div>
                  <div className="risk-rule-rationale">
                    🛡️ {playbook.stopLossRule.rationale}
                  </div>
                </div>
              </div>

              {/* Tactical Adjustments & Rolling Playbook */}
              <div className="risk-section-box">
                <div className="risk-section-header">
                  <h3 className="risk-section-title">
                    <span>🔄 Tactical Defense &amp; Rolling Playbook</span>
                  </h3>
                  <span style={{ fontSize: "0.8rem", color: "#38bdf8" }}>
                    How to defend the trade when challenged
                  </span>
                </div>

                <div className="risk-adjustments-list">
                  {playbook.adjustments.map((adj, idx) => (
                    <div key={idx} className="risk-adjustment-card">
                      <div className="risk-adj-name">
                        <span>🛡️ {adj.name}</span>
                      </div>
                      <div className="risk-adj-row">
                        <span className="risk-adj-label">When to Trigger:</span>
                        <span className="risk-adj-value" style={{ color: "#fbbf24" }}>{adj.trigger}</span>
                      </div>
                      <div className="risk-adj-row">
                        <span className="risk-adj-label">Action:</span>
                        <span className="risk-adj-value">{adj.action}</span>
                      </div>
                      <div className="risk-adj-row">
                        <span className="risk-adj-label">Protection:</span>
                        <span className="risk-adj-value" style={{ color: "#93c5fd" }}>{adj.howItProtects}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* TAB 3: STRESS TESTS & SCENARIOS */}
          {activeTab === "scenarios" && (
            <div className="risk-section-box">
              <div className="risk-section-header">
                <h3 className="risk-section-title">
                  <span>📉 Multi-Point Spot &amp; Tail Shock Stress Test</span>
                </h3>
                <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                  Estimated P&L under sudden market moves
                </span>
              </div>

              <table className="risk-scenario-table">
                <thead>
                  <tr>
                    <th>Shock Scenario</th>
                    <th>Underlying Price</th>
                    <th>Est. P&amp;L</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarioMatrix.map((point) => {
                    const isPositive = point.estimatedPnL > 0;
                    const isZero = point.spotChangePct === 0;
                    return (
                      <tr key={point.spotChangePct} className={isZero ? "spot-row" : ""}>
                        <td style={{ fontWeight: 600 }}>
                          {point.spotChangePct > 0 ? `+${point.spotChangePct}%` : `${point.spotChangePct}%`}
                          {isZero ? " (Current Spot)" : ""}
                        </td>
                        <td>${point.spotPrice.toFixed(2)}</td>
                        <td
                          style={{
                            fontWeight: 700,
                            fontFamily: "monospace",
                            fontSize: "0.95rem",
                            color: isPositive ? "#4ade80" : point.estimatedPnL < 0 ? "#f87171" : "#cbd5e1",
                          }}
                        >
                          {point.estimatedPnL > 0 ? "+" : ""}${point.estimatedPnL.toFixed(2)}
                        </td>
                        <td>{point.outcomeLabel}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "1rem" }}>
                <div style={{ background: "rgba(15, 23, 42, 0.6)", padding: "0.9rem", borderRadius: "8px" }}>
                  <span style={{ fontSize: "0.75rem", color: "#94a3b8", textTransform: "uppercase", fontWeight: 700 }}>
                    Tail Shock: -20% Flash Crash
                  </span>
                  <div style={{ fontSize: "1.2rem", fontWeight: 800, color: anatomy.tailShockDown20Pct >= 0 ? "#4ade80" : "#f87171", marginTop: "0.2rem" }}>
                    {anatomy.tailShockDown20Pct >= 0 ? "+" : ""}${anatomy.tailShockDown20Pct.toLocaleString()}
                  </div>
                </div>

                <div style={{ background: "rgba(15, 23, 42, 0.6)", padding: "0.9rem", borderRadius: "8px" }}>
                  <span style={{ fontSize: "0.75rem", color: "#94a3b8", textTransform: "uppercase", fontWeight: 700 }}>
                    Tail Shock: +20% Squeeze
                  </span>
                  <div style={{ fontSize: "1.2rem", fontWeight: 800, color: anatomy.tailShockUp20Pct >= 0 ? "#4ade80" : "#f87171", marginTop: "0.2rem" }}>
                    {anatomy.tailShockUp20Pct >= 0 ? "+" : ""}${anatomy.tailShockUp20Pct.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: ASK AI AGENT */}
          {activeTab === "ai" && (
            <div className="risk-ai-card">
              <div className="risk-ai-header">
                <h3 className="risk-ai-title">
                  <span>🤖 Ask AI Assistant to Manage This Trade</span>
                </h3>
                <span style={{ fontSize: "0.8rem", color: "#cbd5e1" }}>
                  Autonomous Agent Risk Orchestration
                </span>
              </div>

              <p style={{ margin: 0, fontSize: "0.86rem", color: "#cbd5e1", lineHeight: 1.5 }}>
                Dispatch this tailored trade risk dossier directly to the multi-agent chat. The AI will evaluate market regime, Greeks drift, and formulate specific real-time defense actions:
              </p>

              <div className="risk-ai-prompt-box">
                {playbook.aiPrompt}
              </div>

              <div className="risk-ai-actions">
                <button
                  type="button"
                  className="risk-btn-ask-ai"
                  onClick={() => handleSendToAiChat()}
                >
                  💬 Send Prompt to AI Chat
                </button>
                <button
                  type="button"
                  className="risk-btn-copy-prompt"
                  onClick={handleCopyPrompt}
                >
                  {copiedPrompt ? "✓ Copied to Clipboard!" : "📋 Copy Prompt"}
                </button>
              </div>

              <div style={{ marginTop: "0.5rem" }}>
                <span style={{ fontSize: "0.78rem", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "0.4rem" }}>
                  Quick Question Presets:
                </span>
                <div className="risk-chips-carousel">
                  <button
                    type="button"
                    className="risk-prompt-chip"
                    onClick={() => handleSendToAiChat(`How do I roll ${subject.underlyingSymbol} ${subject.strategyType || "trade"} if the short strike is breached?`)}
                  >
                    🔄 How do I roll if tested?
                  </button>
                  <button
                    type="button"
                    className="risk-prompt-chip"
                    onClick={() => handleSendToAiChat(`What is the optimal delta hedge for ${subject.underlyingSymbol} with Delta ${anatomy.netDelta.toFixed(2)}?`)}
                  >
                    ⚖️ How to delta hedge this?
                  </button>
                  <button
                    type="button"
                    className="risk-prompt-chip"
                    onClick={() => handleSendToAiChat(`Calculate protective collar or put wing costs for ${subject.underlyingSymbol}.`)}
                  >
                    🛡️ Protective collar cost?
                  </button>
                  <button
                    type="button"
                    className="risk-prompt-chip"
                    onClick={() => handleSendToAiChat(`What happens to this ${subject.underlyingSymbol} trade under an IV crush after earnings?`)}
                  >
                    📉 Impact of IV Crush?
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
