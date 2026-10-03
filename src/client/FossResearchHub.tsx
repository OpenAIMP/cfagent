import React, { useState, useEffect } from "react";
import { ResearchReportActions } from "./ResearchReportActions";
import type {
  FossQuote,
  FossCompanyFundamentals,
  FossHistoricalBar,
  AlpacaMarketSnapshot,
  FossResearchReport,
  FossProviderStatus,
} from "../types";

export interface User {
  login: string;
  name?: string;
  avatar?: string;
}

export interface FossResearchHubProps {
  user?: User;
  onSendPrompt?: (prompt: string) => void;
  onTradeSymbol?: (symbol: string) => void;
}

export function FossResearchHub({ user, onSendPrompt, onTradeSymbol }: FossResearchHubProps) {
  // Navigation Subtabs
  const [subTab, setSubTab] = useState<"screener" | "report" | "quoting" | "fundamentals" | "bars" | "snapshot" | "compare">("screener");

  // Active Symbol State
  const [activeSymbol, setActiveSymbol] = useState("NVDA");
  const [symbolInput, setSymbolInput] = useState("NVDA");

  // Providers Status
  const [providers, setProviders] = useState<FossProviderStatus[]>([]);

  // Research Report State
  const [report, setReport] = useState<FossResearchReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  // Quoting State
  const [quoteProvider, setQuoteProvider] = useState<"yfinance" | "alpaca" | "hybrid">("hybrid");
  const [activeQuote, setActiveQuote] = useState<FossQuote | null>(null);
  const [yfinanceQuote, setYfinanceQuote] = useState<FossQuote | null>(null);
  const [alpacaQuote, setAlpacaQuote] = useState<FossQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // Fundamentals State
  const [fundamentals, setFundamentals] = useState<FossCompanyFundamentals | null>(null);
  const [fundamentalsLoading, setFundamentalsLoading] = useState(false);

  // Historical Bars State
  const [bars, setBars] = useState<FossHistoricalBar[]>([]);
  const [barTimeframe, setBarTimeframe] = useState("1D");
  const [barLimit, setBarLimit] = useState(30);
  const [barProvider, setBarProvider] = useState<"yfinance" | "alpaca">("yfinance");
  const [barsMeta, setBarsMeta] = useState<{ source?: string; timestamp?: string; provider?: string } | null>(null);
  const [barsLoading, setBarsLoading] = useState(false);

  // Alpaca Snapshot & Tracing State
  const [snapshot, setSnapshot] = useState<AlpacaMarketSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [alpacaTraces, setAlpacaTraces] = useState<any[]>([]);
  const [tracesLoading, setTracesLoading] = useState(false);
  const [copiedMcpConfig, setCopiedMcpConfig] = useState(false);
  const [alpacaAccount, setAlpacaAccount] = useState<any>(null);
  const [alpacaPositions, setAlpacaPositions] = useState<any[]>([]);
  const [alpacaAccountLoading, setAlpacaAccountLoading] = useState(false);

  // Multi-Stock Comparison State
  const [compareSymbolsInput, setCompareSymbolsInput] = useState("NVDA, AMD, INTC, MSFT");
  const [comparisonResults, setComparisonResults] = useState<Array<{ symbol: string; quote: FossQuote; fundamentals: FossCompanyFundamentals }>>([]);
  const [compareLoading, setCompareLoading] = useState(false);

  // NLQ Prompt Bar State
  const [nlqQuery, setNlqQuery] = useState("");
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqResult, setNlqResult] = useState<any>(null);

  // Copy feedback
  const [copiedDid, setCopiedDid] = useState(false);

  // Yahoo Finance Screener State
  const [screenerStocks, setScreenerStocks] = useState<any[]>([]);
  const [screenerLoading, setScreenerLoading] = useState(false);
  const [screenerSearch, setScreenerSearch] = useState("");
  const [screenerSector, setScreenerSector] = useState("all");
  const [screenerGainersOnly, setScreenerGainersOnly] = useState(false);
  const [screenerLosersOnly, setScreenerLosersOnly] = useState(false);
  const [screenerMinRsi, setScreenerMinRsi] = useState<number | undefined>(undefined);
  const [screenerMaxRsi, setScreenerMaxRsi] = useState<number | undefined>(undefined);
  const [screenerSummary, setScreenerSummary] = useState("All Equities (Yahoo Finance Feed)");
  const [screenerLastScanned, setScreenerLastScanned] = useState<string>("");

  const researchAgentDid = "did:agent:openaimp:research";

  // Initial load
  useEffect(() => {
    fetchProviders();
    loadAllSymbolData("NVDA");
    fetchScreener();
  }, []);

  const fetchScreener = async (override?: {
    search?: string;
    sector?: string;
    gainersOnly?: boolean;
    losersOnly?: boolean;
    minRsi?: number;
    maxRsi?: number;
  }) => {
    setScreenerLoading(true);
    try {
      const search = override?.search !== undefined ? override.search : screenerSearch;
      const sector = override?.sector !== undefined ? override.sector : screenerSector;
      const gainers = override?.gainersOnly !== undefined ? override.gainersOnly : screenerGainersOnly;
      const losers = override?.losersOnly !== undefined ? override.losersOnly : screenerLosersOnly;
      const minRsi = override?.minRsi !== undefined ? override.minRsi : screenerMinRsi;
      const maxRsi = override?.maxRsi !== undefined ? override.maxRsi : screenerMaxRsi;

      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (sector && sector !== "all") params.set("sector", sector);
      if (gainers) params.set("gainersOnly", "true");
      if (losers) params.set("losersOnly", "true");
      if (minRsi !== undefined) params.set("minRsi", String(minRsi));
      if (maxRsi !== undefined) params.set("maxRsi", String(maxRsi));

      const resp = await fetch(`/api/foss/screen?${params.toString()}`);
      if (resp.ok) {
        const data = (await resp.json()) as any;
        setScreenerStocks(data.stocks || data.results || []);
        if (data.filterSummary) setScreenerSummary(data.filterSummary);
        setScreenerLastScanned(new Date().toLocaleTimeString());
      }
    } catch {
      // Ignore
    } finally {
      setScreenerLoading(false);
    }
  };

  const fetchProviders = async () => {
    try {
      const resp = await fetch("/api/foss/providers");
      if (resp.ok) {
        const data = await resp.json() as { providers?: FossProviderStatus[] };
        if (data.providers) setProviders(data.providers);
      }
    } catch {
      // Ignore
    }
  };

  const loadAllSymbolData = async (sym: string) => {
    const cleanSym = sym.toUpperCase().trim();
    setActiveSymbol(cleanSym);
    loadResearchReport(cleanSym);
    loadQuotes(cleanSym);
    loadFundamentals(cleanSym);
    loadHistoricalBars(cleanSym, barTimeframe, barLimit, barProvider);
    loadAlpacaSnapshot(cleanSym);
  };

  const loadResearchReport = async (sym: string) => {
    setReportLoading(true);
    try {
      const resp = await fetch(`/api/foss/research?symbol=${encodeURIComponent(sym)}`);
      if (resp.ok) {
        const data = await resp.json() as FossResearchReport;
        setReport(data);
      }
    } catch {
      // Ignore
    } finally {
      setReportLoading(false);
    }
  };

  const loadQuotes = async (sym: string) => {
    setQuoteLoading(true);
    try {
      const [respYf, respAlpaca] = await Promise.all([
        fetch(`/api/foss/quote?symbol=${encodeURIComponent(sym)}&provider=yfinance`),
        fetch(`/api/foss/quote?symbol=${encodeURIComponent(sym)}&provider=alpaca`),
      ]);
      if (respYf.ok) {
        const dataYf = await respYf.json() as FossQuote;
        setYfinanceQuote(dataYf);
        setActiveQuote(dataYf);
      }
      if (respAlpaca.ok) {
        const dataAlpaca = await respAlpaca.json() as FossQuote;
        setAlpacaQuote(dataAlpaca);
      }
    } catch {
      // Ignore
    } finally {
      setQuoteLoading(false);
    }
  };

  const loadFundamentals = async (sym: string) => {
    setFundamentalsLoading(true);
    try {
      const resp = await fetch(`/api/foss/fundamentals?symbol=${encodeURIComponent(sym)}`);
      if (resp.ok) {
        const data = await resp.json() as FossCompanyFundamentals;
        setFundamentals(data);
      }
    } catch {
      // Ignore
    } finally {
      setFundamentalsLoading(false);
    }
  };

  const loadHistoricalBars = async (sym: string, timeframe: string, limit: number, provider: "yfinance" | "alpaca" = barProvider) => {
    setBarsLoading(true);
    try {
      const resp = await fetch(`/api/foss/bars?symbol=${encodeURIComponent(sym)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}&provider=${provider}`);
      if (resp.ok) {
        const data = await resp.json() as { count: number; bars: FossHistoricalBar[]; source?: string; timestamp?: string; provider?: string };
        setBars(data.bars || []);
        setBarsMeta({ source: data.source, timestamp: data.timestamp, provider: data.provider });
      }
    } catch {
      // Ignore
    } finally {
      setBarsLoading(false);
    }
  };

  const loadAlpacaTraces = async () => {
    setTracesLoading(true);
    try {
      const resp = await fetch("/api/audit?limit=50");
      if (resp.ok) {
        const data = await resp.json() as any;
        const events = Array.isArray(data?.events) ? data.events : [];
        const alpacaEvents = events.filter((e: any) =>
          e.type?.startsWith("alpaca") || e.type?.startsWith("foss.alpaca") || e.agent === "trading" || e.agent === "research"
        );
        setAlpacaTraces(alpacaEvents);
      }
    } catch {
      // Ignore
    } finally {
      setTracesLoading(false);
    }
  };

  const loadAlpacaAccountAndPositions = async () => {
    setAlpacaAccountLoading(true);
    try {
      const [accRes, posRes] = await Promise.all([
        fetch("/api/foss/alpaca/account").catch(() => null),
        fetch("/api/foss/alpaca/positions").catch(() => null),
      ]);
      if (accRes && accRes.ok) {
        const accData = await accRes.json() as any;
        setAlpacaAccount(accData.account || accData);
      }
      if (posRes && posRes.ok) {
        const posData = await posRes.json() as any;
        setAlpacaPositions(posData.positions || []);
      }
      await loadAlpacaTraces();
    } catch {
      // Ignore
    } finally {
      setAlpacaAccountLoading(false);
    }
  };

  const loadAlpacaSnapshot = async (sym: string) => {
    setSnapshotLoading(true);
    try {
      const resp = await fetch(`/api/foss/snapshot?symbol=${encodeURIComponent(sym)}`);
      if (resp.ok) {
        const data = await resp.json() as AlpacaMarketSnapshot;
        setSnapshot(data);
      }
      await loadAlpacaTraces();
    } catch {
      // Ignore
    } finally {
      setSnapshotLoading(false);
    }
  };

  const runComparison = async (symbolsStr: string) => {
    setCompareLoading(true);
    const syms = symbolsStr.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    try {
      const resp = await fetch("/api/foss/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: syms }),
      });
      if (resp.ok) {
        const data = await resp.json() as { count: number; comparison: Array<{ symbol: string; quote: FossQuote; fundamentals: FossCompanyFundamentals }> };
        setComparisonResults(data.comparison || []);
      }
    } catch {
      // Ignore
    } finally {
      setCompareLoading(false);
    }
  };

  const handleRunNlq = async (e?: React.FormEvent, customQuery?: string) => {
    if (e) e.preventDefault();
    const q = customQuery || nlqQuery;
    if (!q.trim() || nlqLoading) return;

    setNlqLoading(true);
    setNlqResult(null);
    try {
      const resp = await fetch("/api/nlq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const data = (await resp.json()) as any;
      setNlqResult(data);

      // If symbol in plan, auto-switch
      if (data?.plan?.researchData?.symbol) {
        const targetSym = data.plan.researchData.symbol.toUpperCase();
        setActiveSymbol(targetSym);
        setSymbolInput(targetSym);
        loadAllSymbolData(targetSym);
      }
    } catch {
      setNlqResult({ error: "Failed to execute NLQ query" });
    } finally {
      setNlqLoading(false);
    }
  };

  const copyDidToClipboard = (did: string) => {
    navigator.clipboard.writeText(did);
    setCopiedDid(true);
    setTimeout(() => setCopiedDid(false), 2000);
  };

  const getRecommendationBadgeClass = (rec?: string) => {
    if (!rec) return "rec-hold";
    const lower = rec.toLowerCase();
    if (lower.includes("strong_buy") || lower.includes("strong buy")) return "rec-strong-buy";
    if (lower.includes("buy")) return "rec-buy";
    if (lower.includes("underperform") || lower.includes("sell")) return "rec-sell";
    return "rec-hold";
  };

  return (
    <div className="foss-research-hub">
      {/* Top FOSS Provider Status Header */}
      <div className="research-header-banner">
        <div className="provider-brand-cluster">
          <div className="provider-logo-box">
            <span className="provider-logo-icon">🔬</span>
            <div className="provider-brand-names">
              <h3>FOSS Market Research &amp; Quoting Engine</h3>
              <span className="provider-subbrand">
                Open-Source Integration: <strong>Yahoo Finance (yfinance)</strong> &amp; <strong>Alpaca Market Data v2</strong>
              </span>
            </div>
          </div>

          <div className="provider-status-chips">
            <span className="chip-provider yf">
              <span className="dot yf-dot" /> Yahoo Finance FOSS Engine
            </span>
            <span className="chip-provider alpaca">
              <span className="dot alpaca-dot" /> Alpaca Data v2 (Paper &amp; Live)
            </span>
          </div>
        </div>

        {/* Research Agent DID Box */}
        <div className="research-did-cluster">
          <div className="did-box">
            <span className="metric-label">Research Agent DID</span>
            <div className="did-attest-row">
              <code className="did-snippet" title={researchAgentDid}>
                did:agent:…:research
              </code>
              <button
                type="button"
                className="btn-tiny-copy"
                onClick={() => copyDidToClipboard(researchAgentDid)}
                title="Copy W3C Agent DID"
              >
                {copiedDid ? "✓" : "📋"}
              </button>
            </div>
            <span className="did-verified-tag">🛡️ Cryptographic Research Attestation</span>
          </div>
        </div>
      </div>

      {/* NLQ Natural Language Research Bar */}
      <div className="nlq-quick-bar">
        <div className="nlq-bar-input-wrap">
          <span className="nlq-bar-icon">🤖</span>
          <input
            type="text"
            className="nlq-bar-input"
            placeholder="Ask FOSS research agent: e.g. 'Research NVDA', 'Yahoo Finance quote for AAPL', 'Alpaca snapshot for TSLA', 'Compare MSFT and GOOGL'..."
            value={nlqQuery}
            onChange={(e) => setNlqQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRunNlq();
            }}
          />
          <button
            type="button"
            className="btn-nlq-submit"
            disabled={nlqLoading || !nlqQuery.trim()}
            onClick={() => handleRunNlq()}
          >
            {nlqLoading ? "Researching…" : "⚡ Run NLQ"}
          </button>
          {onSendPrompt && (
            <button
              type="button"
              className="btn-nlq-chat"
              title="Send to Multi-Agent Chat"
              onClick={() => onSendPrompt(nlqQuery || "Research NVDA")}
            >
              💬 In Chat
            </button>
          )}
        </div>

        {/* Suggestion Chips */}
        <div className="nlq-chips-carousel">
          <span className="chips-label">Quick Prompts:</span>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Research NVDA");
              handleRunNlq(undefined, "Research NVDA");
            }}
          >
            🔬 Research NVDA
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Quote AAPL via Alpaca");
              handleRunNlq(undefined, "Quote AAPL via Alpaca");
            }}
          >
            📊 Quote AAPL (Alpaca)
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Show fundamentals and valuation for MSFT");
              handleRunNlq(undefined, "Show fundamentals and valuation for MSFT");
            }}
          >
            ⚖️ MSFT Fundamentals
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Alpaca market snapshot for TSLA");
              handleRunNlq(undefined, "Alpaca market snapshot for TSLA");
            }}
          >
            📷 TSLA Alpaca Snapshot
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Show historical bars for PLTR");
              handleRunNlq(undefined, "Show historical bars for PLTR");
            }}
          >
            📈 PLTR 30-Day Bars
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Quote BTC/USD crypto");
              handleRunNlq(undefined, "Quote BTC/USD crypto");
            }}
          >
            🪙 BTC/USD Crypto
          </button>
          <button
            type="button"
            className="nlq-chip"
            onClick={() => {
              setNlqQuery("Compare valuation of NVDA, AMD, and INTC");
              handleRunNlq(undefined, "Compare valuation of NVDA, AMD, and INTC");
            }}
          >
            🔄 Compare NVDA, AMD, INTC
          </button>
        </div>
      </div>

      {/* Symbol Search & Selector Bar */}
      <div className="symbol-selector-bar">
        <div className="active-ticker-display">
          <span className="active-ticker-label">Active Symbol:</span>
          <span className="active-ticker-badge">{activeSymbol}</span>
          <span className="active-company-name">{activeQuote?.companyName || "Loading…"}</span>
        </div>

        <div className="symbol-input-group">
          <input
            type="text"
            className="symbol-search-input"
            placeholder="Search ticker (e.g. AAPL, MSFT, BTC/USD)"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && symbolInput.trim()) {
                loadAllSymbolData(symbolInput.trim());
              }
            }}
          />
          <button
            type="button"
            className="btn-load-symbol"
            onClick={() => {
              if (symbolInput.trim()) loadAllSymbolData(symbolInput.trim());
            }}
          >
            🔍 Analyze Ticker
          </button>
          {onTradeSymbol && (
            <button
              type="button"
              className="btn-trade-etrade"
              title="Trade this symbol via E*TRADE"
              onClick={() => onTradeSymbol(activeSymbol)}
            >
              ⚡ Trade on E*TRADE →
            </button>
          )}
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="trading-subnav-bar">
        <button
          className={`subnav-btn ${subTab === "screener" ? "active" : ""}`}
          onClick={() => {
            setSubTab("screener");
            if (screenerStocks.length === 0) fetchScreener();
          }}
        >
          🔍 Yahoo Finance Screener
        </button>
        <button
          className={`subnav-btn ${subTab === "report" ? "active" : ""}`}
          onClick={() => setSubTab("report")}
        >
          🔬 Autonomous Research Report
        </button>
        <button
          className={`subnav-btn ${subTab === "quoting" ? "active" : ""}`}
          onClick={() => setSubTab("quoting")}
        >
          📊 Multi-Provider Quoting
        </button>
        <button
          className={`subnav-btn ${subTab === "fundamentals" ? "active" : ""}`}
          onClick={() => setSubTab("fundamentals")}
        >
          ⚖️ Fundamentals &amp; Valuations
        </button>
        <button
          className={`subnav-btn ${subTab === "bars" ? "active" : ""}`}
          onClick={() => setSubTab("bars")}
        >
          📈 Historical OHLCV Bars ({bars.length})
        </button>
        <button
          className={`subnav-btn ${subTab === "snapshot" ? "active" : ""}`}
          onClick={() => setSubTab("snapshot")}
        >
          📷 Alpaca Market Snapshot
        </button>
        <button
          className={`subnav-btn ${subTab === "compare" ? "active" : ""}`}
          onClick={() => {
            setSubTab("compare");
            if (comparisonResults.length === 0) runComparison(compareSymbolsInput);
          }}
        >
          🔄 Multi-Stock Valuation Comparison
        </button>
      </div>

      {/* SUBTAB 0: YAHOO FINANCE LIVE MARKET SCREENER */}
      {subTab === "screener" && (
        <div className="research-section screener-section">
          <div className="section-intro-card" style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 700, color: "#38bdf8" }}>
                  📊 Yahoo Finance Live Market Screener
                </h3>
                <p style={{ margin: "0.25rem 0 0", color: "#94a3b8", fontSize: "0.85rem" }}>
                  Real-time Level 1 quotes, daily changes, dynamic RSI-14 momentum, and institutional P/E valuations powered 100% by Yahoo Finance FOSS API.
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn-refresh"
                  onClick={() => fetchScreener()}
                  disabled={screenerLoading}
                >
                  {screenerLoading ? "Scanning…" : "🔄 Refresh Screener"}
                </button>
              </div>
            </div>
          </div>

          {/* Screener Controls Bar */}
          <div className="screener-controls-bar" style={{ marginBottom: "1rem" }}>
            <div className="control-item search-item">
              <label>Search Ticker / Company</label>
              <input
                type="text"
                placeholder="e.g. NVDA, Apple, Semiconductors…"
                value={screenerSearch}
                onChange={(e) => setScreenerSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") fetchScreener();
                }}
              />
            </div>

            <div className="control-item">
              <label>Sector</label>
              <select
                value={screenerSector}
                onChange={(e) => {
                  setScreenerSector(e.target.value);
                  fetchScreener({ sector: e.target.value });
                }}
              >
                <option value="all">All Sectors</option>
                <option value="Semiconductors">Semiconductors</option>
                <option value="Technology">Technology</option>
                <option value="Communication Services">Communication Services</option>
                <option value="Consumer Discretionary">Consumer Discretionary</option>
              </select>
            </div>

            <div className="control-item">
              <label>Quick Presets</label>
              <div style={{ display: "flex", gap: "0.35rem" }}>
                <button
                  type="button"
                  className={`btn-pill ${screenerGainersOnly ? "active" : ""}`}
                  onClick={() => {
                    const next = !screenerGainersOnly;
                    setScreenerGainersOnly(next);
                    if (next) setScreenerLosersOnly(false);
                    fetchScreener({ gainersOnly: next, losersOnly: false });
                  }}
                  style={{ fontSize: "0.75rem", padding: "0.4rem 0.65rem", borderRadius: "6px", background: screenerGainersOnly ? "#10b981" : "rgba(15,23,42,0.8)", color: "#fff", border: "1px solid var(--border-subtle)", cursor: "pointer" }}
                >
                  🚀 Gainers
                </button>
                <button
                  type="button"
                  className={`btn-pill ${screenerLosersOnly ? "active" : ""}`}
                  onClick={() => {
                    const next = !screenerLosersOnly;
                    setScreenerLosersOnly(next);
                    if (next) setScreenerGainersOnly(false);
                    fetchScreener({ losersOnly: next, gainersOnly: false });
                  }}
                  style={{ fontSize: "0.75rem", padding: "0.4rem 0.65rem", borderRadius: "6px", background: screenerLosersOnly ? "#ef4444" : "rgba(15,23,42,0.8)", color: "#fff", border: "1px solid var(--border-subtle)", cursor: "pointer" }}
                >
                  📉 Losers
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScreenerSearch("");
                    setScreenerSector("all");
                    setScreenerGainersOnly(false);
                    setScreenerLosersOnly(false);
                    setScreenerMinRsi(undefined);
                    setScreenerMaxRsi(undefined);
                    fetchScreener({ search: "", sector: "all", gainersOnly: false, losersOnly: false, minRsi: undefined, maxRsi: undefined });
                  }}
                  style={{ fontSize: "0.75rem", padding: "0.4rem 0.65rem", borderRadius: "6px", background: "rgba(15,23,42,0.8)", color: "#94a3b8", border: "1px solid var(--border-subtle)", cursor: "pointer" }}
                >
                  Reset
                </button>
              </div>
            </div>

            <button
              type="button"
              className="btn-run-scan"
              onClick={() => fetchScreener()}
              disabled={screenerLoading}
            >
              {screenerLoading ? "Scanning…" : "🔍 Run Scan"}
            </button>
          </div>

          {/* Screener Results Meta */}
          <div className="screener-results-header">
            <span>
              <strong>Filtered:</strong> {screenerSummary} • <strong>Matches:</strong> {screenerStocks.length} equities
            </span>
            <span>
              Data Source: <strong>Yahoo Finance FOSS Engine</strong> {screenerLastScanned ? `• ${screenerLastScanned}` : ""}
            </span>
          </div>
          <ResearchReportActions
            title={`${activeSymbol} stock research`}
            query={nlqQuery || `Run full FOSS market research on ${activeSymbol} using yfinance and Alpaca`}
            userLogin={user?.login}
            sheets={[
              { name: "Stock screen data", rows: screenerStocks as Array<Record<string, unknown>> },
              { name: "Screen evaluation", rows: [{
                scannedAt: screenerLastScanned, summary: screenerSummary, matchedCount: screenerStocks.length,
                search: screenerSearch, sector: screenerSector, gainersOnly: screenerGainersOnly,
                losersOnly: screenerLosersOnly, minRsi: screenerMinRsi, maxRsi: screenerMaxRsi,
              }] },
              { name: "Research report", rows: report ? [report as unknown as Record<string, unknown>] : [] },
              { name: "Quotes", rows: [activeQuote, yfinanceQuote, alpacaQuote].filter(Boolean) as unknown as Array<Record<string, unknown>> },
              { name: "Fundamentals", rows: fundamentals ? [fundamentals as unknown as Record<string, unknown>] : [] },
              { name: "Historical bars", rows: bars as unknown as Array<Record<string, unknown>> },
              { name: "Market snapshot", rows: snapshot ? [snapshot as unknown as Record<string, unknown>] : [] },
              { name: "Stock comparison", rows: comparisonResults as unknown as Array<Record<string, unknown>> },
              { name: "NLQ results", rows: (nlqResult?.rows || []) as Array<Record<string, unknown>> },
            ]}
          />

          {/* Table */}
          {screenerLoading ? (
            <div className="research-loading-state">
              <span className="spinner-large" />
              <p>Scanning equities universe via Yahoo Finance API…</p>
            </div>
          ) : (
            <div className="trading-table-container">
              <table className="trading-table">
                <thead>
                  <tr>
                    <th>Security</th>
                    <th>Sector</th>
                    <th style={{ textAlign: "right" }}>Price (YF)</th>
                    <th style={{ textAlign: "right" }}>Change (1D)</th>
                    <th style={{ textAlign: "right" }}>P/E Ratio</th>
                    <th style={{ textAlign: "right" }}>Market Cap</th>
                    <th style={{ textAlign: "center" }}>RSI (14)</th>
                    <th>Momentum Signal</th>
                    <th style={{ textAlign: "center" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {screenerStocks.map((stock) => (
                    <tr key={stock.symbol}>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <span style={{ fontWeight: 700, color: "#38bdf8" }}>{stock.symbol}</span>
                          <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{stock.companyName}</span>
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: "0.8rem", color: "#cbd5e1" }}>{stock.sector}</span>
                      </td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>
                        ${Number(stock.lastPrice || stock.price || 0).toFixed(2)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <span className={`pill-badge ${stock.change >= 0 ? "positive" : "negative"}`} style={{ display: "inline-block", padding: "0.15rem 0.45rem", borderRadius: "4px", fontSize: "0.78rem", fontWeight: 600, background: stock.change >= 0 ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)", color: stock.change >= 0 ? "#10b981" : "#ef4444", border: "1px solid currentColor" }}>
                          {stock.change >= 0 ? "+" : ""}{Number(stock.change || 0).toFixed(2)} ({Number(stock.changePercent || 0).toFixed(2)}%)
                        </span>
                      </td>
                      <td style={{ textAlign: "right", color: "#94a3b8" }}>
                        {stock.peRatio ? Number(stock.peRatio).toFixed(1) : "N/A"}
                      </td>
                      <td style={{ textAlign: "right", color: "#94a3b8" }}>
                        {stock.marketCap ? `$${Number(stock.marketCap).toFixed(1)}B` : "N/A"}
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <span style={{ fontWeight: 600, fontSize: "0.8rem", padding: "0.15rem 0.45rem", borderRadius: "4px", background: stock.rsi14 > 70 ? "rgba(239, 68, 68, 0.15)" : stock.rsi14 < 35 ? "rgba(16, 185, 129, 0.15)" : "rgba(56, 189, 248, 0.15)", color: stock.rsi14 > 70 ? "#ef4444" : stock.rsi14 < 35 ? "#10b981" : "#38bdf8", border: "1px solid currentColor" }}>
                          {stock.rsi14 ? stock.rsi14.toFixed(1) : "50.0"}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <span style={{ fontSize: "0.78rem", fontWeight: 600, color: stock.changePercent > 0 ? "#10b981" : "#f59e0b" }}>
                            {stock.signal || "RANGE_BOUND"}
                          </span>
                          <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
                            Score: {stock.momentumScore || 50}/100
                          </span>
                        </div>
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <div style={{ display: "flex", gap: "0.35rem", justifyContent: "center" }}>
                          <button
                            type="button"
                            title="Generate AI Research Report with Yahoo Finance & Alpaca"
                            onClick={() => {
                              setActiveSymbol(stock.symbol);
                              loadAllSymbolData(stock.symbol);
                              setSubTab("report");
                            }}
                            style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem", borderRadius: "4px", background: "rgba(56, 189, 248, 0.15)", color: "#38bdf8", border: "1px solid rgba(56, 189, 248, 0.3)", cursor: "pointer" }}
                          >
                            🔬 Report
                          </button>
                          <button
                            type="button"
                            title="Inspect Fundamentals & Valuations via Yahoo Finance"
                            onClick={() => {
                              setActiveSymbol(stock.symbol);
                              loadFundamentals(stock.symbol);
                              setSubTab("fundamentals");
                            }}
                            style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem", borderRadius: "4px", background: "rgba(148, 163, 184, 0.15)", color: "#cbd5e1", border: "1px solid rgba(148, 163, 184, 0.3)", cursor: "pointer" }}
                          >
                            ⚖️ Ratios
                          </button>
                          {onTradeSymbol && (
                            <button
                              type="button"
                              title="Send to E*TRADE Order Ticket for Execution"
                              onClick={() => onTradeSymbol(stock.symbol)}
                              style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem", borderRadius: "4px", background: "rgba(16, 185, 129, 0.15)", color: "#10b981", border: "1px solid rgba(16, 185, 129, 0.3)", cursor: "pointer", fontWeight: 600 }}
                            >
                              ⚡ Trade on E*TRADE
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* SUBTAB 1: AUTONOMOUS RESEARCH REPORT */}
      {subTab === "report" && (
        <div className="research-section report-section">
          {reportLoading ? (
            <div className="research-loading-state">
              <span className="spinner-large" />
              <p>Synthesizing Yahoo Finance fundamentals, Alpaca pricing, and AI technical summary for {activeSymbol}…</p>
            </div>
          ) : report ? (
            <div className="research-report-layout">
              {/* Report Header Card */}
              <div className="report-main-card">
                <div className="report-card-top">
                  <div className="company-heading">
                    <span className="report-ticker">{report.symbol}</span>
                    <div className="heading-meta">
                      <h4>{report.fundamentals.companyName}</h4>
                      <span className="sector-sub">{report.fundamentals.sector} • {report.fundamentals.industry}</span>
                    </div>
                  </div>

                  <div className="report-price-block">
                    <span className="report-price">${report.quote.price.toFixed(2)}</span>
                    <span className={`report-change ${report.quote.change >= 0 ? "positive" : "negative"}`}>
                      {report.quote.change >= 0 ? "+" : ""}{report.quote.change.toFixed(2)} ({report.quote.changePercent >= 0 ? "+" : ""}{report.quote.changePercent.toFixed(2)}%)
                    </span>
                    <span className="source-tag">Source: {report.quote.provider.toUpperCase()} FOSS</span>
                  </div>
                </div>

                {/* AI Research Synthesis Narrative */}
                <div className="report-ai-narrative">
                  <div className="narrative-badge">
                    <span>🤖 Autonomous AI Research Synthesis</span>
                  </div>
                  <p className="narrative-text">{report.aiAnalysis}</p>
                </div>

                {/* Quick Key Metrics Grid */}
                <div className="key-metrics-grid">
                  <div className="metric-pill-item">
                    <span className="label">Trailing P/E</span>
                    <span className="value">{report.fundamentals.peTrailing || "N/A"}</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">Forward P/E</span>
                    <span className="value">{report.fundamentals.peForward || "N/A"}</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">PEG Ratio</span>
                    <span className="value">{report.fundamentals.pegRatio || "N/A"}</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">Beta</span>
                    <span className="value">{report.fundamentals.beta || "1.00"}</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">Market Cap</span>
                    <span className="value">${(report.fundamentals.marketCap / 1e9).toFixed(1)}B</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">Consensus Target</span>
                    <span className="value target-highlight">
                      ${report.fundamentals.targetMeanPrice ? report.fundamentals.targetMeanPrice.toFixed(2) : "N/A"}
                    </span>
                  </div>
                </div>

                {/* Technical Overview Cards */}
                <div className="technical-overview-row">
                  <div className="tech-stat-card">
                    <span className="stat-label">14-Day RSI</span>
                    <span className="stat-num">{report.technicalSummary.rsi14}</span>
                    <div className="rsi-meter-bar">
                      <div
                        className="rsi-fill"
                        style={{
                          width: `${Math.min(100, Math.max(0, report.technicalSummary.rsi14))}%`,
                          background: report.technicalSummary.rsi14 < 35 ? "#10b981" : report.technicalSummary.rsi14 > 70 ? "#ef4444" : "#38bdf8",
                        }}
                      />
                    </div>
                  </div>
                  <div className="tech-stat-card">
                    <span className="stat-label">MACD Signal</span>
                    <span className="stat-num tech-pill">{report.technicalSummary.macd}</span>
                  </div>
                  <div className="tech-stat-card">
                    <span className="stat-label">50 vs 200 SMA Trend</span>
                    <span className="stat-num tech-pill">{report.technicalSummary.trend50vs200SMA}</span>
                  </div>
                  <div className="tech-stat-card">
                    <span className="stat-label">Support / Resistance</span>
                    <span className="stat-num">${report.technicalSummary.support} / ${report.technicalSummary.resistance}</span>
                  </div>
                </div>

                {/* W3C Agent DID Attestation Stamp */}
                <div className="report-attestation-footer">
                  <div className="attest-col">
                    <span className="attest-label">Attesting Research Agent:</span>
                    <code>{report.agentAttestation.did}</code>
                  </div>
                  <div className="attest-col">
                    <span className="attest-label">Cryptographic Signature:</span>
                    <code className="sig-snippet">{report.agentAttestation.signature.slice(0, 32)}…</code>
                  </div>
                  <div className="attest-col">
                    <span className="attest-label">Certified Timestamp:</span>
                    <span>{new Date(report.agentAttestation.timestamp).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* Right Side: Analyst Rating & Action Card */}
              <div className="report-side-card">
                <div className="analyst-rating-box">
                  <h5>Wall Street Consensus</h5>
                  <div className={`rating-big-badge ${getRecommendationBadgeClass(report.analystRating)}`}>
                    {report.analystRating}
                  </div>
                  <div className="target-spread-info">
                    <div className="spread-row">
                      <span>Low Target:</span>
                      <span>${report.fundamentals.targetLowPrice?.toFixed(2) || "N/A"}</span>
                    </div>
                    <div className="spread-row mean">
                      <span>Mean Target:</span>
                      <span>${report.fundamentals.targetMeanPrice?.toFixed(2) || "N/A"}</span>
                    </div>
                    <div className="spread-row">
                      <span>High Target:</span>
                      <span>${report.fundamentals.targetHighPrice?.toFixed(2) || "N/A"}</span>
                    </div>
                    <div className="analyst-count-note">
                      Based on {report.fundamentals.numberOfAnalystOpinions || 30} Wall Street analyst ratings
                    </div>
                  </div>
                </div>

                <div className="company-description-card">
                  <h5>Business Overview</h5>
                  <p>{report.fundamentals.description}</p>
                </div>

                {onTradeSymbol && (
                  <button
                    type="button"
                    className="btn-side-trade"
                    onClick={() => onTradeSymbol(report.symbol)}
                  >
                    ⚡ Trade {report.symbol} on E*TRADE
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-state">No research report available.</div>
          )}
        </div>
      )}

      {/* SUBTAB 2: MULTI-PROVIDER QUOTING */}
      {subTab === "quoting" && (
        <div className="research-section quoting-section">
          <div className="quoting-comparison-grid">
            {/* Yahoo Finance Quote Card */}
            <div className="provider-quote-card yf-card">
              <div className="quote-card-header">
                <div className="provider-name-row">
                  <span className="dot yf-dot" />
                  <h4>Yahoo Finance FOSS Engine</h4>
                </div>
                <span className="provider-tag">yfinance API</span>
              </div>

              {yfinanceQuote ? (
                <div className="quote-card-body">
                  <div className="quote-price-row">
                    <span className="big-quote-price">${yfinanceQuote.price.toFixed(2)}</span>
                    <span className={`quote-change-pill ${yfinanceQuote.change >= 0 ? "positive" : "negative"}`}>
                      {yfinanceQuote.change >= 0 ? "+" : ""}{yfinanceQuote.change.toFixed(2)} ({yfinanceQuote.changePercent >= 0 ? "+" : ""}{yfinanceQuote.changePercent.toFixed(2)}%)
                    </span>
                  </div>

                  <div className="quote-detail-grid">
                    <div className="detail-item">
                      <span className="lbl">Bid</span>
                      <span className="val">${yfinanceQuote.bid.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Ask</span>
                      <span className="val">${yfinanceQuote.ask.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Spread</span>
                      <span className="val">${(yfinanceQuote.ask - yfinanceQuote.bid).toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Open</span>
                      <span className="val">${yfinanceQuote.open.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">High</span>
                      <span className="val">${yfinanceQuote.high.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Low</span>
                      <span className="val">${yfinanceQuote.low.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Volume</span>
                      <span className="val">{(yfinanceQuote.volume / 1e6).toFixed(2)}M</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Prev Close</span>
                      <span className="val">${yfinanceQuote.previousClose.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="provider-foot">
                    <span>Protocol: FOSS Query Endpoint</span>
                    <span>Updated: {new Date(yfinanceQuote.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              ) : (
                <div className="empty-state">Loading Yahoo Finance Quote…</div>
              )}
            </div>

            {/* Alpaca Market Data v2 Quote Card */}
            <div className="provider-quote-card alpaca-card">
              <div className="quote-card-header">
                <div className="provider-name-row">
                  <span className="dot alpaca-dot" />
                  <h4>Alpaca Market Data v2</h4>
                </div>
                <span className="provider-tag">Level 1/2 REST &amp; Paper</span>
              </div>

              {alpacaQuote ? (
                <div className="quote-card-body">
                  <div className="quote-price-row">
                    <span className="big-quote-price">${alpacaQuote.price.toFixed(2)}</span>
                    <span className={`quote-change-pill ${alpacaQuote.change >= 0 ? "positive" : "negative"}`}>
                      {alpacaQuote.change >= 0 ? "+" : ""}{alpacaQuote.change.toFixed(2)} ({alpacaQuote.changePercent >= 0 ? "+" : ""}{alpacaQuote.changePercent.toFixed(2)}%)
                    </span>
                  </div>

                  <div className="quote-detail-grid">
                    <div className="detail-item">
                      <span className="lbl">NBBO Bid</span>
                      <span className="val">${alpacaQuote.bid.toFixed(2)} ({alpacaQuote.bidSize} shs)</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">NBBO Ask</span>
                      <span className="val">${alpacaQuote.ask.toFixed(2)} ({alpacaQuote.askSize} shs)</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Spread</span>
                      <span className="val">${(alpacaQuote.ask - alpacaQuote.bid).toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">VWAP</span>
                      <span className="val">${alpacaQuote.vwap ? alpacaQuote.vwap.toFixed(2) : alpacaQuote.price.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Day High</span>
                      <span className="val">${alpacaQuote.high.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Day Low</span>
                      <span className="val">${alpacaQuote.low.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Volume</span>
                      <span className="val">{(alpacaQuote.volume / 1e6).toFixed(2)}M</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Prev Close</span>
                      <span className="val">${alpacaQuote.previousClose.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="provider-foot">
                    <span>Protocol: Alpaca v2 Data Gateway</span>
                    <span>Updated: {new Date(alpacaQuote.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              ) : (
                <div className="empty-state">Loading Alpaca Quote…</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 3: FUNDAMENTALS & VALUATIONS */}
      {subTab === "fundamentals" && (
        <div className="research-section fundamentals-section">
          {fundamentalsLoading ? (
            <div className="research-loading-state">
              <span className="spinner-large" />
              <p>Extracting financial ratios and balance sheet metrics from Yahoo Finance…</p>
            </div>
          ) : fundamentals ? (
            <div className="fundamentals-layout">
              {/* Valuation Multiples */}
              <div className="fund-card">
                <h5>📊 Valuation Multiples (yfinance)</h5>
                <div className="fund-grid">
                  <div className="fund-item">
                    <span className="lbl">Market Capitalization</span>
                    <span className="val">${(fundamentals.marketCap / 1e9).toFixed(1)}B</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Enterprise Value</span>
                    <span className="val">
                      {fundamentals.enterpriseValue ? `$${(fundamentals.enterpriseValue / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Trailing P/E</span>
                    <span className="val">{fundamentals.peTrailing || "N/A"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Forward P/E</span>
                    <span className="val">{fundamentals.peForward || "N/A"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">PEG Ratio (5-yr expected)</span>
                    <span className="val">{fundamentals.pegRatio || "N/A"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Price to Book (MRQ)</span>
                    <span className="val">{fundamentals.priceToBook || "N/A"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Beta (5-yr monthly)</span>
                    <span className="val">{fundamentals.beta || "1.00"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Dividend Yield</span>
                    <span className="val">{fundamentals.dividendYield ? `${fundamentals.dividendYield}%` : "0.00%"}</span>
                  </div>
                </div>
              </div>

              {/* Financial Performance & Margins */}
              <div className="fund-card">
                <h5>💰 Financial Performance &amp; Margins</h5>
                <div className="fund-grid">
                  <div className="fund-item">
                    <span className="lbl">Total Revenue (TTM)</span>
                    <span className="val">
                      {fundamentals.revenue ? `$${(fundamentals.revenue / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Gross Profit (TTM)</span>
                    <span className="val">
                      {fundamentals.grossProfits ? `$${(fundamentals.grossProfits / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">EBITDA</span>
                    <span className="val">
                      {fundamentals.ebitda ? `$${(fundamentals.ebitda / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Free Cash Flow</span>
                    <span className="val">
                      {fundamentals.freeCashflow ? `$${(fundamentals.freeCashflow / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Profit Margin</span>
                    <span className="val">
                      {fundamentals.profitMargins ? `${(fundamentals.profitMargins * 100).toFixed(1)}%` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Operating Margin</span>
                    <span className="val">
                      {fundamentals.operatingMargins ? `${(fundamentals.operatingMargins * 100).toFixed(1)}%` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Return on Equity</span>
                    <span className="val">
                      {fundamentals.returnOnEquity ? `${(fundamentals.returnOnEquity * 100).toFixed(1)}%` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">52-Week Range</span>
                    <span className="val">${fundamentals.fiftyTwoWeekLow.toFixed(2)} - ${fundamentals.fiftyTwoWeekHigh.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">No fundamentals data available.</div>
          )}
        </div>
      )}

      {/* SUBTAB 4: HISTORICAL OHLCV BARS */}
      {subTab === "bars" && (
        <div className="research-section bars-section">
          <div className="bars-controls-row">
            <span className="bars-title">
              Historical OHLCV Bars for <strong>{activeSymbol}</strong>
            </span>
            <div className="bars-filters">
              <label>Feed:</label>
              <select
                value={barProvider}
                onChange={(e) => {
                  const p = e.target.value as "yfinance" | "alpaca";
                  setBarProvider(p);
                  loadHistoricalBars(activeSymbol, barTimeframe, barLimit, p);
                }}
              >
                <option value="yfinance">Yahoo Finance FOSS (Live)</option>
                <option value="alpaca">Alpaca Data v2 (Live)</option>
              </select>
              <label>Timeframe:</label>
              <select
                value={barTimeframe}
                onChange={(e) => {
                  const tf = e.target.value;
                  setBarTimeframe(tf);
                  loadHistoricalBars(activeSymbol, tf, barLimit, barProvider);
                }}
              >
                <option value="1D">Daily (1D)</option>
                <option value="1W">Weekly (1W)</option>
                <option value="1M">Monthly (1M)</option>
                <option value="1H">Hourly (1H)</option>
              </select>
              <label>Limit:</label>
              <select
                value={barLimit}
                onChange={(e) => {
                  const l = Number(e.target.value);
                  setBarLimit(l);
                  loadHistoricalBars(activeSymbol, barTimeframe, l, barProvider);
                }}
              >
                <option value={15}>15 Bars</option>
                <option value={30}>30 Bars</option>
                <option value={60}>60 Bars</option>
                <option value={90}>90 Bars</option>
              </select>
              <button
                type="button"
                className="btn-compact btn-secondary"
                disabled={barsLoading}
                onClick={() => loadHistoricalBars(activeSymbol, barTimeframe, barLimit, barProvider)}
                title="Refresh live market bars"
                style={{ marginLeft: "0.25rem", padding: "0.25rem 0.65rem", fontSize: "0.78rem" }}
              >
                {barsLoading ? "Refreshing…" : "↻ Refresh"}
              </button>
            </div>
          </div>

          {barsMeta && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0.5rem 0.25rem 0.75rem 0.25rem", fontSize: "0.8rem", color: "#94a3b8" }}>
              <span>
                📡 Verified Source: <strong style={{ color: "#38bdf8" }}>{barsMeta.source || (barProvider === "alpaca" ? "Alpaca Market Data v2" : "Yahoo Finance FOSS Chart API")}</strong>
              </span>
              <span>
                Live Synced: {barsMeta.timestamp ? new Date(barsMeta.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()}
              </span>
            </div>
          )}

          <div className="bars-table-wrap">
            <table className="trading-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Open</th>
                  <th>High</th>
                  <th>Low</th>
                  <th>Close</th>
                  <th>VWAP</th>
                  <th>Volume</th>
                  <th>Trades</th>
                </tr>
              </thead>
              <tbody>
                {bars.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="empty-state">
                      {barsLoading ? "Loading historical bars…" : "No bars returned."}
                    </td>
                  </tr>
                ) : (
                  bars.map((bar, i) => {
                    const isPositive = bar.close >= bar.open;
                    return (
                      <tr key={bar.timestamp || i}>
                        <td>
                          <code>{bar.timestamp}</code>
                        </td>
                        <td>${bar.open.toFixed(2)}</td>
                        <td>${bar.high.toFixed(2)}</td>
                        <td>${bar.low.toFixed(2)}</td>
                        <td>
                          <span className={`price-tag ${isPositive ? "positive-text" : "negative-text"}`}>
                            ${bar.close.toFixed(2)}
                          </span>
                        </td>
                        <td>${bar.vwap ? bar.vwap.toFixed(2) : bar.close.toFixed(2)}</td>
                        <td>{(bar.volume / 1e6).toFixed(2)}M</td>
                        <td>{bar.tradeCount ? bar.tradeCount.toLocaleString() : "N/A"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 5: ALPACA MARKET SNAPSHOT */}
      {subTab === "snapshot" && (
        <div className="research-section snapshot-section">
          {snapshotLoading ? (
            <div className="research-loading-state">
              <span className="spinner-large" />
              <p>Querying real-time Level 1/2 snapshot from Alpaca Market Data v2…</p>
            </div>
          ) : snapshot ? (
            <div className="snapshot-card">
              <div className="snapshot-header">
                <div className="snap-title">
                  <span className="dot alpaca-dot" />
                  <h4>Alpaca Market Data v2 Snapshot: {snapshot.symbol}</h4>
                </div>
                <span className="asset-tag">{snapshot.assetClass.toUpperCase()}</span>
              </div>

              <div className="snapshot-grid">
                <div className="snap-item">
                  <span className="label">Latest Executed Trade</span>
                  <span className="val big">${snapshot.latestTrade.price.toFixed(2)}</span>
                  <span className="sub">Size: {snapshot.latestTrade.size} shares • {new Date(snapshot.latestTrade.timestamp).toLocaleTimeString()}</span>
                </div>

                <div className="snap-item">
                  <span className="label">NBBO Best Bid / Ask</span>
                  <span className="val">${snapshot.latestQuote.bidPrice.toFixed(2)} / ${snapshot.latestQuote.askPrice.toFixed(2)}</span>
                  <span className="sub">Sizes: {snapshot.latestQuote.bidSize} x {snapshot.latestQuote.askSize}</span>
                </div>

                <div className="snap-item">
                  <span className="label">Daily Bar (Today)</span>
                  <span className="val">${snapshot.dailyBar.low.toFixed(2)} - ${snapshot.dailyBar.high.toFixed(2)}</span>
                  <span className="sub">Vol: {(snapshot.dailyBar.volume / 1e6).toFixed(2)}M • VWAP: ${snapshot.dailyBar.vwap ? snapshot.dailyBar.vwap.toFixed(2) : "N/A"}</span>
                </div>

                <div className="snap-item">
                  <span className="label">Previous Daily Bar</span>
                  <span className="val">${snapshot.prevDailyBar.close.toFixed(2)} Close</span>
                  <span className="sub">Range: ${snapshot.prevDailyBar.low.toFixed(2)} - ${snapshot.prevDailyBar.high.toFixed(2)}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="research-loading-state" style={{ opacity: 0.8 }}>
              <p>No snapshot data loaded. Enter a ticker above and click Search FOSS Data.</p>
            </div>
          )}

          <div className="section-intro-card" style={{ marginTop: "1.5rem", background: "rgba(15, 23, 42, 0.65)", border: "1px solid rgba(56, 189, 248, 0.25)", borderRadius: "12px", padding: "1.25rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "1.25rem" }}>🛡️</span>
                <h4 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#38bdf8" }}>
                  Alpaca Agentic Tracing Stream &amp; Provenance Ledger
                </h4>
                <span style={{ fontSize: "0.7rem", background: "rgba(16, 185, 129, 0.15)", color: "#10b981", padding: "2px 8px", borderRadius: "10px", fontWeight: 700, border: "1px solid rgba(16, 185, 129, 0.3)" }}>
                  W3C DID ATTESTED
                </span>
              </div>
              <button
                type="button"
                onClick={loadAlpacaTraces}
                disabled={tracesLoading}
                style={{ background: "rgba(56, 189, 248, 0.15)", border: "1px solid rgba(56, 189, 248, 0.3)", color: "#38bdf8", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "0.85rem", fontWeight: 600 }}
              >
                {tracesLoading ? "Refreshing Traces…" : "🔄 Refresh Audit Traces"}
              </button>
            </div>

            <p style={{ margin: "0 0 1rem 0", fontSize: "0.85rem", color: "#94a3b8", lineHeight: 1.4 }}>
              Every market inquiry, snapshot lookup, and order routed through Alpaca is cryptographically stamped with Agent DID (<code>did:agent:openaimp:trading</code>) and recorded in SQLite Durable Objects (<code>mas_events</code>) for end-to-end provenance.
            </p>

            {alpacaTraces.length === 0 ? (
              <div style={{ textAlign: "center", padding: "1rem", color: "#64748b", fontSize: "0.85rem", background: "rgba(0,0,0,0.2)", borderRadius: "8px" }}>
                {tracesLoading ? "Querying audit ledger…" : "No Alpaca traces recorded in this session yet. Run a snapshot or quote query above to generate trace telemetry."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", maxHeight: "320px", overflowY: "auto" }}>
                {alpacaTraces.map((tr, idx) => (
                  <div key={tr.id || idx} style={{ background: "rgba(15, 23, 42, 0.8)", border: "1px solid rgba(148, 163, 184, 0.15)", borderRadius: "8px", padding: "0.75rem", fontSize: "0.85rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px", flexWrap: "wrap", gap: "4px" }}>
                      <span style={{ fontWeight: 700, color: "#38bdf8", background: "rgba(56, 189, 248, 0.1)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.75rem" }}>
                        {tr.type}
                      </span>
                      <span style={{ color: "#64748b", fontSize: "0.75rem" }}>
                        {new Date(tr.created_at).toLocaleTimeString()} ({new Date(tr.created_at).toLocaleDateString()})
                      </span>
                    </div>
                    <div style={{ color: "#cbd5e1", fontSize: "0.8rem", wordBreak: "break-all", fontFamily: "monospace", background: "rgba(0,0,0,0.25)", padding: "6px", borderRadius: "4px" }}>
                      {typeof tr.payload === "string" ? tr.payload : JSON.stringify(tr.payload)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Antigravity MCP Integration Guide */}
            <div style={{ marginTop: "1.25rem", borderTop: "1px solid rgba(148, 163, 184, 0.15)", paddingTop: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "#f8fafc" }}>
                  ⚡ Antigravity &amp; Agent MCP Server Config (Alpaca)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const cfg = JSON.stringify({
                      mcpServers: {
                        alpaca: {
                          command: "uvx",
                          args: ["alpaca-mcp-server"],
                          env: {
                            ALPACA_API_KEY: "your_alpaca_api_key",
                            ALPACA_SECRET_KEY: "your_alpaca_secret_key"
                          }
                        }
                      }
                    }, null, 2);
                    navigator.clipboard.writeText(cfg);
                    setCopiedMcpConfig(true);
                    setTimeout(() => setCopiedMcpConfig(false), 2000);
                  }}
                  style={{ background: "#2563eb", color: "#fff", border: "none", padding: "4px 10px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer" }}
                >
                  {copiedMcpConfig ? "✓ Copied Config!" : "📋 Copy MCP Config"}
                </button>
              </div>
              <pre style={{ margin: 0, background: "#0b1329", border: "1px solid rgba(56, 189, 248, 0.2)", borderRadius: "6px", padding: "0.75rem", fontSize: "0.78rem", color: "#e2e8f0", overflowX: "auto" }}>
{`{
  "mcpServers": {
    "alpaca": {
      "command": "uvx",
      "args": ["alpaca-mcp-server"],
      "env": {
        "ALPACA_API_KEY": "your_alpaca_api_key",
        "ALPACA_SECRET_KEY": "your_alpaca_secret_key"
      }
    }
  }
}`}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 6: MULTI-STOCK VALUATION COMPARISON */}
      {subTab === "compare" && (
        <div className="research-section compare-section">
          <div className="compare-bar">
            <label>Compare Tickers:</label>
            <input
              type="text"
              className="compare-input"
              value={compareSymbolsInput}
              onChange={(e) => setCompareSymbolsInput(e.target.value.toUpperCase())}
            />
            <button
              type="button"
              className="btn-run-compare"
              disabled={compareLoading}
              onClick={() => runComparison(compareSymbolsInput)}
            >
              {compareLoading ? "Comparing…" : "⚡ Run Valuation Comparison"}
            </button>
          </div>

          <div className="compare-table-wrap">
            <table className="trading-table">
              <thead>
                <tr>
                  <th>Symbol &amp; Company</th>
                  <th>Price</th>
                  <th>24h Change</th>
                  <th>Market Cap</th>
                  <th>Trailing P/E</th>
                  <th>Forward P/E</th>
                  <th>PEG Ratio</th>
                  <th>Price/Book</th>
                  <th>Beta</th>
                  <th>Consensus Target</th>
                  <th>Analyst Rating</th>
                </tr>
              </thead>
              <tbody>
                {comparisonResults.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="empty-state">
                      {compareLoading ? "Gathering multi-stock metrics from Yahoo Finance & Alpaca…" : "No stocks to compare."}
                    </td>
                  </tr>
                ) : (
                  comparisonResults.map(({ symbol, quote, fundamentals: f }) => {
                    const isPositive = quote.change >= 0;
                    return (
                      <tr key={symbol}>
                        <td>
                          <div className="ticker-company">
                            <span className="ticker-badge">{symbol}</span>
                            <span className="company-title">{f.companyName}</span>
                          </div>
                        </td>
                        <td>
                          <span className="price-tag">${quote.price.toFixed(2)}</span>
                        </td>
                        <td>
                          <span className={`change-pill ${isPositive ? "positive" : "negative"}`}>
                            {isPositive ? "+" : ""}{quote.change.toFixed(2)} ({isPositive ? "+" : ""}{quote.changePercent.toFixed(2)}%)
                          </span>
                        </td>
                        <td>${(f.marketCap / 1e9).toFixed(1)}B</td>
                        <td>{f.peTrailing || "N/A"}</td>
                        <td>{f.peForward || "N/A"}</td>
                        <td>{f.pegRatio || "N/A"}</td>
                        <td>{f.priceToBook || "N/A"}</td>
                        <td>{f.beta || "1.00"}</td>
                        <td>
                          <span className="target-val">${f.targetMeanPrice?.toFixed(2) || "N/A"}</span>
                        </td>
                        <td>
                          <span className={`rec-badge ${getRecommendationBadgeClass(f.recommendationKey)}`}>
                            {f.recommendationKey?.toUpperCase() || "BUY"}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
