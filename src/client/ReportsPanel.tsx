/**
 * Issue #309: Reports Panel — list and search persisted screener reports.
 *
 * Displays reports from `mas_reports` (populated by scheduled runs via #278,
 * and by ScreenerAgent.persistRun via #308):
 * - Search box (keyword; semantic via Vectorize in future)
 * - List newest first: title, source, timestamp, universe/thesis
 * - Click through to R2 PDF URL (when available)
 */

import { useState, useEffect, useCallback } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { Button, SegmentedControl } from "./components/ui";
import { ResearchRunDetail } from "./chat/tabs/ResearchRunDetail";
import { ResearchIdeasBrowser } from "./chat/tabs/ResearchIdeasBrowser";
import "./reports.css";

export interface ReportItem {
  id: string;
  runId: string;
  title: string;
  source: string;
  summary: string;
  createdAt: string;
  /** Download URL of the generated PDF, when this report has one (#638). */
  reportUrl?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  screener: "📊 Stock Screener",
  options_scanner: "📈 Options Scanner",
  iv_collection: "💹 IV Collection",
  research_report: "🔬 Research",
};

const SOURCE_COLORS: Record<string, string> = {
  screener: "var(--color-accent)",
  options_scanner: "var(--color-purple)",
  iv_collection: "var(--color-success)",
  research_report: "var(--color-warning)",
};

export function ReportsPanel() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"reports" | "ideas">("reports");

  const fetchReports = useCallback(async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      const res = await fetch(`/api/reports?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as any;
      setReports(data.reports || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, [sourceFilter]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchReports(searchQuery);
  };

  const filteredSources = ["all", "screener", "options_scanner", "iv_collection", "research_report"];

  return (
    <div className="reports-panel">
      <SegmentedControl
        ariaLabel="Reports view"
        value={panelMode}
        onChange={(v) => {
          setPanelMode(v);
          setSelectedReportId(null);
        }}
        options={[
          { id: "reports", label: "Reports" },
          { id: "ideas", label: "Watchlist & Rejected" },
        ]}
      />
      {panelMode === "ideas" ? (
        <ResearchIdeasBrowser
          onOpenReport={(id) => {
            setPanelMode("reports");
            setSelectedReportId(id);
          }}
        />
      ) : (
      <>
      <div className="reports-toolbar">
        <form onSubmit={handleSearch} className="reports-search">
          <input
            type="text"
            placeholder="Search reports… (e.g. NASDAQ100, bullish, NVDA)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          <button type="submit" className="search-btn">🔍 Search</button>
        </form>
        <div className="source-filters">
          {filteredSources.map((s) => (
            <button
              key={s}
              className={`filter-chip ${sourceFilter === s ? "active" : ""}`}
              onClick={() => setSourceFilter(s)}
            >
              {s === "all" ? "All" : SOURCE_LABELS[s] || s}
            </button>
          ))}
        </div>
      </div>

      {!selectedReportId && loading && <div className="loading">Loading reports…</div>}
      {!selectedReportId && error && (
        <div className="error">
          Error: {error} <button onClick={() => fetchReports()}>Retry</button>
        </div>
      )}

      {!selectedReportId && !loading && !error && reports.length === 0 && (
        <div className="empty">
          <p>No reports found.</p>
          <p className="hint">
            Reports appear here after scheduled runs complete.
            The first reports will land after the next hourly screener run.
          </p>
        </div>
      )}

      {selectedReportId ? (
        <ResearchRunDetail
          reportId={selectedReportId}
          onBack={() => setSelectedReportId(null)}
        />
      ) : (
      <div className="reports-list">
        {reports.map((r) => (
          <div key={r.id} className="report-card">
            <div className="report-header">
              <span
                className="source-badge"
                style={{ backgroundColor: SOURCE_COLORS[r.source] || "var(--color-text-dim)" }}
              >
                {SOURCE_LABELS[r.source] || r.source}
              </span>
              <span className="report-time">
                {new Date(r.createdAt).toLocaleString()}
              </span>
            </div>
            <h3 className="report-title">{r.title}</h3>
            <p className="report-summary">{r.summary}</p>
            <div className="report-actions">
              {r.source === "research_report" && (
                <Button variant="secondary" size="sm" onClick={() => setSelectedReportId(r.id)}>
                  View run
                </Button>
              )}
              <span className="run-id" title={r.runId}>
                Run: {r.runId.slice(0, 12)}…
              </span>
              {r.reportUrl && (
                <a className="report-pdf-link" href={r.reportUrl} download>
                  📄 Download PDF
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
      )}
      </>
      )}
    </div>
  );
}
