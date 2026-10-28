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

/**
 * Migration 0005 — agent_market_nodes + agent_market_edges
 * (issue #1740, Hybrid RAG). Portable subset (R2): epoch-ms
 * integers, no dialect date functions, no RETURNING. Grain:
 * one row per (tenant, node type, node key) / one row per
 * (tenant, from, relation, to). The 4-space PRIMARY KEY lines
 * are constraint lines, not columns, for the parity test's
 * two-space column matcher (same shape as migration 0004).
 */
export const MIGRATION_0005_AGENT_MARKET_GRAPH: DataMigration = {
  version: 5,
  name: "0005_agent_market_graph",
  sql: `
CREATE TABLE IF NOT EXISTS agent_market_nodes (
  tenant_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_key TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, node_type, node_key)
);
CREATE INDEX IF NOT EXISTS agent_market_nodes_tenant_type_idx ON agent_market_nodes (tenant_id, node_type, node_key);
CREATE TABLE IF NOT EXISTS agent_market_edges (
  tenant_id TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_key TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_key TEXT NOT NULL,
  weight REAL NOT NULL,
  provenance TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, from_type, from_key, relation, to_type, to_key)
);
CREATE INDEX IF NOT EXISTS agent_market_edges_tenant_from_idx ON agent_market_edges (tenant_id, from_type, from_key, relation);
`,
};

/**
 * Migration 0006 — agent_thesis_realizations +
 * agent_calibration_decisions (issue #1742, RSI telemetry &
 * calibration engine). Portable subset (R2): epoch-ms
 * integers, booleans as INTEGER 0/1, no dialect date
 * functions, no RETURNING. Grain: realizations one row per
 * (tenant, outcome) — the PRIMARY KEY is the idempotency
 * guarantee, so at-least-once projection delivery is safe
 * (adapters check-then-insert and report duplicates);
 * decisions one row per decision id, updated in place through
 * the governed lifecycle (the row IS the audit trail: frozen
 * snapshot + proposer/decider/applier actors + timestamps).
 * The 4-space PRIMARY KEY lines are constraint lines, not
 * columns, for the parity test's two-space column matcher
 * (same shape as migrations 0004/0005).
 */
export const MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION: DataMigration = {
  version: 6,
  name: "0006_agent_telemetry_calibration",
  sql: `
CREATE TABLE IF NOT EXISTS agent_thesis_realizations (
  tenant_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  thesis TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  structure TEXT NOT NULL,
  regime TEXT NOT NULL,
  symbol TEXT NOT NULL,
  run_id TEXT NOT NULL,
  report_id TEXT,
  chain_id TEXT,
  predicted_direction TEXT NOT NULL,
  realized_direction TEXT NOT NULL,
  direction_correct INTEGER NOT NULL,
  falsified INTEGER NOT NULL,
  invalidated INTEGER NOT NULL,
  pnl_estimate_per_unit REAL,
  r_multiple REAL,
  evaluated_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, outcome_id)
);
CREATE INDEX IF NOT EXISTS agent_thesis_realizations_tenant_evaluated_idx ON agent_thesis_realizations (tenant_id, evaluated_at_ms DESC);
CREATE INDEX IF NOT EXISTS agent_thesis_realizations_tenant_thesis_idx ON agent_thesis_realizations (tenant_id, thesis);
CREATE TABLE IF NOT EXISTS agent_calibration_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  prompt_key TEXT NOT NULL,
  dimension TEXT NOT NULL,
  slice_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  falsifying_outcome_ids_json TEXT NOT NULL,
  calibration_note TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  proposed_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at_ms INTEGER,
  applied_by TEXT,
  applied_at_ms INTEGER,
  prior_note TEXT,
  superseded_by TEXT,
  expired_by TEXT,
  expired_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_calibration_decisions_tenant_actor_prompt_idx ON agent_calibration_decisions (tenant_id, actor_key, prompt_key, status);
`,
};

/**
 * Migration 0007 — commercial account store (#2015/#2020/#2022).
 * Portable subset (same rules as migrations 0001-0006): `?` params
 * only where params exist (DDL has none), epoch-ms integers, no
 * dialect date functions, no RETURNING. The claims index serves
 * the oldest-unredeemed lookup (user + family, FIFO by created).
 */
