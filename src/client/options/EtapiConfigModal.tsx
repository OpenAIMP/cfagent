import React, { useState, useEffect } from "react";
import { apiFetch as fetch } from "../apiFetch";
import type { EtapiConfig } from "../../config/etapiConfig";

interface EtapiConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onConfigChanged?: (newConfig: EtapiConfig) => void;
}

export function EtapiConfigModal({
  isOpen,
  onClose,
  activeEnv,
  userLogin,
  onConfigChanged,
}: EtapiConfigModalProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"strategy" | "screener" | "weights" | "scanner">("strategy");

  // Editable fields state
  const [riskFreeRatePct, setRiskFreeRatePct] = useState("4.0");
  const [feePerContract, setFeePerContract] = useState("0.65");
  const [maxCombinations, setMaxCombinations] = useState("150");
  const [detailLimit, setDetailLimit] = useState("50");

  const [defaultMaxDte, setDefaultMaxDte] = useState("90");
  const [defaultMinDte, setDefaultMinDte] = useState("0");
  const [unusualVolOiRatio, setUnusualVolOiRatio] = useState("1.5");
  const [atmBandPct, setAtmBandPct] = useState("2.0");
  const [maxScanSymbols, setMaxScanSymbols] = useState("20");
  const [maxReturnedContracts, setMaxReturnedContracts] = useState("500");

  const [thesisWeight, setThesisWeight] = useState("30");
  const [rewardRiskWeight, setRewardRiskWeight] = useState("20");
  const [liquidityWeight, setLiquidityWeight] = useState("20");
  const [volatilityWeight, setVolatilityWeight] = useState("10");
  const [freshnessWeight, setFreshnessWeight] = useState("15");
  const [thetaWeight, setThetaWeight] = useState("5");

  const [bullishFactor, setBullishFactor] = useState("1.05");
  const [bearishFactor, setBearishFactor] = useState("0.95");
  const [largeMoveFactor, setLargeMoveFactor] = useState("1.10");

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/trading/options/config", {
        headers: {
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
      });
      if (!res.ok) throw new Error("Failed to load options configuration");
      const data = (await res.json()) as { config?: EtapiConfig };
      if (data?.config) {
        populateFields(data.config);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error loading config");
    } finally {
      setLoading(false);
    }
  };

  const populateFields = (cfg: EtapiConfig) => {
    if (cfg.strategyEngine) {
      setRiskFreeRatePct((cfg.strategyEngine.riskFreeRate * 100).toFixed(1));
      setFeePerContract(cfg.strategyEngine.feePerContract.toFixed(2));
      setMaxCombinations(String(cfg.strategyEngine.maxCombinations));
      setDetailLimit(String(cfg.strategyEngine.detailLimit));
      if (cfg.strategyEngine.scoreWeights) {
        setThesisWeight(String(Math.round(cfg.strategyEngine.scoreWeights.thesisAlignment * 100)));
        setRewardRiskWeight(String(Math.round(cfg.strategyEngine.scoreWeights.targetRewardRisk * 100)));
        setLiquidityWeight(String(Math.round(cfg.strategyEngine.scoreWeights.liquidity * 100)));
        setVolatilityWeight(String(Math.round(cfg.strategyEngine.scoreWeights.volatilityAlignment * 100)));
        setFreshnessWeight(String(Math.round(cfg.strategyEngine.scoreWeights.freshness * 100)));
        setThetaWeight(String(Math.round(cfg.strategyEngine.scoreWeights.thetaBurden * 100)));
      }
    }
    if (cfg.screener) {
      setDefaultMaxDte(String(cfg.screener.defaultMaxDte));
      setDefaultMinDte(String(cfg.screener.defaultMinDte));
      setUnusualVolOiRatio(String(cfg.screener.unusualVolumeOiRatio));
      setAtmBandPct((cfg.screener.atmBandPct * 100).toFixed(1));
      setMaxScanSymbols(String(cfg.screener.maxScanSymbols));
      setMaxReturnedContracts(String(cfg.screener.maxReturnedContracts));
    }
    if (cfg.opportunityScanner?.targetFactors) {
      setBullishFactor(String(cfg.opportunityScanner.targetFactors.bullish));
      setBearishFactor(String(cfg.opportunityScanner.targetFactors.bearish));
      setLargeMoveFactor(String(cfg.opportunityScanner.targetFactors.large_move));
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadConfig();
      setSuccessMsg(null);
    }
  }, [isOpen, activeEnv]);

  if (!isOpen) return null;

  const handleApplyOverrides = async () => {
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const overrides: Partial<EtapiConfig> = {
        strategyEngine: {
          riskFreeRate: Number(riskFreeRatePct) / 100,
          feePerContract: Number(feePerContract),
          maxCombinations: Number(maxCombinations),
          detailLimit: Number(detailLimit),
          maxLegs: 6,
          scoreWeights: {
            thesisAlignment: Number(thesisWeight) / 100,
            targetRewardRisk: Number(rewardRiskWeight) / 100,
            liquidity: Number(liquidityWeight) / 100,
            volatilityAlignment: Number(volatilityWeight) / 100,
            freshness: Number(freshnessWeight) / 100,
            thetaBurden: Number(thetaWeight) / 100,
          },
        },
        screener: {
          maxScanSymbols: Number(maxScanSymbols),
          maxExpirationsPerSymbol: 20,
          defaultMaxDte: Number(defaultMaxDte),
          defaultMinDte: Number(defaultMinDte),
          defaultQuoteAgeSeconds: 60,
          maxReturnedContracts: Number(maxReturnedContracts),
          maxRejectionsReturned: 50,
          symbolFetchConcurrency: 4,
          expiryFetchConcurrency: 3,
          unusualVolumeOiRatio: Number(unusualVolOiRatio),
          highDeltaThreshold: 0.65,
          highIvThreshold: 0.7,
          lowIvThreshold: 0.3,
          atmBandPct: Number(atmBandPct) / 100,
        },
        opportunityScanner: {
          maxScanSymbols: Number(maxScanSymbols),
          concurrency: 3,
          targetFactors: {
            bullish: Number(bullishFactor),
            bearish: Number(bearishFactor),
            large_move: Number(largeMoveFactor),
            range_bound: 1.0,
          },
        },
      };

      const res = await fetch("/api/trading/options/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ overrides }),
      });

      if (!res.ok) throw new Error("Failed to apply configuration overrides");
      const data = (await res.json()) as { config?: EtapiConfig };
      setSuccessMsg("✓ Runtime parameters applied live across all screeners and discovery engines!");
      if (data?.config && onConfigChanged) {
        onConfigChanged(data.config);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error applying overrides");
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = async () => {
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch("/api/trading/options/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ reset: true }),
      });

      if (!res.ok) throw new Error("Failed to reset defaults");
      const data = (await res.json()) as { config?: EtapiConfig };
      if (data?.config) {
        populateFields(data.config);
        if (onConfigChanged) onConfigChanged(data.config);
      }
      setSuccessMsg("✓ Reset to environment baseline defaults (from environment.config.json).");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error resetting defaults");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(3, 7, 18, 0.8)",
        backdropFilter: "blur(6px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "680px",
          backgroundColor: "#060b18",
          border: "1px solid rgba(56, 189, 248, 0.25)",
          borderRadius: "12px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.75)",
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1.25rem 1.5rem",
            borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "rgba(15, 23, 42, 0.6)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "1.35rem" }}>⚙️</span>
            <div>
              <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#f8fafc" }}>
                ETAPI Engine Configuration &amp; Tuning
              </h3>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "#94a3b8" }}>
                Externalized defaults • Zero hardcoding • Cascading overrides for active env [{activeEnv}]
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              fontSize: "1.4rem",
              cursor: "pointer",
              padding: "0.25rem 0.5rem",
            }}
          >
            ✕
          </button>
        </div>

        {/* Tab Switcher */}
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            padding: "0.75rem 1.5rem",
            background: "rgba(15, 23, 42, 0.4)",
            borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
          }}
        >
          <button
            type="button"
            className="subnav-btn"
            style={{
              padding: "0.4rem 0.8rem",
              fontSize: "0.82rem",
              background: activeTab === "strategy" ? "rgba(56, 189, 248, 0.2)" : "rgba(30, 41, 59, 0.6)",
              color: activeTab === "strategy" ? "#38bdf8" : "#94a3b8",
              borderColor: activeTab === "strategy" ? "rgba(56, 189, 248, 0.4)" : "rgba(255, 255, 255, 0.1)",
            }}
            onClick={() => setActiveTab("strategy")}
          >
            📈 Strategy &amp; Pricing
          </button>
          <button
            type="button"
            className="subnav-btn"
            style={{
              padding: "0.4rem 0.8rem",
              fontSize: "0.82rem",
              background: activeTab === "screener" ? "rgba(56, 189, 248, 0.2)" : "rgba(30, 41, 59, 0.6)",
              color: activeTab === "screener" ? "#38bdf8" : "#94a3b8",
              borderColor: activeTab === "screener" ? "rgba(56, 189, 248, 0.4)" : "rgba(255, 255, 255, 0.1)",
            }}
            onClick={() => setActiveTab("screener")}
          >
            🔍 Screener Bounds
          </button>
          <button
            type="button"
            className="subnav-btn"
            style={{
              padding: "0.4rem 0.8rem",
              fontSize: "0.82rem",
              background: activeTab === "weights" ? "rgba(56, 189, 248, 0.2)" : "rgba(30, 41, 59, 0.6)",
              color: activeTab === "weights" ? "#38bdf8" : "#94a3b8",
              borderColor: activeTab === "weights" ? "rgba(56, 189, 248, 0.4)" : "rgba(255, 255, 255, 0.1)",
            }}
            onClick={() => setActiveTab("weights")}
          >
            ⚖️ Scoring Weights
          </button>
          <button
            type="button"
            className="subnav-btn"
            style={{
              padding: "0.4rem 0.8rem",
              fontSize: "0.82rem",
              background: activeTab === "scanner" ? "rgba(56, 189, 248, 0.2)" : "rgba(30, 41, 59, 0.6)",
              color: activeTab === "scanner" ? "#38bdf8" : "#94a3b8",
              borderColor: activeTab === "scanner" ? "rgba(56, 189, 248, 0.4)" : "rgba(255, 255, 255, 0.1)",
            }}
            onClick={() => setActiveTab("scanner")}
          >
            🎯 Opportunity Scanner
          </button>
        </div>

        {/* Body content */}
        <div style={{ padding: "1.5rem", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {error && (
            <div style={{ padding: "0.6rem 0.9rem", background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: "6px", color: "#fca5a5", fontSize: "0.85rem" }}>
              {error}
            </div>
          )}
          {successMsg && (
            <div style={{ padding: "0.6rem 0.9rem", background: "rgba(34, 197, 94, 0.15)", border: "1px solid rgba(34, 197, 94, 0.3)", borderRadius: "6px", color: "#86efac", fontSize: "0.85rem" }}>
              {successMsg}
            </div>
          )}

          {activeTab === "strategy" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Risk-Free Rate (%):
                </label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="20"
                  value={riskFreeRatePct}
                  onChange={(e) => setRiskFreeRatePct(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>Applied to Black-Scholes pricing &amp; carry cost.</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Fee per Contract ($):
                </label>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  value={feePerContract}
                  onChange={(e) => setFeePerContract(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>Standard brokerage fee (default $0.65).</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Max Combinations per Run:
                </label>
                <input
                  type="number"
                  step="10"
                  min="10"
                  max="1000"
                  value={maxCombinations}
                  onChange={(e) => setMaxCombinations(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>Limits multi-leg combinatorial explosion.</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Detail Limit:
                </label>
                <input
                  type="number"
                  step="5"
                  min="5"
                  max="200"
                  value={detailLimit}
                  onChange={(e) => setDetailLimit(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>Number of top strategies enriched with full Greeks.</span>
              </div>
            </div>
          )}

          {activeTab === "screener" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Default Max DTE (Days):
                </label>
                <input
                  type="number"
                  value={defaultMaxDte}
                  onChange={(e) => setDefaultMaxDte(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Default Min DTE (Days):
                </label>
                <input
                  type="number"
                  value={defaultMinDte}
                  onChange={(e) => setDefaultMinDte(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Unusual Volume / OI Ratio:
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={unusualVolOiRatio}
                  onChange={(e) => setUnusualVolOiRatio(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  ATM Band (% of spot):
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={atmBandPct}
                  onChange={(e) => setAtmBandPct(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Max Scan Symbols:
                </label>
                <input
                  type="number"
                  value={maxScanSymbols}
                  onChange={(e) => setMaxScanSymbols(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Max Returned Contracts:
                </label>
                <input
                  type="number"
                  value={maxReturnedContracts}
                  onChange={(e) => setMaxReturnedContracts(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
            </div>
          )}

          {activeTab === "weights" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Thesis Alignment Weight (%):
                </label>
                <input
                  type="number"
                  value={thesisWeight}
                  onChange={(e) => setThesisWeight(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Target Reward / Risk Weight (%):
                </label>
                <input
                  type="number"
                  value={rewardRiskWeight}
                  onChange={(e) => setRewardRiskWeight(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Liquidity &amp; Spread Weight (%):
                </label>
                <input
                  type="number"
                  value={liquidityWeight}
                  onChange={(e) => setLiquidityWeight(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Freshness Weight (%):
                </label>
                <input
                  type="number"
                  value={freshnessWeight}
                  onChange={(e) => setFreshnessWeight(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Volatility Alignment Weight (%):
                </label>
                <input
                  type="number"
                  value={volatilityWeight}
                  onChange={(e) => setVolatilityWeight(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Theta Burden Weight (%):
                </label>
                <input
                  type="number"
                  value={thetaWeight}
                  onChange={(e) => setThetaWeight(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
              </div>
            </div>
          )}

          {activeTab === "scanner" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Bullish Target Multiplier:
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={bullishFactor}
                  onChange={(e) => setBullishFactor(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>1.05 = +5% upside target assumption</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Bearish Target Multiplier:
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={bearishFactor}
                  onChange={(e) => setBearishFactor(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>0.95 = -5% downside target assumption</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.3rem" }}>
                  Large Move Target Multiplier:
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={largeMoveFactor}
                  onChange={(e) => setLargeMoveFactor(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", background: "#0f172a", border: "1px solid #1e293b", color: "#f8fafc", borderRadius: "6px" }}
                />
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>1.10 = +10% volatility straddle assumption</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div
          style={{
            padding: "1rem 1.5rem",
            background: "rgba(15, 23, 42, 0.8)",
            borderTop: "1px solid rgba(255, 255, 255, 0.08)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <button
            type="button"
            onClick={handleResetDefaults}
            disabled={saving || loading}
            style={{
              background: "transparent",
              border: "1px solid rgba(255, 255, 255, 0.2)",
              color: "#94a3b8",
              padding: "0.5rem 1rem",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.82rem",
            }}
          >
            Reset Defaults
          </button>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "transparent",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                color: "#e2e8f0",
                padding: "0.5rem 1rem",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "0.82rem",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApplyOverrides}
              disabled={saving || loading}
              style={{
                background: "#0284c7",
                border: "none",
                color: "#f8fafc",
                fontWeight: 600,
                padding: "0.5rem 1.25rem",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "0.85rem",
                boxShadow: "0 4px 12px rgba(2, 132, 199, 0.3)",
              }}
            >
              {saving ? "Applying..." : "Apply Runtime Config"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
