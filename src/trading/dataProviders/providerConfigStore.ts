/**
 * Issue #1118 (P1 of epic #1116): the provider-config store — one row
 * per provider instance in `mas_data_providers`, service-owned DDL in
 * the established mas_* pattern (goalScenarioStore.ts, learnings.ts:
 * CREATE TABLE IF NOT EXISTS at the SqlStorage seam, no new Durable
 * Object class, no wrangler migration).
 *
 * Before this store, provider configuration was scattered across
 * environment.config.json, etapiConfig.ts, screenerConfig.ts,
 * quoteConfig.ts, and ad-hoc env reads, and a provider's existence was
 * implied by code. Here a provider instance is a RECORD: its adapter
 * kind, its lifecycle state, whether it is enabled, its precedence, a
 * credential REFERENCE, and free-form config JSON (endpoints,
 * environment, rate-limit knobs).
 *
 * Security invariant: the store holds credential REFERENCES only
 * (e.g. "sessionstore:etrade:token", "env:ALPACA_API_KEY") — the key
 * under which the secret lives in the SessionStore / Worker env, never
 * a secret value. Nothing in this module accepts, stores, or logs a
 * credential value.
 *
 * Lifecycle states (provisioning lifecycle; transitions are driven by
 * later slices — P4 — but the states are the vocabulary from P1):
 *
 *   registered → configured → verified → enabled ⇄ disabled
 *     → deprovisioned
 *
 * The registry (registry.ts) resolves a capability ONLY to a provider
 * whose record is in state "enabled" with the enabled flag on; every
 * other state is invisible to resolution, so a half-provisioned
 * provider can never serve data.
 *
 * The same module owns the CAPABILITY ROUTING table
 * (mas_data_provider_routes, below): screening composes providers in
 * one run (owner correction, comment 6358714200 on #1116), so each
 * capability is routed to a primary provider plus an optional DECLARED
 * gap-fill provider. Routing — not the precedence column — is the
 * primary composition model; precedence remains the default resolution
 * order where no route is declared.
 */

import type { SqlStorage } from "../../orm";
import type { DataProviderCapability, DataProviderId, Tier } from "./contract";

export const PROVIDER_CONFIG_TABLE = "mas_data_providers";

export type ProviderLifecycleState =
  | "registered"
  | "configured"
  | "verified"
  | "enabled"
  | "disabled"
  | "deprovisioned";

export interface ProviderConfigRecord {
  id: DataProviderId;
  /** Which adapter implementation serves this instance (e.g. "etrade-service"). */
  adapterKind: string;
  lifecycleState: ProviderLifecycleState;
  enabled: boolean;
  /** Owner precedence: lower resolves first. */
  precedence: number;
  /** Credential REFERENCE (a key/name, never a secret value); null = provider needs no credentials. */
  credentialRef: string | null;
  /** Endpoints, environment, rate-limit knobs — provider-specific JSON. */
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConfigInput {
  id: DataProviderId;
  adapterKind: string;
  lifecycleState?: ProviderLifecycleState;
  enabled?: boolean;
  precedence: number;
  credentialRef?: string | null;
  config?: Record<string, unknown>;
}

export function ensureProviderConfigTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${PROVIDER_CONFIG_TABLE} (
    id TEXT PRIMARY KEY,
    adapter_kind TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    precedence INTEGER NOT NULL,
    credential_ref TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_mas_data_providers_precedence ON ${PROVIDER_CONFIG_TABLE}(precedence)`
  );
}

function parseConfig(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function recordFromRow(r: any): ProviderConfigRecord {
  return {
    id: r.id,
    adapterKind: r.adapter_kind,
    lifecycleState: r.lifecycle_state,
    enabled: Number(r.enabled) === 1 || r.enabled === true,
    precedence: Number(r.precedence),
    credentialRef: r.credential_ref ?? null,
    config: parseConfig(r.config_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Insert or update the config record for a provider id (§17.3
 * write→read: returns the record as stored). created_at is preserved
 * across updates.
 */
export function upsertProviderConfig(
  sql: SqlStorage,
  input: ProviderConfigInput
): ProviderConfigRecord {
  ensureProviderConfigTable(sql);
  const existing = getProviderConfig(sql, input.id);
  const now = new Date().toISOString();
  const record: ProviderConfigRecord = {
    id: input.id,
    adapterKind: input.adapterKind,
    lifecycleState: input.lifecycleState ?? existing?.lifecycleState ?? "registered",
    enabled: input.enabled ?? existing?.enabled ?? false,
    precedence: input.precedence,
    credentialRef: input.credentialRef ?? existing?.credentialRef ?? null,
    config: input.config ?? existing?.config ?? {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) {
    sql.exec(
      `UPDATE ${PROVIDER_CONFIG_TABLE}
       SET adapter_kind = ?, lifecycle_state = ?, enabled = ?, precedence = ?,
           credential_ref = ?, config_json = ?, updated_at = ?
       WHERE id = ?`,
      record.adapterKind,
      record.lifecycleState,
      record.enabled ? 1 : 0,
      record.precedence,
      record.credentialRef,
      JSON.stringify(record.config),
      record.updatedAt,
      record.id
    );
  } else {
    sql.exec(
      `INSERT INTO ${PROVIDER_CONFIG_TABLE}
       (id, adapter_kind, lifecycle_state, enabled, precedence, credential_ref, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.adapterKind,
      record.lifecycleState,
      record.enabled ? 1 : 0,
      record.precedence,
      record.credentialRef,
      JSON.stringify(record.config),
      record.createdAt,
      record.updatedAt
    );
  }
  return getProviderConfig(sql, input.id) ?? record;
}

