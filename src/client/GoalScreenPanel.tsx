import { useMemo, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";

/**
 * Goal Screen panel (consolidation C1, issue #1201, epic #1151 R1).
 *
 * The hub surface for the #1096 unified stack: pick a goal, run the
 * goal-driven screen (Phase 1 scenario → Phase 0 ScreeningProvider
 * registry → Phase 3 goal-driven semantics) via
 * POST /api/screening/goal-screen, and read the result with its
 * honesty status intact — a PARTIAL run names the failed asset
 * classes and their reasons; it is never dressed up as complete.
 * Stock hits can be backtested in place (backtest-on-screen,
 * POST /api/screening/backtest) with provenance + limitations shown.
 *
 * The goal-kind list below is presentational: the server validates
 * goalKind against the canonical GOAL_KINDS and 400s anything else.
 */
const GOAL_KIND_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "income", label: "Income" },
  { id: "directional", label: "Directional" },
  { id: "volatility_event", label: "Volatility / Event" },
  { id: "hedge_protect", label: "Hedge / Protect" },
  { id: "repair", label: "Repair" },
  { id: "deconcentrate", label: "Deconcentrate" },
  { id: "iv_harvest", label: "IV Harvest" },
  { id: "capital_efficient_leverage", label: "Capital-Efficient Leverage" },
  { id: "cash_secured_entry", label: "Cash-Secured Entry" },
];

const DIRECTION_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "", label: "Goal default" },
  { id: "bullish", label: "Bullish" },
  { id: "bearish", label: "Bearish" },
  { id: "volatile", label: "Volatile" },
  { id: "range_bound", label: "Range-bound" },
  { id: "unknown", label: "Unknown" },
];

interface GoalScreenHit {
  assetClass: "stocks" | "options";
  providerId: string;
  symbol: string;
  structures?: string[];
}

interface GoalScreenResult {
  goalKind: string;
  outlook: string;
  status: "complete" | "partial" | "failed";
  hits: GoalScreenHit[];
  counts: {
    stocksScanned: number;
    stocksMatched: number;
    optionsUnderlyingsScanned: number;
    optionsContractsMatched: number;
    hits: number;
  };
  partial?: { failedClasses: string[]; reasons: Record<string, string> };
  completedAt: string;
}

interface BacktestResult {
  provenance: string;
  aggregate: {
    totalTrades: number;
    totalNetPnl: number;
    totalReturnPct: number;
    winRate: number | null;
    maxDrawdownPct: number;
  };
  limitations: string[];
}

interface GoalScreenPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.85rem",
  color: "var(--color-text-muted)",
};

