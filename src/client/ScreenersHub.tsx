import { useEffect, useMemo, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import {
  getScreeningProviders,
  providerSupportsFilter,
  SCREENING_ASSET_CLASSES,
  type ScreeningAssetClass,
} from "./screeningAdapters";
import type { ScreenedStockItem } from "../types";
import { TabHoverItem } from "./TabHoverItem";
import "./optionsResearch.css";

interface ScreenersHubProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onStocksLoaded?: (rows: ScreenedStockItem[]) => void;
}

type ScreenRow = Record<string, unknown>;

function numberFilter(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ScreenersHub({ activeEnv, userLogin, onStocksLoaded }: ScreenersHubProps) {
  const [assetClass, setAssetClass] = useState<ScreeningAssetClass>("stocks");
  const providers = useMemo(() => getScreeningProviders(assetClass), [assetClass]);
  const [providerId, setProviderId] = useState("etrade");
  const [symbolSearch, setSymbolSearch] = useState("");
  const [stockLimit, setStockLimit] = useState("100");
  const [exchange, setExchange] = useState("ALL");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [trend, setTrend] = useState("all");
  const [rows, setRows] = useState<ScreenRow[]>([]);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (providers.length > 0 && !providers.some((provider) => provider.id === providerId)) {
      setProviderId(providers[0]?.id || "");
    }
  }, [providers, providerId]);

  const activeProvider = providers.find((provider) => provider.id === providerId);
  const endpoint = activeProvider?.endpointByAssetClass[assetClass];

  const runScreen = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!endpoint || loading) return;
    setLoading(true);
    setError("");
    setRows([]);
    setSummary("");
    try {
      const filters = {
        ...(providerSupportsFilter(activeProvider, assetClass, "search") ? { search: symbolSearch.trim() || undefined } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "limit") ? { limit: numberFilter(stockLimit) } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "exchange") ? { exchange } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "price-range") ? {
          minPrice: numberFilter(minPrice),
          maxPrice: numberFilter(maxPrice),
        } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "trend") ? {
          gainersOnly: trend === "gainers" || undefined,
          losersOnly: trend === "losers" || undefined,
        } : {}),
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify(filters),
      });

      const data = (await response.json()) as {
        error?: string;
        stocks?: ScreenedStockItem[];
        filterSummary?: string;
        validationError?: string;
        totalScanned?: number;
        matchedCount?: number;
      };

      if (!response.ok) throw new Error(data.error || `Screening request failed [HTTP ${response.status}].`);
      if (data.validationError) throw new Error(data.validationError);

      const stockResults = data.stocks || [];
      setRows(stockResults.map((row) => Object.fromEntries(Object.entries(row))));
      setSummary(data.filterSummary || `${data.totalScanned ?? 0} scanned · ${data.matchedCount ?? stockResults.length} matched`);
      onStocksLoaded?.(stockResults);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screening request failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="trading-section screeners-hub">
      <div className="trading-subnav-bar screeners-asset-tabs" role="tablist" aria-label="Instrument class" style={{ margin: "0.25rem 0 0.75rem" }}>
        {SCREENING_ASSET_CLASSES.map((asset) => {
          const descriptions: Record<string, { eyebrow: string; title: string; desc: string }> = {
            stocks: {
              eyebrow: "EQUITIES SCREENING",
              title: "Stock Universe Screener",
              desc: "Screen common stocks and ETFs by price, volume, exchange, and trend.",
            },
            options: {
              eyebrow: "DERIVATIVES · CONSOLIDATED",
              title: "Options · Planned in Hub (Active in Auto Options)",
              desc: "All options capabilities, raw contracts screening, and strategy discovery are now in the dedicated Auto Options Research tab.",
            },
            forex: {
              eyebrow: "CURRENCY PAIRS",
              title: "Forex Screener · Planned",
              desc: "Screen foreign exchange pairs across global FX liquidity pools (adapter in development).",
            },
            futures: {
              eyebrow: "COMMODITY & INDEX FUTURES",
              title: "Futures Screener · Planned",
              desc: "Screen E-mini index futures, energy, metals, and treasury contracts (adapter in development).",
            },
            commodities: {
              eyebrow: "COMMODITY BENCHMARKS",
              title: "Commodities Screener · Planned",
              desc: "Screen physical commodity and spot contracts (adapter in development).",
            },
            bonds: {
              eyebrow: "FIXED INCOME",
              title: "Bonds & Yields · Planned",
              desc: "Screen US Treasuries, corporate bonds, and yield curve spreads (adapter in development).",
            },
          };
          const info = descriptions[asset.id] || {
            eyebrow: "MARKET SCREENER",
            title: asset.label,
            desc: `Screen ${asset.label.toLowerCase()} across connected market data providers.`,
          };

          return (
            <TabHoverItem
              key={asset.id}
              eyebrow={info.eyebrow}
              title={info.title}
              description={info.desc}
            >
              <button
                type="button"
                role="tab"
                aria-selected={assetClass === asset.id}
                className={`subnav-btn ${assetClass === asset.id ? "active" : ""}`}
                onClick={() => setAssetClass(asset.id)}
              >
                {asset.label}{asset.available ? "" : " · Planned"}
              </button>
            </TabHoverItem>
          );
        })}
      </div>

      {assetClass === "stocks" ? (
        <>
          <form className="options-request-form screeners-filter-form" onSubmit={(event) => void runScreen(event)}>
            <label className="options-field">
              <span>Data provider / API</span>
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select>
            </label>
            {providerSupportsFilter(activeProvider, assetClass, "search") && (
              <label className="options-field">
                <span>Ticker or company search</span>
                <input
                  value={symbolSearch}
                  onChange={(event) => setSymbolSearch(event.target.value)}
                  placeholder="Optional; e.g. NVDA, AAPL"
                />
              </label>
            )}
            {providerSupportsFilter(activeProvider, assetClass, "exchange") && (
              <label className="options-field">
                <span>Exchange</span>
                <select value={exchange} onChange={(event) => setExchange(event.target.value)}>
                  <option value="ALL">All U.S. listings</option>
                  <option value="NASDAQ">Nasdaq</option>
                  <option value="NYSE">NYSE</option>
                  <option value="AMEX">AMEX</option>
                </select>
              </label>
            )}
            {providerSupportsFilter(activeProvider, assetClass, "price-range") && (
              <>
                <label className="options-field"><span>Min price</span><input type="number" min="0" step="0.01" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} /></label>
                <label className="options-field"><span>Max price</span><input type="number" min="0" step="0.01" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label>
              </>
            )}
            {providerSupportsFilter(activeProvider, assetClass, "trend") && (
              <label className="options-field">
                <span>Daily trend</span>
                <select value={trend} onChange={(event) => setTrend(event.target.value)}>
                  <option value="all">All</option>
                  <option value="gainers">Gainers</option>
                  <option value="losers">Losers</option>
                </select>
              </label>
            )}
            {providerSupportsFilter(activeProvider, assetClass, "limit") && (
              <label className="options-field"><span>Max results</span><input type="number" min="1" value={stockLimit} onChange={(event) => setStockLimit(event.target.value)} /></label>
            )}
            <div className="options-form-footer">
              <button type="submit" disabled={loading || !endpoint}>{loading ? "Screening…" : "Run stock screen"}</button>
            </div>
          </form>

          {error && <div className="options-error" role="alert">{error}</div>}
          {summary && <div className="screener-results-header"><span>{summary}</span><span>{activeProvider?.label} · {activeEnv}</span></div>}
          {(rows.length > 0 || summary) && (
            rows.length === 0 ? <p className="empty-state">No results matched those filters.</p> : (
              <div className="options-table-scroll">
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.55rem 0.9rem",
                  background: "rgba(15, 23, 42, 0.7)",
                  border: "1px solid rgba(56, 189, 248, 0.25)",
                  borderRadius: "6px",
                  marginBottom: "0.75rem",
                  fontSize: "0.8rem",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ color: "#38bdf8", fontWeight: 600 }}>📡 Feed Source:</span>
                    <span style={{ color: "#f8fafc" }}>
                      {String(rows[0]?.source || activeProvider?.label || "Live Market Feed")}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <span style={{
                      padding: "0.2rem 0.55rem",
                      borderRadius: "4px",
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      background: String(rows[0]?.source || "").includes("Curated") ? "rgba(245, 158, 11, 0.2)" : "rgba(34, 197, 94, 0.2)",
                      color: String(rows[0]?.source || "").includes("Curated") ? "#fbbf24" : "#4ade80",
                      border: `1px solid ${String(rows[0]?.source || "").includes("Curated") ? "rgba(245, 158, 11, 0.4)" : "rgba(34, 197, 94, 0.4)"}`,
                    }}>
                      {String(rows[0]?.source || "").includes("Curated") ? "📂 OFFLINE CURATED UNIVERSE" : "🌐 LIVE REST API FEED"}
                    </span>
                    <span style={{ color: "#94a3b8", fontSize: "0.74rem" }}>
                      Quote Status: <code style={{ color: "#cbd5e1" }}>{String(rows[0]?.quoteStatus || "AS_OF_UNKNOWN")}</code>
                    </span>
                  </div>
                </div>

                <table className="options-comparison-table">
                  <thead><tr>{Object.keys(rows[0]).map((key) => <th key={key}>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</th>)}</tr></thead>
                  <tbody>{rows.map((row, index) => (
                    <tr key={`${String(row.symbol || index)}:${index}`}>
                      {Object.values(row).map((value, column) => <td key={column}>{displayValue(value)}</td>)}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )
          )}
        </>
      ) : assetClass === "options" ? (
        <div className="options-comparison-note" style={{ margin: "1.5rem 0", padding: "1.5rem", background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.3)", borderRadius: "8px" }}>
          <h4 style={{ margin: "0 0 0.5rem", color: "#38bdf8", fontSize: "1.05rem" }}>⚡ Options Capabilities Moved to Auto Options Research</h4>
          <p style={{ margin: "0 0 0.75rem", color: "#cbd5e1", fontSize: "0.92rem", lineHeight: 1.5 }}>
            All options screening, analysis, and execution tools—including the <strong>📋 Raw Contracts Screener</strong>, <strong>🎯 Strategy Discovery &amp; Payoff Analyzer</strong>, <strong>⚙️ Custom Thesis Universe</strong>, <strong>💬 Natural Language Screen (NLQ)</strong>, and <strong>⏰ Scheduled Options Schedulers</strong>—are now centralized under the <strong>Auto Options Research</strong> tab.
          </p>
          <p style={{ margin: 0, color: "#94a3b8", fontSize: "0.85rem" }}>
            The Options tab in this Multi-Asset Screener is marked as planned to keep this screener focused on equities and future multi-asset feeds without duplication.
          </p>
        </div>
      ) : (
        <div className="options-comparison-note" style={{ margin: "1.5rem 0", padding: "1.5rem", background: "rgba(100, 116, 139, 0.1)", border: "1px solid rgba(100, 116, 139, 0.25)", borderRadius: "8px" }}>
          <h4 style={{ margin: "0 0 0.5rem", color: "#94a3b8", fontSize: "1.05rem" }}>🚧 {SCREENING_ASSET_CLASSES.find((a) => a.id === assetClass)?.label || "Asset"} Screener · Planned</h4>
          <p style={{ margin: 0, color: "#94a3b8", fontSize: "0.9rem" }}>
            This instrument class is a planned extension point. Multi-asset provider adapters are currently in development.
          </p>
        </div>
      )}

      <p className="options-assumptions">
        Provider adapters declare the instrument classes and screening endpoint they support. Add a broker, market-data API, or MCP connector by registering its capabilities and mapping its response to the common result table; unsupported instrument classes are not silently routed to an unrelated feed.
      </p>
    </section>
  );
}
