/**
 * ScreenerResultsView (issue #261) — THE single results UI for screening.
 *
 * Used for both manual runs and scheduled runs. One backend (ScreenerAgent),
 * one frontend. Leads with what screening found (opportunities), not raw
 * listings. All columns sortable (click header to toggle asc/desc).
 *
 * Indicator methodology is E*TRADE-honest: computed from snapshot quotes
 * only. Range-based overbought/oversold is labeled as such — never as RSI.
 * RSI(14)/MACD need price history E*TRADE does not provide; shown as "—"
 * when unavailable rather than faked.
 */

import { useMemo, useState } from "react";
import { downloadScreenExport } from "./screenerExport";

export interface StockTechnicalsData {
  rsi14: number | null;
  macdLine: number | null;
  macdSignalLine: number | null;
  macdHistogram: number | null;
  macdSignal: string | null;
  gapPercent: number | null;
  gapDirection: "up" | "down" | "flat" | null;
  historyBars: number;
  historySource: string | null;
}

export interface FactorGradesData {
  value: string | null;
  momentum: string | null;
  growth: null;
  profitability: null;
  revisions: null;
  quantRating: string | null;
  valueScore: number | null;
  momentumScore: number | null;
  compositeScore: number | null;
  gradedFactors: string[];
}

export interface ScreenedIndicatorsData {
  sentiment: string;
  directional: boolean;
  rangeZone: string;
  valueZone: string;
  screenScore: number;
  intradayPosition: number | null;
  rangePosition: number | null;
  summary: string;
}

export interface ScreenerResultData {
  timestamp: string;
  reportUrl?: string;
  /** Durable, per-run PDF key returned by ScreenerAgent. */
  pdfKey?: string;
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
    indicators?: ScreenedIndicatorsData;
    factorGrades?: FactorGradesData;
    technicals?: StockTechnicalsData;
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
    indicators?: ScreenedIndicatorsData;
    factorGrades?: FactorGradesData;
    technicals?: StockTechnicalsData;
  }>;
  discoveryMessage?: string;
  /** Issue #462: qualification when the screen ran on a partial quote set. */
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols: string[];
    failureReasons: Record<string, number>;
  };
  error?: string;
}

type SortKey =
  | "symbol"
  | "lastPrice"
  | "changePercent"
  | "sentiment"
  | "screenScore"
  | "rangeZone"
  | "valueZone"
  | "momentumScore"
  | "rsi14"
  | "quantRating"
  | "valueGrade"
  | "momentumGrade"
  | "gapPercent";

const SENTIMENT_RANK: Record<string, number> = {
  very_bullish: 5,
  bullish: 4,
  neutral: 3,
  bearish: 2,
  very_bearish: 1,
};

const GRADE_RANK: Record<string, number> = {
  "A+": 12, "A": 11, "A-": 10,
  "B+": 9, "B": 8, "B-": 7,
  "C+": 6, "C": 5, "C-": 4,
  "D+": 3, "D": 2, "D-": 1, "F": 0,
};

const QUANT_RANK: Record<string, number> = {
  "Strong Buy": 5, "Buy": 4, "Hold": 3, "Sell": 2, "Strong Sell": 1,
};

const ZONE_RANK: Record<string, number> = {
  overbought: 3,
  neutral: 2,
  oversold: 1,
  overvalued: 3,
  fair: 2,
  undervalued: 1,
};

