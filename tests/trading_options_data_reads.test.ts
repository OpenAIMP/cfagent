/**
 * Issue #291 slice T5b — options data reads on the platform contract.
 *
 * Characterization: ETradeTradingPlatform's getOptionChains /
 * getOptionExpireDates are VERBATIM client passthroughs — the same
 * semantics ETradeService exposes today (its methods are one-line
 * delegations to the same client). No caching, fallback, or rewriting
 * may creep into this layer; the migration of caller sites depends on
 * byte-level equivalence.
 */

import { describe, it, expect } from "vitest";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import type { Env } from "../src/types";

const env = { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env;

describe("ETradeTradingPlatform options data reads (#291 T5b)", () => {
  it("delegates chains and expire dates to the client verbatim", async () => {
    const calls: any[] = [];
    const chainResult = { symbol: "AAPL", underlyingPrice: 150 };
    const expiryResult = [{ year: 2027, month: 1, day: 15 }];
    const fakeClient = {
      getOptionChains: async (params: any) => {
        calls.push(["chains", params]);
        return chainResult;
      },
      getOptionExpireDates: async (symbol: string, expiryType?: string) => {
        calls.push(["expiries", symbol, expiryType]);
        return expiryResult;
      },
    } as any;
    const platform = new ETradeTradingPlatform(env, undefined, "default_trader", undefined, fakeClient);

    const params = { symbol: "AAPL", expiryYear: 2027, expiryMonth: 1, chainType: "CALLPUT" as const };
    await expect(platform.getOptionChains!(params)).resolves.toBe(chainResult);
    await expect(platform.getOptionExpireDates!("AAPL")).resolves.toBe(expiryResult);
    await expect(platform.getOptionExpireDates!("AAPL", "ALL")).resolves.toBe(expiryResult);
    expect(calls).toEqual([
      ["chains", params],
      ["expiries", "AAPL", undefined],
      ["expiries", "AAPL", "ALL"],
    ]);
  });

  it("the contract marks both reads optional (platforms may omit them)", async () => {
    const { AlpacaTradingPlatform } = await import("../src/trading/alpaca/platform");
    const alpaca: any = new AlpacaTradingPlatform(env, undefined, "default_trader");
    expect(alpaca.getOptionChains).toBeUndefined();
    expect(alpaca.getOptionExpireDates).toBeUndefined();
  });
});

describe("TradingPlatformRegistry overrideEnv plumbing (#291 T5c)", () => {
  it("passes the caller's requested environment through to the factory", async () => {
    const { TradingPlatformRegistry } = await import("../src/trading");
    const seen: unknown[] = [];
    TradingPlatformRegistry.register("fakeenv291" as any, ((_env: any, _orm: any, userLogin?: string, overrideEnv?: string) => {
      seen.push([userLogin, overrideEnv]);
      return { platformId: "fakeenv291" };
    }) as any);
    TradingPlatformRegistry.getPlatform("fakeenv291" as any, env, undefined, "alice", "sandbox");
    TradingPlatformRegistry.getPlatform("fakeenv291" as any, env, undefined, "alice");
    expect(seen).toEqual([
      ["alice", "sandbox"],
      ["alice", undefined],
    ]);
  });
});
