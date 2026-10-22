import { useCallback, useEffect, useMemo, useState } from "react";
import { usePolling } from "./usePolling";
import { Skeleton, EmptyState } from "./components/ui";
import { apiFetch as fetch } from "./apiFetch";
import {
  getScreeningProviders,
  providerSupportsFilter,
  SCREENING_ASSET_CLASSES,
  type ScreeningAssetClass,
} from "./screeningAdapters";
import type { ScreenedStockItem } from "../types";
import { CapabilityNavBar, CopilotTriggerButton, type CapabilityTabItem } from "./components/CapabilityNavBar";
import { ScreenerResultsView } from "./ScreenerResultsView";
import "./optionsResearch.css";

interface ScreenersHubProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onStocksLoaded?: (rows: ScreenedStockItem[]) => void;
}

type ScreenRow = Record<string, unknown>;

// Issue #212: a persisted autonomous screener run.
// Issue #253: allStocks carries the full scanned set (not just standouts).
// Issue #261: trigger identifies the source for the unified UI.
// Issue #125: universe + partial mirror ScreenerRunResult so retained runs
// can be listed with their scope and status (see screenRunStatus).
interface ScreenRun {
  timestamp: string;
  pdfKey?: string;
  reportUrl?: string;
  trigger?: "manual" | "scheduled";
  universe?: string;
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols: string[];
    failureReasons: Record<string, number>;
  };
  opportunities: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
  }>;
  allStocks?: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
    rsi14: number | null;
    source: string;
  }>;
  error?: string;
}

// Issue #125: run status, derived from the fields ScreenerRunResult
// actually carries — a failed run has success:false (+ error); a partial
// run is a success that ran on an incomplete quote set (#462 qualification);
// anything else is a clean success. Quiet runs (success, zero standouts)
// are ordinary successes — they are history, not alerts.
export type ScreenRunStatus = "success" | "partial" | "failed";

export function screenRunStatus(run: Pick<ScreenRun, "success" | "partial">): ScreenRunStatus {
  if (!run.success) return "failed";
  if (run.partial) return "partial";
  return "success";
}

export const SCREEN_RUN_STATUS_LABELS: Record<ScreenRunStatus, string> = {
  success: "Success",
  partial: "Partial",
  failed: "Failed",
};

