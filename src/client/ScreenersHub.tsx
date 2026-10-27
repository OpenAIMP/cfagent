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
import {
  StockCriteriaPanel,
  defaultStockCriteria,
  stockCriteriaToFilter,
  type StockCriteriaState,
} from "./StockCriteriaPanel";
import { ScreenerPresetManager } from "./ScreenerPresetManager";
import { CapabilityNavBar, CopilotTriggerButton, type CapabilityTabItem } from "./components/CapabilityNavBar";
import { ScreenerResultsView, type ScreenerResultData } from "./ScreenerResultsView";
import { RunDetailView, type RunDetailConfirmation } from "./RunDetailView";
import { MorningDigest } from "./MorningDigest";
import { ScannerPanel } from "./ScannerPanel";
import { GoalScreenPanel } from "./GoalScreenPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { IvHistoryPanel } from "./IvHistoryPanel";
import { ReportsPanel } from "./ReportsPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { ScreeningReviewPanel } from "./ScreeningReviewPanel";
import { ScreeningOutcomesPanel } from "./ScreeningOutcomesPanel";
import { CalibrationDashboard } from "./CalibrationDashboard";
import { EnrichmentDashboard } from "./EnrichmentDashboard";
import { OptionsResearchHost } from "./options/OptionsResearchHost";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import "./optionsResearch.css";

/** S8 (consolidation, umbrella #958): the hub's tabs — the screening
 *  asset classes plus the folded Strategy/Symbol Scanner and IV
 *  History surfaces (formerly Trading Hub subtabs).
 *  C1 (consolidation #1151, issue #1201): the Goal Screen tab — the
 *  #1096 unified stack's surface (goal-driven screens + backtest).
 *  C2 (consolidation #1151, issue #1246): Reports and Schedules move
 *  INTO the hub as tabs (they were standalone nav entries), and the
 *  hub gains the proposal Review inbox and the recommendation Track
 *  Record — the #1096 surfaces users could not reach before. */
export type ScreenersHubTab =
  | ScreeningAssetClass
  | "scanner"
  | "iv-history"
  | "goal-screen"
  | "reports"
  | "schedules"
  | "review"
  | "track-record";

export const SCREENER_HUB_TABS: readonly ScreenersHubTab[] = [
  "stocks",
  "options",
  "forex",
  "futures",
  "commodities",
  "bonds",
  "scanner",
  "iv-history",
  "goal-screen",
  "reports",
  "schedules",
  "review",
  "track-record",
] as const;

export function isValidScreenerTab(tab: unknown): tab is ScreenersHubTab {
  return typeof tab === "string" && (SCREENER_HUB_TABS as readonly string[]).includes(tab);
}