export function getProviderConfig(
  sql: SqlStorage,
  id: DataProviderId
): ProviderConfigRecord | null {
  ensureProviderConfigTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM ${PROVIDER_CONFIG_TABLE} WHERE id = ?`, id)
  ) as any[];
  return rows.length > 0 ? recordFromRow(rows[0]) : null;
}

/** All provider records in configured precedence order (precedence ASC, id as tiebreak). */
export function listProviderConfigs(sql: SqlStorage): ProviderConfigRecord[] {
  ensureProviderConfigTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${PROVIDER_CONFIG_TABLE} ORDER BY precedence ASC, id ASC`
    )
  ) as any[];
  return rows.map(recordFromRow);
}

export function setProviderLifecycleState(
  sql: SqlStorage,
  id: DataProviderId,
  state: ProviderLifecycleState
): ProviderConfigRecord | null {
  const existing = getProviderConfig(sql, id);
  if (!existing) return null;
  return upsertProviderConfig(sql, {
    ...existing,
    lifecycleState: state,
    config: existing.config,
  });
}

export function setProviderEnabled(
  sql: SqlStorage,
  id: DataProviderId,
  enabled: boolean
): ProviderConfigRecord | null {
  const existing = getProviderConfig(sql, id);
  if (!existing) return null;
  return upsertProviderConfig(sql, {
    ...existing,
    enabled,
    config: existing.config,
  });
}

/**
 * Clear a provider's credential reference (E3, issue #1170). A
 * dedicated UPDATE because upsertProviderConfig treats a null
 * credentialRef as "keep existing" (its merge rule) — deprovision
 * and an explicit configure-to-null need the reference actually
 * gone: a tombstoned or re-provisioning record must not retain a
 * pointer to a secret it no longer owns.
 */
export function clearProviderCredentialRef(
  sql: SqlStorage,
  id: DataProviderId
): ProviderConfigRecord | null {
  const existing = getProviderConfig(sql, id);
  if (!existing) return null;
  sql.exec(
    `UPDATE ${PROVIDER_CONFIG_TABLE} SET credential_ref = NULL, updated_at = ? WHERE id = ?`,
    new Date().toISOString(),
    id
  );
  return getProviderConfig(sql, id);
}

/**
 * The five owner-set providers (epic #1116, decision comment
 * 6358627401) in owner precedence order. Lifecycle states reflect
 * reality at seed time: the four existing providers are "configured"
 * (their implementations and credentials exist); "public" is a
 * descriptor only — "registered", no adapter until its integration
 * slice. NOTHING is seeded "enabled": enablement is a deliberate
 * lifecycle act (P4), never a seed default.
 */
