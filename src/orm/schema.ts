/**
 * Canonical schema for the shared mas_* tables — issue #782
 * (RSI-Data Tier 1, finding C2: dual DDL).
 *
 * These seven tables used to be defined TWICE with byte-identical DDL:
 * in DatabaseORM.initializeSchema() (src/orm/index.ts) and in
 * OrchestratorAgent.ensureTables() (src/agents/orchestrator.ts). With
 * CREATE TABLE IF NOT EXISTS semantics the first definition to run wins
 * per Durable Object instance, so any edit to one copy would silently
 * fork the schema by instance history. The DDL strings below are the
 * single source; they are byte-identical to both former copies (the
 * drift pin in tests/schema_single_source.test.ts proves the effective
 * DDL of both initialization paths equals these strings). Never define
 * a shared table's DDL anywhere else — the same lesson as mas_reports
 * (issue #389), whose DDL lives only in
 * src/services/scheduledReports.ts for the same reason.
 *
 * Per-DO schema-initialization coverage (verified on main @ bf1534c0):
 *  - OrchestratorAgent (wrangler SEARCH_AGENT binding, exported as
 *    SearchAgent): getOrm() runs ensureTables() AND
 *    DatabaseORM.initializeSchema() — the ONLY production call site of
 *    initializeSchema. Its instances are guaranteed all seven shared
 *    tables plus the five ORM-only tables below.
 *  - ORM-only tables (DDL stays in orm/index.ts initializeSchema, its
 *    only definition): mas_categories, mas_external_ads,
 *    webhook_replay_nonces, mas_trades, mas_options_chain_cache.
 *  - ResearchAgent (RESEARCH_AGENT binding): constructs a DatabaseORM
 *    over its own storage but its getOrm() is never invoked and it
 *    never calls initializeSchema; its tables are the research_* set
 *    from its own ensureTables. No reliance on ORM-only tables.
 *  - ScreenerAgent (SCREENER_AGENT binding): uses its DatabaseORM for
 *    ETradeService (ORM optional/guarded, issue #781). It writes no
 *    mas_reports rows: issue #783 removed its dead second copy (the
 *    canonical screener report is stored by OrchestratorAgent). It
 *    does not call initializeSchema and has no direct reliance on the
 *    ORM-only tables.
 *  - SlackAgent: exported but has NO wrangler Durable Object binding;
 *    production Slack traffic is served by OrchestratorAgent instances,
 *    whose getOrm() initializes the schema. The class itself reads
 *    orm.trades (mas_trades, ORM-only) without calling
 *    initializeSchema — if it were ever bound standalone, that table
 *    would not be guaranteed. Pre-existing state, documented here per
 *    issue #782; not changed by the single-sourcing.
 */

import type { SqlStorage } from "./index";

/** The seven mas_* tables shared by the ORM and the orchestrator. */
export const SHARED_MAS_TABLES = [
  "mas_messages",
  "mas_events",
  "mas_memory",
  "mas_referrals",
  "mas_ads",
  "mas_watchlists",
  "mas_transactions",
  "mas_commercial_accounts",
  "mas_tenant_settings",
  "mas_credit_redemptions",
] as const;

export type SharedMasTable = (typeof SHARED_MAS_TABLES)[number];

const MAS_MESSAGES_DDL = `
      CREATE TABLE IF NOT EXISTS mas_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;

// Issue #792 determination (RSI-Data C9): mas_events is the
// session-scoped audit/observability log — single insert owner
// OrchestratorAgent.recordAudit (#270) — and deliberately NOT the
// usage-metering store. Tenant usage metering (user_login / run_id /
// category) lives in usage_events (src/services/scheduledReports.ts),
// whose attribution axis and indexed per-tenant reads do not fit this
// table's session_id shape. Keep the two logs distinct.
const MAS_EVENTS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;

const MAS_MEMORY_DDL = `
      CREATE TABLE IF NOT EXISTS mas_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

const MAS_REFERRALS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_referrals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        category TEXT NOT NULL,
        reward_text TEXT NOT NULL,
        clicks INTEGER DEFAULT 0,
        signups INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `;

const MAS_ADS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_ads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tagline TEXT NOT NULL,
        sponsor TEXT NOT NULL,
        badge TEXT NOT NULL,
        url TEXT NOT NULL,
        cta_text TEXT NOT NULL,
        accent_color TEXT NOT NULL,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `;

const MAS_WATCHLISTS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_watchlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_login TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        items_json TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

const MAS_TRANSACTIONS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_transactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        customer TEXT NOT NULL,
        gateway TEXT NOT NULL,
        gateway_ref TEXT,
        status TEXT NOT NULL,
        checkout_url TEXT,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT,
        proof_signature TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

// Issue #2015/#2020: minimal commercial account store — one row per
// user (id = userId), operator-managed in v1. Plain TEXT/REAL like
// the other shared tables; tier is validated in code, not by CHECK.
const MAS_COMMERCIAL_ACCOUNTS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_commercial_accounts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        credits_usd REAL NOT NULL DEFAULT 0,
        included_runs INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `;

// Issue #2022 (folded into the store decision): per-tenant system
// setting. Absent = ads enabled (the tier rule governs).
const MAS_TENANT_SETTINGS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_tenant_settings (
        tenant_id TEXT PRIMARY KEY,
        ads_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      )
    `;

// Issue #2019: one-time redemption of a failure-credit row. The
// primary key makes a second redemption of the same credit
// impossible; the insert is the atomic claim.
const MAS_CREDIT_REDEMPTIONS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_credit_redemptions (
        credit_run_id TEXT PRIMARY KEY,
        redeemed_by_run_id TEXT NOT NULL,
        redeemed_at TEXT NOT NULL
      )
    `;

/** Canonical DDL per shared table, byte-identical to the former copies. */
export const SHARED_TABLE_DDL: Readonly<Record<SharedMasTable, string>> = {
  mas_messages: MAS_MESSAGES_DDL,
  mas_events: MAS_EVENTS_DDL,
  mas_memory: MAS_MEMORY_DDL,
  mas_referrals: MAS_REFERRALS_DDL,
  mas_ads: MAS_ADS_DDL,
  mas_watchlists: MAS_WATCHLISTS_DDL,
  mas_transactions: MAS_TRANSACTIONS_DDL,
  mas_commercial_accounts: MAS_COMMERCIAL_ACCOUNTS_DDL,
  mas_tenant_settings: MAS_TENANT_SETTINGS_DDL,
  mas_credit_redemptions: MAS_CREDIT_REDEMPTIONS_DDL,
};

/** Create one shared table (IF NOT EXISTS) from the canonical DDL. */
export function ensureSharedTable(sql: SqlStorage, table: SharedMasTable): void {
  sql.exec(SHARED_TABLE_DDL[table]);
}

/** Create every shared table, in SHARED_MAS_TABLES order. */
export function ensureSharedTables(sql: SqlStorage): void {
  for (const table of SHARED_MAS_TABLES) {
    ensureSharedTable(sql, table);
  }
}
