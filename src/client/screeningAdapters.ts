/**
 * Client screening adapters — DERIVED from the one server registry
 * (consolidation C1, issue #1201, epic #1151 R2).
 *
 * Before C1 this module hand-mirrored the server provider registry
 * (src/trading/screeningProvider.ts) with its own SCREENING_PROVIDERS
 * list — two sources describing the same providers, free to drift.
 * The provider list below is now derived from the server registry's
 * descriptor table (SCREENING_PROVIDER_DESCRIPTORS, imported through
 * the trading barrel — the #290 boundary surface): each client entry
 * is one endpoint variant of a registry provider, and carries the
 * registry provider id as provenance. A drift pin
 * (tests/consolidation_c1_execution_path.test.ts) fails if this module
 * declares provider endpoints by hand again.
 *
 * What stays client-owned: the hub's asset-class taxonomy
 * (SCREENING_ASSET_CLASSES) — presentation, not a provider registry —
 * and the pure helper functions over the derived list.
 */
import {
  SCREENING_PROVIDER_DESCRIPTORS,
  type ScreeningFilter,
} from "../trading";

export type { ScreeningFilter };

export type ScreeningAssetClass = "stocks" | "options" | "forex" | "futures" | "commodities" | "bonds";

export interface ScreeningProviderAdapter {
  id: string;
  label: string;
  kind: "broker-api" | "market-data-api" | "mcp";
  /** The server registry provider this entry is a variant of (C1 provenance). */
  registryProviderId: string;
  assetClasses: ScreeningAssetClass[];
  endpointByAssetClass: Partial<Record<ScreeningAssetClass, string>>;
  filtersByAssetClass: Partial<Record<ScreeningAssetClass, ScreeningFilter[]>>;
}

export const SCREENING_PROVIDERS: ScreeningProviderAdapter[] =
  SCREENING_PROVIDER_DESCRIPTORS.flatMap((descriptor) =>
    Object.entries(descriptor.clientEndpoints).flatMap(([assetClass, variants]) =>
      (variants ?? []).map((variant) => ({
        id: variant.id,
        label: variant.label,
        kind: variant.kind,
        registryProviderId: descriptor.id,
        assetClasses: [assetClass as ScreeningAssetClass],
        endpointByAssetClass: { [assetClass]: variant.endpoint },
        filtersByAssetClass: { [assetClass]: [...variant.filters] },
      }))
    )
  );

export const SCREENING_ASSET_CLASSES: Array<{
  id: ScreeningAssetClass;
  label: string;
  available: boolean;
}> = [
  { id: "stocks", label: "Stocks", available: true },
  // S8 (consolidation #958): options screening is hosted in the hub
  // (the OptionsResearchHost surface) — available, not PLANNED. It
  // has no provider adapter (it is not a provider screen), so
  // getScreeningProviders("options") stays empty by design — now by
  // derivation from the server descriptor table (C1): the options
  // provider declares no client endpoint variants.
  { id: "options", label: "Options", available: true },
  { id: "forex", label: "Forex", available: false },
  { id: "futures", label: "Futures", available: false },
  { id: "commodities", label: "Commodities", available: false },
  { id: "bonds", label: "Bonds", available: false },
];

export function getScreeningProviders(assetClass: ScreeningAssetClass): ScreeningProviderAdapter[] {
  return SCREENING_PROVIDERS.filter((provider) => provider.assetClasses.includes(assetClass));
}

export function providerSupportsFilter(
  provider: ScreeningProviderAdapter | undefined,
  assetClass: ScreeningAssetClass,
  filter: ScreeningFilter,
): boolean {
  return provider?.filtersByAssetClass[assetClass]?.includes(filter) ?? false;
}
