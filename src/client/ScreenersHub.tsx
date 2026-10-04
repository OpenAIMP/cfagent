import { useEffect, useMemo, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import {
  getScreeningProviders,
  providerSupportsFilter,
  SCREENING_ASSET_CLASSES,
  type ScreeningAssetClass,
} from "./screeningAdapters";
import type { ScreenedStockItem } from "../types";
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
  const [contractType, setContractType] = useState("BOTH");
  const [minDte, setMinDte] = useState("");
  const [maxDte, setMaxDte] = useState("");
  const [minVolume, setMinVolume] = useState("");
  const [minOpenInterest, setMinOpenInterest] = useState("");
  const [maxSpreadPct, setMaxSpreadPct] = useState("");
  const [rows, setRows] = useState<ScreenRow[]>([]);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!providers.some((provider) => provider.id === providerId)) {
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
      const filters = assetClass === "stocks"
        ? {
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
          }
        : {
            ...(providerSupportsFilter(activeProvider, assetClass, "search") ? {
              underlyingSymbols: symbolSearch.trim() ? [symbolSearch.trim().toUpperCase()] : [],
            } : {}),
            ...(providerSupportsFilter(activeProvider, assetClass, "contract-type") ? { contractType } : {}),
            ...(providerSupportsFilter(activeProvider, assetClass, "dte-range") ? {
              minDte: numberFilter(minDte),
              maxDte: numberFilter(maxDte),
            } : {}),
            ...(providerSupportsFilter(activeProvider, assetClass, "min-volume") ? { minVolume: numberFilter(minVolume) } : {}),
            ...(providerSupportsFilter(activeProvider, assetClass, "min-open-interest") ? { minOpenInterest: numberFilter(minOpenInterest) } : {}),
            ...(providerSupportsFilter(activeProvider, assetClass, "max-spread") ? { maxSpreadPct: numberFilter(maxSpreadPct) } : {}),
            ...(providerSupportsFilter(activeProvider, assetClass, "limit") ? { limit: numberFilter(stockLimit) } : {}),
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
      const data = await response.json() as {
        error?: string;
        stocks?: ScreenedStockItem[];
        contracts?: ScreenRow[];
        filterSummary?: string;
        validationError?: string;
        totalScanned?: number;
        totalContractsEvaluated?: number;
        matchedCount?: number;
      };
      if (!response.ok) throw new Error(data.error || `Screening request failed [HTTP ${response.status}].`);
      if (data.validationError) throw new Error(data.validationError);
      const results = assetClass === "stocks" ? data.stocks || [] : data.contracts || [];
      setRows(results.map((row) => Object.fromEntries(Object.entries(row))));
      setSummary(data.filterSummary || `${data.totalScanned ?? data.totalContractsEvaluated ?? 0} scanned · ${data.matchedCount ?? results.length} matched`);
      if (assetClass === "stocks") onStocksLoaded?.(data.stocks || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screening request failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="trading-section screeners-hub">
      <header className="options-research-heading">
        <div>
          <p className="options-eyebrow">PROVIDER-EXTENSIBLE MARKET SCREENER</p>
          <h2>Screeners</h2>
          <p>Select an instrument class and a connected data provider. Stock and options screeners are available now; other asset classes appear as adapters are added.</p>
        </div>
      </header>

      <div className="trading-subnav-bar screeners-asset-tabs" role="tablist" aria-label="Instrument class">
        {SCREENING_ASSET_CLASSES.map((asset) => (
          <button
            key={asset.id}
            type="button"
            role="tab"
            aria-selected={assetClass === asset.id}
            disabled={!asset.available}
            className={`subnav-btn ${assetClass === asset.id ? "active" : ""}`}
            onClick={() => asset.available && setAssetClass(asset.id)}
            title={asset.available ? `Screen ${asset.label.toLowerCase()}` : `No connected ${asset.label.toLowerCase()} screening provider yet`}
          >
            {asset.label}{asset.available ? "" : " · Planned"}
          </button>
        ))}
      </div>

      {assetClass === "stocks" || assetClass === "options" ? (
        <form className="options-request-form screeners-filter-form" onSubmit={(event) => void runScreen(event)}>
          <label className="options-field">
            <span>Data provider / API</span>
            <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </select>
          </label>
          {providerSupportsFilter(activeProvider, assetClass, "search") && <label className="options-field">
            <span>{assetClass === "stocks" ? "Ticker or company search" : "Underlying symbol"}</span>
            <input
              value={symbolSearch}
              onChange={(event) => setSymbolSearch(event.target.value)}
              placeholder={assetClass === "stocks" ? "Optional; e.g. NVDA" : "Required; e.g. NVDA"}
              required={assetClass === "options"}
            />
          </label>}
          {assetClass === "stocks" ? (
            <>
              {providerSupportsFilter(activeProvider, assetClass, "exchange") && <label className="options-field">
                <span>Exchange</span>
                <select value={exchange} onChange={(event) => setExchange(event.target.value)}>
                  <option value="ALL">All U.S. listings</option>
                  <option value="NASDAQ">Nasdaq</option>
                  <option value="NYSE">NYSE</option>
                  <option value="AMEX">AMEX</option>
                </select>
              </label>}
              {providerSupportsFilter(activeProvider, assetClass, "price-range") && <>
                <label className="options-field"><span>Min price</span><input type="number" min="0" step="0.01" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} /></label>
                <label className="options-field"><span>Max price</span><input type="number" min="0" step="0.01" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label>
              </>}
              {providerSupportsFilter(activeProvider, assetClass, "trend") && <label className="options-field">
                <span>Daily trend</span>
                <select value={trend} onChange={(event) => setTrend(event.target.value)}>
                  <option value="all">All</option>
                  <option value="gainers">Gainers</option>
                  <option value="losers">Losers</option>
                </select>
              </label>}
            </>
          ) : (
            <>
              {providerSupportsFilter(activeProvider, assetClass, "contract-type") && <label className="options-field">
                <span>Contract type</span>
                <select value={contractType} onChange={(event) => setContractType(event.target.value)}>
                  <option value="BOTH">Calls &amp; puts</option>
                  <option value="CALL">Calls</option>
                  <option value="PUT">Puts</option>
                </select>
              </label>}
              {providerSupportsFilter(activeProvider, assetClass, "dte-range") && <>
                <label className="options-field"><span>Min DTE</span><input type="number" min="0" value={minDte} onChange={(event) => setMinDte(event.target.value)} /></label>
                <label className="options-field"><span>Max DTE</span><input type="number" min="0" value={maxDte} onChange={(event) => setMaxDte(event.target.value)} /></label>
              </>}
              {providerSupportsFilter(activeProvider, assetClass, "min-volume") && <label className="options-field"><span>Min volume</span><input type="number" min="0" value={minVolume} onChange={(event) => setMinVolume(event.target.value)} /></label>}
              {providerSupportsFilter(activeProvider, assetClass, "min-open-interest") && <label className="options-field"><span>Min open interest</span><input type="number" min="0" value={minOpenInterest} onChange={(event) => setMinOpenInterest(event.target.value)} /></label>}
              {providerSupportsFilter(activeProvider, assetClass, "max-spread") && <label className="options-field"><span>Max spread (%)</span><input type="number" min="0" step="0.1" value={maxSpreadPct} onChange={(event) => setMaxSpreadPct(event.target.value)} /></label>}
            </>
          )}
          {providerSupportsFilter(activeProvider, assetClass, "limit") && <label className="options-field"><span>Max results</span><input type="number" min="1" value={stockLimit} onChange={(event) => setStockLimit(event.target.value)} /></label>}
          <div className="options-form-footer">
            <button type="submit" disabled={loading || !endpoint}>{loading ? "Screening…" : `Run ${assetClass === "stocks" ? "stock" : "options"} screen`}</button>
          </div>
        </form>
      ) : (
        <p className="options-comparison-note">This instrument class is a registered extension point, but no provider adapter is connected yet.</p>
      )}

      {error && <div className="options-error" role="alert">{error}</div>}
      {summary && <div className="screener-results-header"><span>{summary}</span><span>{activeProvider?.label} · {activeEnv}</span></div>}
      {(rows.length > 0 || summary) && (
        rows.length === 0 ? <p className="empty-state">No results matched those filters.</p> : (
          <div className="options-table-scroll">
            <table className="options-comparison-table">
              <thead><tr>{Object.keys(rows[0]).map((key) => <th key={key}>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</th>)}</tr></thead>
              <tbody>{rows.map((row, index) => (
                <tr key={`${String(row.symbol || row.osiKey || row.contractSymbol || index)}:${index}`}>
                  {Object.values(row).map((value, column) => <td key={column}>{displayValue(value)}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )
      )}
      <p className="options-assumptions">
        Provider adapters declare the instrument classes and screening endpoint they support. Add a broker, market-data API, or MCP connector by registering its capabilities and mapping its response to the common result table; unsupported instrument classes are not silently routed to an unrelated feed.
      </p>
    </section>
  );
}
