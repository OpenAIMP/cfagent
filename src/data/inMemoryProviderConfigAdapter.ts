/**
 * Issue #2303 (#1976 step 1) — in-memory provider-configuration
 * store. A test double with the same port semantics as the D1
 * and DO-SQLite adapters: the conformance suite runs unchanged
 * against all three. It is NOT a production store and NOT a
 * second source of truth — it exists so the port contract is
 * testable without any store at all.
 *
 * applyConfigWrites is atomic here by snapshot/restore: if any
 * op fails, the pre-call state is restored whole — the double
 * honours the same unit-of-work contract the D1 adapter gets
 * from the transaction aspect's batch leg.
 */
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryProviderConfigAdapter implements ProviderConfigStore {
  private providers = new Map<DataProviderId, ProviderConfigRecord>();
  private routes = new Map<DataProviderCapability, CapabilityRouteRecord>();

  async getProviderConfig(
    id: DataProviderId,
  ): Promise<ProviderConfigRecord | null> {
    const record = this.providers.get(id);
    return record ? clone(record) : null;
  }

  async listProviderConfigs(): Promise<ProviderConfigRecord[]> {
    return [...this.providers.values()]
      .sort((a, b) => a.precedence - b.precedence || (a.id < b.id ? -1 : 1))
      .map(clone);
  }

  async upsertProviderConfig(
    input: ProviderConfigInput,
  ): Promise<ProviderConfigRecord> {
    const existing = this.providers.get(input.id) ?? null;
    const record = mergeProviderConfigInput(
      input,
      existing ? clone(existing) : null,
      new Date().toISOString(),
    );
    this.providers.set(record.id, clone(record));
    return clone(record);
  }

  async setProviderLifecycleState(
    id: DataProviderId,
    state: ProviderLifecycleState,
  ): Promise<ProviderConfigRecord | null> {
    const existing = this.providers.get(id);
    if (!existing) return null;
    return this.upsertProviderConfig({
      ...clone(existing),
      lifecycleState: state,
      config: existing.config,
    });
  }

  async setProviderEnabled(
    id: DataProviderId,
    enabled: boolean,
  ): Promise<ProviderConfigRecord | null> {
    const existing = this.providers.get(id);
    if (!existing) return null;
    return this.upsertProviderConfig({
      ...clone(existing),
      enabled,
      config: existing.config,
    });
  }

  async clearProviderCredentialRef(
    id: DataProviderId,
  ): Promise<ProviderConfigRecord | null> {
    const existing = this.providers.get(id);
    if (!existing) return null;
    const updated: ProviderConfigRecord = {
      ...clone(existing),
      credentialRef: null,
      updatedAt: new Date().toISOString(),
    };
    this.providers.set(id, updated);
    return clone(updated);
  }

  async getCapabilityRoute(
    capability: DataProviderCapability,
  ): Promise<CapabilityRouteRecord | null> {
    const record = this.routes.get(capability);
    return record ? clone(record) : null;
  }

  async listCapabilityRoutes(): Promise<CapabilityRouteRecord[]> {
    return [...this.routes.values()]
      .sort((a, b) => (a.capability < b.capability ? -1 : 1))
      .map(clone);
  }

  async upsertCapabilityRoute(
    input: CapabilityRouteInput,
  ): Promise<CapabilityRouteRecord> {
    const existing = this.routes.get(input.capability) ?? null;
    const record = mergeCapabilityRouteInput(
      input,
      existing ? clone(existing) : null,
      new Date().toISOString(),
    );
    this.routes.set(record.capability, clone(record));
    return clone(record);
  }

  async deleteCapabilityRoutesForProvider(
    providerId: DataProviderId,
  ): Promise<{ deleted: number; gapFillCleared: number }> {
    let deleted = 0;
    let gapFillCleared = 0;
    for (const route of [...this.routes.values()]) {
      if (route.primaryProviderId === providerId) {
        this.routes.delete(route.capability);
        deleted++;
      } else if (route.gapFillProviderId === providerId) {
        this.routes.set(route.capability, {
          ...route,
          gapFillProviderId: null,
          updatedAt: new Date().toISOString(),
        });
        gapFillCleared++;
      }
    }
    return { deleted, gapFillCleared };
  }

  async seedProviderConfigs(): Promise<ProviderConfigRecord[]> {
    for (const seed of DEFAULT_PROVIDER_SEEDS) {
      if (!this.providers.has(seed.id)) {
        await this.upsertProviderConfig(clone(seed));
      }
    }
    await this.seedCapabilityRoutes();
    return this.listProviderConfigs();
  }

  async seedCapabilityRoutes(): Promise<CapabilityRouteRecord[]> {
    for (const route of DEFAULT_CAPABILITY_ROUTES) {
      if (!this.routes.has(route.capability)) {
        await this.upsertCapabilityRoute(clone(route));
      }
    }
    return this.listCapabilityRoutes();
  }

  async bootstrapDataProviders(): Promise<ProviderConfigRecord[]> {
    await this.seedProviderConfigs();
    const etrade = this.providers.get("etrade");
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

  async applyConfigWrites(
    writes: readonly ProviderConfigWrite[],
  ): Promise<void> {
    const providersSnapshot = new Map(this.providers);
    const routesSnapshot = new Map(this.routes);
    try {
      for (const write of writes) {
        if (write.kind === "upsertProvider") {
          this.providers.set(write.record.id, clone(write.record));
        } else if (write.kind === "upsertRoute") {
          this.routes.set(write.record.capability, clone(write.record));
        } else {
          this.routes.delete(write.capability);
        }
      }
    } catch (err) {
      this.providers = providersSnapshot;
      this.routes = routesSnapshot;
      throw err;
    }
  }
}
