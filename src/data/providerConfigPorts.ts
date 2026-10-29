/**
 * Issue #2303 (#1976 step 1, ADR 0022 D-0/D-I step 1) —
 * provider-configuration port for the #1116 data-provider
 * platform: the provider instance records (mas_data_providers'
 * vocabulary) plus the capability routing table.
 *
 * ADR D-0 ruled this family D1-sufficient — fleet-global
 * configuration in shared records, rare administrative writes,
 * none of the six DO properties consumed — making it the
 * programme's first D1 migration. This module carries the
 * record types, the seed constants, the write-set vocabulary,
 * and the port interface ONLY (ADR 0002 R1/R2): no store
 * client, no env binding, no SQL. Adapters:
 * d1ProviderConfigAdapter.ts (production), 
 * inMemoryProviderConfigAdapter.ts (test double),
 * doSqliteProviderConfigAdapter.ts (the legacy DO store,
 * sync-shaped, behind the same port).
 *
 * The types and seeds moved here from
 * src/trading/dataProviders/providerConfigStore.ts, which is
 * now a re-export shim over the DO adapter — every existing
 * import path keeps resolving to the same symbols.
 *
 * WRITE SETS (the transaction aspect's seam, ADR D-C): a
 * lifecycle transition's write phase (configure / deprovision)
 * performs several row writes across both tables that must
 * land atomically or not at all. Callers compute the final
 * rows from their reads (reads happen BEFORE the unit, per
 * the aspect contract) and hand them to applyConfigWrites as
 * ProviderConfigWrite ops; the D1 adapter executes them
 * through withTransaction (D1 batch leg). Single-row port
 * methods stay the surface for everything else.
 */
import type {
  DataProviderCapability,
  DataProviderId,
  Tier,
} from "../trading";

/** The legacy DO table names (the D1 tables are agent_data_*). */
export const PROVIDER_CONFIG_TABLE = "mas_data_providers";
export const PROVIDER_ROUTING_TABLE = "mas_data_provider_routes";

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

/**
 * One routing row: the provider that primarily serves a capability,
 * plus an optional gap-fill provider that is consulted ONLY for
 * elements the primary did not supply. Gap-fill is a declared
 * composition role — never invented by resolution, never promoted
 * to primary.
 */
