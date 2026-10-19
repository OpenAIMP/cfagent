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
import "./reports.css";

export interface ReportItem {
  id: string;
  runId: string;
  title: string;
  source: string;
  summary: string;
  createdAt: string;
}

const SOURCE_LABELS: Record<string, string> = {
  screener: "📊 Stock Screener",
  options_scanner: "📈 Options Scanner",
  iv_collection: "💹 IV Collection",
};

const SOURCE_COLORS: Record<string, string> = {
  screener: "#3b82f6",
  options_scanner: "#8b5cf6",
  iv_collection: "#10b981",
};

export function ReportsPanel() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

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

  const filteredSources = ["all", "screener", "options_scanner", "iv_collection"];

  return (
    <div className="reports-panel">
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

      {loading && <div className="loading">Loading reports…</div>}
      {error && (
        <div className="error">
          Error: {error} <button onClick={() => fetchReports()}>Retry</button>
        </div>
      )}

      {!loading && !error && reports.length === 0 && (
        <div className="empty">
          <p>No reports found.</p>
          <p className="hint">
            Reports appear here after scheduled runs complete.
            The first reports will land after the next hourly screener run.
          </p>
        </div>
      )}

      <div className="reports-list">
        {reports.map((r) => (
          <div key={r.id} className="report-card">
            <div className="report-header">
              <span
                className="source-badge"
                style={{ backgroundColor: SOURCE_COLORS[r.source] || "#6b7280" }}
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
              <span className="run-id" title={r.runId}>
                Run: {r.runId.slice(0, 12)}…
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
