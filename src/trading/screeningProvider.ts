/**
 * Issue #1098 (Phase 0 of epic #1096): unified ScreeningProvider contract.
 *
 * Stock screening (E*TRADE/Yahoo pipeline behind DynamicMarketScreener,
 * which implements IMarketScreener) and options screening
 * (DynamicOptionsScreener.screenOptions) previously had no shared
 * contract: goal/scenario-driven screening (Phase 1+) had nothing uniform
 * to build on. This module wraps — never rewrites — both screeners behind
 * one discriminated request/result contract and a registry.
 *
 * Semantics that differ deliberately from TradingPlatformRegistry:
 *  - Resolution fails EXPLICITLY (ScreeningProviderNotFoundError) when no
 *    provider serves an asset class. TradingPlatformRegistry falls back
 *    to E*TRADE; for screening that would silently mislabel provenance —
 *    a stock result must never be returned for an options request.
 *  - Provider ids are unique in a registry: re-registering an id throws,
 *    so provenance ids stay unambiguous.
 *
 * Providers return the wrapped screener's result object unchanged; the
 * wrapper only tags it with the provider id and asset class.
 */

import type {
  StockScreenerFilter,
  StockScreenResult,
  OptionScreenerFilter,
  OptionScreenResult,
} from "../types";
import type { IMarketScreener } from "./interfaces";
import type { DynamicOptionsScreener } from "./optionsScreener";

export type ScreeningProviderAssetClass = "stocks" | "options";

export type ScreeningRequest =
  | { assetClass: "stocks"; filter?: StockScreenerFilter }
  | { assetClass: "options"; filter?: OptionScreenerFilter };

export type ScreeningResult =
  | { assetClass: "stocks"; providerId: string; result: StockScreenResult }
  | { assetClass: "options"; providerId: string; result: OptionScreenResult };

export interface ScreeningProvider {
  readonly id: string;
  readonly assetClasses: readonly ScreeningProviderAssetClass[];
  screen(request: ScreeningRequest): Promise<ScreeningResult>;
}

export class ScreeningProviderNotFoundError extends Error {
  readonly assetClass: ScreeningProviderAssetClass;
  constructor(assetClass: ScreeningProviderAssetClass) {
    super(`No screening provider registered for asset class "${assetClass}".`);
    this.name = "ScreeningProviderNotFoundError";
    this.assetClass = assetClass;
  }
}

function assertServes(providerId: string, served: ScreeningProviderAssetClass, requested: ScreeningProviderAssetClass): void {
  if (served !== requested) {
    throw new Error(
      `Screening provider "${providerId}" does not serve asset class "${requested}" (it serves "${served}").`
    );
  }
}

/** Wrap a stock screener (IMarketScreener — DynamicMarketScreener over the E*TRADE/Yahoo pipeline). */
export function createStockScreeningProvider(id: string, screener: IMarketScreener): ScreeningProvider {
  return {
    id,
    assetClasses: ["stocks"] as const,
    async screen(request: ScreeningRequest): Promise<ScreeningResult> {
      assertServes(id, "stocks", request.assetClass);
      const filter = request.assetClass === "stocks" ? request.filter : undefined;
      const result = await screener.screenMarkets(filter);
      return { assetClass: "stocks", providerId: id, result };
    },
  };
}

/** Wrap the dynamic options screener (DynamicOptionsScreener.screenOptions). */
export function createOptionsScreeningProvider(
  id: string,
  screener: Pick<DynamicOptionsScreener, "screenOptions">
): ScreeningProvider {
  return {
    id,
    assetClasses: ["options"] as const,
    async screen(request: ScreeningRequest): Promise<ScreeningResult> {
      assertServes(id, "options", request.assetClass);
      const filter = request.assetClass === "options" ? request.filter : undefined;
      const result = await screener.screenOptions(filter);
      return { assetClass: "options", providerId: id, result };
    },
  };
}

export class ScreeningProviderRegistry {
  private providers = new Map<string, ScreeningProvider>();

  register(provider: ScreeningProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Screening provider "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ScreeningProvider | undefined {
    return this.providers.get(id);
  }

  list(): ScreeningProvider[] {
    return Array.from(this.providers.values());
  }

  /** First registered provider serving the asset class; throws ScreeningProviderNotFoundError when none does. */
  resolve(assetClass: ScreeningProviderAssetClass): ScreeningProvider {
    for (const provider of this.providers.values()) {
      if (provider.assetClasses.includes(assetClass)) return provider;
    }
    throw new ScreeningProviderNotFoundError(assetClass);
  }

  async screen(request: ScreeningRequest): Promise<ScreeningResult> {
    return this.resolve(request.assetClass).screen(request);
  }
}

/**
 * Default wiring under stable provenance ids: the E*TRADE/Yahoo stock
 * pipeline ("etrade-yahoo-stocks") and the dynamic options screener
 * ("dynamic-options").
 */
export function createDefaultScreeningRegistry(deps: {
  stockScreener: IMarketScreener;
  optionsScreener: Pick<DynamicOptionsScreener, "screenOptions">;
}): ScreeningProviderRegistry {
  const registry = new ScreeningProviderRegistry();
  registry.register(createStockScreeningProvider("etrade-yahoo-stocks", deps.stockScreener));
  registry.register(createOptionsScreeningProvider("dynamic-options", deps.optionsScreener));
  return registry;
}
