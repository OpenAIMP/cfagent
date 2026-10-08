export type ScreeningAssetClass = "stocks" | "options" | "forex" | "futures" | "commodities" | "bonds";
export type ScreeningFilter = "search" | "limit" | "exchange" | "price-range" | "trend" |
  "contract-type" | "dte-range" | "min-volume" | "min-open-interest" | "max-spread";

export interface ScreeningProviderAdapter {
  id: string;
  label: string;
  kind: "broker-api" | "market-data-api" | "mcp";
  assetClasses: ScreeningAssetClass[];
  endpointByAssetClass: Partial<Record<ScreeningAssetClass, string>>;
  filtersByAssetClass: Partial<Record<ScreeningAssetClass, ScreeningFilter[]>>;
}

export const SCREENING_PROVIDERS: ScreeningProviderAdapter[] = [
  {
    id: "etrade",
    label: "Nasdaq All-Exchange Listing Feed (Live API · E*TRADE Execution)",
    kind: "broker-api",
    assetClasses: ["stocks"],
    endpointByAssetClass: {
      stocks: "/api/etrade/screen",
    },
    filtersByAssetClass: {
      stocks: ["search", "limit", "exchange", "price-range", "trend"],
    },
  },
  {
    id: "yahoo-finance",
    label: "Yahoo Finance FOSS Engine (Market Data API)",
    kind: "market-data-api",
    assetClasses: ["stocks"],
    endpointByAssetClass: { stocks: "/api/foss/screen" },
    filtersByAssetClass: { stocks: ["search", "trend"] },
  },
];

export const SCREENING_ASSET_CLASSES: Array<{
  id: ScreeningAssetClass;
  label: string;
  available: boolean;
}> = [
  { id: "stocks", label: "Stocks", available: true },
  { id: "options", label: "Options", available: false },
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
