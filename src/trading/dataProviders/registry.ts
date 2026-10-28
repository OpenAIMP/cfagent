/**
 * Issue #1118 (P1 of epic #1116): the DataProviderRegistry.
 *
 * Mirrors the #1103 ScreeningProviderRegistry idiom — unique ids
 * (re-registering throws, so provenance ids stay unambiguous) and
 * EXPLICIT resolution failure — and applies its no-silent-fallback rule
 * to data: TradingPlatformRegistry's fallback to E*TRADE is the wrong
 * semantic for a data platform, where silently serving provider B's
 * data for provider A's capability would mislabel every downstream
 * capture and screen.
 *
 * Resolution is driven by the provider-config store, never by code
 * order. A provider is SERVABLE for a capability only when ALL of
 * these hold:
 *
 *   1. its config record's lifecycle state is "enabled",
 *   2. its config record's enabled flag is on,
 *   3. an adapter is registered under its id, and
 *   4. the adapter declares the capability.
 *
 * Screening COMPOSES providers (owner correction, comment 6358714200
 * on #1116), so the headline resolution is resolveRoute(): given the
 * capability ROUTING table, it returns the routed assignment — the
 * route's primary provider plus its declared gap-fill provider when
 * that provider is also servable. EXCEPTION (issue #2144, owner
 * ruling): the quotes capability never resolves a gap-fill — a
 * live quote row is never filled by another provider, even when a
 * stored route declares one. Yahoo still fills columns
 * (technicals/history) through other capabilities and paths.
 * The semantics are strict in both directions:
 *
 *   - A routed PRIMARY that is not servable fails EXPLICITLY
 *     (DataProviderNotFoundError). The gap-fill is never silently
 *     promoted, and no precedence winner is substituted — a run that
 *     cannot get its routed primary must say so, not quietly change
 *     composition.
 *   - An unservable GAP-FILL is simply omitted from the assignment —
 *     visible in the returned shape (gapFill undefined), never fatal
 *     and never replaced: gap-fill is supplementary by definition.
 *   - With NO route declared for a capability, precedence order is
 *     the routing default: the highest-precedence servable declarer
 *     becomes the primary, and there is no gap-fill (gap-fill exists
 *     only where a route declares it).
 *
 * resolve() is the precedence-only convenience (the primary of the
 * no-route default), kept for consumers that genuinely need a single
 * provider. Anything unservable — unregistered capability,
 * half-provisioned provider, disabled provider, enabled config with
 * no adapter (the seeded "public" descriptor is exactly this until
 * its integration slice) — throws DataProviderNotFoundError. Adding,
 * reprioritizing, or re-routing a provider is a config act, not a
 * code change.
 */

import type {
  DataProvider,
  DataProviderCapability,
  DataProviderId,
  Tier,
} from "./contract";
import type {
  CapabilityRouteRecord,
  ProviderConfigRecord,
} from "./providerConfigStore";

/**
 * The routed assignment for one capability: the primary provider that
 * serves it, and — only where the route declares one and it is
 * servable — the gap-fill provider for elements the primary lacks.
 */
export interface CapabilityAssignment {
  capability: DataProviderCapability;
  primary: DataProvider;
  gapFill?: DataProvider;
}

export class DataProviderNotFoundError extends Error {
  readonly capability: DataProviderCapability;
  constructor(capability: DataProviderCapability) {
    super(
      `No enabled data provider serves capability "${capability}". ` +
        `Resolution requires a provider whose config-store state is "enabled" ` +
        `(state and flag) with a registered adapter declaring the capability.`
    );
    this.name = "DataProviderNotFoundError";
    this.capability = capability;
  }
}

/**
 * An entitlement refusal (E5, issue #1202): the route EXISTS and its
 * primary is servable, but the route's minTier is above the tier the
 * caller presented. Deliberately NOT a DataProviderNotFoundError —
 * "your tier does not include this route" and "no provider serves
 * this capability" are different operational facts, and callers must
 * be able to tell a refusal from an outage. The tier gates the whole
 * route: a freemium caller is never quietly served by the route's
 * gap-fill instead (no silent substitution).
 */
