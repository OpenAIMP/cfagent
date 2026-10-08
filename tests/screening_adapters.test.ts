import { describe, expect, it } from "vitest";
import {
  getScreeningProviders,
  providerSupportsFilter,
  SCREENING_ASSET_CLASSES,
  SCREENING_PROVIDERS,
} from "../src/client/screeningAdapters";

describe("provider- and asset-class screening adapters", () => {
  it("registers the current E*TRADE and Yahoo stock-screening routes", () => {
    expect(getScreeningProviders("stocks").map(({ id }) => id)).toEqual(["etrade", "yahoo-finance"]);
    expect(SCREENING_PROVIDERS.find(({ id }) => id === "etrade")?.endpointByAssetClass.stocks)
      .toBe("/api/etrade/screen");
  });

  it("models unsupported and planned asset classes as unavailable rather than routing them to another provider", () => {
    const planned = SCREENING_ASSET_CLASSES.filter(({ available }) => !available);
    expect(planned.map(({ id }) => id)).toEqual(["options", "forex", "futures", "commodities", "bonds"]);
    for (const { id } of planned) expect(getScreeningProviders(id)).toEqual([]);
  });

  it("only exposes a provider for an asset class it declares support for", () => {
    for (const provider of SCREENING_PROVIDERS) {
      for (const [assetClass, endpoint] of Object.entries(provider.endpointByAssetClass)) {
        expect(provider.assetClasses).toContain(assetClass);
        expect(endpoint).toMatch(/^\/api\//);
      }
    }
  });

  it("only advertises stock filters implemented by each provider", () => {
    const [etrade, yahoo] = getScreeningProviders("stocks");
    expect(providerSupportsFilter(etrade, "stocks", "price-range")).toBe(true);
    expect(providerSupportsFilter(yahoo, "stocks", "trend")).toBe(true);
    expect(providerSupportsFilter(yahoo, "stocks", "exchange")).toBe(false);
    expect(providerSupportsFilter(yahoo, "stocks", "limit")).toBe(false);
  });
});