export const MIGRATION_0007_COMMERCIAL_STORE: DataMigration = {
  version: 7,
  name: "0007_commercial_store",
  sql: `
CREATE TABLE IF NOT EXISTS agent_commercial_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  credits_usd REAL NOT NULL,
  included_runs INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tenant_settings (
  tenant_id TEXT PRIMARY KEY,
  ads_enabled INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_credit_claims (
  credit_run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  family TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_credit_claims_user_family_created_idx ON agent_credit_claims (user_id, family, created_at_ms);
CREATE TABLE IF NOT EXISTS agent_credit_redemptions (
  credit_run_id TEXT PRIMARY KEY,
  redeemed_by_run_id TEXT NOT NULL,
  redeemed_at_ms INTEGER NOT NULL
);
`,
};

/**
 * Migration 0008 — subscriptions (#2020/#2127). Portable subset
 * (same rules as migrations 0001-0007): `?` params only where
 * params exist (DDL has none), epoch-ms integers, no dialect
 * date functions, no RETURNING. The tier_source column on the
 * accounts table records WHO granted a stored Subscribed tier:
 * pre-0008 rows have NULL, which the effective-tier helper reads
 * as "operator" (every pre-subscription row was operator-set).
 * The UNIQUE index on provider_payment_ref is the replay guard
 * for purchase: one verified checkout, one subscription.
 */
export const MIGRATION_0008_SUBSCRIPTIONS: DataMigration = {
  version: 8,
  name: "0008_subscriptions",
  sql: `
CREATE TABLE IF NOT EXISTS agent_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_payment_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  period_start_ms INTEGER NOT NULL,
  period_end_ms INTEGER NOT NULL,
  canceled_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_subscriptions_payment_ref_idx ON agent_subscriptions (provider_payment_ref);
CREATE INDEX IF NOT EXISTS agent_subscriptions_user_created_idx ON agent_subscriptions (user_id, created_at_ms);
CREATE TABLE IF NOT EXISTS agent_subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_usd REAL NOT NULL,
  period_days INTEGER NOT NULL,
  included_runs INTEGER NOT NULL,
  active INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
ALTER TABLE agent_commercial_accounts ADD COLUMN tier_source TEXT;
`,
};

/**
 * Minimal double-entry journal (#2155, sub-issue of #2012). DDL
 * authority for the journal tables lives here; the Drizzle
 * mapping in drizzleSchema.ts must agree (pinned by test).
 * The chart accounts themselves are seeded by
 * ensureJournalSchema, not by DDL — seeding is data, not schema.
 */
export const MIGRATION_0009_JOURNAL: DataMigration = {
  version: 9,
  name: "0009_journal",
  sql: `
CREATE TABLE IF NOT EXISTS agent_journal_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_journal_entries (
  id TEXT PRIMARY KEY,
  transaction_ref TEXT NOT NULL,
  account_code TEXT NOT NULL,
  debit_usd REAL NOT NULL,
  credit_usd REAL NOT NULL,
  currency TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_request_id TEXT NOT NULL,
  family TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_journal_entries_tenant_account_idx ON agent_journal_entries (tenant_id, account_code);
CREATE INDEX IF NOT EXISTS agent_journal_entries_ref_idx ON agent_journal_entries (transaction_ref);
`,
};

/**
 * Migration 0010 — Q7 audit-policy mechanism (#2183, sub-issue
 * of #2012; proposal slice for CISO+CDO review under #945).
 * DDL authority for the audit-policy tables lives here; the
 * Drizzle mapping in drizzleSchema.ts must agree (pinned by
 * test). The policy rows are OPERATOR DATA, not code: the
 * blocking set, the enforcement mode, and the retention period
 * below are PROPOSED seeds (INSERT OR IGNORE semantics in the
 * ensure path — re-seeding never overwrites an operator edit),
 * pending CISO+CDO sign-off. Enforcement seeds to audit-only;
 * nothing in this migration enables blocking.
 */
export const MIGRATION_0010_AUDIT_POLICY: DataMigration = {
  version: 10,
  name: "0010_audit_policy",
  sql: `
CREATE TABLE IF NOT EXISTS agent_audit_policy_actions (
  action TEXT PRIMARY KEY,
  block_on_audit_failure INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_audit_policy_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_audit_chain (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_audit_chain_tenant_seq_idx ON agent_audit_chain (tenant_id, sequence);
CREATE INDEX IF NOT EXISTS agent_audit_chain_tenant_created_idx ON agent_audit_chain (tenant_id, created_at_ms);
`,
};

export const ALL_MIGRATIONS: DataMigration[] = [
  MIGRATION_0001_AGENT_GOVERNANCE,
  MIGRATION_0002_AGENT_CHAINS_SCHEDULES,
  MIGRATION_0003_AGENT_SHARD_JOBS,
  MIGRATION_0004_AGENT_AUDIT_REPORTS,
  MIGRATION_0005_AGENT_MARKET_GRAPH,
  MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0010_AUDIT_POLICY,
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
