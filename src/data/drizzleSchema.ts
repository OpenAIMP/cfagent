/**
 * Issue #1548 ([AGENTIC] Slice 0) — Drizzle schema mapping for
 * the data foundation layer.
 *
 * This schema MAPS tables; it does not create them. DDL authority
 * lives in exactly one migration file per table
 * (src/data/migrationRunner.ts, migration 0001); a test pins that
 * this mapping and that DDL agree on columns. If they ever drift,
 * the migration file wins and this mapping is fixed to match.
 */
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/** Mirror of governance transitions (slice 0: halt rows only). */
export const agentGovernance = sqliteTable("agent_governance", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id"),
  state: text("state").notNull(),
  setBy: text("set_by").notNull(),
  setAtMs: integer("set_at_ms").notNull(),
  reason: text("reason").notNull(),
  version: integer("version").notNull(),
  provenance: text("provenance").notNull(),
});

/** Projection of a compiled chain (slice 1, issue #1651). */
export const agentChains = sqliteTable("agent_chains", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  chainId: text("chain_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  goal: text("goal").notNull(),
  stepsJson: text("steps_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  provenanceWriter: text("provenance_writer").notNull(),
  provenanceSourceDo: text("provenance_source_do").notNull(),
  provenanceSourceVersion: text("provenance_source_version").notNull(),
});

/** Projection of a synthesized schedule (slice 1, issue #1651). */
/**
 * Issue #1676: agent_shard_jobs projection table. Grain: one
 * row per (tenant, chain, job, version). Column names match
 * migration 0003 exactly; the test pins the two together.
 */
export const agentShardJobs = sqliteTable(
  "agent_shard_jobs",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    chainId: text("chain_id").notNull(),
    jobKey: text("job_key").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    stage: text("stage").notNull(),
    capabilityId: text("capability_id").notNull(),
    detail: text("detail").notNull(),
    resultJson: text("result_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    provenanceWriter: text("provenance_writer").notNull(),
    provenanceSourceDo: text("provenance_source_do").notNull(),
    provenanceSourceVersion: text("provenance_source_version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.chainId, table.jobKey, table.version],
    }),
  ],
);

export const agentSynthesizedSchedules = sqliteTable(
  "agent_synthesized_schedules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    scheduleId: text("schedule_id").notNull(),
    chainId: text("chain_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    kind: text("kind").notNull(),
    cron: text("cron"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    provenanceWriter: text("provenance_writer").notNull(),
    provenanceSourceDo: text("provenance_source_do").notNull(),
    provenanceSourceVersion: text("provenance_source_version").notNull(),
  },
);

/**
 * Issue #1688: agent_chain_audit projection table. Grain: one
 * row per lifecycle event (append-only; version is the
 * row-shape version, always 1, not a per-subject counter).
 * chain_id is nullable: tenant-wide events (reconcile, seed)
 * have no single chain subject. Column names match migration
 * 0004 exactly; the test pins the two together.
 */
export const agentChainAudit = sqliteTable("agent_chain_audit", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  chainId: text("chain_id"),
  eventKind: text("event_kind").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  actor: text("actor").notNull(),
  detailJson: text("detail_json").notNull(),
  occurredAtMs: integer("occurred_at_ms").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
  provenanceWriter: text("provenance_writer").notNull(),
  provenanceSourceDo: text("provenance_source_do").notNull(),
  provenanceSourceVersion: text("provenance_source_version").notNull(),
});

/**
 * Issue #1688: agent_reports projection table. Grain: one row
 * per (tenant, report, version). Canonical rows are written
 * only by the projection path; deletion happens only via
 * deleteCanonicalReport. Column names match migration 0004
 * exactly; the test pins the two together.
 */
export const agentReports = sqliteTable(
  "agent_reports",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    reportId: text("report_id").notNull(),
    runId: text("run_id").notNull(),
    generationId: text("generation_id"),
    title: text("title").notNull(),
    source: text("source").notNull(),
    summary: text("summary").notNull(),
    body: text("body").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    version: integer("version").notNull(),
    provenanceWriter: text("provenance_writer").notNull(),
    provenanceSourceDo: text("provenance_source_do").notNull(),
    provenanceSourceVersion: text("provenance_source_version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.reportId, table.version],
    }),
  ],
);

/**
 * Runner bookkeeping, owned by the migration runner — not a
 * domain table, and not part of any migration file's DDL.
 */
export const dataMigrations = sqliteTable("_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAtMs: integer("applied_at_ms").notNull(),
});
