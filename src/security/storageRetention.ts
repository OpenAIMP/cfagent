/**
 * Issue #255 (Assessment P1, part of #143): mas_messages retention.
 *
 * The `scheduled()` handler's nightly cron (`0 4 * * *`, see wrangler.jsonc)
 * triggers this pass through the Orchestrator agent's
 * `/schedules/trigger-retention` route. The pass deletes mas_messages rows
 * older than the retention window, oldest first, in bounded batches, with a
 * per-run cap — and records one mas_events row per run summarizing the work.
 *
 * Design notes:
 * - Window is env-configurable via MAS_MESSAGES_RETENTION_DAYS (string or
 *   number). Default 90 days, matching the retention the UI advertises.
 *   A window <= 0 DISABLES the pass entirely (rows are never touched).
 * - `created_at` is stored as ISO-8601 strings, so the cutoff comparison is
 *   a lexicographic `<` — correct for that format in both real SQLite and
 *   the test mock.
 * - R2 archival-before-delete is deliberately NOT here (follow-on: no
 *   bucket exists yet). When it lands, this module is the hook point:
 *   archive the batch before deleting it.
 * - The module is SDK-free and pure against DatabaseORM, so the whole
 *   policy is unit-testable.
 */

import type { DatabaseORM } from "../orm";
// Issue #278: durable scheduled-run reports for the AI Search agent.

/** Default retention window, days — matches the 90d the UI advertises. */
export const STORAGE_RETENTION_DEFAULT_DAYS = 90;

/** Rows fetched + deleted per batch (keeps each DELETE bounded). */
export const STORAGE_RETENTION_DEFAULT_BATCH_SIZE = 500;

/** Safety cap: maximum rows deleted in a single run. */
export const STORAGE_RETENTION_DEFAULT_MAX_PER_RUN = 5000;

/** Nightly cron for the retention pass (must match wrangler.jsonc). */
export const STORAGE_RETENTION_CRON = "0 4 * * *";

export interface StorageRetentionOptions {
  /** Window in days; string or number. <= 0 disables pruning. */
  retentionDays?: number | string | null;
  /** Batch size per DELETE round. Defaults to STORAGE_RETENTION_DEFAULT_BATCH_SIZE. */
  batchSize?: number;
  /** Max rows deleted per run. Defaults to STORAGE_RETENTION_DEFAULT_MAX_PER_RUN. */
  maxPerRun?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface StorageRetentionResult {
  /** True when the pass was disabled (window <= 0) — nothing touched. */
  skipped: boolean;
  /** Rows actually deleted. */
  pruned: number;
  /** ISO cutoff used, or null when skipped. */
  cutoffIso: string | null;
  /** Resolved window in days. */
  windowDays: number;
  /** True when the per-run cap stopped the pass early. */
  capped: boolean;
}

/**
 * Resolve the configured window. Missing/blank/unparseable -> default.
 * A resolved window <= 0 is intentional and means "disabled".
 */
export function resolveRetentionDays(
  raw: number | string | null | undefined
): number {
  if (raw === undefined || raw === null || raw === "") {
    return STORAGE_RETENTION_DEFAULT_DAYS;
  }
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : STORAGE_RETENTION_DEFAULT_DAYS;
}

/**
 * Run one retention pass. Oldest rows first, batched, capped; one
 * mas_events audit record is written per run (even when nothing was pruned,
 * so the pass is observable). Never throws for missing data — a disabled
 * or zero-row pass returns a summary instead.
 */
export function runStorageRetention(
  orm: DatabaseORM,
  options: StorageRetentionOptions = {}
): StorageRetentionResult {
  const windowDays = resolveRetentionDays(options.retentionDays);
  const nowMs = options.now ? options.now() : Date.now();

  if (!(windowDays > 0)) {
    return { skipped: true, pruned: 0, cutoffIso: null, windowDays, capped: false };
  }

  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? STORAGE_RETENTION_DEFAULT_BATCH_SIZE)
  );
  const maxPerRun = Math.max(
    1,
    Math.floor(options.maxPerRun ?? STORAGE_RETENTION_DEFAULT_MAX_PER_RUN)
  );
  const cutoffIso = new Date(nowMs - windowDays * 86_400_000).toISOString();

  let pruned = 0;
  let capped = false;
  for (;;) {
    const remaining = maxPerRun - pruned;
    if (remaining <= 0) {
      capped = true;
      break;
    }
    const limit = Math.min(batchSize, remaining);
    const rows = orm.execQuery(
      "SELECT id FROM mas_messages WHERE created_at < ? ORDER BY created_at ASC LIMIT ?",
      cutoffIso,
      limit
    );
    const ids = rows
      .map((r: any) => r?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) break;
    for (const id of ids) {
      orm.messages.delete(id);
    }
    pruned += ids.length;
    if (ids.length < limit) break;
  }

  orm.events.create({
    id: `retention_${crypto.randomUUID().slice(0, 8)}`,
    sessionId: "system",
    type: "STORAGE_RETENTION",
    // Attributed to the Orchestrator agent, which owns the scheduled route;
    // the STORAGE_RETENTION type distinguishes the pass.
    agent: "orchestrator",
    payload: {
      pruned,
      cutoffIso,
      windowDays,
      batchSize,
      maxPerRun,
      capped,
      note: "Nightly mas_messages retention pass (issue #255). R2 archival is a follow-on; rows are deleted directly.",
    } as Record<string, unknown>,
    createdAt: new Date(nowMs).toISOString(),
  });

  // Issue #278: persist the scheduled run's summary as a durable report
  // (mas_reports) so the AI Search agent can surface it later.
  // Issue #308: through the single generate→store seam — one canonical
  // row per generation (generationId = run id).
  try {
    orm.storeCanonicalReport({
      runId: `retention:${cutoffIso}`,
      generationId: `retention:${cutoffIso}`,
      title: `Nightly storage retention — ${windowDays}d window`,
      source: "retention",
      summary: `Pruned ${pruned} mas_messages rows older than ${cutoffIso} (${windowDays}d window${capped ? ", capped at per-run max" : ""}).`,
      body: { pruned, cutoffIso, windowDays, batchSize, maxPerRun, capped },
      createdAt: new Date(nowMs).toISOString(),
    });
  } catch {
    // Non-critical report persistence error
  }

  return { skipped: false, pruned, cutoffIso, windowDays, capped };
}
