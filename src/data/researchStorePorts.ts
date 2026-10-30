/**
 * Issue #2361 (#1976 step 4e, ADR 0022 D-I step 4) — the
 * ResearchAgent-private store ports: FOUR ports, one per table
 * the agent owns outright (step-4 audit §4e): research_settings,
 * research_task_store, research_runs, research_evaluations.
 * Single-host confirmed: no other src module names these tables;
 * ResearchAgent is their only reader and writer.
 *
 * ADR D-0 residency: all four stay DO-resident behind ports —
 * (a) agent-runtime identity (the settings, the durable task
 * ledger, the run history and its evaluations are the research
 * instance's own state), (b) per-instance serialization (the
 * DELETE+INSERT upserts and the lock-free ledger check-and-set
 * ride it), (e) colocated strongly-consistent storage,
 * (f) tenancy isolation by construction (one instance per
 * research tenant). This module carries the record types and
 * the port interfaces ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteResearchStoreAdapter.ts (production),
 * inMemoryResearchStoreAdapters.ts (test doubles). Composition:
 * createResearchStorePorts.ts — the per-agent composition root
 * ResearchAgent now consumes INSTEAD of its hand-rolled facade
 * shim (the class's own `{ exec }` wrapper over ctx.storage.sql).
 *
 * R-7 INVARIANT (step 3a, preserved by construction): these are
 * AGENT-PRIVATE tables. Their DDL lives in the adapters'
 * ensureSchema — and nowhere else. Nothing in this family knows
 * the shared ORM schema exists: composing these ports executes
 * no DDL, and ensureSchema creates ONLY the four tables above.
 * ResearchAgent never initializes the shared schema; that pin
 * (tests/orm_step3a_conformance_2345.test.ts) keeps holding over
 * this composition.
 *
 * OUT OF THIS FAMILY (named, not silently absorbed):
 * mas_learnings — fenced out by audit ruling R-1 (its screener
 * read stays exactly as-is); the shared ORM tables — step 3a's
 * family, untouched; sessionStore — step 5.
 *
 * FAIL-SOFT READS ARE CONTRACT, not adapter accident: the legacy
 * settings/task stores swallowed every storage error on read
 * (get → null, list → []) because runDiscoveryIfDue reads its
 * durable marker BEFORE any ensure has run — a missing table
 * must read as "no marker", never throw. Both KV ports pin that
 * behaviour; the run/evaluation reads keep the legacy shape
 * (their callers wrap in try/catch themselves, so those ports
 * may throw — insert-or-throw per ADR D-E.1).
 *
 * TRANSACTION SEAM (ADR D-C): deliberately none. The two
 * multi-statement upserts (settings/task set, run replace) are
 * DELETE+INSERT pairs — the legacy statements, verbatim — whose
 * interleaving is excluded by the instance's serialization;
 * a crash between the pair has the same exposure it had inline
 * (named here, not hidden). No wrap is claimed.
 */
import type { SqlStorage } from "./repositoryPorts";

export type ResearchStoreSqlExecutor = SqlStorage;

// ---------------------------------------------------------------------------
// research_settings — the mas_settings-idiom KV behind ResearchConfigService.
// ---------------------------------------------------------------------------

export interface ResearchSettingsPort {
  /** The table's ONE DDL home. Ensure-style; idempotent. */
  ensureSchema(): void;
  /** FAIL-SOFT: the stored value, or null when absent OR on any
   *  storage error (including a not-yet-created table). */
  get(key: string): string | null;
  /** DELETE+INSERT overwrite (not INSERT OR REPLACE — the legacy
   *  statement pair, kept for MockSqlStorage compatibility);
   *  updated_at is stamped inside the operation. */
  set(key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// research_task_store — the KV behind the durable ResearchTaskLedger (#577).
// ---------------------------------------------------------------------------

export interface ResearchTaskStorePort {
  /** The table's ONE DDL home. Ensure-style; idempotent. */
  ensureSchema(): void;
  /** FAIL-SOFT: the stored value, or null when absent OR on any
   *  storage error (including a not-yet-created table). */
  get(key: string): string | null;
  /** DELETE+INSERT overwrite; updated_at stamped inside. */
  set(key: string, value: string): void;
  /** Delete the key's row (no-op when absent). */
  delete(key: string): void;
  /** FAIL-SOFT: rows whose key starts with `prefix`, in storage
   *  order; [] on any storage error. Rows with non-string cells
   *  are dropped, exactly as the legacy store dropped them. */
  list(prefix: string): Array<{ key: string; value: string }>;
}

// ---------------------------------------------------------------------------
// research_runs — one row per published run; report_json is the record.
// ---------------------------------------------------------------------------

export interface ResearchRunInsert {
  runId: string;
  trigger: string;
  userLogin: string;
  createdAt: string;
  rulesVersion: string;
  /** Precomputed by the caller: "published" when the run produced
   *  ideas, "no_qualifying" otherwise (the legacy persist ternary). */
  status: string;
  ideasCount: number;
  reportJson: string;
}

/** One row of the due-evaluation scan (cells unvalidated — the
 *  caller keeps its legacy typeof filtering). */
export interface ResearchRunRef {
  runId: unknown;
  createdAt: unknown;
}

export interface ResearchRunPort {
  /** The table's ONE DDL home. Ensure-style; idempotent. */
  ensureSchema(): void;
  /** Upsert by run_id: DELETE the existing row, INSERT the new
   *  one (the legacy persist pair, verbatim). */
  replaceRun(record: ResearchRunInsert): void;
  /** Every row's report_json cell, newest run first
   *  (ORDER BY created_at DESC — the track-record feed order). */
  listReportJsonValues(): unknown[];
  /** The report_json cell for one run, or undefined when absent. */
  getReportJsonValue(runId: string): unknown;
  /** Every row's (run_id, created_at), in storage order — the
   *  due-evaluation scan's input. */
  listRunRefs(): ResearchRunRef[];
}

// ---------------------------------------------------------------------------
// research_evaluations — append-only §9 evaluation rows per run.
// ---------------------------------------------------------------------------

export interface ResearchEvaluationInsert {
  id: string;
  runId: string;
  evaluatedAt: string;
  evaluationJson: string;
}

export interface ResearchEvaluationPort {
  /** The table's ONE DDL home. Ensure-style; idempotent. */
  ensureSchema(): void;
  /** Append one evaluation row. Insert-or-throw (ADR D-E.1): a
   *  duplicate id surfaces the storage error, never overwrites. */
  insertEvaluation(record: ResearchEvaluationInsert): void;
  /** Every row's evaluation_json cell, oldest evaluation first
   *  (ORDER BY evaluated_at ASC — the track-record join order). */
  listEvaluationJsonValues(): unknown[];
  /** Every row's run_id cell, in storage order. */
  listEvaluatedRunIds(): unknown[];
}

// ---------------------------------------------------------------------------
// The family aggregate the agent composes.
// ---------------------------------------------------------------------------

export interface ResearchStorePorts {
  settings: ResearchSettingsPort;
  tasks: ResearchTaskStorePort;
  runs: ResearchRunPort;
  evaluations: ResearchEvaluationPort;
  /** Ensure all four agent-private tables (the legacy
   *  ensureTables order: settings, runs, evaluations, tasks). */
  ensureSchema(): void;
}
