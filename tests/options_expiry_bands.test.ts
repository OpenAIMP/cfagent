import { afterEach, describe, expect, it, vi } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { ETradeRestClient } from "../src/trading/etrade/client";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

describe("strategy expiry DTE bands", () => {
  afterEach(() => DynamicOptionsScreener.clearTestChainsFixture());

  it("fetches bounded expirations from each requested band and skips gaps", async () => {
    const expirations = [30, 45, 55, 100, 120, 200, 250, 350, 400, 500].map(expiryAtDte);
    const fetchDtes: number[] = [];
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const client = {
      getOptionExpireDates: vi.fn(async () => expirations),
      getOptionChains: vi.fn(async (params: { symbol: string; expiryYear: number; expiryMonth: number; expiryDay: number }) => {
        const dte = Math.ceil((Date.UTC(params.expiryYear, params.expiryMonth - 1, params.expiryDay) - todayUtc) / 86_400_000);
        fetchDtes.push(dte);
        return {
          symbol: params.symbol,
          underlyingPrice: 100,
          selectedExpiry: { year: params.expiryYear, month: params.expiryMonth, day: params.expiryDay },
          pairs: [],
        } satisfies ETradeOptionChain;
      }),
    } as unknown as ETradeRestClient;
    const screener = new DynamicOptionsScreener(client, { maxExpirationsPerSymbol: 100 });

    await screener.screenOptions({
      underlyingSymbols: ["XYZ"],
      minDte: 0,
      maxDte: 550,
      expirationDteBands: [
        { minDte: 14, maxDte: 60, maxExpirations: 8 },
        { minDte: 180, maxDte: 365, maxExpirations: 4 },
        { minDte: 365, maxDte: 550, maxExpirations: 4 },
      ],
    });

    expect(fetchDtes).toEqual([30, 45, 55, 200, 250, 350, 400, 500]);
  });

  it("sanitizes invalid bands and clamps each band fanout", async () => {
    const expirations = [30, 45, 55, 58, 59, 60, 61, 62, 63, 64].map(expiryAtDte);
    const fetchDtes: number[] = [];
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const client = {
      getOptionExpireDates: async () => expirations,
      getOptionChains: async (params: { symbol: string; expiryYear: number; expiryMonth: number; expiryDay: number }) => {
        fetchDtes.push(Math.ceil((Date.UTC(params.expiryYear, params.expiryMonth - 1, params.expiryDay) - todayUtc) / 86_400_000));
        return {
          symbol: params.symbol,
          underlyingPrice: 100,
          selectedExpiry: { year: params.expiryYear, month: params.expiryMonth, day: params.expiryDay },
          pairs: [],
        } satisfies ETradeOptionChain;
      },
    } as unknown as ETradeRestClient;
    const screener = new DynamicOptionsScreener(client, { maxExpirationsPerSymbol: 100 });

    const result = await screener.screenOptions({
      underlyingSymbols: ["XYZ"],
      minDte: 0,
      maxDte: 70,
      expirationDteBands: [
        { minDte: 14, maxDte: 70, maxExpirations: 100 },
        { minDte: 80, maxDte: 20, maxExpirations: 4 },
      ],
    });

    expect(fetchDtes).toEqual([30, 45, 55, 58, 59, 60, 61, 62]);
    expect(result.warnings?.some((warning) => warning.includes("invalid or excess expiration DTE bands"))).toBe(true);
  });
});
