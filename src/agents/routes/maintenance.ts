/**
 * Maintenance routes: bulk clears for caller-owned tables and queues.
 *
 * Issue #2280 follow-up to POST /api/schedules/cancel-all (PR #2320):
 * cancel-all empties the framework queue (`cf_agents_jobs` — schedules
 * ARE the queue rows), but it deliberately touches nothing else. This
 * endpoint covers the remaining clearable state: the app async-job queue
 * (`mas_async_jobs`), the job-outcome history (`mas_job_outcomes`), and
 * the paused-schedule store (`paused_schedules`).
 *
 * Every clear follows the same contract as cancel-all:
 * - Preview without `{ confirm: true }`: counts what WOULD be deleted,
 *   deletes nothing, writes no audit event.
 * - With confirm: deletes, audits once (`maintenance.table.cleared`).
 * - Scope is always the caller's own state: `mas_async_jobs` is filtered
 *   to the caller's session; the other two tables live in the caller's
 *   own per-user agent instance, so instance-wide IS caller-owned.
 * - Fail-closed allowlist: any other table name is rejected. In
 *   particular `mas_events` (audit history) is NEVER bulk-clearable here,
 *   `mas_messages` is cleared per session via POST /clear (purge), and
 *   the framework queue goes through POST /api/schedules/cancel-all —
 *   each rejection names the right route instead of silently refusing.
 * - `mas_async_jobs` rows with status 'running' are NEVER deleted
 *   (deleting them would orphan in-flight executions); they are counted
 *   as skippedRunning and reported, even if explicitly requested.
 * - `mas_job_outcomes_meta` (the `pruned_at` watermark) is preserved
 *   when outcomes are cleared; it is harmless metadata, not history.
 */

import type { AgentContext } from "agents";
import { SqlPausedScheduleStore } from "../../services/scheduleManagement";

export interface MaintenanceRouteContext {
  /** Durable Object agent context (owner: OrchestratorAgent). */
  agentCtx: AgentContext;
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
}

const CLEARABLE_TABLES = [
  "mas_async_jobs",
  "mas_job_outcomes",
  "paused_schedules",
] as const;

type ClearableTable = (typeof CLEARABLE_TABLES)[number];

function isMissingTable(err: unknown): boolean {
  return (
    err instanceof Error && /no such table/i.test(err.message)
  );
}

export async function handleMaintenanceRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: MaintenanceRouteContext,
): Promise<Response | null> {
  if (
    !path.endsWith("/maintenance/clear-table") ||
    request.method !== "POST"
  ) {
    return null;
  }
  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const table = body.table as string;

    if (table === "mas_events") {
      return Response.json(
        { error: "mas_events (audit history) is never bulk-clearable via this endpoint" },
        { status: 400 },
      );
    }
    if (table === "mas_messages") {
      return Response.json(
        { error: "mas_messages is cleared per session via POST /clear (purge), not here" },
        { status: 400 },
      );
    }
    if (table === "cf_agents_jobs") {
      return Response.json(
        { error: "the framework queue is cleared via POST /api/schedules/cancel-all, not here" },
        { status: 400 },
      );
    }
    if (!(CLEARABLE_TABLES as readonly string[]).includes(table)) {
      return Response.json(
        {
          error: `Unknown or not clearable table: ${table}. Clearable: ${CLEARABLE_TABLES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    const sql = ctx.agentCtx.storage.sql;
    const confirm = body.confirm === true;
    const clearable = table as ClearableTable;

    // Each plan reports scope, preview counts, and (on confirm) the delete.
    // Counts are taken before the delete in the same request, so the
    // reported deleted count is exact (single-threaded DO, no interleaving).
    let scope: string;
    let wouldDelete = 0;
    let skippedRunning = 0;
    let breakdown: Record<string, number> | undefined;
    let runDelete: () => void;

    if (clearable === "mas_async_jobs") {
      scope = "session";
      const requested: string[] | undefined = Array.isArray(body.statuses)
        ? body.statuses.filter((s: unknown) => typeof s === "string")
        : undefined;
      let rows: Array<{ status: string; n: number }> = [];
      try {
        rows = Array.from(
          sql.exec(
            "SELECT status, COUNT(*) AS n FROM mas_async_jobs WHERE session_id = ? GROUP BY status",
            sessionId,
          ),
        ) as Array<{ status: string; n: number }>;
      } catch (err) {
        if (!isMissingTable(err)) throw err;
      }
      breakdown = {};
      for (const row of rows) {
        breakdown[row.status] = row.n;
        if (row.status === "running") {
          skippedRunning = row.n;
        } else if (!requested || requested.includes(row.status)) {
          wouldDelete += row.n;
        }
      }
      const statuses = requested
        ? requested.filter((s) => s !== "running")
        : undefined;
      runDelete = () => {
        try {
          if (statuses && statuses.length > 0) {
            const placeholders = statuses.map(() => "?").join(", ");
            sql.exec(
              `DELETE FROM mas_async_jobs WHERE session_id = ? AND status IN (${placeholders})`,
              sessionId,
              ...statuses,
            );
          } else if (!statuses) {
            sql.exec(
              "DELETE FROM mas_async_jobs WHERE session_id = ? AND status <> 'running'",
              sessionId,
            );
          }
          // Requested statuses all running (or empty): nothing to delete.
        } catch (err) {
          // Fresh instance with no table yet: preview already counted zero.
          if (!isMissingTable(err)) throw err;
        }
      };
    } else if (clearable === "mas_job_outcomes") {
      scope = "instance";
      try {
        const rows = Array.from(
          sql.exec("SELECT COUNT(*) AS n FROM mas_job_outcomes"),
        ) as Array<{ n: number }>;
        wouldDelete = rows[0]?.n ?? 0;
      } catch (err) {
        if (!isMissingTable(err)) throw err;
      }
      runDelete = () => {
        try {
          sql.exec("DELETE FROM mas_job_outcomes");
        } catch (err) {
          if (!isMissingTable(err)) throw err;
        }
      };
    } else {
      scope = "instance";
      const store = new SqlPausedScheduleStore(sql as any);
      wouldDelete = store.list().length;
      runDelete = () => {
        sql.exec("DELETE FROM paused_schedules");
      };
    }

    if (!confirm) {
      return Response.json({
        table: clearable,
        scope,
        confirmed: false,
        confirmRequired: true,
        wouldDelete,
        ...(breakdown ? { breakdown } : {}),
        ...(clearable === "mas_async_jobs" ? { skippedRunning } : {}),
      });
    }

    runDelete();
    ctx.audit("maintenance.table.cleared", "orchestrator", {
      table: clearable,
      scope,
      deletedCount: wouldDelete,
      ...(clearable === "mas_async_jobs" ? { skippedRunning } : {}),
    });
    return Response.json({
      table: clearable,
      scope,
      confirmed: true,
      deleted: wouldDelete,
      ...(clearable === "mas_async_jobs" ? { skippedRunning } : {}),
    });
  } catch (err: any) {
    return Response.json(
      { error: err.message || "Failed to clear table" },
      { status: 500 },
    );
  }
}