export class DataProviderTierError extends Error {
  readonly providerId: DataProviderId;
  readonly capability: DataProviderCapability;
  readonly requiredTier: Tier;
  readonly callerTier: Tier;
  constructor(
    providerId: DataProviderId,
    capability: DataProviderCapability,
    requiredTier: Tier,
    callerTier: Tier
  ) {
    super(
      `Data provider "${providerId}" serves capability "${capability}" ` +
        `only on the ${requiredTier} tier; the caller presented the ${callerTier} tier. ` +
        `The route is not served at a lower tier and no substitute provider is used.`
    );
    this.name = "DataProviderTierError";
    this.providerId = providerId;
    this.capability = capability;
    this.requiredTier = requiredTier;
    this.callerTier = callerTier;
  }
}

export class DataProviderRegistry {
  private providers = new Map<DataProviderId, DataProvider>();

  register(provider: DataProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Data provider "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: DataProviderId): DataProvider | undefined {
    return this.providers.get(id);
  }

  list(): DataProvider[] {
    return Array.from(this.providers.values());
  }

  /** The servable provider registered under `id` for `capability`, or undefined. */
  private servable(
    id: DataProviderId,
    capability: DataProviderCapability,
    configsById: Map<DataProviderId, ProviderConfigRecord>
  ): DataProvider | undefined {
    const config = configsById.get(id);
    if (!config) return undefined;
    if (config.lifecycleState !== "enabled" || !config.enabled) return undefined;
    const provider = this.providers.get(id);
    if (!provider || !provider.capabilities.includes(capability)) return undefined;
    return provider;
  }

  /**
   * The highest-precedence servable provider for `capability` per the
   * config records (the no-route routing default). Throws
   * DataProviderNotFoundError when no provider qualifies.
   */
  resolve(
    capability: DataProviderCapability,
    configs: readonly ProviderConfigRecord[]
  ): DataProvider {
    const ordered = [...configs].sort((a, b) => a.precedence - b.precedence);
    const configsById = new Map(ordered.map((c) => [c.id, c] as const));
    for (const config of ordered) {
      const provider = this.servable(config.id, capability, configsById);
      if (provider) return provider;
    }
    throw new DataProviderNotFoundError(capability);
  }

  /**
   * The routed assignment for `capability`: the routing table's
   * primary (+ declared gap-fill) when a route exists, else the
   * precedence default. See the module header for the strict
   * primary/gap-fill semantics. Throws DataProviderNotFoundError when
   * the primary cannot be served.
   *
   * `callerTier` (E5, issue #1202) is the entitlement check, applied
   * only when a caller presents a tier: a route whose minTier is
   * "premium" refuses a "freemium" caller with DataProviderTierError
   * — after servability, so an unservable primary still reports as
   * not-found. When the tier is omitted the behaviour is exactly the
   * pre-E5 one: internal composition points present no tier and rely
   * on entry points presenting theirs.
   */
  resolveRoute(
    capability: DataProviderCapability,
    configs: readonly ProviderConfigRecord[],
    routes: readonly CapabilityRouteRecord[],
    callerTier?: Tier
  ): CapabilityAssignment {
    const configsById = new Map(configs.map((c) => [c.id, c] as const));
    const route = routes.find((r) => r.capability === capability);
    if (!route) {
      return { capability, primary: this.resolve(capability, configs) };
    }
    const primary = this.servable(route.primaryProviderId, capability, configsById);
    if (!primary) throw new DataProviderNotFoundError(capability);
    if (
      callerTier !== undefined &&
      route.minTier === "premium" &&
      callerTier === "freemium"
    ) {
      throw new DataProviderTierError(
        route.primaryProviderId,
        capability,
        route.minTier,
        callerTier
      );
    }
    // Issue #2144 (owner ruling): live quote ROWS are never
    // gap-filled. Yahoo may fill columns (technicals/history) but
    // never a whole symbol's live quote, so the quotes capability
    // resolves no gap-fill even when a stored route declares one.
    // Every other capability keeps its declared gap-fill.
    const gapFill =
      capability === "quotes"
        ? undefined
        : route.gapFillProviderId
          ? this.servable(route.gapFillProviderId, capability, configsById)
          : undefined;
    return gapFill
      ? { capability, primary, gapFill }
      : { capability, primary };
  }
}