export function parseScreenerTabFromUrl(urlStr?: string): ScreenersHubTab | null {
  try {
    const targetUrl = urlStr
      ? new URL(urlStr, "http://localhost")
      : typeof window !== "undefined"
      ? new URL(window.location.href)
      : null;
    if (!targetUrl) return null;

    const param = targetUrl.searchParams.get("screenerTab") || targetUrl.searchParams.get("tab");
    if (param && isValidScreenerTab(param)) {
      return param;
    }

    const hash = targetUrl.hash.replace(/^#/, "");
    if (hash) {
      if (isValidScreenerTab(hash)) {
        return hash;
      }
      const hashParams = new URLSearchParams(hash);
      const hashTab = hashParams.get("screenerTab") || hashParams.get("tab");
      if (hashTab && isValidScreenerTab(hashTab)) {
        return hashTab;
      }
    }
  } catch {
    // Malformed URL, ignore
  }
  return null;
}

interface ScreenersHubProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onStocksLoaded?: (rows: ScreenedStockItem[]) => void;
  /** S8: the trade-preview handoff threaded into the folded panels —
   *  the Trading Hub passes its order-ticket handler, exactly as it
   *  did when the panels were its own subtabs. */
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onJobStateChange?: (state: "idle" | "running" | "ready") => void;
  /** S8: the tab to open on — the Trading Hub's screening redirects
   *  deep-link into the hub with the folded surface's tab. */
  initialTab?: ScreenersHubTab;
  onTabChange?: (tab: ScreenersHubTab) => void;
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
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
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

export function ScreenersHub({
  activeEnv,
  userLogin,
  onStocksLoaded,
  onPreviewTrade,
  onSendPrompt,
  onJobStateChange,
  initialTab,
  onTabChange,
}: ScreenersHubProps) {
  // Reference tabbed browsing: URL priority (query > hash > prop > fallback)
  const initialResolvedTab = useMemo<ScreenersHubTab>(() => {
    const fromUrl = parseScreenerTabFromUrl();
    if (fromUrl) return fromUrl;
    if (initialTab && isValidScreenerTab(initialTab)) return initialTab;
    return "stocks";
  }, [initialTab]);

  const [hubTab, setHubTab] = useState<ScreenersHubTab>(initialResolvedTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<ScreenersHubTab>>(
    () => new Set([initialResolvedTab]),
  );

  useEffect(() => {
    if (initialTab && isValidScreenerTab(initialTab) && initialTab !== hubTab) {
      setHubTab(initialTab);
      setVisitedTabs((prev) => new Set(prev).add(initialTab));
    }
  }, [initialTab]);

  const handleTabChange = useCallback(
    (newTabId: string) => {
      if (!isValidScreenerTab(newTabId)) return;
      setHubTab(newTabId);
      setVisitedTabs((prev) => new Set(prev).add(newTabId));
      onTabChange?.(newTabId);

      if (typeof window !== "undefined" && window.history) {
        try {
          const url = new URL(window.location.href);
          if (url.searchParams.get("screenerTab") !== newTabId) {
            url.searchParams.set("screenerTab", newTabId);
            window.history.pushState({ screenerTab: newTabId }, "", url.toString());
          }
        } catch {
          // Safe fallback for environments with restricted history
        }
      }
    },
    [onTabChange],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePopState = () => {
      const tabFromUrl = parseScreenerTabFromUrl();
      if (tabFromUrl && tabFromUrl !== hubTab) {
        setHubTab(tabFromUrl);
        setVisitedTabs((prev) => new Set(prev).add(tabFromUrl));
        onTabChange?.(tabFromUrl);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [hubTab, onTabChange]);

  // The provider-adapter machinery below serves the asset classes;
  // the folded scanner / iv-history tabs have no adapter, so they
  // borrow "stocks" for the (unused) provider lookups.
  const assetClass: ScreeningAssetClass =
    hubTab === "scanner" ||
    hubTab === "iv-history" ||
    hubTab === "goal-screen" ||
    hubTab === "reports" ||
    hubTab === "schedules" ||
    hubTab === "review" ||
    hubTab === "track-record"
      ? "stocks"
      : hubTab;
  const providers = useMemo(() => getScreeningProviders(assetClass), [assetClass]);
  const [providerId, setProviderId] = useState("etrade");
  const [symbolSearch, setSymbolSearch] = useState("");
  const [stockLimit, setStockLimit] = useState("100");
  const [exchange, setExchange] = useState("ALL");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [trend, setTrend] = useState("all");
  // Issue #1496 (#940-B): stock criteria panel state. All toggles default
  // off, so existing run behavior is unchanged until the user opts in.
  const [stockCriteria, setStockCriteria] = useState<StockCriteriaState>(defaultStockCriteria);
  // Run request object sent with the last stock run, for the panel's view.
  // (The request body, not just the filter: it also carries universe and
  // minScore, and exchange as a plain string — hence Record, not
  // StockScreenerFilter. The panel reads only its seven managed keys.)
  const [lastSentStockFilters, setLastSentStockFilters] = useState<Record<string, unknown> | null>(null);
  const [rows, setRows] = useState<ScreenRow[]>([]);
  // Issue #261: manual run result for the unified ScreenerResultsView.
  const [universe, setUniverse] = useState("TECH");
  const [sector, setSector] = useState("ALL");
  const [minScore, setMinScore] = useState("");
  const [shardedResults, setShardedResults] = useState<any[]>([]);
  const [manualResult, setManualResult] = useState<ScreenerResultData | null>(null);
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

  // Issue #1326: delivery confirmations for the selected run, joined
  // exactly server-side via its canonical row (run_id =
  // `screener:<timestamp>`). Re-fetched whenever the selection changes.
  const [runConfirmations, setRunConfirmations] = useState<RunDetailConfirmation[]>([]);
  const [runConfirmationsLoading, setRunConfirmationsLoading] = useState(false);
  useEffect(() => {
    const ts = selectedAutoRun?.timestamp;
    if (!ts) {
      setRunConfirmations([]);
      return;
    }
    let cancelled = false;
    setRunConfirmationsLoading(true);
    fetch(`/api/trading/reports/confirmations?runId=${encodeURIComponent(`screener:${ts}`)}`)
      .then((res) => (res.ok ? res.json() : { confirmations: [] }))
      .then((data: unknown) => {
        const list = (data as { confirmations?: unknown } | null)?.confirmations;
        if (!cancelled) setRunConfirmations(Array.isArray(list) ? (list as RunDetailConfirmation[]) : []);
      })
      .catch(() => {
        if (!cancelled) setRunConfirmations([]);
      })
      .finally(() => {
        if (!cancelled) setRunConfirmationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAutoRun?.timestamp]);

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
        // Issue #1496 (#940-B): enabled panel criteria only; a toggled-off
        // criterion is absent, never sent as a null/zero the engine would
        // misread. All seven fields genuinely filter on the manual path
        // (evaluateUniverse), on both providers.
        ...stockCriteriaToFilter(stockCriteria),
      };
      setLastSentStockFilters(filters);

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
        pdfStatus: (data as any).pdfStatus,
        pdfError: (data as any).pdfError,
        reportUrl: data.reportUrl,
        xlsxKey: (data as any).xlsxKey,
        xlsxStatus: (data as any).xlsxStatus,
        xlsxUrl: (data as any).xlsxUrl,
        quoteTrace: (data as any).quoteTrace,
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
      void loadAuto();
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
        eyebrow: "DERIVATIVES SCREENING",
        title: "Options Research",
        desc: "Strategy discovery, the raw contracts screener, custom thesis scans, NLQ, and the LLM idea experiment — the full options research surface, hosted here.",
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

    const assetTabs: CapabilityTabItem[] = SCREENING_ASSET_CLASSES.map((asset) => {
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

    // S8: the folded surfaces ride the same tab bar, right after
    // Options — the Strategy/Symbol Scanner and IV History, formerly
    // Trading Hub subtabs.
    const optionsIndex = assetTabs.findIndex((tab) => tab.id === "options");
    assetTabs.splice(optionsIndex + 1, 0,
      {
        id: "scanner",
        label: "Strategy Scanner",
        icon: "🎯",
        badge: "AI",
        badgeType: "purple",
        tooltip: {
          eyebrow: "STRATEGY / SYMBOL SCANNING",
          title: "Strategy/Symbol Scanner",
          description: "Best strategy for a name, or names that fit your strategy — across the full strategy catalog.",
        },
      },
      {
        id: "iv-history",
        label: "IV History",
        icon: "📈",
        tooltip: {
          eyebrow: "IMPLIED VOLATILITY",
          title: "IV History",
          description: "Daily option-chain IV snapshots: per-symbol coverage, IV rank, and the latest readings.",
        },
      },
      {
        // C1 (consolidation #1151, issue #1201): the goal-driven
        // screen — one goal, one screen across stocks + options
        // through the unified screening stack, with backtest-on-screen.
        id: "goal-screen",
        label: "Goal Screen",
        icon: "🧭",
        badge: "AI",
        badgeType: "purple",
        tooltip: {
          eyebrow: "GOAL-DRIVEN SCREENING",
          title: "Goal Screen",
          description: "Pick a goal; the unified screening stack screens stocks and options for it — and can backtest the hits.",
        },
      },
    );
    // C2 (consolidation #1151, issue #1246): the hub's own surfaces —
    // Reports and Schedules (formerly standalone nav entries) and the
    // #1096 Review inbox + recommendation Track Record.
    assetTabs.push(
      {
        id: "reports",
        label: "Reports",
        icon: "📄",
        tooltip: {
          eyebrow: "SCREENING REPORTS",
          title: "Reports",
          description: "Generated screening reports — view, download, and regenerate them here.",
        },
      },
      {
        id: "schedules",
        label: "Schedules",
        icon: "🗓️",
        tooltip: {
          eyebrow: "SCREENING SCHEDULES",
          title: "Schedules",
          description: "The one scheduling surface for screening runs — create, pause, and inspect scheduled jobs.",
        },
      },
      {
        id: "review",
        label: "Review",
        icon: "🧾",
        badge: "AI",
        badgeType: "purple",
        tooltip: {
          eyebrow: "PROPOSAL REVIEW",
          title: "Proposal Review",
          description: "Decide what the system proposed: goal proposals, adaptation candidates, and strategy re-selections — nothing activates without a person.",
        },
      },
      {
        id: "track-record",
        label: "Track Record",
        icon: "📈",
        tooltip: {
          eyebrow: "RECOMMENDATION OUTCOMES",
          title: "Track Record",
          description: "What happened to issued recommendations, from the outcome ledger — Unverified stays Unverified.",
        },
      },
    );
    return assetTabs;
  }, []);

  return (
    <section className="trading-section screeners-hub">
      <CapabilityNavBar
        ariaLabel="Instrument class capabilities"
        tabs={screenerTabs}
        activeTabId={hubTab}
        onTabChange={handleTabChange}
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

      {/* Tabbed Browsing Panels — reference multi-tab state retention:
          Panels mount on first visit and stay preserved in the DOM with role="tabpanel",
          id, and aria-labelledby linking back to their corresponding tab button. */}

      {/* 1. Stocks Screener Panel */}
      {visitedTabs.has("stocks") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-stocks"
          aria-labelledby="cap-tab-stocks"
          hidden={hubTab !== "stocks"}
          style={hubTab !== "stocks" ? { display: "none" } : undefined}
        >
          {/* Issue #1328: morning digest above the runs panel — one briefing
              of last night's runs, linking each entry to its run detail
              (child 3) and held items to the pending-review queue (child 1). */}
          <div style={{ marginBottom: "1rem" }}>
            <MorningDigest
              runs={autoRuns}
              onSelectRun={(timestamp) => {
                setSelectedAutoTs(timestamp);
                if (typeof document !== "undefined") {
                  document.getElementById("selected-run-detail")?.scrollIntoView?.({ block: "start" });
                }
              }}
              onViewQueue={() => handleTabChange("reports")}
            />
          </div>
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
                  id="selected-run-detail"
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
                  {selectedAutoRun && (
                    <div style={{ marginTop: "0.75rem" }}>
                      <RunDetailView
                        run={selectedAutoRun}
                        confirmations={runConfirmations}
                        confirmationsLoading={runConfirmationsLoading}
                      />
                    </div>
                  )}
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
                      Yahoo Finance Engine (<code>query1.finance.yahoo.com</code>)
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
                      ● LIVE YAHOO ENGINE
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
            <div className="screener-criteria-presets-deck">
              <ScreenerPresetManager
                assetClass="stocks"
                userLogin={userLogin}
                currentFilter={stockCriteriaToFilter(stockCriteria)}
                onApplyPreset={setStockCriteria}
              />
              <StockCriteriaPanel
                criteria={stockCriteria}
                onChange={setStockCriteria}
                lastSentFilters={lastSentStockFilters}
              />
            </div>
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
        </div>
      )}

      {/* 2. Options Research Panel */}
      {visitedTabs.has("options") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-options"
          aria-labelledby="cap-tab-options"
          hidden={hubTab !== "options"}
          style={hubTab !== "options" ? { display: "none" } : undefined}
        >
          <OptionsResearchHost
            activeEnv={activeEnv}
            userLogin={userLogin}
            onPreviewTrade={onPreviewTrade}
            onJobStateChange={onJobStateChange}
            onSendPrompt={onSendPrompt}
            onOpenSchedules={() => handleTabChange("schedules")}
          />
        </div>
      )}

      {/* 3. Strategy/Symbol Scanner Panel */}
      {visitedTabs.has("scanner") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-scanner"
          aria-labelledby="cap-tab-scanner"
          hidden={hubTab !== "scanner"}
          style={hubTab !== "scanner" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Strategy/Symbol Scanner panel">
            <ScannerPanel activeEnv={activeEnv} userLogin={userLogin} onPreviewTrade={onPreviewTrade} />
          </ErrorBoundary>
        </div>
      )}

      {/* 4. IV History Panel */}
      {visitedTabs.has("iv-history") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-iv-history"
          aria-labelledby="cap-tab-iv-history"
          hidden={hubTab !== "iv-history"}
          style={hubTab !== "iv-history" ? { display: "none" } : undefined}
        >
          <IvHistoryPanel />
        </div>
      )}

      {/* 5. Goal Screen Panel */}
      {visitedTabs.has("goal-screen") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-goal-screen"
          aria-labelledby="cap-tab-goal-screen"
          hidden={hubTab !== "goal-screen"}
          style={hubTab !== "goal-screen" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Goal Screen panel">
            <GoalScreenPanel activeEnv={activeEnv} userLogin={userLogin} />
          </ErrorBoundary>
        </div>
      )}

      {/* 6. Reports Panel */}
      {visitedTabs.has("reports") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-reports"
          aria-labelledby="cap-tab-reports"
          hidden={hubTab !== "reports"}
          style={hubTab !== "reports" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Reports panel">
            <ReportsPanel />
          </ErrorBoundary>
        </div>
      )}

      {/* 7. Schedules Panel */}
      {visitedTabs.has("schedules") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-schedules"
          aria-labelledby="cap-tab-schedules"
          hidden={hubTab !== "schedules"}
          style={hubTab !== "schedules" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Schedules panel">
            <SchedulesPanel activeEnv={activeEnv} userLogin={userLogin} onPreviewTrade={onPreviewTrade} />
          </ErrorBoundary>
        </div>
      )}

      {/* 8. Proposal Review Panel */}
      {visitedTabs.has("review") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-review"
          aria-labelledby="cap-tab-review"
          hidden={hubTab !== "review"}
          style={hubTab !== "review" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Proposal Review panel">
            <ScreeningReviewPanel userLogin={userLogin} />
          </ErrorBoundary>
        </div>
      )}

      {/* 9. Track Record Panel */}
      {visitedTabs.has("track-record") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-track-record"
          aria-labelledby="cap-tab-track-record"
          hidden={hubTab !== "track-record"}
          style={hubTab !== "track-record" ? { display: "none" } : undefined}
        >
          <ErrorBoundary label="Calibration dashboard">
            <CalibrationDashboard userLogin={userLogin} />
          </ErrorBoundary>
          {/* Issue #1888: enrichment dashboard panel — provider, coverage,
              breaker state, killswitch state, recent runs. */}
          <ErrorBoundary label="Enrichment dashboard">
            <EnrichmentDashboard userLogin={userLogin} />
          </ErrorBoundary>
          <ErrorBoundary label="Track Record panel">
            <ScreeningOutcomesPanel userLogin={userLogin} />
          </ErrorBoundary>
        </div>
      )}

      {/* 10. Multi-Asset Planned Panels (forex, futures, commodities, bonds) */}
      {(["forex", "futures", "commodities", "bonds"] as const).map((asset) =>
        visitedTabs.has(asset) ? (
          <div
            key={asset}
            role="tabpanel"
            id={`screener-tabpanel-${asset}`}
            aria-labelledby={`cap-tab-${asset}`}
            hidden={hubTab !== asset}
            style={hubTab !== asset ? { display: "none" } : undefined}
          >
            <div className="options-comparison-note" style={{ margin: "1.5rem 0", padding: "1.5rem", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px" }}>
              <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-text-muted)", fontSize: "1.05rem" }}>
                🚧 {SCREENING_ASSET_CLASSES.find((a) => a.id === asset)?.label || "Asset"} Screener · Planned
              </h4>
              <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
                This instrument class is a planned extension point. Multi-asset provider adapters are currently in development.
              </p>
            </div>
          </div>
        ) : null
      )}

      <p className="options-assumptions">
        Provider adapters declare the instrument classes and screening endpoint they support. Add a broker, market-data API, or MCP connector by registering its capabilities and mapping its response to the common result table; unsupported instrument classes are not silently routed to an unrelated feed.
      </p>
    </section>
  );
}
