import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AsyncState, Button, StatusBadge, Surface, type StatusTone } from './components/ui/Foundations';
import './asyncJobs.css';

type AsyncJob = {
  jobId: string; capability: string; label: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string; updatedAt: string; completedAt?: string; error?: string;
};
export interface AsyncJobsPanelProps { embedded?: boolean; }
const tones: Record<AsyncJob['status'], StatusTone> = { queued: 'warning', running: 'info', completed: 'success', failed: 'danger' };

export function AsyncJobsPanel({ embedded = false }: AsyncJobsPanelProps = {}) {
  const [jobs, setJobs] = useState<AsyncJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState('');
  const [selectedJob, setSelectedJob] = useState<string>();
  const [result, setResult] = useState<unknown>();
  const [resultLoading, setResultLoading] = useState(false);
  const [resultLoaded, setResultLoaded] = useState(false);
  const [resultError, setResultError] = useState('');
  const mounted = useRef(false);
  const listRequest = useRef<AbortController | null>(null);
  const resultRequest = useRef<AbortController | null>(null);
  const headingId = useId();
  const resultId = useId();
  const resultHeadingId = useId();
  const resultJson = useMemo(() => result === undefined ? '' : JSON.stringify(result, null, 2), [result]);

  const refresh = useCallback(async () => {
    if (!mounted.current || listRequest.current) return;
    const controller = new AbortController();
    listRequest.current = controller;
    setRefreshing(true);
    try {
      const response = await globalThis.fetch('/api/jobs?limit=30', { signal: controller.signal });
      const data = await response.json() as { jobs?: AsyncJob[]; error?: string };
      if (!response.ok) throw new Error(data?.error || 'Could not load async jobs.');
      if (!data || (data.jobs !== undefined && !Array.isArray(data.jobs))) throw new Error('Invalid jobs response.');
      if (!mounted.current || controller.signal.aborted || listRequest.current !== controller) return;
      setJobs(data.jobs || []);
      setLoaded(true);
      setListError('');
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && listRequest.current === controller) {
        setListError(cause instanceof Error ? cause.message : 'Could not load async jobs.');
      }
    } finally {
      if (listRequest.current === controller) {
        listRequest.current = null;
        if (mounted.current) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      listRequest.current?.abort();
      resultRequest.current?.abort();
      listRequest.current = null;
      resultRequest.current = null;
    };
  }, [refresh]);

  const openResult = async (jobId: string) => {
    resultRequest.current?.abort();
    const controller = new AbortController();
    resultRequest.current = controller;
    setSelectedJob(jobId);
    setResult(undefined);
    setResultLoaded(false);
    setResultLoading(true);
    setResultError('');
    try {
      const response = await globalThis.fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal });
      const job = await response.json() as AsyncJob & { result?: unknown };
      if (!response.ok) throw new Error(job?.error || 'Could not load job result.');
      if (!job) throw new Error('Invalid job response.');
      if (job.status === 'failed') throw new Error(job.error || 'Async job failed.');
      if (!mounted.current || controller.signal.aborted || resultRequest.current !== controller) return;
      setResult(job.result);
      setResultLoaded(true);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && resultRequest.current === controller) {
        setResultError(cause instanceof Error ? cause.message : 'Could not load job result.');
      }
    } finally {
      if (resultRequest.current === controller) {
        resultRequest.current = null;
        if (mounted.current) setResultLoading(false);
      }
    }
  };

  const closeResult = () => {
    resultRequest.current?.abort();
    resultRequest.current = null;
    setSelectedJob(undefined);
    setResult(undefined);
    setResultLoading(false);
    setResultLoaded(false);
    setResultError('');
  };

  const downloadResult = () => {
    if (result === undefined || !selectedJob) return;
    const url = URL.createObjectURL(new Blob([resultJson], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `async-job-${selectedJob}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const activeCount = jobs.filter(job => job.status === 'queued' || job.status === 'running').length;
  const visibleJobs = embedded ? jobs.slice(0, 5) : jobs;
  const previewLimit = embedded ? 10_000 : 100_000;
  const content = <Surface className="ds-jobs" role="region" aria-labelledby={headingId}>
    <div className="ds-jobs-toolbar">
      <strong id={headingId}>Background work</strong>
      {loaded && <StatusBadge tone={activeCount ? 'info' : 'neutral'}>{activeCount ? `${activeCount} active task${activeCount === 1 ? '' : 's'}` : 'No active tasks'}</StatusBadge>}
      <Button size="sm" loading={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
    </div>
    {listError && <AsyncState state="error" title={loaded ? 'Could not refresh background jobs' : 'Could not load background jobs'} description={listError}
      action={<Button size="sm" disabled={refreshing} onClick={() => void refresh()}>Retry loading jobs</Button>} />}
    {!loaded && !listError && <AsyncState state="loading" title="Loading background jobs…" />}
    {loaded && jobs.length === 0 && !listError && <AsyncState state="empty" title="No background jobs" description="Submitted work will appear here." />}
    {loaded && jobs.length > 0 && <ul className="ds-jobs-list">
      {visibleJobs.map(job => <li key={job.jobId} className="ds-jobs-item">
        <div className="ds-jobs-meta">
          <strong>{job.label}</strong>
          <div className="ds-jobs-tags">
            <StatusBadge tone={tones[job.status] || 'neutral'}>{job.status}</StatusBadge>
            <span className="ds-jobs-time">{new Date(job.createdAt).toLocaleString()}</span>
          </div>
        </div>
        {(job.status === 'completed' || job.status === 'failed') && <Button size="sm"
          aria-label={`${job.status === 'completed' ? 'View result' : 'View error'} for ${job.label}`}
          aria-controls={selectedJob === job.jobId ? resultId : undefined}
          aria-expanded={selectedJob === job.jobId} onClick={() => void openResult(job.jobId)}>
          {job.status === 'completed' ? 'View result' : 'View error'}
        </Button>}
      </li>)}
    </ul>}
    {embedded && jobs.length > visibleJobs.length && <p className="ds-jobs-note">Showing {visibleJobs.length} of {jobs.length} recent jobs.</p>}
    {selectedJob && <Surface tone="sunken" id={resultId} role="region" aria-labelledby={resultHeadingId}>
      <div className="ds-jobs-toolbar">
        <strong id={resultHeadingId} className="ds-jobs-id">Task: {selectedJob}</strong>
        {result !== undefined && <Button size="sm" onClick={downloadResult}>Export JSON</Button>}
        <Button size="sm" onClick={closeResult}>Close result</Button>
      </div>
      {resultLoading && <AsyncState state="loading" title="Loading job result…" />}
      {resultError && <AsyncState state="error" title="Job result unavailable" description={resultError}
        action={<Button size="sm" onClick={() => void openResult(selectedJob)}>Retry result</Button>} />}
      {resultLoaded && result === undefined && <AsyncState state="empty" title="No result payload available" description="The job returned no result payload. Refresh the job result to check again."
        action={<Button size="sm" onClick={() => void openResult(selectedJob)}>Refresh result</Button>} />}
      {result !== undefined && <pre className="ds-jobs-result" tabIndex={0} aria-label={`JSON result for task ${selectedJob}`}>
        {resultJson.slice(0, previewLimit)}{resultJson.length > previewLimit ? '\n… preview truncated; export full JSON.' : ''}
      </pre>}
    </Surface>}
  </Surface>;

  if (embedded) return content;
  return <details className="ds-jobs-disclosure">
    <summary>Async tasks{activeCount > 0 ? ` (${activeCount} active)` : ''}</summary>
    {content}
  </details>;
}
