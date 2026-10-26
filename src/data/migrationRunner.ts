/**
 * Issue #1548 ([AGENTIC] Slice 0) — portable versioned migration
 * runner (R3).
 *
 * Rules this runner enforces:
 *  - A table's DDL lives in exactly one migration file. The runner
 *    never invents DDL; it only executes listed migrations in
 *    version order.
 *  - The `_migrations` bookkeeping table is owned by the runner
 *    itself, not by any migration file.
 *  - Application is idempotent and re-runnable: a migration whose
 *    version is already recorded is skipped, and a migration's
 *    statements are all `IF NOT EXISTS` / `OR IGNORE` shaped, so a
 *    partial apply (crash between statements) converges on retry.
 *  - The `_migrations` row is written LAST for each migration, so
 *    the row is the commit marker: no row means "not applied",
 *    regardless of how many statements already landed.
 *  - Deliberately NOT wrapped in a multi-statement transaction:
 *    drizzle-orm/d1 implements `db.transaction()` as sequential
 *    BEGIN/COMMIT statements, which is not Postgres-equivalent
 *    atomicity on D1's request-per-statement API. Slice 0 needs no
 *    multi-statement atomicity (every statement is idempotent and
 *    the marker is last); a future multi-statement need must use
 *    the store's atomic primitive (D1 `batch()`) explicitly, not
 *    `db.transaction()` on D1. See the ADR.
 *  - Migration SQL constraint: statements are split on `;`, so a
 *    migration file must not contain a semicolon inside a string
 *    literal. All slice-0 DDL satisfies this.
 */
import { sql, type SQL } from "drizzle-orm";

export interface DataMigration {
  version: number;
  name: string;
  sql: string;
}

/** Minimal structural surface the runner needs from a Drizzle DB. */
export interface MigrationDb {
  all<T>(query: SQL): Promise<T[]>;
  run(query: SQL): Promise<unknown>;
}

/**
 * Migration 0001 — agent_governance (halt rows only). Portable
 * subset (R2): `?` params only where params exist (DDL has none),
 * epoch-ms integers, no dialect date functions, no RETURNING.
 * The tenant/scope index serves the latest-row read; the
 * `set_at_ms DESC` ordering matches the read's ORDER BY.
 */
export const MIGRATION_0001_AGENT_GOVERNANCE: DataMigration = {
  version: 1,
  name: "0001_agent_governance",
  sql: `
CREATE TABLE IF NOT EXISTS agent_governance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT,
  state TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  version INTEGER NOT NULL,
  provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_governance_tenant_scope_idx ON agent_governance (tenant_id, scope, scope_id, set_at_ms DESC);
`,
};

/**
 * Migration 0002 — agent_chains + agent_synthesized_schedules
 * (slice 1, issue #1651). Portable subset (R2): epoch-ms
 * integers, no dialect date functions, no RETURNING. The `id`
 * column is the deterministic replay key
 * `<tenant_id>:<chain_or_schedule_id>:<version>`, so replaying
 * the same version conflicts on the primary key and is a no-op
 * under the adapters' onConflictDoNothing writes. The
 * tenant/chain/version indexes serve the latest-row reads.
 */
export const MIGRATION_0002_AGENT_CHAINS_SCHEDULES: DataMigration = {
  version: 2,
  name: "0002_agent_chains_schedules",
  sql: `
CREATE TABLE IF NOT EXISTS agent_chains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  goal TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_chains_tenant_chain_idx ON agent_chains (tenant_id, chain_id, version DESC);
CREATE TABLE IF NOT EXISTS agent_synthesized_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  cron TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_synthesized_schedules_tenant_schedule_idx ON agent_synthesized_schedules (tenant_id, schedule_id, version DESC);
`,
};

/**
 * Issue #1676: agent_shard_jobs. Grain: one row per (chain,
 * job, version). The PRIMARY KEY on (tenant_id, chain_id,
 * job_key, version) is the idempotency guarantee: replaying
 * the same version is ON CONFLICT DO NOTHING, so at-least-once
 * projection delivery is safe. Row shape mirrors the R4
 * columns: tenant/workspace/chain/version, timestamps,
 * provenance. The result_json column is capped by the
 * projector (see src/data/shardJobProjection.ts), never by
 * the database.
 */
export const MIGRATION_0003_AGENT_SHARD_JOBS: DataMigration = {
  version: 3,
  name: "0003_agent_shard_jobs",
  sql: `CREATE TABLE IF NOT EXISTS agent_shard_jobs (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL,
    PRIMARY KEY (tenant_id, chain_id, job_key, version)
);`,
};

/**
 * Issue #1688: agent_chain_audit + agent_reports. Grain:
 * agent_chain_audit is one row per lifecycle event (never a
 * log blob); agent_reports is one row per (tenant, report,
 * version). The PRIMARY KEY lines below use four-space
 * indent so the DDL/schema parity test's two-space column
 * matcher reads columns only, not the constraint line.
 */
export const MIGRATION_0004_AGENT_AUDIT_REPORTS: DataMigration = {
  version: 4,
  name: "0004_agent_audit_reports",
  sql: `
CREATE TABLE IF NOT EXISTS agent_chain_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  chain_id TEXT,
  event_kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_chain_audit_tenant_chain_idx ON agent_chain_audit (tenant_id, chain_id, occurred_at_ms DESC);
CREATE INDEX IF NOT EXISTS agent_chain_audit_tenant_kind_idx ON agent_chain_audit (tenant_id, event_kind, occurred_at_ms DESC);
CREATE TABLE IF NOT EXISTS agent_reports (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation_id TEXT,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL,
    PRIMARY KEY (tenant_id, report_id, version)
);
CREATE INDEX IF NOT EXISTS agent_reports_tenant_report_idx ON agent_reports (tenant_id, report_id, version DESC);
`,
};

export const ALL_MIGRATIONS: DataMigration[] = [
  MIGRATION_0001_AGENT_GOVERNANCE,
  MIGRATION_0002_AGENT_CHAINS_SCHEDULES,
  MIGRATION_0003_AGENT_SHARD_JOBS,
  MIGRATION_0004_AGENT_AUDIT_REPORTS,
];

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Apply every unapplied migration in version order. Idempotent. */
export async function applyMigrations(
  db: MigrationDb,
  migrations: DataMigration[],
  nowMs: number = Date.now(),
): Promise<number[]> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )
  `);
  const applied: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const existing = await db.all<{ version: number }>(sql`
      SELECT version FROM _migrations WHERE version = ${migration.version}
    `);
    if (existing.length > 0) continue;
    for (const statement of splitStatements(migration.sql)) {
      await db.run(sql.raw(statement));
    }
    // Commit marker LAST (see header): no row means not applied.
    await db.run(sql`
      INSERT INTO _migrations (version, name, applied_at_ms)
      VALUES (${migration.version}, ${migration.name}, ${nowMs})
    `);
    applied.push(migration.version);
  }
  return applied;
}
