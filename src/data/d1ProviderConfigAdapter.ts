/**
 * Issue #2303 (#1976 step 1) — Drizzle D1 adapter for the
 * provider-configuration port (ADR 0022 D-0: this family is
 * D1-sufficient; this adapter is the production implementation
 * when AGENT_DB is bound). All SQL-adjacent code for the family
 * lives here, behind the port interface.
 *
 * The record semantics are the legacy store's, exactly: upsert
 * merge rules (shared pure helpers in providerConfigPorts.ts),
 * write→read returns, precedence/capability orderings, the
 * seed/bootstrap behaviour. The shared conformance suite runs
 * the same assertions against this adapter, the in-memory
 * adapter, and the DO-SQLite adapter.
 *
 * TRANSACTIONS: applyConfigWrites is the transaction aspect's
 * first production consumer (ADR D-C). The write set is
 * translated to raw statements and executed through
 * withTransaction over the D1 batch leg — statements are
 * buffered while the unit runs and applied by ONE batch()
 * call, so the set lands atomically or not at all. (The
 * aspect's unit is write-only by design: callers compute the
 * final rows from reads taken before the unit opens.)
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import {
  agentDataProviderRoutes,
  agentDataProviders,
} from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import {
  d1BatchTransactionBackend,
  withTransaction,
  type D1BatchDatabase,
} from "../aspects/transactionAspect";
import type {
  DataProviderCapability,
  DataProviderId,
} from "../trading";
import {
  DEFAULT_CAPABILITY_ROUTES,
  DEFAULT_PROVIDER_SEEDS,
  mergeCapabilityRouteInput,
  mergeProviderConfigInput,
  type CapabilityRouteInput,
  type CapabilityRouteRecord,
  type ProviderConfigInput,
  type ProviderConfigRecord,
  type ProviderConfigStore,
  type ProviderConfigWrite,
  type ProviderLifecycleState,
} from "./providerConfigPorts";

/** Drizzle D1 database object carrying the provider-config schema. */
export type ProviderConfigDb = DrizzleD1Database<{
  agentDataProviders: typeof agentDataProviders;
  agentDataProviderRoutes: typeof agentDataProviderRoutes;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ProviderConfigDb(d1: D1Database): ProviderConfigDb {
  return drizzle(d1, {
    schema: { agentDataProviders, agentDataProviderRoutes },
  });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureProviderConfigSchema(
  db: ProviderConfigDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

type ProviderRow = typeof agentDataProviders.$inferSelect;
type RouteRow = typeof agentDataProviderRoutes.$inferSelect;

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

function toProviderRecord(raw: ProviderRow): ProviderConfigRecord {
  return {
    id: raw.id as DataProviderId,
    adapterKind: raw.adapterKind,
    lifecycleState: raw.lifecycleState as ProviderLifecycleState,
    enabled: Number(raw.enabled) === 1,
    precedence: Number(raw.precedence),
    credentialRef: raw.credentialRef ?? null,
    config: parseConfig(raw.configJson),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function toRouteRecord(raw: RouteRow): CapabilityRouteRecord {
  return {
    capability: raw.capability as DataProviderCapability,
    primaryProviderId: raw.primaryProviderId as DataProviderId,
    gapFillProviderId:
      (raw.gapFillProviderId as DataProviderId | null) ?? null,
    minTier: raw.minTier === "premium" ? "premium" : "freemium",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

const UPSERT_PROVIDER_SQL = `INSERT INTO agent_data_providers
  (id, adapter_kind, lifecycle_state, enabled, precedence, credential_ref, config_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET adapter_kind = excluded.adapter_kind,
    lifecycle_state = excluded.lifecycle_state, enabled = excluded.enabled,
    precedence = excluded.precedence, credential_ref = excluded.credential_ref,
    config_json = excluded.config_json, created_at = excluded.created_at,
    updated_at = excluded.updated_at`;

const UPSERT_ROUTE_SQL = `INSERT INTO agent_data_provider_routes
  (capability, primary_provider_id, gap_fill_provider_id, min_tier, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(capability) DO UPDATE SET primary_provider_id = excluded.primary_provider_id,
    gap_fill_provider_id = excluded.gap_fill_provider_id, min_tier = excluded.min_tier,
    created_at = excluded.created_at, updated_at = excluded.updated_at`;

const DELETE_ROUTE_SQL = `DELETE FROM agent_data_provider_routes WHERE capability = ?`;

function providerParams(record: ProviderConfigRecord): unknown[] {
  return [
    record.id,
    record.adapterKind,
    record.lifecycleState,
    record.enabled ? 1 : 0,
    record.precedence,
    record.credentialRef,
    JSON.stringify(record.config),
    record.createdAt,
    record.updatedAt,
  ];
}

function routeParams(record: CapabilityRouteRecord): unknown[] {
  return [
    record.capability,
    record.primaryProviderId,
    record.gapFillProviderId,
    record.minTier,
    record.createdAt,
    record.updatedAt,
  ];
}

/** Provider-configuration store over D1 via Drizzle. */
export class D1ProviderConfigAdapter implements ProviderConfigStore {
  constructor(
    readonly db: ProviderConfigDb,
    private readonly d1: D1BatchDatabase,
  ) {}

  async getProviderConfig(
    id: DataProviderId,
  ): Promise<ProviderConfigRecord | null> {
    const rows = await this.db
      .select()
      .from(agentDataProviders)
      .where(eq(agentDataProviders.id, id))
      .limit(1);
    return rows.length > 0 ? toProviderRecord(rows[0]) : null;
  }

  async listProviderConfigs(): Promise<ProviderConfigRecord[]> {
    const rows = await this.db
      .select()
      .from(agentDataProviders)
      .orderBy(asc(agentDataProviders.precedence), asc(agentDataProviders.id));
    return rows.map(toProviderRecord);
  }

  async upsertProviderConfig(
    input: ProviderConfigInput,
  ): Promise<ProviderConfigRecord> {
    const existing = await this.getProviderConfig(input.id);
    const record = mergeProviderConfigInput(
      input,
      existing,
      new Date().toISOString(),
    );
    if (existing) {
      await this.db
        .update(agentDataProviders)
        .set({
          adapterKind: record.adapterKind,
          lifecycleState: record.lifecycleState,
          enabled: record.enabled ? 1 : 0,
          precedence: record.precedence,
          credentialRef: record.credentialRef,
          configJson: JSON.stringify(record.config),
          updatedAt: record.updatedAt,
        })
        .where(eq(agentDataProviders.id, record.id));
    } else {
      await this.db.insert(agentDataProviders).values({
        id: record.id,
        adapterKind: record.adapterKind,
        lifecycleState: record.lifecycleState,
        enabled: record.enabled ? 1 : 0,
        precedence: record.precedence,
        credentialRef: record.credentialRef,
        configJson: JSON.stringify(record.config),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }
    return (await this.getProviderConfig(input.id)) ?? record;
  }

  async setProviderLifecycleState(
    id: DataProviderId,
    state: ProviderLifecycleState,
  ): Promise<ProviderConfigRecord | null> {
    const existing = await this.getProviderConfig(id);
    if (!existing) return null;
    return this.upsertProviderConfig({
      ...existing,
      lifecycleState: state,
      config: existing.config,
    });
  }

  async setProviderEnabled(
    id: DataProviderId,
    enabled: boolean,
  ): Promise<ProviderConfigRecord | null> {
    const existing = await this.getProviderConfig(id);
    if (!existing) return null;
    return this.upsertProviderConfig({
      ...existing,
      enabled,
      config: existing.config,
    });
  }

  async clearProviderCredentialRef(
    id: DataProviderId,
  ): Promise<ProviderConfigRecord | null> {
    const existing = await this.getProviderConfig(id);
    if (!existing) return null;
    await this.db
      .update(agentDataProviders)
      .set({ credentialRef: null, updatedAt: new Date().toISOString() })
      .where(eq(agentDataProviders.id, id));
    return this.getProviderConfig(id);
  }

  async getCapabilityRoute(
    capability: DataProviderCapability,
  ): Promise<CapabilityRouteRecord | null> {
    const rows = await this.db
      .select()
      .from(agentDataProviderRoutes)
      .where(eq(agentDataProviderRoutes.capability, capability))
      .limit(1);
    return rows.length > 0 ? toRouteRecord(rows[0]) : null;
  }

  async listCapabilityRoutes(): Promise<CapabilityRouteRecord[]> {
    const rows = await this.db
      .select()
      .from(agentDataProviderRoutes)
      .orderBy(asc(agentDataProviderRoutes.capability));
    return rows.map(toRouteRecord);
  }

  async upsertCapabilityRoute(
    input: CapabilityRouteInput,
  ): Promise<CapabilityRouteRecord> {
    const existing = await this.getCapabilityRoute(input.capability);
    const record = mergeCapabilityRouteInput(
      input,
      existing,
      new Date().toISOString(),
    );
    if (existing) {
      await this.db
        .update(agentDataProviderRoutes)
        .set({
          primaryProviderId: record.primaryProviderId,
          gapFillProviderId: record.gapFillProviderId,
          minTier: record.minTier,
          updatedAt: record.updatedAt,
        })
        .where(eq(agentDataProviderRoutes.capability, record.capability));
    } else {
      await this.db.insert(agentDataProviderRoutes).values({
        capability: record.capability,
        primaryProviderId: record.primaryProviderId,
        gapFillProviderId: record.gapFillProviderId,
        minTier: record.minTier,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }
    return (await this.getCapabilityRoute(input.capability)) ?? record;
  }

  async deleteCapabilityRoutesForProvider(
    providerId: DataProviderId,
  ): Promise<{ deleted: number; gapFillCleared: number }> {
    const writes: ProviderConfigWrite[] = [];
    let deleted = 0;
    let gapFillCleared = 0;
    for (const route of await this.listCapabilityRoutes()) {
      if (route.primaryProviderId === providerId) {
        writes.push({ kind: "deleteRoute", capability: route.capability });
        deleted++;
      } else if (route.gapFillProviderId === providerId) {
        writes.push({
          kind: "upsertRoute",
          record: {
            ...route,
            gapFillProviderId: null,
            updatedAt: new Date().toISOString(),
          },
        });
        gapFillCleared++;
      }
    }
    if (writes.length > 0) await this.applyConfigWrites(writes);
    return { deleted, gapFillCleared };
  }

  async seedProviderConfigs(): Promise<ProviderConfigRecord[]> {
    for (const seed of DEFAULT_PROVIDER_SEEDS) {
      if (!(await this.getProviderConfig(seed.id))) {
        await this.upsertProviderConfig(seed);
      }
    }
    await this.seedCapabilityRoutes();
    return this.listProviderConfigs();
  }

  async seedCapabilityRoutes(): Promise<CapabilityRouteRecord[]> {
    for (const route of DEFAULT_CAPABILITY_ROUTES) {
      if (!(await this.getCapabilityRoute(route.capability))) {
        await this.upsertCapabilityRoute(route);
      }
    }
    return this.listCapabilityRoutes();
  }

  async bootstrapDataProviders(): Promise<ProviderConfigRecord[]> {
    await this.seedProviderConfigs();
    const etrade = await this.getProviderConfig("etrade");
    if (etrade && (etrade.lifecycleState !== "enabled" || !etrade.enabled)) {
      if (etrade.lifecycleState !== "enabled") {
        await this.setProviderLifecycleState("etrade", "enabled");
      }
      if (!etrade.enabled) {
        await this.setProviderEnabled("etrade", true);
      }
    }
    return this.listProviderConfigs();
  }

  /**
   * Apply a write set as ONE unit of work through the
   * transaction aspect (D1 batch leg — see the module header).
   */
  async applyConfigWrites(
    writes: readonly ProviderConfigWrite[],
  ): Promise<void> {
    if (writes.length === 0) return;
    await withTransaction(
      d1BatchTransactionBackend(this.d1),
      { operationName: "dataProviders.applyConfigWrites", domain: "data-providers" },
      (unit) => {
        for (const write of writes) {
          if (write.kind === "upsertProvider") {
            unit.exec(UPSERT_PROVIDER_SQL, ...providerParams(write.record));
          } else if (write.kind === "upsertRoute") {
            unit.exec(UPSERT_ROUTE_SQL, ...routeParams(write.record));
          } else {
            unit.exec(DELETE_ROUTE_SQL, write.capability);
          }
        }
      },
    );
  }
}
