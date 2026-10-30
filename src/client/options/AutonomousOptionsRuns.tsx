/**
 * Issue #223: autonomous options-analysis runs, surfaced in the UI.
 *
 * The scheduler persists its last 20 runs (DO storage, `options:last_runs`)
 * and serves them at GET /api/options/latest; until now they were only
 * visible in the live WebSocket broadcast. This section renders the
 * persisted record — what ran, when, which trigger, whether it succeeded,
 * and its top opportunities — and polls while mounted so a scheduled run
 * appears without a page reload.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState } from "../components/ui";
import { apiFetch as fetch } from "../apiFetch";
import { usePolling } from "../usePolling";
import { getPollingConfig } from "../pollingConfig";

interface OptionsRunOpportunity {
  symbol?: string;
  pick?: { best?: { candidate?: { type?: string } } };
  directionTags?: string[];
}

interface OptionsRun {
  timestamp: string;
  success: boolean;
  trigger: "manual" | "scheduled";
  thesis: string;
  symbols: string[];
  withTrades: number;
  summary: string;
  opportunities: OptionsRunOpportunity[];
  error?: string;
}

export function AutonomousOptionsRuns() {
  const [runs, setRuns] = useState<OptionsRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/options/latest");
      const data = (await res.json()) as { runs?: OptionsRun[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRuns(Array.isArray(data.runs) ? data.runs : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load options runs");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Issue #2419: shared treatment — hidden-pause + externalized
  // cadence (was a hand-rolled 60s setInterval with no visibility
  // handling). The immediate load above is unchanged.
  const optionsLatestMs = getPollingConfig().optionsLatestPollMs;
  usePolling(load, { fastMs: optionsLatestMs, idleMs: optionsLatestMs });

  return (
    <section className="autonomous-runs" aria-label="Autonomous options runs">
      <div className="autonomous-runs-head">
        <h3>🤖 Autonomous Options Runs</h3>
        <Button variant="ghost" tone="subtle" onClick={() => void load()}>
          ↻ Refresh
        </Button>
      </div>
      {loadError && <p className="autonomous-runs-error">Could not load runs: {loadError}</p>}
      {runs === null && !loadError && <p className="autonomous-runs-loading">Loading runs…</p>}
      {runs !== null && runs.length === 0 && (
        <EmptyState
          title="No autonomous options runs yet"
          description="Scheduled scans (the hourly Strategy/Symbol Scanner) and manual options runs will appear here once they complete."
        />
      )}
      {runs !== null && runs.length > 0 && (
        <ul className="autonomous-runs-list">
          {runs.map((run, i) => (
            <li key={`${run.timestamp}-${i}`} className="autonomous-run">
              <div className="autonomous-run-head">
                <Badge tone={run.success ? "success" : "danger"}>
                  {run.success ? "Completed" : "Failed"}
                </Badge>
                <Badge tone="neutral">{run.trigger === "manual" ? "Manual" : "Scheduled"}</Badge>
                <span className="autonomous-run-thesis">{run.thesis}</span>
                <span className="autonomous-run-time">
                  {new Date(run.timestamp).toLocaleString()}
                </span>
              </div>
              <div className="autonomous-run-meta">
                {run.symbols.length} symbols · {run.withTrades} with trades
              </div>
              {run.summary && <p className="autonomous-run-summary">{run.summary}</p>}
              {run.error && <p className="autonomous-runs-error">{run.error}</p>}
              {run.opportunities.length > 0 && (
                <div className="autonomous-run-opps">
                  {run.opportunities.slice(0, 10).map((opp, j) => (
                    <span key={j} className="autonomous-run-opp">
                      {opp.symbol || "?"}
                      {opp.pick?.best?.candidate?.type ? ` · ${opp.pick.best.candidate.type}` : ""}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
