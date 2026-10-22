import { useState } from "react";
import { apiFetch as fetch } from "../apiFetch";
import type { ScreenedOptionContractItem } from "../../types";
import { buildPaymentSignature, describeChallenge, sendUsdcPayment, type PaidTransfer, type X402Challenge } from "../x402Pay";
import { OptionsDataDownloadDropdown } from "./optionsDataExporter";
import type { TradeOrderContext } from "../trading/tradeOrderContext";
import { RiskAnalysisModal } from "./RiskAnalysisModal";
import type { RiskSubject } from "./riskManagementEngine";

interface RawContractsScreenerProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  initialSymbol?: string;
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onSelectContract?: (contract: ScreenedOptionContractItem) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

interface PendingPayment {
  challenge: X402Challenge;
  filters: Record<string, unknown>;
  paid?: PaidTransfer;
}

function numberFilter(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

const POPULAR_SYMBOLS = ["NVDA", "TSLA", "SPY", "QQQ", "AAPL", "MSFT", "AMZN", "AMD"];

export function RawContractsScreener({
  activeEnv,
  userLogin,
  initialSymbol = "NVDA",
  onPreviewTrade,
  onSelectContract,
  onSendPrompt,
}: RawContractsScreenerProps) {
  const [riskSubject, setRiskSubject] = useState<RiskSubject | null>(null);
  const [symbol, setSymbol] = useState(initialSymbol);
  const [contractType, setContractType] = useState<"BOTH" | "CALL" | "PUT">("BOTH");
  const [minDte, setMinDte] = useState("0");
  const [maxDte, setMaxDte] = useState("90");
  const [minVolume, setMinVolume] = useState("");
  const [minOpenInterest, setMinOpenInterest] = useState("");
  const [maxSpreadPct, setMaxSpreadPct] = useState("");
  const [maxResults, setMaxResults] = useState("5000");
  // Issue #959: sort keys are the canonical OptionScreenSortKey values
  // the engine actually implements. The previous "openInterest",
  // "impliedVolatility" and "strike" values were not engine sort keys —
  // the engine's sanitizer silently discarded them and every such
  // selection sorted by volume. "Open Interest" is dropped (no engine
  // comparator exists; adding one is an engine change, out of #959's
  // scope); IV maps to the canonical "iv" key and Strike to
  // "strikeDistance" (distance from spot), which now actually sort.
  const [sortBy, setSortBy] = useState<"volume" | "iv" | "spreadPct" | "strikeDistance">("volume");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [contracts, setContracts] = useState<ScreenedOptionContractItem[]>([]);
  const [summary, setSummary] = useState("");
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);

  // In-memory table search & filter
  const [tableSearch, setTableSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"ALL" | "CALL" | "PUT">("ALL");

  // Payment challenge state
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [payStatus, setPayStatus] = useState("");

  const callScreen = async (filters: Record<string, unknown>, paymentSignature?: string) => {
    const response = await fetch("/api/trading/options/screen", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-environment": activeEnv,
        ...(userLogin ? { "x-user-login": userLogin } : {}),
        ...(paymentSignature ? { "PAYMENT-SIGNATURE": paymentSignature } : {}),
      },
      body: JSON.stringify({ ...filters, pushToSlack: true }),
    });

    const body = (await response.json()) as Record<string, any>;
    if (response.status === 402) {
      const challenge = body.protocols?.x402?.challenge as X402Challenge | undefined;
      if (!challenge) throw new Error(body.error || "Payment required, but no payment challenge was returned.");
      return {
        challenge,
        reason: paymentSignature ? (body.reason as string | undefined) : undefined,
        retryable: /not yet visible/i.test(String(body.reason || "")),
      };
    }

    const data = body as {
      error?: string;
      contracts?: ScreenedOptionContractItem[];
      filterSummary?: string;
      validationError?: string;
      totalUnderlyingsScanned?: number;
      totalContractsEvaluated?: number;
      matchedCount?: number;
      totalMatches?: number;
      scannedAt?: string;
      reportUrl?: string;
    };

    if (!response.ok) throw new Error(data.error || `Screening request failed [HTTP ${response.status}].`);
    if (data.validationError) throw new Error(data.validationError);

    const results = (data.contracts || []) as ScreenedOptionContractItem[];
    setContracts(results);
    setSummary(
      data.filterSummary ||
        `${data.totalContractsEvaluated ?? 0} evaluated · ${data.totalMatches ?? results.length} matching contracts (limit ${filters.limit})`
    );
    setScannedAt(data.scannedAt ? new Date(data.scannedAt).toLocaleTimeString() : new Date().toLocaleTimeString());
    setReportUrl(data.reportUrl || null);
    setPending(null);
    return null;
  };

  const runWithoutPaying = async () => {
    if (!pending || loading) return;
    setLoading(true);
    setError("");
    try {
      await callScreen(pending.filters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screening failed.");
    } finally {
      setLoading(false);
    }
  };

  const payAndRun = async () => {
    if (!pending || loading) return;
    setLoading(true);
    setError("");
    try {
      let current = pending;
      for (let attempt = 0; attempt < 5; attempt++) {
        const paid = current.paid ?? (await sendUsdcPayment(current.challenge, setPayStatus));
        current = { ...current, paid };
        setPending(current);
        setPayStatus("Verifying payment…");
        const signature = await buildPaymentSignature(current.challenge, paid);
        const outcome = await callScreen(current.filters, signature);
        if (!outcome) return;
        if (!outcome.retryable) throw new Error(outcome.reason || "Payment could not be verified.");
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      throw new Error("Payment sent but not yet visible to the server. Click retry to verify.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment failed.");
    } finally {
      setLoading(false);
      setPayStatus("");
    }
  };

  const handleScreenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbol.trim() || loading) return;
    setLoading(true);
    setError("");
    setContracts([]);
    setSummary("");
    setPending(null);

    try {
      const filters = {
        underlyingSymbols: [symbol.trim().toUpperCase()],
        contractType,
        minDte: numberFilter(minDte),
        maxDte: numberFilter(maxDte),
        minVolume: numberFilter(minVolume),
        minOpenInterest: numberFilter(minOpenInterest),
        maxSpreadPct: numberFilter(maxSpreadPct),
        limit: numberFilter(maxResults) ?? 5000,
        sortBy,
      };

      const outcome = await callScreen(filters);
      if (outcome) setPending({ challenge: outcome.challenge, filters });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screening request failed.");
    } finally {
      setLoading(false);
    }
  };

  // Filter in-memory results
  const filteredContracts = contracts.filter((c) => {
    if (typeFilter !== "ALL" && c.optionType !== typeFilter) return false;
    if (tableSearch.trim()) {
      const query = tableSearch.toLowerCase();
      const matchSymbol = (c.symbol || c.displaySymbol || c.osiKey || "").toLowerCase().includes(query);
      const matchStrike = String(c.strikePrice).includes(query);
      const matchExpiry = (c.expirationDate || "").toLowerCase().includes(query);
      if (!matchSymbol && !matchStrike && !matchExpiry) return false;
    }
    return true;
  });

  return (
    <div className="raw-contracts-screener-view" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Top Banner & Quick Underlying Chips */}
      <div
        style={{
          background: "var(--color-card)",
          border: "1px solid var(--color-accent-border)",
          borderRadius: "10px",
          padding: "1rem 1.25rem",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <div>
          <h3 style={{ margin: "0 0 0.25rem", fontSize: "1.1rem", color: "var(--color-accent)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span>📋 Raw Option Contracts Screener</span>
            <span style={{ fontSize: "0.72rem", background: "var(--color-accent-subtle)", border: "1px solid var(--color-border-focus)", borderRadius: "var(--radius-xs, 4px)", padding: "0.15rem 0.5rem", color: "var(--color-accent)" }}>
              Live E*TRADE Chains
            </span>
          </h3>
          <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--color-text-muted)" }}>
            Query live individual option contracts with implied volatility, bid/ask spreads, Greeks, and liquidity bounds.
          </p>
        </div>

        {/* Quick Ticker Chips */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.78rem", color: "var(--color-text-dim)" }}>Quick symbols:</span>
          {POPULAR_SYMBOLS.map((s) => (
            <button
              key={s}
              type="button"
              className="subnav-btn"
              style={{
                padding: "0.25rem 0.6rem",
                fontSize: "0.76rem",
                background: symbol.toUpperCase() === s ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
                borderColor: symbol.toUpperCase() === s ? "var(--color-border-focus)" : "var(--color-border-subtle)",
                color: symbol.toUpperCase() === s ? "var(--color-accent)" : "var(--color-text-secondary)",
              }}
              onClick={() => setSymbol(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Screener Parameter Form */}
      <form
        className="options-request-form screeners-filter-form"
        onSubmit={(e) => void handleScreenSubmit(e)}
        style={{ margin: 0 }}
      >
        <label className="options-field">
          <span>Underlying Symbol</span>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="e.g. NVDA, TSLA, SPY"
            required
            style={{ fontWeight: 600, letterSpacing: "0.05em" }}
          />
        </label>

        <label className="options-field">
          <span>Contract Type</span>
          <select value={contractType} onChange={(e) => setContractType(e.target.value as any)}>
            <option value="BOTH">Calls &amp; Puts</option>
            <option value="CALL">Calls Only</option>
            <option value="PUT">Puts Only</option>
          </select>
        </label>

        <label className="options-field">
          <span>Min DTE (Days)</span>
          <input
            type="number"
            min="0"
            value={minDte}
            onChange={(e) => setMinDte(e.target.value)}
            placeholder="0"
          />
        </label>

        <label className="options-field">
          <span>Max DTE (Days)</span>
          <input
            type="number"
            min="0"
            value={maxDte}
            onChange={(e) => setMaxDte(e.target.value)}
            placeholder="90"
          />
        </label>

        <label className="options-field">
          <span>Min Volume</span>
          <input
            type="number"
            min="0"
            value={minVolume}
            onChange={(e) => setMinVolume(e.target.value)}
            placeholder="e.g. 10"
          />
        </label>

        <label className="options-field">
          <span>Min Open Interest</span>
          <input
            type="number"
            min="0"
            value={minOpenInterest}
            onChange={(e) => setMinOpenInterest(e.target.value)}
            placeholder="e.g. 50"
          />
        </label>

        <label className="options-field">
          <span>Max Spread (%)</span>
          <input
            type="number"
            step="0.5"
            min="0"
            value={maxSpreadPct}
            onChange={(e) => setMaxSpreadPct(e.target.value)}
            placeholder="e.g. 15"
          />
        </label>

        <label className="options-field">
          <span>Sort By</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
            <option value="volume">Volume (Highest First)</option>
            <option value="iv">Implied Volatility (IV)</option>
            <option value="spreadPct">Tightest Spread (%)</option>
            <option value="strikeDistance">Strike Distance</option>
          </select>
        </label>

        <label className="options-field">
          <span>Max Results (Limit)</span>
          <input
            type="number"
            min="10"
            max="10000"
            value={maxResults}
            onChange={(e) => setMaxResults(e.target.value)}
            placeholder="5000"
          />
        </label>

        <div className="options-form-footer" style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="submit" disabled={loading} style={{ minWidth: "180px", fontWeight: 600 }}>
            {loading ? "Scanning Chains…" : `⚡ Screen ${symbol || "Options"} Contracts`}
          </button>
        </div>
      </form>

      {/* Optional Payment Challenge */}
      {pending && (
        <div className="options-error" role="status" style={{ borderColor: "var(--color-accent)" }}>
          <p>
            <strong>Payment Optional (x402 Protocol).</strong> Pay ${pending.challenge.amount.toFixed(2)} {describeChallenge(pending.challenge).label} or run for free.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button type="button" disabled={loading} onClick={() => void payAndRun()}>
              {loading ? payStatus || "Working…" : pending.paid ? "Retry Verification" : `Pay $${pending.challenge.amount.toFixed(2)} & Run`}
            </button>
            {!pending.paid && (
              <button type="button" disabled={loading} onClick={() => void runWithoutPaying()}>
                Skip Payment &amp; Run Free
              </button>
            )}
          </div>
        </div>
      )}

      {error && <div className="options-error" role="alert">{error}</div>}

      {/* Results Header with In-Memory Filter and Exporter */}
      {(contracts.length > 0 || summary) && (
        <div
          style={{
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "8px",
            padding: "0.75rem 1rem",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.88rem", fontWeight: 600, color: "var(--color-text-primary)" }}>
              {summary || `${contracts.length} contracts retrieved`}
            </span>
            {scannedAt && (
              <span style={{ fontSize: "0.76rem", color: "var(--color-text-muted)" }}>
                · Updated: {scannedAt}
              </span>
            )}
            {reportUrl && <a href={reportUrl} download>📄 Download this run’s PDF</a>}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            {/* Type selector */}
            <div style={{ display: "flex", border: "1px solid var(--color-border-medium)", borderRadius: "6px", overflow: "hidden" }}>
              {(["ALL", "CALL", "PUT"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  style={{
                    padding: "0.25rem 0.6rem",
                    fontSize: "0.75rem",
                    border: "none",
                    background: typeFilter === t ? "var(--color-info-subtle)" : "transparent",
                    color: typeFilter === t ? "var(--color-accent)" : "var(--color-text-muted)",
                    cursor: "pointer",
                  }}
                  onClick={() => setTypeFilter(t)}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* In-table search input */}
            <input
              type="text"
              placeholder="Filter by strike / expiry…"
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              style={{
                padding: "0.3rem 0.6rem",
                fontSize: "0.78rem",
                background: "var(--color-input)",
                border: "1px solid var(--color-input-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--color-input-foreground)",
                width: "180px",
              }}
            />

            {/* Export Dropdown */}
            {contracts.length > 0 && (
              <OptionsDataDownloadDropdown
                symbol={symbol}
                activeEnv={activeEnv}
                userLogin={userLogin}
              />
            )}
          </div>
        </div>
      )}

      {/* Contracts Table */}
      {contracts.length > 0 && (
        <div className="options-table-scroll" style={{ maxHeight: "650px", overflowY: "auto" }}>
          <table className="options-comparison-table" style={{ fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, background: "var(--color-surface-sunken)", zIndex: 10 }}>
                <th>Contract</th>
                <th>Type</th>
                <th>Strike</th>
                <th>Moneyness</th>
                <th>Expiration / DTE</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Mid</th>
                <th>Spread %</th>
                <th>Vol</th>
                <th>Open Int</th>
                <th>IV %</th>
                <th>Delta</th>
                <th>Gamma</th>
                <th>Theta</th>
                <th>Vega</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredContracts.map((c, idx) => {
                const isCall = c.optionType === "CALL";
                const mid = Number(((c.bid + c.ask) / 2).toFixed(2));
                const ivPct = c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(1) : "—";
                const contractLabel = c.displaySymbol || c.symbol || c.osiKey || `Option #${idx + 1}`;

                return (
                  <tr key={`${c.symbol || c.displaySymbol || c.osiKey || idx}:${idx}`}>
                    <td style={{ fontSize: "0.78rem", color: "var(--color-text-muted)" }}>
                      {contractLabel}
                    </td>
                    <td>
                      <span
                        style={{
                          padding: "0.15rem 0.45rem",
                          borderRadius: "var(--radius-xs, 4px)",
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          background: isCall ? "var(--color-success-subtle)" : "var(--color-danger-subtle)",
                          color: isCall ? "var(--color-success)" : "var(--color-danger)",
                          border: `1px solid ${isCall ? "var(--color-success)" : "var(--color-danger)"}`,
                        }}
                      >
                        {c.optionType}
                      </span>
                    </td>
                    <td style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>
                      ${Number(c.strikePrice).toFixed(2)}
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: "0.72rem",
                          padding: "0.1rem 0.35rem",
                          borderRadius: "var(--radius-xs, 3px)",
                          background: c.moneyness === "ITM" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
                          color: c.moneyness === "ITM" ? "var(--color-accent)" : "var(--color-text-muted)",
                        }}
                      >
                        {c.moneyness || "OTM"}
                      </span>
                    </td>
                    <td>
                      {c.expirationDate} <span style={{ color: "var(--color-text-dim)" }}>({c.daysToExpiration}d)</span>
                    </td>
                    <td>${Number(c.bid).toFixed(2)}</td>
                    <td>${Number(c.ask).toFixed(2)}</td>
                    <td style={{ fontWeight: 600 }}>${mid.toFixed(2)}</td>
                    <td>
                      <span style={{ color: c.spreadPct > 15 ? "var(--color-danger)" : "var(--color-text-secondary)" }}>
                        {Number(c.spreadPct).toFixed(1)}%
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{(c.volume ?? 0).toLocaleString()}</td>
                    <td>{(c.openInterest ?? 0).toLocaleString()}</td>
                    <td>{ivPct}%</td>
                    <td style={{ color: Number(c.delta) >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>
                      {c.delta !== undefined ? Number(c.delta).toFixed(3) : "—"}
                    </td>
                    <td>{c.gamma !== undefined ? Number(c.gamma).toFixed(4) : "—"}</td>
                    <td style={{ color: "var(--color-danger)" }}>{c.theta !== undefined ? Number(c.theta).toFixed(3) : "—"}</td>
                    <td>{c.vega !== undefined ? Number(c.vega).toFixed(3) : "—"}</td>
                    <td>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        {onSelectContract && (
                          <button
                            type="button"
                            className="subnav-btn"
                            style={{ padding: "0.2rem 0.4rem", fontSize: "0.72rem" }}
                            title="Inspect in options tools"
                            onClick={() => onSelectContract(c)}
                          >
                            Select
                          </button>
                        )}
                        <button
                          type="button"
                          className="subnav-btn"
                          style={{ padding: "0.2rem 0.4rem", fontSize: "0.72rem", borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
                          title="Analyze risk profile and mitigation playbook"
                          onClick={() =>
                            setRiskSubject({
                              title: `${c.optionType} $${c.strikePrice} (${c.expirationDate})`,
                              underlyingSymbol: c.underlyingSymbol,
                              underlyingPrice: c.underlyingPrice,
                              strategyType: `Long ${c.optionType}`,
                              sentiment: isCall ? "bullish" : "bearish",
                              expirationDate: c.expirationDate,
                              dte: c.daysToExpiration,
                              quantity: 1,
                              netDebit: mid,
                              maxProfit: isCall ? null : c.strikePrice * 100,
                              maxLoss: mid * 100,
                              chanceOfProfit: isCall ? (c.delta ? Math.min(99, Math.abs(c.delta) * 100) : 50) : (c.delta ? Math.min(99, Math.abs(c.delta) * 100) : 50),
                              breakevens: [isCall ? Number((c.strikePrice + mid).toFixed(2)) : Number((c.strikePrice - mid).toFixed(2))],
                              legs: [
                                {
                                  side: "BUY",
                                  action: "BUY",
                                  optionType: c.optionType,
                                  strike: c.strikePrice,
                                  expirationDate: c.expirationDate,
                                  entryPrice: mid,
                                  bid: c.bid,
                                  ask: c.ask,
                                  iv: c.impliedVolatility,
                                  delta: c.delta,
                                  gamma: c.gamma,
                                  theta: c.theta,
                                  vega: c.vega,
                                },
                              ],
                              netGreeks: {
                                delta: c.delta,
                                gamma: c.gamma,
                                theta: c.theta,
                                vega: c.vega,
                              },
                              bid: c.bid,
                              ask: c.ask,
                              openInterest: c.openInterest,
                              volume: c.volume,
                            })
                          }
                        >
                          🛡️ Risk
                        </button>
                        {onPreviewTrade && (
                          <button
                            type="button"
                            className="subnav-btn"
                            style={{ padding: "0.2rem 0.4rem", fontSize: "0.72rem", borderColor: "var(--color-accent)", color: "var(--color-accent)" }}
                            title="Preview buy trade order"
                            onClick={() =>
                              onPreviewTrade({
                                assetClass: "options",
                                symbol: c.underlyingSymbol,
                                action: "BUY",
                                quantity: 1,
                                underlyingPrice: c.underlyingPrice,
                                label: `Buy 1x ${contractLabel} (${c.optionType} $${c.strikePrice})`,
                                legs: [`BUY 1 ${contractLabel} @ $${mid.toFixed(2)}`],
                                optionLegs: [{
                                  securityType: "OPTN",
                                  side: "BUY",
                                  quantity: 1,
                                  optionType: c.optionType,
                                  strike: c.strikePrice,
                                  expirationDate: c.expirationDate,
                                }],
                                strategyNetDebit: mid * 100,
                              })
                            }
                          >
                            Trade
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {contracts.length === 0 && !loading && (
        <div
          style={{
            padding: "3rem 1.5rem",
            textAlign: "center",
            background: "var(--color-surface-sunken)",
            border: "1px dashed var(--color-border-subtle)",
            borderRadius: "var(--radius-md, 8px)",
            color: "var(--color-text-dim)",
          }}
        >
          <p style={{ margin: "0 0 0.5rem", fontSize: "1.1rem", color: "var(--color-text-muted)" }}>
            No screened contracts loaded yet.
          </p>
          <p style={{ margin: 0, fontSize: "0.85rem" }}>
            Select an underlying symbol above and click <strong>Screen Contracts</strong> to stream live contracts from E*TRADE.
          </p>
        </div>
      )}

      {/* Risk Analysis & Management Playbook Modal */}
      <RiskAnalysisModal
        isOpen={Boolean(riskSubject)}
        onClose={() => setRiskSubject(null)}
        subject={riskSubject}
        onSendPrompt={onSendPrompt}
      />
    </div>
  );
}
