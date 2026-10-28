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
  real,
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
 * Issue #1740: agent_market_nodes projection table. Grain: one
 * row per (tenant, node type, node key). Column names match
 * migration 0005 exactly; the test pins the two together.
 */
export const agentMarketNodes = sqliteTable(
  "agent_market_nodes",
  {
    tenantId: text("tenant_id").notNull(),
    nodeType: text("node_type").notNull(),
    nodeKey: text("node_key").notNull(),
    label: text("label").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.nodeType, table.nodeKey],
    }),
  ],
);

/**
 * Issue #1740: agent_market_edges projection table. Grain: one
 * row per (tenant, from, relation, to). Column names match
 * migration 0005 exactly; the test pins the two together.
 */
export const agentMarketEdges = sqliteTable(
  "agent_market_edges",
  {
    tenantId: text("tenant_id").notNull(),
    fromType: text("from_type").notNull(),
    fromKey: text("from_key").notNull(),
    relation: text("relation").notNull(),
    toType: text("to_type").notNull(),
    toKey: text("to_key").notNull(),
    weight: real("weight").notNull(),
    provenance: text("provenance").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.fromType,
        table.fromKey,
        table.relation,
        table.toType,
        table.toKey,
      ],
    }),
  ],
);

/**
 * Issue #1742: agent_thesis_realizations projection table.
 * Grain: one row per (tenant, outcome). Booleans are INTEGER
 * 0/1 (portable subset); the adapter converts at the boundary.
 * Column names match migration 0006 exactly; the test pins the
 * two together.
 */
export const agentThesisRealizations = sqliteTable(
  "agent_thesis_realizations",
  {
    tenantId: text("tenant_id").notNull(),
    outcomeId: text("outcome_id").notNull(),
    thesis: text("thesis").notNull(),
    agentKey: text("agent_key").notNull(),
    structure: text("structure").notNull(),
    regime: text("regime").notNull(),
    symbol: text("symbol").notNull(),
    runId: text("run_id").notNull(),
    reportId: text("report_id"),
    chainId: text("chain_id"),
    predictedDirection: text("predicted_direction").notNull(),
    realizedDirection: text("realized_direction").notNull(),
    directionCorrect: integer("direction_correct").notNull(),
    falsified: integer("falsified").notNull(),
    invalidated: integer("invalidated").notNull(),
    pnlEstimatePerUnit: real("pnl_estimate_per_unit"),
    rMultiple: real("r_multiple"),
    evaluatedAtMs: integer("evaluated_at_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.outcomeId],
    }),
  ],
);

/**
 * Issue #1742: agent_calibration_decisions table. Grain: one
 * row per decision id, updated in place through the governed
 * lifecycle (proposed → approved/rejected → applied →
 * superseded/expired). The row IS the audit trail: frozen
 * snapshot JSON + proposer/decider/applier actors + prior
 * note. Column names match migration 0006 exactly; the test
 * pins the two together.
 */