export interface CapabilityRouteRecord {
  capability: DataProviderCapability;
  primaryProviderId: DataProviderId;
  gapFillProviderId: DataProviderId | null;
  /**
   * Minimum caller tier served through this route (E5, #1202).
   * The tier gates the ROUTE — primary and gap-fill alike. Rows
   * written before the min_tier column existed read as
   * "freemium" (the pre-E5 behaviour: every route served every
   * caller).
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

/**
 * The five owner-set providers (epic #1116, decision comment
 * 6358627401) in owner precedence order. Lifecycle states reflect
 * reality at seed time: the four existing providers are
 * "configured"; "public" is a descriptor only — "registered", no
 * adapter until its integration slice. NOTHING is seeded
 * "enabled": enablement is a deliberate lifecycle act (P4), never
 * a seed default.
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
 * TODAY's screening composition (owner correction, comment
 * 6358714200 on #1116) — the routes the current stock/options
 * screeners actually run. No route for `news`: nothing serves it
 * yet, and resolution fails explicitly rather than inventing an
 * assignment.
 */
export const DEFAULT_CAPABILITY_ROUTES: readonly CapabilityRouteInput[] = [
  { capability: "screenUniverse", primaryProviderId: "nasdaq", gapFillProviderId: null, minTier: "freemium" },
  { capability: "historicalBars", primaryProviderId: "yahoo", gapFillProviderId: null, minTier: "freemium" },
  { capability: "quotes", primaryProviderId: "etrade", gapFillProviderId: null, minTier: "freemium" },
  { capability: "optionsChains", primaryProviderId: "etrade", gapFillProviderId: null, minTier: "freemium" },
  { capability: "fundamentals", primaryProviderId: "yahoo", gapFillProviderId: null, minTier: "freemium" },
];

/**
 * One write in a transactional write set: a FINAL row (computed
 * by the caller from its reads, merge rules already applied) or
 * a route deletion. Adapters translate ops to their store's
 * statements; the set is applied as one unit of work.
 */
export type ProviderConfigWrite =
  | { kind: "upsertProvider"; record: ProviderConfigRecord }
  | { kind: "upsertRoute"; record: CapabilityRouteRecord }
  | { kind: "deleteRoute"; capability: DataProviderCapability };

/** The provider-configuration store surface (async, port-shaped). */
export interface ProviderConfigStore {
  /** Insert or update a config record (merge rules per the legacy store); returns the record as stored. */
  upsertProviderConfig(input: ProviderConfigInput): Promise<ProviderConfigRecord>;
  getProviderConfig(id: DataProviderId): Promise<ProviderConfigRecord | null>;
  /** All provider records in configured precedence order (precedence ASC, id as tiebreak). */
  listProviderConfigs(): Promise<ProviderConfigRecord[]>;
  setProviderLifecycleState(
    id: DataProviderId,
    state: ProviderLifecycleState
  ): Promise<ProviderConfigRecord | null>;
  setProviderEnabled(
    id: DataProviderId,
    enabled: boolean
  ): Promise<ProviderConfigRecord | null>;
  /**
   * Clear a provider's credential reference (E3, #1170) — a
   * dedicated operation because upsert treats a null
   * credentialRef as "keep existing".
   */
  clearProviderCredentialRef(id: DataProviderId): Promise<ProviderConfigRecord | null>;
  /** Insert or replace the route for a capability; returns the record as stored. */
  upsertCapabilityRoute(input: CapabilityRouteInput): Promise<CapabilityRouteRecord>;
  getCapabilityRoute(
    capability: DataProviderCapability
  ): Promise<CapabilityRouteRecord | null>;
  /** All routes, ordered by capability for a deterministic composition view. */
  listCapabilityRoutes(): Promise<CapabilityRouteRecord[]>;
  /**
   * Withdraw every routing assignment naming a provider (E3):
   * primary rows are deleted, gap-fill slots are cleared.
   * Returns what was done so the lifecycle audit can report it.
   */
  deleteCapabilityRoutesForProvider(
    providerId: DataProviderId
  ): Promise<{ deleted: number; gapFillCleared: number }>;
  /** Idempotently insert any missing seed records (existing records untouched); also seeds the routes. */
  seedProviderConfigs(): Promise<ProviderConfigRecord[]>;
  /** Idempotently insert any missing default routes. */
  seedCapabilityRoutes(): Promise<CapabilityRouteRecord[]>;
  /**
   * Bootstrap for platform-routed screening (E2, #1157): seed,
   * then enable E*TRADE — and only E*TRADE — via the store's own
   * setters, only when not already enabled (a repeat bootstrap
   * writes nothing). Returns the full config list as stored.
   */
  bootstrapDataProviders(): Promise<ProviderConfigRecord[]>;
  /**
   * Apply a pre-computed write set as ONE unit of work (the
   * transaction aspect's seam — see the module header). On the
   * D1 adapter the set runs through withTransaction's batch
   * leg: all statements land or none do.
   */
  applyConfigWrites(writes: readonly ProviderConfigWrite[]): Promise<void>;
}

/**
 * The merge rule shared by every adapter's upsert (the legacy
 * store's semantics): fields the input omits are preserved from
 * the existing record; createdAt is preserved across updates.
 * Pure — adapters call it with their own read of `existing`.
 */
export function mergeProviderConfigInput(
  input: ProviderConfigInput,
  existing: ProviderConfigRecord | null,
  now: string
): ProviderConfigRecord {
  return {
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
}

/** The route merge rule: an omitted tier preserves the stored one. */
export function mergeCapabilityRouteInput(
  input: CapabilityRouteInput,
  existing: CapabilityRouteRecord | null,
  now: string
): CapabilityRouteRecord {
  return {
    capability: input.capability,
    primaryProviderId: input.primaryProviderId,
    gapFillProviderId: input.gapFillProviderId ?? null,
    minTier: input.minTier ?? existing?.minTier ?? "freemium",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
