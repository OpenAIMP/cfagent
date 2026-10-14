import React, { useCallback, useEffect, useMemo, useState } from "react";

type AsyncJob = {
  jobId: string;
  capability: string;
  label: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};

export interface AsyncJobsPanelProps {
  embedded?: boolean;
}

export function AsyncJobsPanel({ embedded = false }: AsyncJobsPanelProps = {}) {
  const [jobs, setJobs] = useState<AsyncJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>();
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState("");
  const resultJson = useMemo(() => result === undefined ? "" : JSON.stringify(result, null, 2), [result]);

  const refresh = useCallback(async () => {
    try {
      const response = await globalThis.fetch("/api/jobs?limit=30");
      const data = await response.json() as { jobs?: AsyncJob[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load async jobs.");
      setJobs(data.jobs || []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load async jobs.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const openResult = async (jobId: string) => {
    setSelectedJob(jobId);
    setResult(undefined);
    setError("");
    try {
      const response = await globalThis.fetch(`/api/jobs/${jobId}`);
      const job = await response.json() as AsyncJob & { result?: unknown };
      if (!response.ok) throw new Error((job as { error?: string }).error || "Could not load job result.");
      if (job.status === "failed") throw new Error(job.error || "Async job failed.");
      setResult(job.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load job result.");
    }
  };

  const downloadResult = () => {
    if (result === undefined || !selectedJob) return;
    const blobUrl = URL.createObjectURL(new Blob([resultJson], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `async-job-${selectedJob}.json`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
  };

  const activeCount = jobs.filter((job) => job.status === "queued" || job.status === "running").length;

  if (embedded) {
    return (
      <div className="settings-async-jobs-box">
        <div className="async-jobs-subhead">
          <div className="async-status-pill-badge">
            <span className={`async-dot ${activeCount > 0 ? "active" : "idle"}`} />
            <span className="async-count-txt">
              {activeCount > 0 ? `${activeCount} task${activeCount === 1 ? "" : "s"} running` : "Idle / Queue clear"}
            </span>
          </div>
          <button
            type="button"
            className="btn-async-mini-refresh"
            onClick={() => void refresh()}
            title="Refresh background tasks"
          >
            🔄 Refresh
          </button>
        </div>

        {error && <p className="async-jobs-error" role="alert">{error}</p>}

        {jobs.length === 0 ? (
          <div className="async-jobs-empty-hint">
            <span>No background jobs recorded in this session.</span>
          </div>
        ) : (
          <ul className="settings-async-jobs-list">
            {jobs.slice(0, 5).map((job) => (
              <li key={job.jobId} className={`settings-async-job-item status-${job.status}`}>
                <div className="job-item-main">
                  <span className="job-item-label" title={job.label}>{job.label}</span>
                  <div className="job-item-tags">
                    <span className={`job-tag-status ${job.status}`}>{job.status}</span>
                    <span className="job-tag-time">
                      {new Date(job.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
                {(job.status === "completed" || job.status === "failed") && (
                  <button
                    type="button"
                    className="btn-async-view-result"
                    onClick={() => void openResult(job.jobId)}
                    title={job.status === "completed" ? "Inspect job payload result" : "Inspect failure reason"}
                  >
                    {job.status === "completed" ? "Result" : "Error"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {selectedJob && result !== undefined && (
          <div className="settings-async-result-container">
            <div className="async-result-header">
              <span className="result-job-id" title={selectedJob}>Task: {selectedJob.slice(0, 14)}…</span>
              <button type="button" className="btn-async-download" onClick={downloadResult} title="Export JSON result">
                📥 Export JSON
              </button>
            </div>
            <pre className="settings-async-result-body">
              {resultJson.slice(0, 10_000)}
              {resultJson.length > 10_000 ? "\n… preview truncated; download full JSON." : ""}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <details className="async-jobs-panel">
      <summary>
        Async tasks
        {activeCount > 0 && <span className="async-jobs-count">{activeCount}</span>}
      </summary>
      <div className="async-jobs-content">
        <div className="async-jobs-heading">
          <strong>Background work</strong>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
        {error && <p className="async-jobs-error" role="alert">{error}</p>}
        {jobs.length === 0 ? (
          <p className="async-jobs-empty">Submitted work will appear here.</p>
        ) : (
          <ul className="async-jobs-list">
            {jobs.map((job) => (
              <li key={job.jobId}>
                <span>
                  <strong>{job.label}</strong>
                  <small>{job.status} · {new Date(job.createdAt).toLocaleString()}</small>
                </span>
                {(job.status === "completed" || job.status === "failed") && (
                  <button type="button" onClick={() => void openResult(job.jobId)}>
                    {job.status === "completed" ? "View result" : "View error"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {selectedJob && result !== undefined && (
          <>
            <button type="button" onClick={downloadResult}>Download full result</button>
            <pre className="async-jobs-result">
              {resultJson.slice(0, 100_000)}
              {resultJson.length > 100_000 ? "\n… preview truncated; download the full result." : ""}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}
