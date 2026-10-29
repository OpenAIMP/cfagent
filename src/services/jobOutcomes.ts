/**
 * Issue #1333 (job-truth program #1332): the one outcome-event sink
 * for every job producer. A JobOutcome is the uniform shape — job id,
 * kind, trigger, status, counts, coded error, artifact links, delivery
 * states, origin — emitted by the job-tree hook, the bus subscriber,
 * goal-screen, discovery, and manual paths, and rendered by Autopilot
 * Control as its job feed (labeled by origin).
 *
 * @deprecated Superseded by src/data/jobOutcomePorts.ts (port),
 * src/data/doSqliteJobOutcomeAdapter.ts (production adapter) and
 * src/data/createEvidenceSatellitePorts.ts (composition root) —
 * #1976 step 4c (#2356, ADR 0022 D-I step 4). This module is a
 * re-export shim: every function delegates to the DO adapter over
 * the caller's sql handle, statement-for-statement identical to
 * the pre-port implementation (BOTH tables — mas_job_outcomes
 * and the mas_job_outcomes_meta prune watermark).
 *
 * Upsert is by stable id: the run's deliveryId when one exists
 * (shared by the tree hook and the bus subscriber, so a run
 * recorded twice converges to one row), otherwise a caller-
 * supplied run key. Re-records MERGE: defined scalar fields
 * win, undefined never wipes an existing value, delivery
 * states merge key-wise, and a completed/partial re-record
 * without a coded error clears a stale one (errors belong to
 * failed outcomes). All statements are single-line: the
 * shared MockSqlStorage INSERT regex has no dotAll flag.
 */

import { DoSqliteJobOutcomeStore } from "../data/doSqliteJobOutcomeAdapter";
import type { SqlStorage } from "../orm";
import type {
  JobOutcomeInput,
  JobOutcomeRow,
  PruneJobOutcomesOptions,
  PruneJobOutcomesResult,
} from "../data/jobOutcomePorts";

export {
  JOB_OUTCOMES_KEEP_ROWS,
  JOB_OUTCOMES_PRUNE_INTERVAL_MS,
  JOB_OUTCOMES_RETENTION_DEFAULT_DAYS,
  type JobOutcomeInput,
  type JobOutcomeKind,
  type JobOutcomeRow,
  type JobOutcomeStatus,
  type JobOutcomeTrigger,
  type PruneJobOutcomesOptions,
  type PruneJobOutcomesResult,
} from "../data/jobOutcomePorts";

function store(sql: SqlStorage): DoSqliteJobOutcomeStore {
  return new DoSqliteJobOutcomeStore(sql);
}

export function ensureJobOutcomesTable(sql: SqlStorage): void {
  store(sql).ensureTables();
}

export function recordJobOutcome(sql: SqlStorage, input: JobOutcomeInput): JobOutcomeRow {
  return store(sql).record(input);
}

export function pruneJobOutcomes(
  sql: SqlStorage,
  options: PruneJobOutcomesOptions = {},
): PruneJobOutcomesResult {
  return store(sql).prune(options);
}

export function maybePruneJobOutcomes(sql: SqlStorage, nowMs: number = Date.now()): boolean {
  return store(sql).maybePrune(nowMs);
}

export function listJobOutcomes(sql: SqlStorage, limit = 50): JobOutcomeRow[] {
  return store(sql).list(limit);
}
