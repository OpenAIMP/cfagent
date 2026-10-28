/**
 * Docs and Reports — the document index for the screener workflow.
 *
 * Every run of the screener workflow records the artifacts it produced
 * (PDF / XLSX / CSV) in the Runs read surface (GET /api/runs). This page
 * lists those runs as one row per run, with the run's family
 * (stock / options / goal / strategy), how it was started
 * (manual / scheduled), direct download links for each artifact, and the
 * run id for cross-referencing.
 *
 * The page reads, it never generates: a link is only shown when the run
 * recorded that artifact's key, so a missing file is an honest "—" and
 * not a 404 in disguise.
 */

import { useCallback, useEffect, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  Spinner,
  Table,
  type TableColumn,
} from "./components/ui";
import {
  DOCUMENT_SOURCE_LABELS,
  formatRunTimestamp,
  toDocumentRows,
  type DocumentRow,
  type DocumentRunType,
} from "./docsAndReports";
import "./docsAndReports.css";

const RUN_TYPE_LABELS: Record<DocumentRunType, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
};

function RunTypeCell({ row }: { row: DocumentRow }) {
  if (!row.runType) {
    // Honest absence: some stores record no trigger at all (options scans).
    return (
      <span className="docs-run-type unknown" title="The run's store recorded no trigger">
        —
      </span>
    );
  }
  return (
    <span className={`docs-run-type ${row.runType}`} title={row.rawTrigger ?? undefined}>
      <Badge size="sm" tone={row.runType === "scheduled" ? "info" : "neutral"}>
        {RUN_TYPE_LABELS[row.runType]}
      </Badge>
    </span>
  );
}

function ArtifactLink({
  url,
  kind,
  runId,
  status,
  error,
}: {
  url: string | null;
  kind: "PDF" | "XLSX" | "CSV";
  runId: string;
  status?: string | null;
  error?: string | null;
}) {
  if (!url && status === "failed") {
    // Issue #2088: a recorded leg failure renders as a failure
    // state with its reason, never a bare "—".
    return (
      <span className="docs-artifact-failed" title={error ?? undefined}>
        <Badge size="sm" tone="danger">failed</Badge>
      </span>
    );
  }
  if (!url) {
    return (
      <span className="docs-artifact-missing" title={`This run recorded no ${kind} artifact`}>
        —
      </span>
    );
  }
  return (
    <a
      className="docs-artifact-link"
      href={url}
      download
      title={`Download the ${kind} for run ${runId}`}
      aria-label={`Download the ${kind} for run ${runId}`}
    >
      {kind}
    </a>
  );
}

const COLUMNS: TableColumn<DocumentRow>[] = [
  {
    key: "createdAt",
    header: "Date-Time",
    render: (row) => (
      <time className="docs-time" dateTime={row.createdAt} title={row.createdAt}>
        {formatRunTimestamp(row.createdAt)}
      </time>
    ),
  },
  {
    key: "runType",
    header: "Run Type",
    render: (row) => <RunTypeCell row={row} />,
  },
  {
    key: "runSource",
    header: "Run Source",
    render: (row) => (
      <span className={`docs-source ${row.runSource}`}>
        {DOCUMENT_SOURCE_LABELS[row.runSource]}
      </span>
    ),
  },
  {
    key: "pdf",
    header: "PDF",
    render: (row) => <ArtifactLink url={row.pdfUrl} kind="PDF" runId={row.runId} status={row.pdfStatus} error={row.pdfError} />,
  },
  {
    key: "xlsx",
    header: "XLSX",
    render: (row) => <ArtifactLink url={row.xlsxUrl} kind="XLSX" runId={row.runId} status={row.xlsxStatus} error={row.xlsxError} />,
  },
  {
    key: "csv",
    header: "CSV",
    render: (row) => <ArtifactLink url={row.csvUrl} kind="CSV" runId={row.runId} status={row.csvStatus} error={row.csvError} />,
  },
  {
    key: "runId",
    header: "Run ID",
    render: (row) => (
      <code className="docs-run-id" title={row.runId}>
        {row.runId}
      </code>
    ),
  },
];

export function DocsAndReportsPanel() {
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeErrors, setStoreErrors] = useState<Record<string, string>>({});
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/runs?kind=all&limit=100");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        runs?: unknown[];
        storeErrors?: Record<string, string>;
      };
      setRows(toDocumentRows((data.runs ?? []) as Parameters<typeof toDocumentRows>[0]));
      setStoreErrors(data.storeErrors ?? {});
      setLoadedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const storeErrorNames = Object.keys(storeErrors);

  return (
    <div className="docs-report-page">
      <header className="docs-header">
        <div>
          <h2 className="docs-title">Docs and Reports</h2>
          <p className="docs-scope">
            Every document set produced by a screener-workflow run — stock, options, goal and
            strategy — with the PDF, XLSX and CSV that run generated. Links are shown only when
            the run recorded that artifact.
          </p>
        </div>
        <div className="docs-toolbar">
          {loadedAt && <span className="docs-loaded-at">Updated {loadedAt}</span>}
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </header>

      {error && (
        <Notice tone="danger" title="Documents unavailable">
          {error}{" "}
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </Notice>
      )}

      {!error && storeErrorNames.length > 0 && (
        <Notice tone="warning" title="Some run stores were skipped">
          {storeErrorNames.map((name) => `${name}: ${storeErrors[name]}`).join(" · ")}
        </Notice>
      )}

      {loading && rows.length === 0 ? (
        <div className="docs-loading">
          <Spinner label="Loading documents" />
          <span>Loading documents…</span>
        </div>
      ) : (
        <>
          <div className="docs-count" aria-live="polite">
            {rows.length} {rows.length === 1 ? "run" : "runs"}
          </div>
          <Table
            caption="Documents generated by screener-workflow runs, newest first"
            columns={COLUMNS}
            rows={rows}
            rowKey={(row) => `${row.runSource}:${row.id}`}
            containerClassName="docs-table-container"
            empty={
              <EmptyState
                icon="🗂"
                title="No screener documents yet"
                description="Documents appear here after a stock, options, goal or strategy run completes. Each row links the PDF, XLSX and CSV that run generated."
                action={
                  <Button variant="secondary" size="sm" onClick={() => void load()}>
                    Check again
                  </Button>
                }
              />
            }
          />
        </>
      )}
    </div>
  );
}
