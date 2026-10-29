import React from "react";
import { Button } from "../components/ui";
import type { OptionsRunSummary } from "./types";

export interface LatestRunsSectionProps {
  latestRuns: OptionsRunSummary[];
  runsLoading: boolean;
  runsError: string | null;
  fetchLatestRuns: () => Promise<void>;
}

export function LatestRunsSection({
  latestRuns,
  runsLoading,
  runsError,
  fetchLatestRuns,
}: LatestRunsSectionProps) {
  return (
      <section className="sched-section-card">
        <header className="sched-section-header">
          <h4>
            <span>📈</span> Latest Autonomous Options Runs
            <span className="sched-count-pill">{latestRuns.length} Runs</span>
          </h4>
          <Button
            type="button"
            className="btn-sched-action-sm"
            onClick={fetchLatestRuns}
            disabled={runsLoading}
          >
            {runsLoading ? "Refreshing…" : "↻ Refresh"}
          </Button>
        </header>

        {runsError ? (
          <p style={{ margin: "0.4rem 0 0", fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>{runsError}</p>
        ) : null}

        {latestRuns.length === 0 && !runsLoading ? (
          <p style={{ margin: "0.4rem 0 0", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
            No options runs recorded yet. A scheduled or manual analysis appears here once it completes.
          </p>
        ) : (
          <div className="schedules-grid">
            {latestRuns.map((run, idx) => (
              <div className="schedule-item-card is-options" key={`${run.timestamp}-${idx}`}>
                <div className="schedule-card-top">
                  <span className={`schedule-type-badge ${run.success ? "interval" : "once"}`}>
                    {run.success ? "completed" : "failed"}
                  </span>
                  <span className="schedule-id-snippet" title={run.timestamp}>
                    {new Date(run.timestamp).toLocaleString()}
                  </span>
                </div>
                <h5 className="schedule-title">
                  {run.symbols && run.symbols.length > 0 ? run.symbols.join(", ") : "Autonomous options analysis"}
                </h5>
                <div className="schedule-payload-details">
                  <div className="payload-row">
                    <span className="payload-label">setups:</span>
                    <span className="payload-value">{run.withTrades ?? 0}</span>
                  </div>
                  <div className="payload-row">
                    <span className="payload-label">trigger:</span>
                    <span className="payload-value">
                      {run.trigger || "scheduled"}
                      {run.thesis ? ` · ${run.thesis}` : ""}
                    </span>
                  </div>
                </div>
                {run.summary ? <p className="schedule-system-note">{run.summary}</p> : null}
                {!run.success && run.error ? (
                  <p style={{ margin: "0.4rem 0 0", fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>{run.error}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
  );
}
