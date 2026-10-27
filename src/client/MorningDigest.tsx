/**
 * Issue #1328: the trusted morning digest of overnight runs, composing
 * existing pieces (job tree, notifications, #218 digest publishers):
 * what ran, what was partial (with qualification), what failed (with
 * codes), what needs approval, artifacts attached.
 *
 * Composition, documented honestly:
 *  - Runs come from the ScreenersHub feed rows (the job tree) passed in
 *    as a prop — the digest adds no run fetch of its own.
 *  - Held items come from the existing pending-confirmations endpoint
 *    (#1324). The digest links to the queue; it does not re-implement it.
 *  - #218 digest snippets are delivery-time only (prepended to Slack /
 *    email text, never stored on the run), so the digest composes stored
 *    run truth instead of re-running the LLM.
 *  - Run entries link to run detail: onSelectRun selects the run in
 *    ScreenersHub, which renders the #1326 RunDetailView for it.
 *    Held items link to the queue: onViewQueue switches the hub to the
 *    reports tab, which renders the #1324 PendingReviewQueue.
 *
 * Overnight window: 18:00 previous day → 09:00 today, viewer-local.
 * Before 09:00 the window is in progress (18:00 yesterday → now), so a
 * morning reader always sees last night's runs. The window is
 * deterministic per morning: one digest per morning.
 *
 * Compliance (docs/agents/ux-architecture.md): built only from
 * src/client/components/ui/ primitives; server-confirmed state only
 * (feed rows + pending endpoint); failures render business messages;
 * evidence is labeled by outcome (Complete/Partial/Failed), never by
 * an unexplained confidence figure. No new CSS, no new backend route.
 */

import { useEffect, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import { Badge, Button, Card, EmptyState, Notice, Spinner } from "./components/ui";
import { formatCountdown } from "./PendingReviewQueue";

/** Overnight window: 18:00 previous day → 09:00 today, viewer-local. */
export interface OvernightWindow {
  startMs: number;
  endMs: number;
  inProgress: boolean;
}

export function overnightWindow(nowMs: number): OvernightWindow {
  const now = new Date(nowMs);
  const today9 = new Date(now);
  today9.setHours(9, 0, 0, 0);
  if (nowMs >= today9.getTime()) {
    // Window ended at 09:00 today; it started 15h earlier (18:00 yesterday).
    return { startMs: today9.getTime() - 15 * 3600 * 1000, endMs: today9.getTime(), inProgress: false };
  }
  // Still night: window runs from 18:00 yesterday through now.
  const start = new Date(now);
  start.setDate(now.getDate() - 1);
  start.setHours(18, 0, 0, 0);
  return { startMs: start.getTime(), endMs: nowMs, inProgress: true };
}

/** Minimal feed-row shape the digest reads (structural — ScreenersHub's rows assign). */
export interface DigestRun {
  timestamp: string;
  universe?: string;
  sector?: string;
  success?: boolean;
  totalScanned?: number;
  matchedCount?: number;
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols?: string[];
    failureReasons?: Record<string, number>;
  } | null;
  reportUrl?: string;
  pdfKey?: string;
  pdfStatus?: string;
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: string;
  error?: string;
}

interface HeldItem {
  confirmationId: string;
  kind: string;
  detail?: string;
  expiresAt?: string;
}

