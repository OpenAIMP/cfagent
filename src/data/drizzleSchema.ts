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
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

/**
 * Runner bookkeeping, owned by the migration runner — not a
 * domain table, and not part of any migration file's DDL.
 */
export const dataMigrations = sqliteTable("_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAtMs: integer("applied_at_ms").notNull(),
});