function sortValue(row: { indicators?: ScreenedIndicatorsData } & Record<string, any>, key: SortKey): number | string {
  switch (key) {
    case "symbol":
      return row.symbol;
    case "sentiment":
      return SENTIMENT_RANK[row.indicators?.sentiment ?? "neutral"] ?? 3;
    case "screenScore":
      return row.indicators?.screenScore ?? 0;
    case "rangeZone":
      return ZONE_RANK[row.indicators?.rangeZone ?? "neutral"] ?? 2;
    case "valueZone":
      return ZONE_RANK[row.indicators?.valueZone ?? "fair"] ?? 2;
    case "rsi14":
      return row.rsi14 ?? -1;
    case "quantRating":
      return QUANT_RANK[row.factorGrades?.quantRating ?? ""] ?? -1;
    case "valueGrade":
      return GRADE_RANK[row.factorGrades?.value ?? ""] ?? -1;
    case "momentumGrade":
      return GRADE_RANK[row.factorGrades?.momentum ?? ""] ?? -1;
    case "gapPercent":
      return row.technicals?.gapPercent ?? -999;
    default:
      return row[key] ?? 0;
  }
}

function useSortable<T extends Record<string, any>>(rows: T[], defaultKey: SortKey, defaultDir: 1 | -1 = -1) {
  const [sortKey, setSortKey] = useState<SortKey>(defaultKey);
  const [sortDir, setSortDir] = useState<1 | -1>(defaultDir);
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (typeof va === "string" && typeof vb === "string")
        return sortDir * va.localeCompare(vb);
      return sortDir * (Number(va) - Number(vb));
    });
    return copy;
  }, [rows, sortKey, sortDir]);
  const toggle = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  };
  return { sorted, sortKey, sortDir, toggle };
}

function SortTh({
  label,
  k,
  sortKey,
  sortDir,
  toggle,
  title,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: 1 | -1;
  toggle: (k: SortKey) => void;
  title?: string;
}) {
  return (
    <th
      onClick={() => toggle(k)}
      title={title ?? `Sort by ${label}`}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
    >
      {label}
      {sortKey === k && <span style={{ marginLeft: "0.25rem" }}>{sortDir === 1 ? "▲" : "▼"}</span>}
    </th>
  );
}

function gradeColor(g: string | null | undefined): string {
  if (!g) return "var(--theme-text-muted)";
  const top = g[0];
  if (top === "A") return "var(--color-success, #30a46c)";
  if (top === "B") return "#8fc76f";
  if (top === "C") return "var(--color-warning, #d4a017)";
  return "var(--color-danger, #e5484d)";
}

function GradeBadge({
  grade,
  withheldReason,
}: {
  grade: string | null | undefined;
  withheldReason?: string;
}) {
  if (!grade) {
    return (
      <span
        title={withheldReason ?? "Insufficient data — grade withheld, not estimated"}
        style={{ color: "var(--theme-text-muted)", cursor: "help" }}
      >
        —
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: "2rem",
        textAlign: "center",
        padding: "0.1rem 0.4rem",
        borderRadius: "4px",
        fontWeight: 700,
        fontSize: "0.8rem",
        color: gradeColor(grade),
        border: `1px solid ${gradeColor(grade)}`,
      }}
    >
      {grade}
    </span>
  );
}

function quantRatingColor(r: string | null | undefined): string {
  if (!r) return "var(--theme-text-muted)";
  if (r === "Strong Buy") return "var(--color-success, #30a46c)";
  if (r === "Buy") return "#8fc76f";
  if (r === "Hold") return "var(--color-warning, #d4a017)";
  if (r === "Sell") return "#e08080";
  return "var(--color-danger, #e5484d)";
}

function GapCell({ t }: { t?: StockTechnicalsData }) {
  if (t?.gapPercent == null) {
    return <td style={{ color: "var(--theme-text-muted)" }} title="No history — gap unavailable">—</td>;
  }
  const arrow = t.gapDirection === "up" ? "▲" : t.gapDirection === "down" ? "▼" : "•";
  const color =
    t.gapDirection === "up"
      ? "var(--color-success, #30a46c)"
      : t.gapDirection === "down"
        ? "var(--color-danger, #e5484d)"
        : "var(--theme-text-muted)";
  return (
    <td style={{ color, fontWeight: 600 }} title={`Overnight gap (Yahoo): ${t.gapPercent.toFixed(2)}%`}>
      {arrow} {t.gapPercent >= 0 ? "+" : ""}{t.gapPercent.toFixed(2)}%
    </td>
  );
}