// Issue #125: the viewed run is tracked by timestamp so a polling refresh
// that prepends a newer run never silently re-points the view at a
// different run; a selection that has aged out of the retained history
// (or no selection yet) falls back to the latest run.
export function resolveSelectedRun<T extends { timestamp: string }>(
  runs: T[],
  selectedTimestamp: string | null,
): T | undefined {
  if (selectedTimestamp) {
    const found = runs.find((run) => run.timestamp === selectedTimestamp);
    if (found) return found;
  }
  return runs[0];
}

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
  // Issue #261: manual run result for the unified ScreenerResultsView.
  const [universe, setUniverse] = useState("TECH");
  const [sector, setSector] = useState("ALL");
  const [minScore, setMinScore] = useState("");
  const [shardedResults, setShardedResults] = useState<any[]>([]);
  const [manualResult, setManualResult] = useState<{
    timestamp: string;
    pdfKey?: string;
    reportUrl?: string;
    trigger: "manual" | "scheduled";
    sector: string;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: Array<{
      symbol: string;
      companyName: string;
      signal: string;
      momentumScore: number;
      lastPrice: number;
      changePercent: number;
    }>;
    allStocks: Array<{
      symbol: string;
      companyName: string;
      signal: string;
      momentumScore: number;
      lastPrice: number;
      changePercent: number;
      rsi14: number | null;
      source: string;
    }>;
    discoveryMessage?: string;
    pdfStatus?: "generated" | "failed" | "skipped";
    pdfError?: string;
    xlsxKey?: string;
    xlsxStatus?: "generated" | "failed" | "skipped";
    xlsxError?: string;
    xlsxUrl?: string;
  } | null>(null);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [discovery, setDiscovery] = useState<{
    mode?: string;
    candidateCount?: number;
    listingCount?: number;
    sourceCounts?: Record<string, number>;
    message?: string;
  } | null>(null);
  const [scannedAt, setScannedAt] = useState<string>("");
  // Issue #212: latest autonomous screener runs (from the 5-min schedule).
  const [autoRuns, setAutoRuns] = useState<ScreenRun[]>([]);
  const [autoLoading, setAutoLoading] = useState(true);
  // Issue #125: which retained run the results view shows (null = latest).
  const [selectedAutoTs, setSelectedAutoTs] = useState<string | null>(null);
  const selectedAutoRun = resolveSelectedRun(autoRuns, selectedAutoTs) ?? autoRuns[0];

  const loadAuto = useCallback(async () => {
    try {
      const res = await fetch("/api/screener/latest");
      if (!res.ok) return;
      const data = (await res.json()) as { runs?: unknown };
      if (Array.isArray(data.runs)) setAutoRuns(data.runs as ScreenRun[]);
    } catch {
      // Non-critical: panel stays empty.
    } finally {
      setAutoLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAuto();
  }, [loadAuto]);

  // Issue #329 (P1): 30 s -> 60 s, and paused entirely while the tab is hidden.
  usePolling(loadAuto, { fastMs: 60_000, idleMs: 60_000 });

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
    setManualResult(null);
    setSummary("");
    setDiscovery(null);
    try {
      const filters = {
        universe,
        ...(sector && sector !== "ALL" ? { sector } : {}),
        ...(minScore.trim() !== "" ? { minScore: Number(minScore) } : {}),
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
        opportunities?: Array<{
          symbol: string;
          companyName: string;
          signal: string;
          momentumScore: number;
          lastPrice: number;
          changePercent: number;
        }>;
        filterSummary?: string;
        discoveryMessage?: string;
        validationError?: string;
        totalScanned?: number;
        matchedCount?: number;
        discovery?: {
          mode?: string;
          candidateCount?: number;
          listingCount?: number;
          sourceCounts?: Record<string, number>;
          message?: string;
        };
        scannedAt?: string;
        pdfKey?: string;
        reportUrl?: string;
      };

      if (!response.ok) throw new Error(data.error || `Screening request failed [HTTP ${response.status}].`);
      if (data.validationError) throw new Error(data.validationError);

      // Issue #261: manual results feed the unified ScreenerResultsView.
      // Issue #270: sharded ALL results render per-universe sections.
      const mapRow = (s: any) => ({
        symbol: s.symbol,
        companyName: s.companyName || s.symbol,
        signal: s.signal || "unknown",
        momentumScore: s.momentumScore ?? 0,
        lastPrice: s.lastPrice ?? 0,
        changePercent: s.changePercent ?? 0,
        rsi14: s.rsi14 ?? null,
        source: s.source || "E*TRADE live",
        indicators: s.indicators,
        factorGrades: s.factorGrades,
        technicals: s.technicals,
      });
      if ((data as any).sharded) {
        const shards = (data as any).universes || [];
        setShardedResults(
          shards.map((u: any) => ({
            universe: u.universe,
            timestamp: u.scannedAt || new Date().toISOString(),
            pdfKey: u.pdfKey,
            reportUrl: u.reportUrl,
            trigger: "manual" as const,
            sector: "Technology",
            success: u.success,
            totalScanned: u.totalScanned ?? 0,
            matchedCount: u.matchedCount ?? 0,
            opportunities: (u.opportunities ?? []).map(mapRow),
            allStocks: (u.stocks ?? []).map(mapRow),
            discoveryMessage: u.discoveryMessage,
          }))
        );
        setManualResult(null);
        setSummary(`${shards.length} universes screened in parallel`);
        setScannedAt(new Date().toLocaleTimeString());
        return;
      }
      setShardedResults([]);
      const stockResults = data.stocks || [];
      setManualResult({
        timestamp: data.scannedAt || new Date().toISOString(),
        pdfKey: data.pdfKey,
        reportUrl: data.reportUrl,
        trigger: "manual",
        sector: "Technology",
        success: true,
        totalScanned: data.totalScanned ?? stockResults.length,
        matchedCount: data.matchedCount ?? stockResults.length,
        opportunities: (data.opportunities ?? []).map(mapRow),
        allStocks: stockResults.map(mapRow),
        discoveryMessage: data.discoveryMessage,
      });
      setRows(stockResults.map((row) => Object.fromEntries(Object.entries(row))));
      setSummary(data.filterSummary || `${data.totalScanned ?? 0} scanned · ${data.matchedCount ?? stockResults.length} matched`);
      setDiscovery(data.discovery || null);
      setScannedAt(data.scannedAt || new Date().toLocaleTimeString());
      onStocksLoaded?.(stockResults);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screening request failed.");
    } finally {
      setLoading(false);
    }
  };

  const screenerTabs: CapabilityTabItem[] = useMemo(() => {
    const descriptions: Record<string, { eyebrow: string; title: string; desc: string; icon: string }> = {
      stocks: {
        eyebrow: "EQUITIES SCREENING",
        title: "Stock Universe Screener",
        desc: "Screen common stocks and ETFs by price, volume, exchange, and trend.",
        icon: "📈",
      },
      options: {
        eyebrow: "DERIVATIVES · CONSOLIDATED",
        title: "Options · Auto Options Research",
        desc: "All options capabilities, raw contracts screening, and strategy discovery are in the dedicated Auto Options Research tab.",
        icon: "⚡",
      },
      forex: {
        eyebrow: "CURRENCY PAIRS",
        title: "Forex Screener · Planned",
        desc: "Screen foreign exchange pairs across global FX liquidity pools (adapter in development).",
        icon: "💱",
      },
      futures: {
        eyebrow: "COMMODITY & INDEX FUTURES",
        title: "Futures Screener · Planned",
        desc: "Screen E-mini index futures, energy, metals, and treasury contracts (adapter in development).",
        icon: "📊",
      },
      commodities: {
        eyebrow: "COMMODITY BENCHMARKS",
        title: "Commodities Screener · Planned",
        desc: "Screen physical commodity and spot contracts (adapter in development).",
        icon: "🛢️",
      },
      bonds: {
        eyebrow: "FIXED INCOME",
        title: "Bonds & Yields · Planned",
        desc: "Screen US Treasuries, corporate bonds, and yield curve spreads (adapter in development).",
        icon: "🏛️",
      },
    };

    return SCREENING_ASSET_CLASSES.map((asset) => {
      const info = descriptions[asset.id] || {
        eyebrow: "MARKET SCREENER",
        title: asset.label,
        desc: `Screen ${asset.label.toLowerCase()} across connected market data providers.`,
        icon: "🔍",
      };

      return {
        id: asset.id,
        label: asset.label,
        icon: info.icon,
        badge: asset.available ? (asset.id === "stocks" ? "LIVE" : undefined) : "PLANNED",
        badgeType: asset.available ? (asset.id === "stocks" ? "live" : "default") : "amber",
        tooltip: {
          eyebrow: info.eyebrow,
          title: info.title,
          description: info.desc,
        },
      };
    });
  }, []);

  return (
    <section className="trading-section screeners-hub">
      <CapabilityNavBar
        ariaLabel="Instrument class capabilities"
        tabs={screenerTabs}
        activeTabId={assetClass}
        onTabChange={(id) => setAssetClass(id as ScreeningAssetClass)}
        rightContent={
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
            <CopilotTriggerButton label="✨ Ask Copilot" />
            {scannedAt && (
              <span>
                Last scan: <strong style={{ color: "var(--color-text-primary)" }}>{scannedAt}</strong>
              </span>
            )}
            {rows.length > 0 && (
              <span
                style={{
                  padding: "0.15rem 0.5rem",
                  borderRadius: "4px",
                  background: "var(--color-card)",
                  border: "1px solid var(--color-border-subtle)",
                  fontWeight: 600,
                  color: "var(--color-accent)",
                }}
              >
                {rows.length} matched
              </span>
            )}
          </div>
        }
      />

      {assetClass === "stocks" ? (
        <>
          {/* Issue #212: autonomous screener panel — latest scheduled runs. */}
          <div className="screener-feed-callout" style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
              <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>🤖 Autonomous Screen</span>
              <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                Runs every 5 min via the scheduled job — latest results below (refreshes automatically).
              </span>
            </div>
            {autoLoading ? (
              <div role="status" aria-label="Loading latest autonomous run">
                <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>Loading latest autonomous run…</div>
                <Skeleton lines={3} />
              </div>
            ) : autoRuns.length === 0 ? (
              <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
                No autonomous runs recorded yet. The next 5-minute tick will populate this panel.
              </div>
            ) : (
              <>
                {/* Issue #830: grouped jobs + data panel.
                    Jobs are grouped by universe in scrollable panels.
                    Selecting a job shows its latest run data below. */}
                <div
                  aria-label="Scheduled jobs by universe"
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    overflowX: "auto",
                    paddingBottom: "0.5rem",
                    marginBottom: "0.75rem",
                  }}
                >
                  {Object.entries(
                    autoRuns.reduce((groups, run) => {
                      const universe = run.universe || "nasdaq100";
                      if (!groups[universe]) groups[universe] = [];
                      groups[universe].push(run);
                      return groups;
                    }, {} as Record<string, typeof autoRuns>)
                  ).map(([universe, runs]) => {
                    const latest = runs[0];
                    const status = screenRunStatus(latest);
                    const isSelected = selectedAutoRun?.universe === universe ||
                      (selectedAutoRun && runs.some(r => r.timestamp === selectedAutoRun.timestamp));
                    return (
                      <button
                        key={universe}
                        type="button"
                        onClick={() => setSelectedAutoTs(latest.timestamp)}
                        aria-pressed={isSelected}
                        style={{
                          minWidth: "220px",
                          flex: "0 0 auto",
                          textAlign: "left",
                          padding: "0.75rem",
                          borderRadius: "8px",
                          border: isSelected
                            ? "2px solid var(--color-accent)"
                            : "1px solid var(--color-border-subtle)",
                          background: "var(--color-surface)",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: "0.25rem", color: "var(--color-text-primary)" }}>
                          {universe.toUpperCase()}
                        </div>
                        <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.25rem" }}>
                          Every 5 min · {runs.length} run{runs.length !== 1 ? "s" : ""} retained
                        </div>
                        <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                          Last: {new Date(latest.timestamp).toLocaleTimeString()} · {latest.totalScanned || 0} scanned · {latest.matchedCount || 0} matched
                        </div>
                        <div style={{
                          display: "inline-block",
                          marginTop: "0.35rem",
                          padding: "0.15rem 0.5rem",
                          borderRadius: "12px",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          ...(status === "success"
                            ? { background: "var(--color-success-subtle)", color: "var(--color-success)", border: "1px solid var(--color-success)" }
                            : status === "partial"
                            ? { background: "var(--color-warning-subtle)", color: "var(--color-warning)", border: "1px solid var(--color-warning)" }
                            : { background: "var(--color-danger-subtle)", color: "var(--color-danger)", border: "1px solid var(--color-danger)" }),
                        }}>
                          {status === "success" ? "✓ Complete" : status === "partial" ? "◐ Partial" : "✗ Failed"}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {/* Issue #125: per-run history — every retained run is
                    selectable (newest first), across universes. Selecting a
                    run swaps the results view + PDF + exports below to that
                    run. The grouped universe cards above are a #830 shortcut
                    to each universe's latest run; this list is the full
                    history. */}
                <div
                  aria-label="Autonomous run history"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.35rem",
                    marginBottom: "0.75rem",
                  }}
                >
                  {autoRuns.map((run) => {
                    const status = screenRunStatus(run);
                    const isSelected = selectedAutoRun?.timestamp === run.timestamp;
                    const oppCount = run.opportunities?.length ?? 0;
                    return (
                      <button
                        key={run.timestamp}
                        type="button"
                        className="screener-run-item"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedAutoTs(run.timestamp)}
                        style={{
                          textAlign: "left",
                          padding: "0.5rem 0.75rem",
                          borderRadius: "6px",
                          border: isSelected
                            ? "2px solid var(--color-accent)"
                            : "1px solid var(--color-border-subtle)",
                          background: "var(--color-surface)",
                          cursor: "pointer",
                          fontSize: "0.8rem",
                          color: "var(--color-text-primary)",
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>
                          {new Date(run.timestamp).toLocaleString()}
                        </span>
                        {" · "}
                        {(run.universe || "nasdaq100").toUpperCase()}
                        {run.sector && run.sector !== "ALL" ? ` · ${run.sector} sector` : ""}
                        {" · "}
                        {run.totalScanned ?? 0} scanned · {run.matchedCount ?? 0} matched · {oppCount} standout
                        {" "}
                        <span className="screener-run-status" style={{ fontWeight: 700 }}>
                          {SCREEN_RUN_STATUS_LABELS[status]}
                        </span>
                        {" · "}
                        <span>{isSelected ? "Viewing" : "View"}</span>
                      </button>
                    );
                  })}
                </div>
                {/* Data panel for selected job */}
                <div
                  aria-label="Selected job run data"
                  style={{
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: "8px",
                    padding: "1rem",
                    background: "var(--color-surface)",
                    marginBottom: "0.75rem",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: "0.5rem", color: "var(--color-text-primary)" }}>
                    {(selectedAutoRun?.universe || "nasdaq100").toUpperCase()} · {selectedAutoRun ? new Date(selectedAutoRun.timestamp).toLocaleString() : "—"}
                  </div>
                  <ScreenerResultsView
                    result={{ ...selectedAutoRun, trigger: selectedAutoRun.trigger ?? "scheduled" }}
                  />
                </div>
              </>
            )}
          </div>
          <form className="options-request-form screeners-filter-form" onSubmit={(event) => void runScreen(event)}>
            <label className="options-field">
              <span>Data provider / API</span>
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select>
            </label>

            <div className="screener-feed-callout">
              {providerId === "etrade" ? (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>📡 Live Feed Source:</span>
                    <span className="screener-feed-name" style={{ fontWeight: 600 }}>
                      E*TRADE REST API — live quotes only (<code>api.etrade.com</code>)
                    </span>
                    <span style={{
                      padding: "0.15rem 0.55rem",
                      borderRadius: "9999px",
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      background: "var(--color-success-subtle)",
                      color: "var(--color-success)",
                      border: "1px solid var(--color-success)",
                    }}>
                      ● LIVE REST API
                    </span>
                  </div>
                  <div className="screener-feed-meta" style={{ fontSize: "0.76rem" }}>
                    • <strong>Coverage:</strong> E*TRADE live quotes ({activeEnv}) &middot; <strong>Policy:</strong> E*TRADE-only — if unavailable, the screen fails honestly. No fallback data substituted.
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>📡 Live Feed Source:</span>
                    <span className="screener-feed-name" style={{ fontWeight: 600 }}>
                      Yahoo Finance FOSS Engine (<code>query1.finance.yahoo.com</code>)
                    </span>
                    <span style={{
                      padding: "0.15rem 0.55rem",
                      borderRadius: "9999px",
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      background: "var(--color-accent-subtle)",
                      color: "var(--color-accent)",
                      border: "1px solid var(--color-border-focus)",
                    }}>
                      ● LIVE FOSS ENGINE
                    </span>
                  </div>
                  <div className="screener-feed-meta" style={{ fontSize: "0.76rem" }}>
                    • <strong>Coverage:</strong> Free &amp; Open Source fundamental ratios, trailing/forward P/E, PEG, and analyst price targets (no broker credentials required).
                  </div>
                </div>
              )}
            </div>
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
            <label className="options-field">
              <span>Universe</span>
              <select value={universe} onChange={(event) => setUniverse(event.target.value)} title="Index/ETF universe to screen">
                <option value="TECH">Technology (discovery)</option>
                <option value="NASDAQ100">Nasdaq-100</option>
                <option value="SP100">S&P 100</option>
                <option value="SP500">S&P 500</option>
                <option value="RUSSELL2000">Russell 2000</option>
                <option value="ETF">ETFs</option>
                <option value="LEV_ETF">Leveraged ETFs</option>
                <option value="ALL">All (auto-sharded, parallel)</option>
              </select>
            </label>
            <label className="options-field">
              <span>Sector</span>
              <select value={sector} onChange={(event) => setSector(event.target.value)} title="Industry sector filter">
                <option value="ALL">All Sectors</option>
                <option value="Technology">Technology</option>
                <option value="Semiconductors">Semiconductors</option>
                <option value="Financial">Financial / Banking</option>
                <option value="Healthcare">Healthcare / Biotech</option>
                <option value="Consumer Discretionary">Consumer Discretionary</option>
                <option value="Communication Services">Communication Services</option>
                <option value="Energy">Energy</option>
                <option value="Industrials">Industrials</option>
              </select>
            </label>
            <label className="options-field">
              <span>Min Score (0–100)</span>
              <input
                type="number"
                min="0"
                max="100"
                value={minScore}
                onChange={(event) => setMinScore(event.target.value)}
                placeholder="Optional; e.g. 50"
              />
            </label>
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
          {/* Issue #261: manual results use the same ScreenerResultsView as autonomous. */}
          {manualResult && <ScreenerResultsView result={manualResult} />}
          {shardedResults.length > 0 && shardedResults.map((r) => (
            <div key={r.universe} style={{ marginTop: "1.5rem" }}>
              <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>🌐 {r.universe}</h3>
              <ScreenerResultsView result={r} />
            </div>
          ))}
          {!manualResult && summary && <div className="screener-results-header"><span>{summary}</span><span>{activeProvider?.label} · {activeEnv}</span></div>}
          {!manualResult && (rows.length > 0 || summary) && (
            rows.length === 0 ? <EmptyState title="No results matched those filters." /> : (
              <div className="options-table-scroll">
                <div style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.6rem",
                  padding: "0.85rem 1rem",
                  background: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: "8px",
                  marginBottom: "1rem",
                  fontSize: "0.82rem",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                      <span style={{ color: "var(--color-accent)", fontWeight: 700, fontSize: "0.9rem" }}>📡 Feed Source &amp; Data Provenance</span>
                      <span style={{
                        padding: "0.2rem 0.6rem",
                        borderRadius: "4px",
                        fontSize: "0.72rem",
                        fontWeight: 700,
                        background: String(rows[0]?.source || "").includes("Curated") ? "var(--color-warning-subtle)" : "var(--color-success-subtle)",
                        color: String(rows[0]?.source || "").includes("Curated") ? "var(--color-warning)" : "var(--color-success)",
                        border: `1px solid ${String(rows[0]?.source || "").includes("Curated") ? "var(--color-warning)" : "var(--color-success)"}`,
                      }}>
                        {String(rows[0]?.source || "").includes("Curated") ? "📂 OFFLINE STATIC SNAPSHOT" : "🌐 LIVE REST API FEED (api.nasdaq.com)"}
                      </span>
                    </div>
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.76rem" }}>
                      Scanned at: <strong style={{ color: "var(--color-text-primary)" }}>{scannedAt || "Just now"}</strong> • Scope: <strong style={{ color: "var(--color-accent)" }}>{exchange} Listings</strong>
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.5rem", padding: "0.5rem 0.75rem", background: "var(--color-card)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-sm)" }}>
                    <div>
                      <span style={{ color: "var(--color-text-muted)", display: "block", fontSize: "0.72rem" }}>UPSTREAM API ENDPOINT</span>
                      <span style={{ color: "var(--color-text-primary)", fontWeight: 600, fontSize: "0.78rem" }}>
                        {String(rows[0]?.source || "").includes("Yahoo")
                          ? "query1.finance.yahoo.com/v8/finance/chart"
                          : String(rows[0]?.source || "").includes("Curated")
                          ? "src/config/curatedStockUniverse.json (Offline Fallback)"
                          : "https://api.nasdaq.com/api/screener/stocks"}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-muted)", display: "block", fontSize: "0.72rem" }}>EXCHANGE UNIVERSE LOADED</span>
                      <span style={{ color: "var(--color-text-primary)", fontWeight: 600, fontSize: "0.78rem" }}>
                        {discovery?.sourceCounts ? (
                          `Nasdaq: ${discovery.sourceCounts.nasdaq?.toLocaleString() || 0} • NYSE: ${discovery.sourceCounts.nyse?.toLocaleString() || 0} • AMEX: ${discovery.sourceCounts.amex?.toLocaleString() || 0}`
                        ) : (
                          `Live multi-exchange coverage (~8,000 listings across Nasdaq, NYSE, AMEX)`
                        )}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-muted)", display: "block", fontSize: "0.72rem" }}>EXECUTION BROKER</span>
                      <span style={{ color: "var(--color-accent)", fontWeight: 600, fontSize: "0.78rem" }}>
                        E*TRADE REST API · {activeEnv} (Orders &amp; Previews)
                      </span>
                    </div>
                  </div>

                  {discovery?.message && (
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", fontStyle: "italic" }}>
                      ℹ️ {discovery.message}
                    </div>
                  )}
                </div>

                <table className="options-comparison-table">
                  <thead><tr>{Object.keys(rows[0]).map((key) => <th key={key}>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</th>)}</tr></thead>
                  <tbody>{rows.map((row, index) => (
                    <tr key={`${String(row.symbol || index)}:${index}`}>
                      {Object.entries(row).map(([key, value], column) => (
                        <td key={column}>
                          {key === "source" ? (
                            <span style={{
                              display: "inline-block",
                              padding: "0.15rem 0.45rem",
                              borderRadius: "4px",
                              fontSize: "0.72rem",
                              fontWeight: 600,
                              background: String(value).includes("Curated") ? "var(--color-warning-subtle)" : "var(--color-accent-subtle)",
                              color: String(value).includes("Curated") ? "var(--color-warning)" : "var(--color-accent)",
                              border: `1px solid ${String(value).includes("Curated") ? "var(--color-warning)" : "var(--color-border-focus)"}`,
                            }}>
                              {String(value)}
                            </span>
                          ) : key === "validationStatus" ? (
                            <span style={{
                              display: "inline-block",
                              padding: "0.15rem 0.45rem",
                              borderRadius: "4px",
                              fontSize: "0.72rem",
                              fontWeight: 600,
                              background: value === "PASS_CONFIRMED" ? "var(--color-success-subtle)" : "var(--color-danger-subtle)",
                              color: value === "PASS_CONFIRMED" ? "var(--color-success)" : "var(--color-danger)",
                              border: `1px solid ${value === "PASS_CONFIRMED" ? "var(--color-success)" : "var(--color-danger)"}`,
                            }}>
                              {String(value)}
                            </span>
                          ) : (
                            displayValue(value)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )
          )}
        </>
      ) : assetClass === "options" ? (
        <div className="options-comparison-note" style={{ margin: "1.5rem 0", padding: "1.5rem", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px" }}>
          <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-accent)", fontSize: "1.05rem" }}>⚡ Options Capabilities Moved to Auto Options Research</h4>
          <p style={{ margin: "0 0 0.75rem", color: "var(--color-text-secondary)", fontSize: "0.92rem", lineHeight: 1.5 }}>
            All options screening, analysis, and execution tools—including the <strong>📋 Raw Contracts Screener</strong>, <strong>🎯 Strategy Discovery &amp; Payoff Analyzer</strong>, <strong>⚙️ Custom Thesis Universe</strong>, <strong>💬 Natural Language Screen (NLQ)</strong>, and <strong>⏰ Scheduled Options Schedulers</strong>—are now centralized under the <strong>Auto Options Research</strong> tab.
          </p>
          <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "0.85rem" }}>
            The Options tab in this Multi-Asset Screener is marked as planned to keep this screener focused on equities and future multi-asset feeds without duplication.
          </p>
        </div>
      ) : (
        <div className="options-comparison-note" style={{ margin: "1.5rem 0", padding: "1.5rem", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px" }}>
          <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-text-muted)", fontSize: "1.05rem" }}>🚧 {SCREENING_ASSET_CLASSES.find((a) => a.id === assetClass)?.label || "Asset"} Screener · Planned</h4>
          <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
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