export const agentCalibrationDecisions = sqliteTable("agent_calibration_decisions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  actorKey: text("actor_key").notNull(),
  promptKey: text("prompt_key").notNull(),
  dimension: text("dimension").notNull(),
  sliceKey: text("slice_key").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  falsifyingOutcomeIdsJson: text("falsifying_outcome_ids_json").notNull(),
  calibrationNote: text("calibration_note").notNull(),
  proposedBy: text("proposed_by").notNull(),
  proposedAtMs: integer("proposed_at_ms").notNull(),
  status: text("status").notNull(),
  decidedBy: text("decided_by"),
  decidedAtMs: integer("decided_at_ms"),
  appliedBy: text("applied_by"),
  appliedAtMs: integer("applied_at_ms"),
  priorNote: text("prior_note"),
  supersededBy: text("superseded_by"),
  expiredBy: text("expired_by"),
  expiredAtMs: integer("expired_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Runner bookkeeping, owned by the migration runner — not a
 * domain table, and not part of any migration file's DDL.
 */
export const dataMigrations = sqliteTable("_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAtMs: integer("applied_at_ms").notNull(),
});

/**
 * Minimal commercial account store (#2015/#2020) on D1. One row per
 * user (id = userId), operator-managed in v1. This schema MAPS
 * tables; it does not create them — DDL authority lives in
 * migration 0007 (src/data/migrationRunner.ts), and a test pins
 * that this mapping and that DDL agree on columns.
 */
export const agentCommercialAccounts = sqliteTable("agent_commercial_accounts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tier: text("tier").notNull(),
  tierSource: text("tier_source"),
  creditsUSD: real("credits_usd").notNull(),
  includedRuns: integer("included_runs").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** Per-tenant system settings (#2022): the ads flag. Absent = ads enabled. */
export const agentTenantSettings = sqliteTable("agent_tenant_settings", {
  tenantId: text("tenant_id").primaryKey(),
  adsEnabled: integer("ads_enabled").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Redeemable failure-credit claims (#2019). One row per failed paid
 * run, written by the payment adapter alongside the DO ledger
 * credit row (the ledger row is the financial audit record; this
 * row is the redeemable claim and carries family natively, so
 * redemption never needs an audit-payload family join).
 */
export const agentCreditClaims = sqliteTable("agent_credit_claims", {
  creditRunId: text("credit_run_id").primaryKey(),
  userId: text("user_id").notNull(),
  family: text("family").notNull(),
  amountUSD: real("amount_usd").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * Paid-submission ownership (#2137 follow-ups). One row per
 * submitted paid run, keyed by the workflowId the submit route
 * returns, so submission-status can enforce owner-only reads.
 * This schema MAPS tables; it does not create them — DDL
 * authority lives in migration 0010
 * (src/data/migrationRunner.ts).
 */
export const agentPaidSubmissions = sqliteTable("agent_paid_submissions", {
  workflowId: text("workflow_id").primaryKey(),
  userId: text("user_id").notNull(),
  runRequestId: text("run_request_id").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/** One-time redemption of a credit claim: the PK makes a second redemption impossible. */
export const agentCreditRedemptions = sqliteTable("agent_credit_redemptions", {
  creditRunId: text("credit_run_id").primaryKey(),
  redeemedByRunId: text("redeemed_by_run_id").notNull(),
  redeemedAtMs: integer("redeemed_at_ms").notNull(),
});

/**
 * Subscription object (#2020/#2127) on D1. One row per purchase:
 * a paid-through period, not a provider-managed recurring
 * billing object (cfpay is one-time-only; renewal is repurchase).
 * The UNIQUE index on provider_payment_ref is the replay guard:
 * one verified checkout activates at most one subscription.
 * This schema MAPS tables; it does not create them — DDL
 * authority lives in migration 0008
 * (src/data/migrationRunner.ts).
 */
export const agentSubscriptions = sqliteTable("agent_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  planId: text("plan_id").notNull(),
  provider: text("provider").notNull(),
  providerPaymentRef: text("provider_payment_ref").notNull(),
  status: text("status").notNull(),
  periodStartMs: integer("period_start_ms").notNull(),
  periodEndMs: integer("period_end_ms").notNull(),
  canceledAtMs: integer("canceled_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Minimal double-entry journal (#2155, sub-issue of #2012). This
 * schema MAPS tables; it does not create them — DDL authority
 * lives in migration 0009 (src/data/migrationRunner.ts), and a
 * test pins that this mapping and that DDL agree on columns.
 * The chart is global (same codes for all tenants); entries are
 * tenant-scoped. This is a projection of the DO ledger, not a
 * second financial record.
 */
export const agentJournalAccounts = sqliteTable("agent_journal_accounts", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const agentJournalEntries = sqliteTable("agent_journal_entries", {
  id: text("id").primaryKey(),
  transactionRef: text("transaction_ref").notNull(),
  accountCode: text("account_code").notNull(),
  debitUSD: real("debit_usd").notNull(),
  creditUSD: real("credit_usd").notNull(),
  currency: text("currency").notNull(),
  tenantId: text("tenant_id").notNull(),
  runRequestId: text("run_request_id").notNull(),
  family: text("family").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * Subscription plans (#2020/#2127) as OPERATOR DATA, not code:
 * operators create plans; no price is hardcoded anywhere, because
 * no subscription price is owner-approved. Active plans are what
 * users can buy; deactivation stops new purchases without
 * touching existing subscriptions.
 */
export const agentSubscriptionPlans = sqliteTable("agent_subscription_plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priceUSD: real("price_usd").notNull(),
  periodDays: integer("period_days").notNull(),
  includedRuns: integer("included_runs").notNull(),
  active: integer("active").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});