export const DEFAULT_PROVIDER_SEEDS: readonly ProviderConfigInput[] = [
  {
    id: "etrade",
    adapterKind: "etrade-service",
    lifecycleState: "configured",
    enabled: false,
    precedence: 1,
    // Per-user OAuth tokens live in the SessionStore "etrade" namespace
    // (etrade:token:<ENV>:<login>, #1066) — a reference, never a value.
    credentialRef: "sessionstore:etrade:token",
    config: { tokenNamespace: "etrade", environments: ["TEST", "PROD"] },
  },
  {
    id: "public",
    adapterKind: "public",
    lifecycleState: "registered",
    enabled: false,
    precedence: 2,
    credentialRef: null,
    config: {},
  },
  {
    id: "yahoo",
    adapterKind: "yahoo-finance",
    lifecycleState: "configured",
    enabled: false,
    precedence: 3,
    credentialRef: null, // public endpoints + crumb session; no credentials
    config: {},
  },
  {
    id: "nasdaq",
    adapterKind: "nasdaq-listings",
    lifecycleState: "configured",
    enabled: false,
    precedence: 4,
    credentialRef: null, // public listings feed; no credentials
    config: {},
  },
  {
    id: "alpaca",
    adapterKind: "alpaca-market-data",
    lifecycleState: "configured",
    enabled: false,
    precedence: 5,
    // Deploy-time Worker env keys (marketDataResearch.ts reads ALPACA_API_KEY
    // et al.) — the env var NAME is the reference, never the value.
    credentialRef: "env:ALPACA_API_KEY",
    config: { dataUrl: "https://data.alpaca.markets" },
  },
];

/**
 * Idempotently insert any missing seed records; existing records are
 * left untouched (seeding never resets an operator's lifecycle state).
 * Also seeds the capability routes (seedCapabilityRoutes) so a fresh
 * store carries the full composition. Returns the full config list in
 * precedence order.
 */
export function seedProviderConfigs(sql: SqlStorage): ProviderConfigRecord[] {
  ensureProviderConfigTable(sql);
  for (const seed of DEFAULT_PROVIDER_SEEDS) {
    if (!getProviderConfig(sql, seed.id)) {
      upsertProviderConfig(sql, seed);
    }
  }
  seedCapabilityRoutes(sql);
  return listProviderConfigs(sql);
}

// ---------------------------------------------------------------------------
// Capability routing — who serves each capability in a composed run.
// ---------------------------------------------------------------------------

export const PROVIDER_ROUTING_TABLE = "mas_data_provider_routes";

/**
 * One routing row: the provider that primarily serves a capability,
 * plus an optional gap-fill provider that is consulted ONLY for
 * elements the primary did not supply (the Yahoo quote gap-fill in
 * today's stock screener). Gap-fill is a declared composition role —
 * it is never invented by resolution and never promoted to primary.
 */