export function GoalScreenPanel({ activeEnv, userLogin }: GoalScreenPanelProps) {
  const [goalKind, setGoalKind] = useState("income");
  const [direction, setDirection] = useState("");
  const [symbolsText, setSymbolsText] = useState("");
  const [includeStocks, setIncludeStocks] = useState(true);
  const [includeOptions, setIncludeOptions] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<GoalScreenResult | null>(null);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestError, setBacktestError] = useState("");

  const stockHits = useMemo(
    () =>
      result
        ? [...new Set(result.hits.filter((h) => h.assetClass === "stocks").map((h) => h.symbol))]
        : [],
    [result]
  );

  const runScreen = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    const assetClasses = [
      ...(includeStocks ? ["stocks"] : []),
      ...(includeOptions ? ["options"] : []),
    ];
    if (assetClasses.length === 0) {
      setError("Select at least one asset class to screen.");
      return;
    }
    const symbols = symbolsText
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    setLoading(true);
    setError("");
    setResult(null);
    setBacktest(null);
    setBacktestError("");
    try {
      const res = await fetch("/api/screening/goal-screen", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          goalKind,
          environment: activeEnv,
          ...(direction ? { direction } : {}),
          ...(symbols.length > 0 ? { symbols } : {}),
          assetClasses,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        result?: GoalScreenResult;
      };
      // A failed run (every asset class down) answers 502 WITH the
      // labeled result — render it; only a body without a result is
      // a plain error.
      if (data.result) {
        setResult(data.result);
        if (!res.ok) setError(data.error || "The goal screen failed on every requested asset class.");
      } else {
        throw new Error(data.error || `Goal screen request failed [HTTP ${res.status}].`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Goal screen request failed.");
    } finally {
      setLoading(false);
    }
  };

  const runBacktest = async () => {
    if (backtestLoading || stockHits.length === 0) return;
    setBacktestLoading(true);
    setBacktestError("");
    setBacktest(null);
    try {
      const res = await fetch("/api/screening/backtest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ symbols: stockHits }),
      });
      const data = (await res.json()) as { error?: string } & BacktestResult;
      if (!res.ok) throw new Error(data.error || `Backtest request failed [HTTP ${res.status}].`);
      setBacktest(data);
    } catch (err) {
      setBacktestError(err instanceof Error ? err.message : "Backtest request failed.");
    } finally {
      setBacktestLoading(false);
    }
  };

  const statusStyle: React.CSSProperties =
    result?.status === "complete"
      ? { background: "var(--color-success-subtle)", color: "var(--color-success)" }
      : result?.status === "partial"
        ? { background: "var(--color-warning-subtle)", color: "var(--color-warning)" }
        : { background: "var(--color-danger-subtle)", color: "var(--color-danger)" };

  return (
    <div style={{ padding: "1rem 0" }}>
      <p style={{ margin: "0 0 1rem", color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
        Run a goal-driven screen through the unified screening stack: the goal&rsquo;s scenario
        drives one screen across stocks and options, executed by the shared provider registry.
        Results are recorded in Reports and the screening activity log.
      </p>
      <form onSubmit={runScreen} style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-end" }}>
        <label style={fieldStyle}>
          Goal
          <select value={goalKind} onChange={(e) => setGoalKind(e.target.value)}>
            {GOAL_KIND_OPTIONS.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          Direction
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            {DIRECTION_OPTIONS.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        <label style={{ ...fieldStyle, flex: "1 1 220px" }}>
          Symbols (optional, comma-separated — scopes the options leg only; the stock leg always scans the full universe)
          <input
            type="text"
            value={symbolsText}
            onChange={(e) => setSymbolsText(e.target.value)}
            placeholder="AAPL, NVDA, MSFT"
          />
        </label>
        <label style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: "0.4rem" }}>
          <input type="checkbox" checked={includeStocks} onChange={(e) => setIncludeStocks(e.target.checked)} />
          Stocks
        </label>
        <label style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: "0.4rem" }}>
          <input type="checkbox" checked={includeOptions} onChange={(e) => setIncludeOptions(e.target.checked)} />
          Options
        </label>
        <button type="submit" disabled={loading}>
          {loading ? "Screening…" : "Run goal screen"}
        </button>
      </form>

      {error && <div className="options-error" role="alert">{error}</div>}

      {result && (
        <div style={{ marginTop: "1rem" }}>
          <div
            role="status"
            style={{ ...statusStyle, padding: "0.5rem 0.75rem", borderRadius: "6px", fontWeight: 600 }}
          >
            {result.status === "complete" && `Complete — ${result.goalKind} (${result.outlook})`}
            {result.status === "partial" &&
              `PARTIAL — ${result.partial?.failedClasses.join(", ")} failed: ${Object.values(result.partial?.reasons ?? {}).join("; ")}`}
            {result.status === "failed" && "Failed — the screen produced no complete result."}
          </div>
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
            Scanned {result.counts.stocksScanned} stocks ({result.counts.stocksMatched} matched),{" "}
            {result.counts.optionsUnderlyingsScanned} option underlyings ({result.counts.optionsContractsMatched}{" "}
            contracts matched); {result.counts.hits} hit(s).
          </p>
          {result.hits.length > 0 && (
            <table style={{ borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.25rem 0.75rem 0.25rem 0" }}>Symbol</th>
                  <th style={{ textAlign: "left", padding: "0.25rem 0.75rem 0.25rem 0" }}>Asset class</th>
                  <th style={{ textAlign: "left", padding: "0.25rem 0.75rem 0.25rem 0" }}>Provider</th>
                  {/* Issue #1963: stock hits never carry structures, so a
                      structures column over a structure-less result is
                      6594 meaningless dashes — hide it unless at least
                      one hit actually carries structures. */}
                  {result.hits.some((hit) => (hit.structures?.length ?? 0) > 0) && (
                    <th style={{ textAlign: "left" }}>Candidate structures</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {result.hits.map((hit, i) => (
                  <tr key={`${hit.assetClass}-${hit.symbol}-${i}`}>
                    <td style={{ padding: "0.25rem 0.75rem 0.25rem 0", fontWeight: 600 }}>{hit.symbol}</td>
                    <td style={{ padding: "0.25rem 0.75rem 0.25rem 0" }}>{hit.assetClass}</td>
                    <td style={{ padding: "0.25rem 0.75rem 0.25rem 0" }}>{hit.providerId}</td>
                    {result.hits.some((h) => (h.structures?.length ?? 0) > 0) && (
                      <td>{hit.structures?.join(", ") ?? "—"}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {stockHits.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <button type="button" onClick={runBacktest} disabled={backtestLoading}>
                {backtestLoading ? "Backtesting…" : `Backtest the ${stockHits.length} stock hit(s)`}
              </button>
              {backtestError && <div className="options-error" role="alert">{backtestError}</div>}
              {backtest && (
                <div style={{ marginTop: "0.75rem", fontSize: "0.9rem" }}>
                  <p style={{ margin: "0 0 0.5rem" }}>
                    <strong>Backtest (provenance: {backtest.provenance})</strong> — {backtest.aggregate.totalTrades}{" "}
                    trade(s), net ${backtest.aggregate.totalNetPnl.toLocaleString("en-US")} (
                    {backtest.aggregate.totalReturnPct}%), win rate{" "}
                    {backtest.aggregate.winRate === null
                      ? "n/a"
                      : `${Math.round(backtest.aggregate.winRate * 100)}%`}
                    , max drawdown {backtest.aggregate.maxDrawdownPct}%.
                  </p>
                  <ul style={{ margin: 0, color: "var(--color-text-muted)" }}>
                    {backtest.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
