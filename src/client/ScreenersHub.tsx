import { useEffect, useMemo, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import {
  getScreeningProviders,
  providerSupportsFilter,
  SCREENING_ASSET_CLASSES,
  type ScreeningAssetClass,
} from "./screeningAdapters";
import type { ScreenedStockItem } from "../types";
import { buildPaymentSignature, describeChallenge, sendUsdcPayment, type PaidTransfer, type X402Challenge } from "./x402Pay";
import "./optionsResearch.css";

const PAID_OPTIONS_ENDPOINT = "/api/premium/options-scan";

interface PendingPayment {
  challenge: X402Challenge;
  filters: Record<string, unknown>;
  paid?: PaidTransfer;
}

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
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [payStatus, setPayStatus] = useState("");

  useEffect(() => {
    if (!providers.some((provider) => provider.id === providerId)) {
      setProviderId(providers[0]?.id || "");
    }
  }, [providers, providerId]);

  const activeProvider = providers.find((provider) => provider.id === providerId);
  const endpoint = activeProvider?.endpointByAssetClass[assetClass];

  const callScreen = async (filters: Record<string, unknown>, paymentSignature?: string) => {
    const paid = assetClass === "options";
    const response = await fetch(paid ? PAID_OPTIONS_ENDPOINT : endpoint!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-environment": activeEnv,
        ...(userLogin ? { "x-user-login": userLogin } : {}),
        ...(paymentSignature ? { "PAYMENT-SIGNATURE": paymentSignature } : {}),
      },
      body: JSON.stringify(filters),
    });
    const body = await response.json() as Record<string, any>;
    if (paid && response.status === 402) {
      const challenge = body.protocols?.x402?.challenge as X402Challenge | undefined;
      if (!challenge) throw new Error(body.error || "Payment required, but no payment challenge was returned.");
      return { challenge, reason: paymentSignature ? (body.reason as string | undefined) : undefined, retryable: /not yet visible/i.test(String(body.reason || "")) };
    }
    const data = (paid ? body.screenResult ?? body : body) as {
      error?: string;
      stocks?: ScreenedStockItem[];
      contracts?: ScreenRow[];
      filterSummary?: string;
      validationError?: string;
      totalScanned?: number;
      totalContractsEvaluated?: number;
      matchedCount?: number;
    };
    if (!response.ok) throw new Error(body.error || data.error || `Screening request failed [HTTP ${response.status}].`);
    if (data.validationError) throw new Error(data.validationError);
    const results = assetClass === "stocks" ? data.stocks || [] : data.contracts || [];
    setRows(results.map((row) => Object.fromEntries(Object.entries(row))));
    setSummary(data.filterSummary || `${data.totalScanned ?? data.totalContractsEvaluated ?? 0} scanned · ${data.matchedCount ?? results.length} matched`);
    if (assetClass === "stocks") onStocksLoaded?.(data.stocks || []);
    setPending(null);
    return null;
  };

  const payAndRun = async () => {
    if (!pending || loading) return;
    setLoading(true);
    setError("");
    try {
      let current = pending;
      for (let attempt = 0; attempt < 5; attempt++) {
        const paid = current.paid ?? await sendUsdcPayment(current.challenge, setPayStatus);
        current = { ...current, paid };
        setPending(current);
        setPayStatus("Verifying payment…");
        const signature = await buildPaymentSignature(current.challenge, paid);
        const outcome = await callScreen(current.filters, signature);
        if (!outcome) return;
        if (!outcome.retryable) throw new Error(outcome.reason || "Payment could not be verified.");
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      throw new Error("Payment sent but not yet visible to the server. Press the button again to retry; you will not be charged twice.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment failed.");
    } finally {
      setLoading(false);
      setPayStatus("");
    }
  };

  const runScreen = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!endpoint || loading) return;
    setLoading(true);
    setError("");
    setRows([]);
    setSummary("");
    setPending(null);
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

      const outcome = await callScreen(filters);
      if (outcome) setPending({ challenge: outcome.challenge, filters });
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

      {pending && (
        <div className="options-error" role="status">
          <p>
            <strong>Payment required.</strong> The options screener costs ${pending.challenge.amount.toFixed(2)} {describeChallenge(pending.challenge).label}.
            {pending.paid ? " Your payment was sent; retry verification below." : " You will be asked to confirm the transfer in your wallet."}
          </p>
          <p>Recipient: <code>{pending.challenge.recipient}</code></p>
          <button type="button" disabled={loading} onClick={() => void payAndRun()}>
            {loading ? payStatus || "Working…" : pending.paid ? "Retry verification" : `Pay $${pending.challenge.amount.toFixed(2)} & run screen`}
          </button>
        </div>
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