/** Outcome mapping, in parity with ScreenersHub's screenRunStatus (kept local to avoid a circular import). */
export function digestRunStatus(run: DigestRun): "success" | "partial" | "failed" {
  if (run.success === false) return "failed";
  if (run.partial) return "partial";
  return "success";
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MorningDigest({
  runs,
  nowMs,
  onSelectRun,
  onViewQueue,
}: {
  runs: DigestRun[];
  nowMs?: number;
  onSelectRun: (timestamp: string) => void;
  onViewQueue: () => void;
}) {
  const now = nowMs ?? Date.now();
  const window = overnightWindow(now);
  const [held, setHeld] = useState<HeldItem[]>([]);
  const [heldLoading, setHeldLoading] = useState(true);
  const [heldError, setHeldError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/trading/reports/pending");
        const data = (await res.json().catch(() => null)) as { pending?: unknown } | null;
        if (cancelled) return;
        if (!res.ok) {
          setHeldError("Held items could not be loaded.");
          return;
        }
        setHeld(Array.isArray(data?.pending) ? (data.pending as HeldItem[]) : []);
      } catch {
        if (!cancelled) setHeldError("Held items could not be loaded.");
      } finally {
        if (!cancelled) setHeldLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const overnight = runs.filter((run) => {
    const ts = new Date(run.timestamp).getTime();
    return Number.isFinite(ts) && ts >= window.startMs && ts <= window.endMs;
  });
  const partialCount = overnight.filter((r) => digestRunStatus(r) === "partial").length;
  const failedCount = overnight.filter((r) => digestRunStatus(r) === "failed").length;

  return (
    <Card padding="md">
      <h3 style={{ margin: "0 0 0.25rem" }}>Morning digest</h3>
      <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", margin: "0 0 1rem" }}>
        Overnight: {formatTime(window.startMs)} – {formatTime(window.endMs)}
        {window.inProgress ? " (in progress)" : ""} · {overnight.length} ran · {partialCount} partial ·{" "}
        {failedCount} failed · {held.length} held for review
      </p>

      {overnight.length === 0 ? (
        <EmptyState
          title="No runs overnight"
          description="No screener runs finished in the overnight window. Held items below are still actionable."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {overnight.map((run) => {
            const status = digestRunStatus(run);
            const pdfHref = run.reportUrl || (run.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(run.pdfKey)}` : null);
            const xlsxHref = run.xlsxKey ? `/api/screener/report.xlsx?key=${encodeURIComponent(run.xlsxKey)}` : null;
            return (
              <div
                key={run.timestamp}
                style={{
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: "8px",
                  padding: "var(--space-3)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <Badge tone={status === "failed" ? "danger" : status === "partial" ? "warning" : "success"}>
                    {status === "failed" ? "Failed" : status === "partial" ? "Partial" : "Complete"}
                  </Badge>
                  <span style={{ fontWeight: 700 }}>
                    {run.universe || "Screen"} {run.sector ? `· ${run.sector}` : ""}
                  </span>
                  <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
                    {formatTime(new Date(run.timestamp).getTime())}
                    {typeof run.matchedCount === "number" && typeof run.totalScanned === "number"
                      ? ` · ${run.matchedCount} of ${run.totalScanned} matched`
                      : ""}
                  </span>
                </div>
                {run.partial && (
                  <div style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                    Partial: quoted {run.partial.quotedCount} of {run.partial.requestedCount} requested
                    {run.partial.failedSymbols && run.partial.failedSymbols.length > 0
                      ? ` · failed: ${run.partial.failedSymbols.slice(0, 5).join(", ")}`
                      : ""}
                  </div>
                )}
                {status === "failed" && (
                  <div style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                    {run.error || run.pdfError || "Run failed."}
                  </div>
                )}
                {run.pdfStatus === "failed" && run.pdfError && status !== "failed" && (
                  <div style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>PDF failed: {run.pdfError}</div>
                )}
                <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                  <Button variant="secondary" size="sm" onClick={() => onSelectRun(run.timestamp)}>
                    View run detail
                  </Button>
                  {pdfHref && (
                    <a href={pdfHref} target="_blank" rel="noreferrer">
                      PDF
                    </a>
                  )}
                  {xlsxHref && (
                    <a href={xlsxHref} target="_blank" rel="noreferrer">
                      XLSX
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h4 style={{ margin: "1.25rem 0 0.5rem" }}>Held for review</h4>
      {heldError && (
        <Notice tone="danger" density="compact" onDismiss={() => setHeldError(null)}>
          {heldError}
        </Notice>
      )}
      {heldLoading ? (
        <Spinner label="Loading held items…" />
      ) : held.length === 0 ? (
        <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", margin: 0 }}>
          Nothing held for review.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {held.map((item) => (
            <div key={item.confirmationId} style={{ fontSize: "0.85rem" }}>
              <Badge tone="warning">Held for review</Badge>{" "}
              {item.kind}
              {item.detail ? ` · ${item.detail}` : ""}
              {item.expiresAt ? ` · ${formatCountdown(item.expiresAt, now)}` : ""}
            </div>
          ))}
          <div>
            <Button variant="secondary" size="sm" onClick={onViewQueue}>
              View pending-review queue
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
