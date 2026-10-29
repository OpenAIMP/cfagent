/**
 * Issue #1326: one run-detail view (natural home ScreenersHub, which
 * already has run-status labels and a runs list) showing a run's full
 * story without opening Slack/email:
 *  - outcome: status, matched/total counts, trigger, universe/sector,
 *    timestamp
 *  - partial qualification (#462 stamp): prominent banner with quoted
 *    vs requested counts, failed symbols, failure reasons — a qualified
 *    partial is never a complete screen, never a failure
 *  - artifacts: PDF/XLSX links + pdfStatus/pdfError (a failed artifact
 *    shows its coded error, never a silent missing link)
 *  - delivery status per channel: the run's confirmations incl.
 *    held (pending) / approved / rejected / expired state
 *
 * Compliance (docs/agents/ux-architecture.md): built only from
 * src/client/components/ui/ primitives; server state is authoritative
 * (confirmations come from GET /trading/reports/confirmations, joined
 * exactly via the run's canonical row); a field the store does not
 * record renders as absent, never invented.
 */

import { Badge, Card, EmptyState, Notice, Spinner } from "./components/ui";

export interface RunDetailPartial {
  quotedCount: number;
  requestedCount: number;
  failedSymbols: string[];
  failureReasons: Record<string, number>;
}

export interface RunDetailRun {
  timestamp: string;
  trigger?: string;
  universe?: string;
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  partial?: RunDetailPartial;
  pdfKey?: string;
  reportUrl?: string;
  pdfStatus?: string;
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: string;
  xlsxError?: string;
}

export interface RunDetailConfirmation {
  confirmationId: string;
  kind: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  detail: string;
}

export interface RunDetailViewProps {
  run: RunDetailRun;
  confirmations: RunDetailConfirmation[];
  confirmationsLoading: boolean;
}

function outcomeOf(run: RunDetailRun): { label: string; tone: "success" | "warning" | "danger" } {
  if (!run.success) return { label: "Failed", tone: "danger" };
  if (run.partial) return { label: "Partial", tone: "warning" };
  return { label: "Complete", tone: "success" };
}

function confirmationLabel(status: string): string {
  if (status === "pending") return "Held for review";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "expired") return "Expired";
  return status;
}

export function RunDetailView({ run, confirmations, confirmationsLoading }: RunDetailViewProps) {
  const outcome = outcomeOf(run);
  const pdfUrl = run.reportUrl || (run.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(run.pdfKey)}` : null);
  const xlsxUrl = run.xlsxKey ? `/api/screener/report.xlsx?key=${encodeURIComponent(run.xlsxKey)}` : null;

  return (
    <Card padding="md">
      <h3 style={{ margin: "0 0 0.75rem" }}>Run detail</h3>

      <section aria-label="Outcome" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Badge tone={outcome.tone}>{outcome.label}</Badge>
          <span>
            {run.matchedCount} matched of {run.totalScanned} scanned
          </span>
        </div>
        <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", marginTop: "0.25rem" }}>
          {(run.universe || "nasdaq100").toUpperCase()} · {run.sector} · {run.trigger || "scheduled"} ·{" "}
          {new Date(run.timestamp).toLocaleString()}
        </div>
      </section>

      {run.partial && (
        <Notice tone="warning" variant="strip" density="compact">
          <strong>Partial run — qualified, not complete.</strong> This screen ran on {run.partial.quotedCount} of{" "}
          {run.partial.requestedCount} requested symbols; {run.partial.requestedCount - run.partial.quotedCount}{" "}
          failed to quote and were not substituted.
          {run.partial.failedSymbols.length > 0 && (
            <div style={{ marginTop: "0.25rem" }}>Failed symbols: {run.partial.failedSymbols.join(", ")}</div>
          )}
          {Object.keys(run.partial.failureReasons).length > 0 && (
            <div style={{ marginTop: "0.25rem" }}>
              Failure reasons:{" "}
              {Object.entries(run.partial.failureReasons)
                .map(([reason, count]) => `${reason}: ${count}`)
                .join(", ")}
            </div>
          )}
        </Notice>
      )}

      <section aria-label="Artifacts" style={{ margin: "1rem 0" }}>
        <h4 style={{ margin: "0 0 0.5rem" }}>Artifacts</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div>
            {pdfUrl ? (
              <a href={pdfUrl} target="_blank" rel="noreferrer">
                📄 Download PDF report
              </a>
            ) : run.pdfError ? (
              <Notice tone="danger" density="compact">
                📄 PDF unavailable — {run.pdfError}
              </Notice>
            ) : run.pdfStatus === "failed" ? (
              <span>📄 PDF generation failed.</span>
            ) : (
              <span>📄 No PDF recorded for this run.</span>
            )}
          </div>
          <div>
            {xlsxUrl ? (
              <a href={xlsxUrl} target="_blank" rel="noreferrer">
                📊 Download XLSX report
              </a>
            ) : run.xlsxError ? (
              <Notice tone="danger" density="compact">
                📊 XLSX unavailable — {run.xlsxError}
              </Notice>
            ) : run.xlsxStatus === "failed" ? (
              <span>📊 XLSX generation failed.</span>
            ) : (
              <span>📊 No XLSX recorded for this run.</span>
            )}
          </div>
        </div>
      </section>

      <section aria-label="Delivery status">
        <h4 style={{ margin: "0 0 0.5rem" }}>Delivery status</h4>
        {confirmationsLoading ? (
          <Spinner label="Loading delivery status…" />
        ) : confirmations.length === 0 ? (
          <EmptyState
            title="No delivery record linked to this run."
            description="This run has no held, approved, or rejected delivery confirmations on record."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {confirmations.map((c) => (
              <div
                key={c.confirmationId}
                style={{
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: "8px",
                  padding: "var(--space-2) var(--space-3)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <Badge tone={c.status === "approved" ? "success" : c.status === "pending" ? "warning" : "neutral"}>
                    {confirmationLabel(c.status)}
                  </Badge>
                  <span style={{ fontWeight: 600 }}>{c.kind}</span>
                  <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>{c.detail}</span>
                </div>
                <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", marginTop: "0.25rem" }}>
                  Created {new Date(c.createdAt).toLocaleString()}
                  {c.decidedAt ? ` · decided ${new Date(c.decidedAt).toLocaleString()}` : ""}
                  {c.decidedBy ? ` by ${c.decidedBy}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </Card>
  );
}