function ChangeCell({ value }: { value: number }) {
  return (
    <td
      style={{
        color: value >= 0 ? "var(--color-success, #30a46c)" : "var(--color-danger, #e5484d)",
      }}
    >
      {value >= 0 ? "+" : ""}
      {value.toFixed(2)}%
    </td>
  );
}

function sentimentLabel(s?: string): string {
  return (s ?? "neutral").replace(/_/g, " ");
}

function sentimentColor(s?: string): string {
  switch (s) {
    case "very_bullish":
      return "var(--color-success, #30a46c)";
    case "bullish":
      return "var(--color-success, #30a46c)";
    case "very_bearish":
      return "var(--color-danger, #e5484d)";
    case "bearish":
      return "var(--color-danger, #e5484d)";
    default:
      return "var(--theme-text-muted)";
  }
}

export function ScreenerResultsView({ result }: { result: ScreenerResultData }) {
  const triggerLabel = result.trigger === "manual" ? "Manual Screen" : "Autonomous Screen";
  const reportUrl = result.reportUrl || (result.pdfKey
    ? `/api/screener/report.pdf?key=${encodeURIComponent(result.pdfKey)}`
    : "/api/screener/report.pdf");
  const opps = useSortable(result.opportunities, "screenScore");
  const all = useSortable(result.allStocks ?? [], "screenScore");

  // Issue #125 (PR-B) / #126: result-set downloads of THIS run (the one
  // being viewed), beside the PDF report. A failed run produced no
  // result set, so it offers none; partial runs export with their #462
  // qualification carried into the file (see screenerExport.ts).
  const exportButtonStyle = {
    fontSize: "0.8rem",
    padding: "0.35rem 0.75rem",
    borderRadius: "4px",
    border: "1px solid var(--color-accent)",
    color: "var(--color-accent)",
    background: "transparent",
    cursor: "pointer",
  } as const;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        {result.success && (
          <>
            <button
              type="button"
              className="screener-export-csv"
              style={exportButtonStyle}
              onClick={() => downloadScreenExport(result, "standouts")}
              title="Download this run's standout opportunities as CSV"
            >
              ⬇ CSV standouts
            </button>
            {(result.allStocks?.length ?? 0) > 0 && (
              <button
                type="button"
                className="screener-export-csv-all"
                style={exportButtonStyle}
                onClick={() => downloadScreenExport(result, "all-stocks")}
                title="Download every symbol this run scanned as CSV"
              >
                ⬇ CSV all screened
              </button>
            )}
            <button
              type="button"
              className="screener-export-json"
              style={exportButtonStyle}
              onClick={() => downloadScreenExport(result, "run-json")}
              title="Download this run's full result as JSON"
            >
              ⬇ JSON run
            </button>
          </>
        )}
        <a
          href={reportUrl}
          download
          style={{
            fontSize: "0.8rem",
            padding: "0.35rem 0.75rem",
            borderRadius: "4px",
            border: "1px solid var(--color-accent)",
            color: "var(--color-accent)",
            textDecoration: "none",
          }}
        >
          📄 Download PDF report
        </a>
      </div>
      <div style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
        {/* Issue #421: no sector claim when none was selected ("ALL"). */}
        <strong>{triggerLabel}</strong>
        {result.sector && result.sector !== "ALL" && (
          <> • <strong>{result.sector}</strong> sector</>
        )}{" "}
        • {result.totalScanned.toLocaleString()} scanned • {result.matchedCount} matched •{" "}
        <span style={{ color: "var(--theme-text-muted)" }}>
          {new Date(result.timestamp).toLocaleString()}
        </span>
        {!result.success && (
          <span style={{ color: "var(--color-danger, #e5484d)", marginLeft: "0.5rem" }}>
            ⚠️ Failed: {result.error || "E*TRADE unavailable"}
          </span>
        )}
      </div>

      {result.success && result.partial && (
        <div
          style={{
            fontSize: "0.85rem",
            color: "var(--theme-text-warning, #b45309)",
            padding: "0.75rem",
            border: "1px solid var(--theme-text-warning, #b45309)",
            borderRadius: "4px",
            marginBottom: "0.5rem",
          }}
        >
          ⚠️ Partial screen — qualified results: {result.partial.quotedCount} of {result.partial.requestedCount} symbols quoted;{" "}
          {result.partial.failedSymbols.length} unavailable ({result.partial.failedSymbols.slice(0, 5).join(", ")}
          {result.partial.failedSymbols.length > 5 ? "…" : ""}). Results cover the quoted subset only; no fallback data substituted.
        </div>
      )}

      {!result.success ? (
        <div
          style={{
            fontSize: "0.85rem",
            color: "var(--color-danger, #e5484d)",
            padding: "0.75rem",
            border: "1px solid var(--color-danger, #e5484d)",
            borderRadius: "4px",
          }}
        >
          {result.error || "E*TRADE unavailable — no market data. No fallback data substituted."}
        </div>
      ) : (
        <>
          {result.opportunities.length > 0 ? (
            <div className="options-table-scroll">
              <table className="options-comparison-table">
                <thead>
                  <tr>
                    <SortTh label="Symbol" k="symbol" {...opps} />
                    <th>Company</th>
                    <SortTh label="Sentiment" k="sentiment" {...opps} title="Day-action sentiment: very bearish → very bullish" />
                    <SortTh label="Score" k="screenScore" {...opps} title="Composite 0-100 screening score (heuristic)" />
                    <SortTh label="Quant" k="quantRating" {...opps} title="Quant rating from graded factors (Strong Buy → Strong Sell)" />
                    <SortTh label="Val" k="valueGrade" {...opps} title="Value factor grade A+…F (P/E + 52-week position, relative)" />
                    <SortTh label="Mom" k="momentumGrade" {...opps} title="Momentum factor grade A+…F (relative)" />
                    <SortTh label="Price" k="lastPrice" {...opps} />
                    <SortTh label="Change" k="changePercent" {...opps} />
                    <SortTh label="Gap" k="gapPercent" {...opps} title="Overnight gap % (open vs prev close, Yahoo)" />
                    <SortTh label="Range" k="rangeZone" {...opps} title="Range-based overbought/oversold (52-week position, not RSI)" />
                    <SortTh label="Value" k="valueZone" {...opps} title="Heuristic value zone (P/E + 52-week position)" />
                  </tr>
                </thead>
                <tbody>
                  {opps.sorted.map((o) => (
                    <tr key={o.symbol}>
                      <td>
                        <strong>{o.symbol}</strong>
                        {o.indicators?.directional && (
                          <span title="Strong directional move (|change| ≥ 2%)" style={{ marginLeft: "0.3rem" }}>
                            ⚡
                          </span>
                        )}
                      </td>
                      <td>{o.companyName}</td>
                      <td style={{ color: sentimentColor(o.indicators?.sentiment), fontWeight: 600 }}>
                        {sentimentLabel(o.indicators?.sentiment)}
                      </td>
                      <td>
                        <strong>{o.indicators?.screenScore ?? "—"}</strong>
                      </td>
                      <td style={{ color: quantRatingColor(o.factorGrades?.quantRating), fontWeight: 700, whiteSpace: "nowrap" }}>
                        {o.factorGrades?.quantRating ?? "—"}
                      </td>
                      <td><GradeBadge grade={o.factorGrades?.value} /></td>
                      <td><GradeBadge grade={o.factorGrades?.momentum} /></td>
                      <td>${o.lastPrice.toFixed(2)}</td>
                      <ChangeCell value={o.changePercent} />
                      <GapCell t={o.technicals} />
                      <td>{o.indicators?.rangeZone ?? "—"}</td>
                      <td>{o.indicators?.valueZone ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ fontSize: "0.85rem", color: "var(--theme-text-muted)" }}>
              No standout opportunities in this run.
            </div>
          )}

          {(result.allStocks?.length ?? 0) > 0 && (
            <details style={{ marginTop: "0.75rem" }}>
              <summary
                style={{
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  color: "var(--color-accent)",
                }}
              >
                All {result.allStocks!.length} screened symbols (click column headers to sort)
              </summary>
              <div className="options-table-scroll" style={{ marginTop: "0.5rem" }}>
                <table className="options-comparison-table">
                  <thead>
                    <tr>
                      <SortTh label="Symbol" k="symbol" {...all} />
                      <th>Company</th>
                      <SortTh label="Price" k="lastPrice" {...all} />
                      <SortTh label="Change" k="changePercent" {...all} />
                      <SortTh label="Gap" k="gapPercent" {...all} title="Overnight gap % (Yahoo)" />
                      <SortTh label="Sentiment" k="sentiment" {...all} />
                      <SortTh label="Score" k="screenScore" {...all} />
                      <SortTh label="Quant" k="quantRating" {...all} />
                      <SortTh label="Val" k="valueGrade" {...all} />
                      <SortTh label="Mom" k="momentumGrade" {...all} />
                      <SortTh label="Momentum" k="momentumScore" {...all} />
                      <SortTh label="Range" k="rangeZone" {...all} title="Range-based (52-week position), not RSI" />
                      <SortTh label="Value" k="valueZone" {...all} />
                      <SortTh label="RSI(14)" k="rsi14" {...all} title="Real RSI(14) from Yahoo daily history" />
                      <th title="MACD(12,26,9) from Yahoo daily history">MACD</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {all.sorted.map((s) => (
                      <tr key={s.symbol}>
                        <td>
                          <strong>{s.symbol}</strong>
                          {s.indicators?.directional && (
                            <span title="Strong directional move" style={{ marginLeft: "0.3rem" }}>
                              ⚡
                            </span>
                          )}
                        </td>
                        <td>{s.companyName}</td>
                        <td>${s.lastPrice.toFixed(2)}</td>
                        <ChangeCell value={s.changePercent} />
                        <GapCell t={s.technicals} />
                        <td style={{ color: sentimentColor(s.indicators?.sentiment) }}>
                          {sentimentLabel(s.indicators?.sentiment)}
                        </td>
                        <td>
                          <strong>{s.indicators?.screenScore ?? "—"}</strong>
                        </td>
                        <td style={{ color: quantRatingColor(s.factorGrades?.quantRating), fontWeight: 700, whiteSpace: "nowrap" }}>
                          {s.factorGrades?.quantRating ?? "—"}
                        </td>
                        <td><GradeBadge grade={s.factorGrades?.value} /></td>
                        <td><GradeBadge grade={s.factorGrades?.momentum} /></td>
                        <td>{s.momentumScore.toFixed(0)}</td>
                        <td>{s.indicators?.rangeZone ?? "—"}</td>
                        <td>{s.indicators?.valueZone ?? "—"}</td>
                        <td title={s.technicals?.historySource ? `RSI(14) from ${s.technicals.historySource} (${s.technicals.historyBars} bars)` : "No history — RSI unavailable"}>
                          {s.rsi14 == null ? "—" : s.rsi14.toFixed(1)}
                        </td>
                        <td
                          style={{ fontSize: "0.75rem" }}
                          title={s.technicals?.macdSignal ?? "No history — MACD unavailable"}
                        >
                          {s.technicals?.macdHistogram == null
                            ? "—"
                            : `${s.technicals.macdHistogram >= 0 ? "+" : ""}${s.technicals.macdHistogram.toFixed(2)}`}
                        </td>
                        <td style={{ fontSize: "0.75rem", color: "var(--theme-text-muted)" }}>
                          {s.source}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