export interface CapabilityRouteRecord {
  capability: DataProviderCapability;
  primaryProviderId: DataProviderId;
  gapFillProviderId: DataProviderId | null;
  /**
   * Minimum caller tier served through this route (E5, issue
   * #1202). The tier gates the ROUTE — primary and gap-fill alike:
   * a freemium caller is refused a premium route outright rather
   * than silently served by its gap-fill. Rows written before the
   * min_tier column existed read as "freemium" (see routeFromRow),
   * which is the pre-E5 behaviour: every route served every caller.
   */
  minTier: Tier;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityRouteInput {
  capability: DataProviderCapability;
  primaryProviderId: DataProviderId;
  gapFillProviderId?: DataProviderId | null;
  /** Omitted on upsert: the stored tier is preserved (a fresh row starts freemium). */
  minTier?: Tier;
}

export function ensureProviderRoutingTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${PROVIDER_ROUTING_TABLE} (
    capability TEXT PRIMARY KEY,
    primary_provider_id TEXT NOT NULL,
    gap_fill_provider_id TEXT,
    min_tier TEXT NOT NULL DEFAULT 'freemium',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // Pre-E5 tables lack min_tier: add it in place (the scan-run
  // store's ensure-column idiom). The column DEFAULT backfills
  // existing rows to freemium — the tier they always effectively had.
  const columns = Array.from(
    sql.exec(`PRAGMA table_info(${PROVIDER_ROUTING_TABLE})`)
  ) as any[];
  if (!columns.some((c) => c.name === "min_tier")) {
    sql.exec(
      `ALTER TABLE ${PROVIDER_ROUTING_TABLE} ADD COLUMN min_tier TEXT NOT NULL DEFAULT 'freemium'`
    );
  }
}

function routeFromRow(r: any): CapabilityRouteRecord {
  return {
    capability: r.capability,
    primaryProviderId: r.primary_provider_id,
    gapFillProviderId: r.gap_fill_provider_id ?? null,
    minTier: r.min_tier === "premium" ? "premium" : "freemium",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Insert or replace the route for a capability; returns the record as stored. */
export function upsertCapabilityRoute(
  sql: SqlStorage,
  input: CapabilityRouteInput
): CapabilityRouteRecord {
  ensureProviderRoutingTable(sql);
  const existing = getCapabilityRoute(sql, input.capability);
  const now = new Date().toISOString();
  const record: CapabilityRouteRecord = {
    capability: input.capability,
    primaryProviderId: input.primaryProviderId,
    gapFillProviderId: input.gapFillProviderId ?? null,
    // An omitted tier PRESERVES the stored one: slot-maintenance
    // upserts (the deprovision gap-fill clearing) must not silently
    // reset an operator-set tier. Only an explicit tier changes it.
    minTier: input.minTier ?? existing?.minTier ?? "freemium",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) {
    sql.exec(
      `UPDATE ${PROVIDER_ROUTING_TABLE}
       SET primary_provider_id = ?, gap_fill_provider_id = ?, min_tier = ?, updated_at = ?
       WHERE capability = ?`,
      record.primaryProviderId,
      record.gapFillProviderId,
      record.minTier,
      record.updatedAt,
      record.capability
    );
  } else {
    sql.exec(
      `INSERT INTO ${PROVIDER_ROUTING_TABLE}
       (capability, primary_provider_id, gap_fill_provider_id, min_tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      record.capability,
      record.primaryProviderId,
      record.gapFillProviderId,
      record.minTier,
      record.createdAt,
      record.updatedAt
    );
  }
  return getCapabilityRoute(sql, input.capability) ?? record;
}

export function getCapabilityRoute(
  sql: SqlStorage,
  capability: DataProviderCapability
): CapabilityRouteRecord | null {
  ensureProviderRoutingTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${PROVIDER_ROUTING_TABLE} WHERE capability = ?`,
      capability
    )
  ) as any[];
  return rows.length > 0 ? routeFromRow(rows[0]) : null;
}

/** All routes, ordered by capability for a deterministic composition view. */
export function listCapabilityRoutes(sql: SqlStorage): CapabilityRouteRecord[] {
  ensureProviderRoutingTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM ${PROVIDER_ROUTING_TABLE} ORDER BY capability ASC`)
  ) as any[];
  return rows.map(routeFromRow);
}

/**
 * Withdraw every routing assignment that names a provider (E3,
 * issue #1170 — the deprovision side effect). Rows where the
 * provider is the PRIMARY are deleted outright (the capability
 * loses its routed assignment and resolution fails explicitly
 * until an operator re-routes it); rows where the provider is
 * only the declared GAP-FILL keep their primary and have the
 * gap-fill slot cleared — withdrawing a supplementary provider
 * must not take down the primary's route. Returns what was done
 * so the lifecycle audit can report it.
 */
export function deleteCapabilityRoutesForProvider(
  sql: SqlStorage,
  providerId: DataProviderId
): { deleted: number; gapFillCleared: number } {
  ensureProviderRoutingTable(sql);
  let deleted = 0;
  let gapFillCleared = 0;
  for (const route of listCapabilityRoutes(sql)) {
    if (route.primaryProviderId === providerId) {
      sql.exec(
        `DELETE FROM ${PROVIDER_ROUTING_TABLE} WHERE capability = ?`,
        route.capability
      );
      deleted++;
    } else if (route.gapFillProviderId === providerId) {
      upsertCapabilityRoute(sql, {
        capability: route.capability,
        primaryProviderId: route.primaryProviderId,
        gapFillProviderId: null,
      });
      gapFillCleared++;
    }
  }
  return { deleted, gapFillCleared };
}

/**
 * TODAY's screening composition (owner correction, comment 6358714200
 * on #1116) — the routes the current stock/options screeners actually
 * run, named in platform vocabulary:
 *
 *   screenUniverse ← nasdaq   (listings/universe membership)
 *   historicalBars ← yahoo    (technicals history E*TRADE lacks)
 *   quotes         ← etrade primary, NO gap-fill (issue #2144:
 *                     live quote rows are never gap-filled)
 *   optionsChains  ← etrade   (the only chain source)
 *   fundamentals   ← yahoo    (market-data)
 *
 * No route for `news`: nothing serves it yet, and resolution fails
 * explicitly rather than inventing an assignment.
 */
export const DEFAULT_CAPABILITY_ROUTES: readonly CapabilityRouteInput[] = [
  { capability: "screenUniverse", primaryProviderId: "nasdaq", gapFillProviderId: null, minTier: "freemium" },
  { capability: "historicalBars", primaryProviderId: "yahoo", gapFillProviderId: null, minTier: "freemium" },
  { capability: "quotes", primaryProviderId: "etrade", gapFillProviderId: null, minTier: "freemium" },
  { capability: "optionsChains", primaryProviderId: "etrade", gapFillProviderId: null, minTier: "freemium" },
  { capability: "fundamentals", primaryProviderId: "yahoo", gapFillProviderId: null, minTier: "freemium" },
];

/** Idempotently insert any missing default routes; existing routes are left untouched. */
export function seedCapabilityRoutes(sql: SqlStorage): CapabilityRouteRecord[] {
  ensureProviderRoutingTable(sql);
  for (const route of DEFAULT_CAPABILITY_ROUTES) {
    if (!getCapabilityRoute(sql, route.capability)) {
      upsertCapabilityRoute(sql, route);
    }
  }
  return listCapabilityRoutes(sql);
}

// ---------------------------------------------------------------------------
// Bootstrap — the minimal enablement the screening cutover owns (E2).
// ---------------------------------------------------------------------------

/**
 * Bootstrap this store for platform-routed screening (E2, issue
 * #1157): seed the provider configs + capability routes (idempotent,
 * above) and enable E*TRADE — the one provider whose full lifecycle
 * the #1116 vertical implements first.
 *
 * Enablement here is deliberately narrow: etrade's record is moved
 * to lifecycleState "enabled" with the enabled flag on, via the
 * store's own setters, and ONLY when it is not already in that state
 * — so a second bootstrap writes nothing at all (pinned: the stored
 * records are byte-identical across a repeat call). No other
 * provider's seeded state is touched: yahoo/nasdaq/alpaca stay
 * "configured"/disabled and public stays "registered" until their
 * own lifecycle acts (E3 owns the general provisioning lifecycle;
 * this is the cutover's minimal seed+enable step for the reference
 * provider, per the E2 survey's enablement decision).
 *
 * Returns the full config list in precedence order, as stored.
 */
export function bootstrapDataProviders(sql: SqlStorage): ProviderConfigRecord[] {
  seedProviderConfigs(sql);
  const etrade = getProviderConfig(sql, "etrade");
  if (etrade && (etrade.lifecycleState !== "enabled" || !etrade.enabled)) {
    if (etrade.lifecycleState !== "enabled") {
      setProviderLifecycleState(sql, "etrade", "enabled");
    }
    if (!etrade.enabled) {
      setProviderEnabled(sql, "etrade", true);
    }
  }
  return listProviderConfigs(sql);
}
