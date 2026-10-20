import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { apiFetch as fetch } from "../apiFetch";
import type { EtapiConfig, AiModelDefinition } from "../../config/etapiConfig";

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
  const [activeTab, setActiveTab] = useState<"strategy" | "screener" | "weights" | "scanner" | "ai">("strategy");

  // Editable fields state
  const [riskFreeRatePct, setRiskFreeRatePct] = useState("4.0");
  const [feePerContract, setFeePerContract] = useState("0.65");
  const [maxCombinations, setMaxCombinations] = useState("5000");
  const [detailLimit, setDetailLimit] = useState("5000");

  const [defaultMaxDte, setDefaultMaxDte] = useState("90");
  const [defaultMinDte, setDefaultMinDte] = useState("0");
  const [unusualVolOiRatio, setUnusualVolOiRatio] = useState("1.5");
  const [atmBandPct, setAtmBandPct] = useState("2.0");
  const [maxScanSymbols, setMaxScanSymbols] = useState("20");
  const [maxReturnedContracts, setMaxReturnedContracts] = useState("10000");

  const [thesisWeight, setThesisWeight] = useState("30");
  const [rewardRiskWeight, setRewardRiskWeight] = useState("20");
  const [liquidityWeight, setLiquidityWeight] = useState("20");
  const [volatilityWeight, setVolatilityWeight] = useState("10");
  const [freshnessWeight, setFreshnessWeight] = useState("15");
  const [thetaWeight, setThetaWeight] = useState("5");
  const [popWeight, setPopWeight] = useState("15");
  const [cushionWeight, setCushionWeight] = useState("8");
  const [capitalWeight, setCapitalWeight] = useState("7");

  const [bullishFactor, setBullishFactor] = useState("1.05");
  const [bearishFactor, setBearishFactor] = useState("0.95");
  const [largeMoveFactor, setLargeMoveFactor] = useState("1.10");

  // AI & Safety Limits state
  const [availableModels, setAvailableModels] = useState<AiModelDefinition[]>([
    { id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash (Flagship, 24k context)", provider: "workers-ai", contextWindow: 24000, supportsTools: true, supportsStreaming: true, category: "flagship" },
    { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B Instruct FP8 Fast", provider: "workers-ai", contextWindow: 131072, supportsTools: true, supportsStreaming: true, category: "reasoning" },
    { id: "@cf/meta/llama-3.1-70b-instruct", name: "Llama 3.1 70B Instruct", provider: "workers-ai", contextWindow: 131072, supportsTools: true, supportsStreaming: true, category: "general" },
    { id: "@cf/qwen/qwen2.5-72b-instruct", name: "Qwen 2.5 72B Instruct", provider: "workers-ai", contextWindow: 32768, supportsTools: true, supportsStreaming: true, category: "analytical" },
    { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", name: "DeepSeek R1 Distill Qwen 32B", provider: "workers-ai", contextWindow: 65536, supportsTools: false, supportsStreaming: true, category: "reasoning" },
  ]);
  const [selectedDefaultModel, setSelectedDefaultModel] = useState("@cf/zai-org/glm-4.7-flash");
  const [selectedFallbackModel, setSelectedFallbackModel] = useState("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const [selectedIdeasModel, setSelectedIdeasModel] = useState("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const [selectedComparisonModel, setSelectedComparisonModel] = useState("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const [selectedNlqModel, setSelectedNlqModel] = useState("@cf/zai-org/glm-4.7-flash");
  const [temperatureDeterministic, setTemperatureDeterministic] = useState("0.0");
  const [temperatureAnalytical, setTemperatureAnalytical] = useState("0.2");
  const [temperatureCreative, setTemperatureCreative] = useState("0.7");
  const [maxOrderQuantity, setMaxOrderQuantity] = useState("10000");
  const [maxOrderTotalUsd, setMaxOrderTotalUsd] = useState("500000");
  const [maxDiscountPercent, setMaxDiscountPercent] = useState("90");

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
        setPopWeight(String(Math.round((cfg.strategyEngine.scoreWeights.popAlignment ?? 0) * 100)));
        setCushionWeight(String(Math.round((cfg.strategyEngine.scoreWeights.cushion ?? 0) * 100)));
        setCapitalWeight(String(Math.round((cfg.strategyEngine.scoreWeights.capitalEfficiency ?? 0) * 100)));
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
    if (cfg.ai) {
      if (cfg.ai.availableModels && cfg.ai.availableModels.length > 0) {
        setAvailableModels(cfg.ai.availableModels);
      }
      if (cfg.ai.defaultModel) setSelectedDefaultModel(cfg.ai.defaultModel);
      if (cfg.ai.fallbackModel) setSelectedFallbackModel(cfg.ai.fallbackModel);
      if (cfg.ai.taskModels) {
        if (cfg.ai.taskModels.optionsIdeas) setSelectedIdeasModel(cfg.ai.taskModels.optionsIdeas);
        if (cfg.ai.taskModels.optionsComparison) setSelectedComparisonModel(cfg.ai.taskModels.optionsComparison);
        if (cfg.ai.taskModels.nlqValidation) setSelectedNlqModel(cfg.ai.taskModels.nlqValidation);
      }
      if (cfg.ai.temperatureDefaults) {
        setTemperatureDeterministic(String(cfg.ai.temperatureDefaults.deterministic ?? 0.0));
        setTemperatureAnalytical(String(cfg.ai.temperatureDefaults.analytical ?? 0.2));
        setTemperatureCreative(String(cfg.ai.temperatureDefaults.creative ?? 0.7));
      }
    }
    if (cfg.tradingConstraints) {
      if (cfg.tradingConstraints.maxOrderQuantity) setMaxOrderQuantity(String(cfg.tradingConstraints.maxOrderQuantity));
      if (cfg.tradingConstraints.maxOrderTotalUsd) setMaxOrderTotalUsd(String(cfg.tradingConstraints.maxOrderTotalUsd));
      if (cfg.tradingConstraints.maxDiscountPercent) setMaxDiscountPercent(String(cfg.tradingConstraints.maxDiscountPercent));
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
            popAlignment: Number(popWeight) / 100,
            cushion: Number(cushionWeight) / 100,
            capitalEfficiency: Number(capitalWeight) / 100,
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
          // Fit-gate defaults (issue #24) — carried so a saved config
          // stays complete; not edited in this modal.
          fitGate: {
            minCompositeScore: 55,
            minProbabilityOfProfit: 0.35,
            requireFresh: true,
            minConfidence: "MEDIUM" as const,
          },
          targetFactors: {
            bullish: Number(bullishFactor),
            bearish: Number(bearishFactor),
            large_move: Number(largeMoveFactor),
            range_bound: 1.0,
          },
          // Expected-move target multiples (issue #25) — carried so a
          // saved config stays complete; not edited in this modal.
          targetEmMultiples: {
            bullish: 0.6,
            bearish: -0.6,
            large_move: 1.2,
            range_bound: 0,
          },
        },
        ai: {
          defaultModel: selectedDefaultModel,
          fallbackModel: selectedFallbackModel,
          fastModel: selectedDefaultModel,
          reasoningModel: selectedFallbackModel,
          availableModels,
          taskModels: {
            optionsIdeas: selectedIdeasModel,
            optionsComparison: selectedComparisonModel,
            nlqPlanning: selectedNlqModel,
            nlqValidation: selectedNlqModel,
            orchestrator: selectedDefaultModel,
            marketResearch: selectedDefaultModel,
          },
          temperatureDefaults: {
            deterministic: Number(temperatureDeterministic),
            analytical: Number(temperatureAnalytical),
            creative: Number(temperatureCreative),
          },
          maxTokens: {
            nlq: 2048,
            ideas: 4096,
            comparison: 4096,
            orchestrator: 2048,
            search: 2048,
          },
        },
        tradingConstraints: {
          maxOrderQuantity: Number(maxOrderQuantity),
          maxOrderTotalUsd: Number(maxOrderTotalUsd),
          defaultOrderQuantity: 1,
          maxDiscountPercent: Number(maxDiscountPercent),
          maxPremiumPercent: 500,
          requireHitlVoiceConfirmation: true,
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

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "0.5rem",
    background: "var(--color-input)",
    border: "1px solid var(--color-input-border)",
    color: "var(--color-input-foreground)",
    borderRadius: "var(--radius-sm)",
    fontVariantNumeric: "tabular-nums",
  };

  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: "0.45rem",
    background: "var(--color-input)",
    border: "1px solid var(--color-input-border)",
    color: "var(--color-input-foreground)",
    borderRadius: "var(--radius-sm)",
    fontSize: "0.8rem",
  };

  const smallInputStyle: React.CSSProperties = {
    width: "100%",
    padding: "0.45rem",
    background: "var(--color-input)",
    border: "1px solid var(--color-input-border)",
    color: "var(--color-input-foreground)",
    borderRadius: "var(--radius-sm)",
    fontVariantNumeric: "tabular-nums",
  };

  const modalContent = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "var(--color-overlay)",
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
          backgroundColor: "var(--color-card)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "12px",
          boxShadow: "var(--shadow-xl)",
          color: "var(--color-text-primary)",
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
            borderBottom: "1px solid var(--color-border-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--color-surface-sunken)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "1.35rem" }}>⚙️</span>
            <div>
              <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
                ETAPI Engine Configuration &amp; Tuning
              </h3>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
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
              color: "var(--color-text-muted)",
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
            background: "var(--color-surface-sunken)",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <button
            type="button"
            className="subnav-btn"
            style={{
              padding: "0.4rem 0.8rem",
              fontSize: "0.82rem",
              background: activeTab === "strategy" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "strategy" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "strategy" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
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
              background: activeTab === "screener" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "screener" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "screener" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
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
              background: activeTab === "weights" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "weights" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "weights" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
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
              background: activeTab === "scanner" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "scanner" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "scanner" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
            }}
            onClick={() => setActiveTab("scanner")}
          >
            🎯 Opportunity Scanner
          </button>
          <button
            type="button"
            className="subnav-btn"
            style={{
              padding: "0.4rem 0.8rem",
              fontSize: "0.82rem",
              background: activeTab === "ai" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "ai" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "ai" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
            }}
            onClick={() => setActiveTab("ai")}
          >
            🤖 AI Models &amp; Guardrails
          </button>
        </div>

        {/* Body content */}
        <div style={{ padding: "1.5rem", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {error && (
            <div style={{ padding: "0.6rem 0.9rem", background: "var(--color-danger-subtle)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-sm, 6px)", color: "var(--color-danger)", fontSize: "0.85rem" }}>
              {error}
            </div>
          )}
          {successMsg && (
            <div style={{ padding: "0.6rem 0.9rem", background: "var(--color-success-subtle)", border: "1px solid var(--color-success)", borderRadius: "var(--radius-sm, 6px)", color: "var(--color-success)", fontSize: "0.85rem" }}>
              {successMsg}
            </div>
          )}

          {activeTab === "strategy" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Risk-Free Rate (%):
                </label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="20"
                  value={riskFreeRatePct}
                  onChange={(e) => setRiskFreeRatePct(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Applied to Black-Scholes pricing &amp; carry cost.</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Fee per Contract ($):
                </label>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  value={feePerContract}
                  onChange={(e) => setFeePerContract(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Standard brokerage fee (default $0.65).</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Max Combinations per Run:
                </label>
                <input
                  type="number"
                  step="50"
                  min="10"
                  max="50000"
                  value={maxCombinations}
                  onChange={(e) => setMaxCombinations(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Limits multi-leg combinatorial explosion.</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Detail Limit:
                </label>
                <input
                  type="number"
                  step="50"
                  min="5"
                  max="50000"
                  value={detailLimit}
                  onChange={(e) => setDetailLimit(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Number of top strategies enriched with full Greeks.</span>
              </div>
            </div>
          )}

          {activeTab === "screener" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Default Max DTE (Days):
                </label>
                <input
                  type="number"
                  value={defaultMaxDte}
                  onChange={(e) => setDefaultMaxDte(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Default Min DTE (Days):
                </label>
                <input
                  type="number"
                  value={defaultMinDte}
                  onChange={(e) => setDefaultMinDte(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Unusual Volume / OI Ratio:
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={unusualVolOiRatio}
                  onChange={(e) => setUnusualVolOiRatio(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  ATM Band (% of spot):
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={atmBandPct}
                  onChange={(e) => setAtmBandPct(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Max Scan Symbols:
                </label>
                <input
                  type="number"
                  value={maxScanSymbols}
                  onChange={(e) => setMaxScanSymbols(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Max Returned Contracts:
                </label>
                <input
                  type="number"
                  value={maxReturnedContracts}
                  onChange={(e) => setMaxReturnedContracts(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>
          )}

          {activeTab === "weights" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Thesis Alignment Weight (%):
                </label>
                <input
                  type="number"
                  value={thesisWeight}
                  onChange={(e) => setThesisWeight(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Target Reward / Risk Weight (%):
                </label>
                <input
                  type="number"
                  value={rewardRiskWeight}
                  onChange={(e) => setRewardRiskWeight(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Liquidity &amp; Spread Weight (%):
                </label>
                <input
                  type="number"
                  value={liquidityWeight}
                  onChange={(e) => setLiquidityWeight(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Freshness Weight (%):
                </label>
                <input
                  type="number"
                  value={freshnessWeight}
                  onChange={(e) => setFreshnessWeight(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Volatility Alignment Weight (%):
                </label>
                <input
                  type="number"
                  value={volatilityWeight}
                  onChange={(e) => setVolatilityWeight(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Theta Burden Weight (%):
                </label>
                <input
                  type="number"
                  value={thetaWeight}
                  onChange={(e) => setThetaWeight(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>
          )}

          {activeTab === "scanner" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Bullish Target Multiplier:
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={bullishFactor}
                  onChange={(e) => setBullishFactor(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>1.05 = +5% upside target assumption</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Bearish Target Multiplier:
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={bearishFactor}
                  onChange={(e) => setBearishFactor(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>0.95 = -5% downside target assumption</span>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                  Large Move Target Multiplier:
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={largeMoveFactor}
                  onChange={(e) => setLargeMoveFactor(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>1.10 = +10% volatility straddle assumption</span>
              </div>
            </div>
          )}

          {activeTab === "ai" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
              <div style={{ padding: "0.85rem", background: "var(--color-accent-subtle)", border: "1px solid var(--color-border-focus)", borderRadius: "var(--radius-md, 8px)" }}>
                <h4 style={{ margin: "0 0 0.4rem", fontSize: "0.9rem", color: "var(--color-accent)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>🧠</span> Workflow Model Selection
                </h4>
                <p style={{ margin: "0 0 0.85rem", fontSize: "0.76rem", color: "var(--color-text-muted)" }}>
                  Configure which Cloudflare Workers AI model is assigned to each specific trading and intelligence workflow.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.85rem" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.78rem", color: "var(--color-text-secondary)", marginBottom: "0.25rem" }}>
                      Default Flagship Model:
                    </label>
                    <select
                      value={selectedDefaultModel}
                      onChange={(e) => setSelectedDefaultModel(e.target.value)}
                      style={selectStyle}
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.78rem", color: "var(--color-text-secondary)", marginBottom: "0.25rem" }}>
                      Fallback Resilience Model:
                    </label>
                    <select
                      value={selectedFallbackModel}
                      onChange={(e) => setSelectedFallbackModel(e.target.value)}
                      style={selectStyle}
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.78rem", color: "var(--color-text-secondary)", marginBottom: "0.25rem" }}>
                      Options Ideas Evaluator:
                    </label>
                    <select
                      value={selectedIdeasModel}
                      onChange={(e) => setSelectedIdeasModel(e.target.value)}
                      style={selectStyle}
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.78rem", color: "var(--color-text-secondary)", marginBottom: "0.25rem" }}>
                      Multi-Leg Options Comparator:
                    </label>
                    <select
                      value={selectedComparisonModel}
                      onChange={(e) => setSelectedComparisonModel(e.target.value)}
                      style={selectStyle}
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ gridColumn: "span 2" }}>
                    <label style={{ display: "block", fontSize: "0.78rem", color: "var(--color-text-secondary)", marginBottom: "0.25rem" }}>
                      NLQ Natural Language Query Validator:
                    </label>
                    <select
                      value={selectedNlqModel}
                      onChange={(e) => setSelectedNlqModel(e.target.value)}
                      style={selectStyle}
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div style={{ padding: "0.85rem", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px" }}>
                <h4 style={{ margin: "0 0 0.4rem", fontSize: "0.9rem", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>🌡️</span> Sampling Temperatures
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.2rem" }}>
                      Deterministic (Orders):
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={temperatureDeterministic}
                      onChange={(e) => setTemperatureDeterministic(e.target.value)}
                      style={smallInputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.2rem" }}>
                      Analytical (Screener):
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={temperatureAnalytical}
                      onChange={(e) => setTemperatureAnalytical(e.target.value)}
                      style={smallInputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.2rem" }}>
                      Creative (Ideas):
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={temperatureCreative}
                      onChange={(e) => setTemperatureCreative(e.target.value)}
                      style={smallInputStyle}
                    />
                  </div>
                </div>
              </div>

              <div style={{ padding: "0.85rem", background: "var(--color-danger-subtle)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-md, 8px)" }}>
                <h4 style={{ margin: "0 0 0.4rem", fontSize: "0.9rem", color: "var(--color-danger)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>🛡️</span> Trading Safety Limits &amp; Constraints
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.2rem" }}>
                      Max Order Shares:
                    </label>
                    <input
                      type="number"
                      value={maxOrderQuantity}
                      onChange={(e) => setMaxOrderQuantity(e.target.value)}
                      style={smallInputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.2rem" }}>
                      Max Total Value ($):
                    </label>
                    <input
                      type="number"
                      value={maxOrderTotalUsd}
                      onChange={(e) => setMaxOrderTotalUsd(e.target.value)}
                      style={smallInputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.2rem" }}>
                      Max Discount Limit (%):
                    </label>
                    <input
                      type="number"
                      value={maxDiscountPercent}
                      onChange={(e) => setMaxDiscountPercent(e.target.value)}
                      style={smallInputStyle}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div
          style={{
            padding: "1rem 1.5rem",
            background: "var(--color-surface-sunken)",
            borderTop: "1px solid var(--color-border-subtle)",
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
              border: "1px solid var(--color-border-subtle)",
              color: "var(--color-text-muted)",
              padding: "0.5rem 1rem",
              borderRadius: "var(--radius-sm, 6px)",
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
                border: "1px solid var(--color-border-subtle)",
                color: "var(--color-text-secondary)",
                padding: "0.5rem 1rem",
                borderRadius: "var(--radius-sm, 6px)",
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
                background: "var(--color-accent)",
                border: "none",
                color: "var(--color-text-inverse)",
                fontWeight: 600,
                padding: "0.5rem 1.25rem",
                borderRadius: "var(--radius-sm, 6px)",
                cursor: "pointer",
                fontSize: "0.85rem",
                boxShadow: "var(--shadow-sm)",
              }}
            >
              {saving ? "Applying..." : "Apply Runtime Config"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modalContent, document.body) : modalContent;
}
