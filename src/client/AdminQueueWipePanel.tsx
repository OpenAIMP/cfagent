/**
 * #2173 admin-panel Queue tab — wipe surface for the own instance.
 *
 * Reads and mutates ONLY through existing routes (see adminQueueApi):
 * GET /api/schedules (dump), POST /api/schedules/cancel-all
 * (preview + confirm), POST /api/maintenance/clear-table (preview +
 * confirm), POST /api/schedules/create (Track 1 recreation).
 *
 * Scope honesty, stated on the tab itself: this surface wipes the
 * OWN instance's queue only. Cross-instance / platform-wide wipe is
 * deliberately NOT offered (today's routes are own-instance by
 * design; platform-admin authority over another login's queue is
 * undecided). This tab loads under the panel's platform-admin gate;
 * a tenant-admin-gated wipe surface does not exist yet, so tenant
 * scope is not offered here either.
 *
 * Flow for every destructive action: preview first (fail-closed,
 * nothing cancelled), modal confirm, confirmed action, then a
 * re-fetched dump shown as the verify step. Paused records are
 * preserved by the cancel-all route and are never deleted by it.
 * Track 1 recreation is a separate explicit action, never automatic.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./components/ui/Button";
import { Modal } from "./components/ui/Modal";
import { Notice } from "./components/ui/Notice";
import { Spinner } from "./components/ui/Spinner";
import { Table } from "./components/ui/Table";
import {
  type CancelAllPreview,
  type CancelAllResult,
  type ClearableTable,
  type ClearTablePreview,
  type ClearTableResult,
  type QueueDump,
  type RecreateResultItem,
  confirmCancelAll,
  confirmClearTable,
  fetchQueueDump,
  previewCancelAll,
  previewClearTable,
  recreateTrack1,
  track1RecreatePlan,
} from "./adminQueueApi";

const CLEARABLE_TABLES: ClearableTable[] = ["mas_async_jobs", "mas_job_outcomes", "paused_schedules"];

function cadenceOf(row: { cron?: string; intervalSeconds?: number }): string {
  if (row.cron) return row.cron;
  if (typeof row.intervalSeconds === "number") return `Every ${row.intervalSeconds / 60} min`;
  return "—";
}

function deliveryOf(payload: Record<string, unknown>): string {
  const slack = typeof payload.slackChannel === "string" ? payload.slackChannel : undefined;
  const email = typeof payload.emailTo === "string" ? payload.emailTo : undefined;
  if (slack && email) return `${slack} + ${email}`;
  if (slack) return slack;
  if (email) return email;
  return "Env channel (no explicit delivery)";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AdminQueueWipePanel() {
  const [dump, setDump] = useState<QueueDump | null>(null);
  const [dumpError, setDumpError] = useState<string | null>(null);
  const [dumpBusy, setDumpBusy] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const [cancelPreview, setCancelPreview] = useState<CancelAllPreview | null>(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelResult, setCancelResult] = useState<CancelAllResult | null>(null);
  const [cancelVerified, setCancelVerified] = useState(false);

  const [clearTable, setClearTable] = useState<ClearableTable | null>(null);
  const [clearPreview, setClearPreview] = useState<ClearTablePreview | null>(null);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearResult, setClearResult] = useState<ClearTableResult | null>(null);

  const [recreateModalOpen, setRecreateModalOpen] = useState(false);
  const [recreateBusy, setRecreateBusy] = useState(false);
  const [recreateResults, setRecreateResults] = useState<RecreateResultItem[] | null>(null);

  const track1Plan = useMemo(() => {
    try {
      return { items: track1RecreatePlan(), error: null as string | null };
    } catch (err) {
      return { items: [], error: messageOf(err) };
    }
  }, []);

  const loadDump = useCallback(async () => {
    setDumpBusy(true);
    setDumpError(null);
    try {
      setDump(await fetchQueueDump());
    } catch (err) {
      setDumpError(messageOf(err));
    } finally {
      setDumpBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadDump();
  }, [loadDump]);

  const activeCount = dump ? dump.schedules.filter((row) => !row.paused).length : 0;
  const pausedCount = dump ? dump.schedules.filter((row) => row.paused).length : 0;

  const onPreviewCancel = useCallback(async () => {
    setActionError(null);
    setCancelResult(null);
    setCancelVerified(false);
    setCancelBusy(true);
    try {
      setCancelPreview(await previewCancelAll());
      setCancelModalOpen(true);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setCancelBusy(false);
    }
  }, []);

  const onConfirmCancel = useCallback(async () => {
    setCancelBusy(true);
    try {
      const result = await confirmCancelAll();
      setCancelResult(result);
      setCancelModalOpen(false);
      setCancelPreview(null);
      await loadDump();
      setCancelVerified(true);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setCancelBusy(false);
    }
  }, [loadDump]);

  const onPreviewClear = useCallback(async (table: ClearableTable) => {
    setActionError(null);
    setClearResult(null);
    setClearBusy(true);
    try {
      setClearTable(table);
      setClearPreview(await previewClearTable(table));
      setClearModalOpen(true);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setClearBusy(false);
    }
  }, []);

  const onConfirmClear = useCallback(async () => {
    if (!clearTable) return;
    setClearBusy(true);
    try {
      setClearResult(await confirmClearTable(clearTable));
      setClearModalOpen(false);
      setClearPreview(null);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setClearBusy(false);
    }
  }, [clearTable]);

  const onRecreate = useCallback(async () => {
    setActionError(null);
    setRecreateBusy(true);
    try {
      setRecreateResults(await recreateTrack1());
      setRecreateModalOpen(false);
      await loadDump();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setRecreateBusy(false);
    }
  }, [loadDump]);

  return (
    <div>
      <p className="iaaa-admin-note">
        This tab manages the queue of your own instance only. A wipe here cancels this
        instance&apos;s schedules and clears its own tables — it never touches another
        login&apos;s queue, and there is no platform-wide wipe action on this tab.
        Tenant-scoped wipe is not offered here: this tab loads under the panel&apos;s
        platform-admin gate, and no tenant-admin-gated wipe surface exists yet.
      </p>

      {actionError && (
        <Notice tone="danger" title="Action failed">
          {actionError}
        </Notice>
      )}

      <h3>Queue dump</h3>
      <p className="iaaa-admin-note">
        Read before any destructive action. Refresh after a wipe to verify the queue is empty.
      </p>
      <Button onClick={() => void loadDump()} disabled={dumpBusy}>
        Refresh dump
      </Button>
      {dumpBusy && !dump ? (
        <Spinner />
      ) : dumpError ? (
        <Notice tone="danger" title="Queue dump failed">
          {dumpError}
        </Notice>
      ) : dump ? (
        <>
          <p className="iaaa-admin-note">
            {dump.count} schedule(s) · {activeCount} active · {pausedCount} paused (paused records are preserved, never deleted, by a queue wipe)
          </p>
          <Table
            columns={[
              { key: "callback", header: "Callback", render: (row) => row.callback },
              { key: "id", header: "ID", render: (row) => <code>{row.id}</code> },
              { key: "cadence", header: "Cadence", render: (row) => cadenceOf(row) },
              { key: "universe", header: "Universe", render: (row) => row.universe ?? "—" },
              { key: "status", header: "Status", render: (row) => (row.paused ? "Paused" : "Active") },
            ]}
            rows={dump.schedules}
            rowKey={(row) => row.id}
            empty={<p>No schedules in this instance queue.</p>}
          />
        </>
      ) : null}

      <h3>Cancel all schedules (queue wipe)</h3>
      <p className="iaaa-admin-note">
        Preview first: the preview lists exactly what would be cancelled and how many paused
        records would be preserved, and cancels nothing. Confirm in the dialog to wipe.
        Paused records are preserved, never deleted. Every wipe writes the
        schedules.cancelled.all audit event.
      </p>
      <Button onClick={() => void onPreviewCancel()} disabled={cancelBusy} variant="danger">
        Preview queue wipe
      </Button>
      {cancelResult && (
        <Notice tone={cancelResult.failed.length > 0 ? "warning" : "success"} title="Queue wipe result">
          Cancelled {cancelResult.cancelled} schedule(s); {cancelResult.pausedPreserved} paused record(s) preserved.
          {cancelResult.failed.length > 0 &&
            ` Failed: ${cancelResult.failed.map((f) => `${f.id} (${f.error})`).join(", ")}.`}
        </Notice>
      )}
      {cancelVerified && activeCount === 0 && (
        <Notice tone="success" title="Verify empty">
          Queue verified empty — {pausedCount} paused record(s) preserved, no active schedules remain.
        </Notice>
      )}
      {cancelVerified && activeCount > 0 && (
        <Notice tone="warning" title="Verify: schedules remain">
          {activeCount} active schedule(s) remain after the wipe — see the refreshed dump above.
        </Notice>
      )}
      <Modal
        open={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        title="Confirm queue wipe"
        footer={
          <>
            <Button onClick={() => setCancelModalOpen(false)} disabled={cancelBusy}>
              Keep schedules
            </Button>
            <Button onClick={() => void onConfirmCancel()} disabled={cancelBusy} variant="danger">
              Cancel schedules
            </Button>
          </>
        }
      >
        {cancelPreview && (
          <p>
            {cancelPreview.wouldCancelCount} schedule(s) would be cancelled:{" "}
            {cancelPreview.wouldCancel.map((row) => `${row.callback} (${row.id})`).join(", ") || "none"}.
            {" "}{cancelPreview.pausedPreserved} paused record(s) preserved.
          </p>
        )}
      </Modal>

      <h3>Clear a table</h3>
      <p className="iaaa-admin-note">
        Only the allowlisted tables are offered. Running jobs are never deleted (counted as
        skipped). Audit history (mas_events) is never bulk-clearable; messages are cleared via
        POST /clear, and the framework queue via the cancel-all action above.
      </p>
      {CLEARABLE_TABLES.map((table) => (
        <div key={table}>
          <Button onClick={() => void onPreviewClear(table)} disabled={clearBusy}>
            Preview {table}
          </Button>
        </div>
      ))}
      {clearResult && (
        <Notice tone="success" title="Table cleared">
          Deleted {clearResult.deleted} row(s) from {clearResult.table}
          {typeof clearResult.skippedRunning === "number" ? `; ${clearResult.skippedRunning} running row(s) skipped, never deleted.` : "."}
        </Notice>
      )}
      <Modal
        open={clearModalOpen}
        onClose={() => setClearModalOpen(false)}
        title="Confirm table clear"
        footer={
          <>
            <Button onClick={() => setClearModalOpen(false)} disabled={clearBusy}>
              Keep table
            </Button>
            {clearTable && (
              <Button onClick={() => void onConfirmClear()} disabled={clearBusy} variant="danger">
                Clear {clearTable}
              </Button>
            )}
          </>
        }
      >
        {clearPreview && (
          <p>
            {clearPreview.wouldDelete} row(s) would be deleted from {clearPreview.table} ({clearPreview.scope} scope)
            {clearPreview.breakdown ? ` — ${Object.entries(clearPreview.breakdown).map(([k, v]) => `${k}: ${v}`).join(", ")}` : ""}
            {typeof clearPreview.skippedRunning === "number" ? `. ${clearPreview.skippedRunning} running row(s) would be skipped, never deleted.` : "."}
          </p>
        )}
      </Modal>

      <h3>Recreate Track 1</h3>
      <p className="iaaa-admin-note">
        A separate explicit action, never automatic after a wipe. Review the four schedules
        below; creating them is the recreate half of the wipe decision, and leaving schedules
        off is the alternative — do not press this button unless recreating is intended.
        Creating an account-scoped schedule requires a connected E*TRADE account for this
        environment; a 409 for one leg is reported per schedule and does not hide the others.
      </p>
      {track1Plan.error ? (
        <Notice tone="danger" title="Track 1 plan failed">
          {track1Plan.error}
        </Notice>
      ) : (
        <>
          <Table
            columns={[
              { key: "label", header: "Schedule", render: (row) => row.label },
              { key: "callback", header: "Callback", render: (row) => String(row.requestBody.callback) },
              { key: "cadence", header: "Cadence", render: (row) => String(row.requestBody.cron ?? `Every ${(row.requestBody.intervalSeconds ?? 0) / 60} min`) },
              { key: "universe", header: "Universe", render: (row) => String((row.requestBody.payload as Record<string, unknown>).universe ?? "—") },
              { key: "delivery", header: "Delivery", render: (row) => deliveryOf(row.requestBody.payload as Record<string, unknown>) },
            ]}
            rows={track1Plan.items}
            rowKey={(row) => row.label}
          />
          <Button onClick={() => setRecreateModalOpen(true)} disabled={recreateBusy}>
            Recreate Track 1
          </Button>
        </>
      )}
      {recreateResults && (
        <Notice tone={recreateResults.some((r) => !r.ok) ? "warning" : "success"} title="Track 1 recreation result">
          {recreateResults.map((r) => (r.ok ? `${r.label}: created${r.duplicate ? " (already existed)" : ""}${r.scheduleId ? ` (${r.scheduleId})` : ""}` : `${r.label}: failed — ${r.error}`)).join("; ")}
        </Notice>
      )}
      <Modal
        open={recreateModalOpen}
        onClose={() => setRecreateModalOpen(false)}
        title="Confirm Track 1 recreation"
        footer={
          <>
            <Button onClick={() => setRecreateModalOpen(false)} disabled={recreateBusy}>
              Leave schedules off
            </Button>
            <Button onClick={() => void onRecreate()} disabled={recreateBusy} variant="primary">
              Create 4 schedules
            </Button>
          </>
        }
      >
        <p>
          Create the four Track 1 schedules (2 stock crons, 2 hourly options legs) in this
          instance. This is a separate action from the wipe and only runs when you confirm here.
        </p>
      </Modal>
    </div>
  );
}
