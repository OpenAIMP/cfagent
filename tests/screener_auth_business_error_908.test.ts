import { describe, expect, it } from "vitest";
import { acquireUniverse } from "../src/trading/screenerPipeline";
import { BusinessError } from "../src/errors/errorAspects";

const listings = (symbols: string[]) =>
  symbols.map((symbol) => ({ symbol, companyName: `${symbol} Inc`, exchange: "NASDAQ" }) as any);

// #908 scenario: auth failures are the root cause even when most
// failures are batch-omitted secondaries. Zero quotes + any auth
// failure must surface AUTH_002, never the technical token message.
const mixedDeps = {
  fetchQuote: async (symbol: string) => {
    if (symbol === "AUTHX") {
      throw new Error("E*TRADE OAuth access token is missing for AUTHX in live mode.");
    }
    throw new Error(`batch quote omitted for ${symbol}`);
  },
};

const nonAuthDeps = {
  fetchQuote: async (symbol: string) => {
    throw new Error(`batch quote omitted for ${symbol}`);
  },
};

describe("AUTH_002 on mixed auth + batch-omitted failures (#908)", () => {
  it("live-quotes mode throws AUTH_002 when any auth failure occurs with zero quotes", async () => {
    const err = await acquireUniverse({
      mode: "live-quotes",
      symbols: listings(["AUTHX", "BATCH1", "BATCH2"]),
      quoteDeps: mixedDeps as any,
    }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(BusinessError);
    expect((err as BusinessError).code).toBe("AUTH_002");
    expect((err as Error).message).not.toContain("OAuth access token is missing");
  });

  it("etrade-only mode throws AUTH_002 for the same mixed failure", async () => {
    const err = await acquireUniverse({
      mode: "etrade-only",
      symbols: listings(["AUTHX", "BATCH1", "BATCH2"]),
      quoteDeps: mixedDeps as any,
    }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(BusinessError);
    expect((err as BusinessError).code).toBe("AUTH_002");
  });

  it("zero quotes with no auth failure still surfaces the technical error, not AUTH_002", async () => {
    const err = await acquireUniverse({
      mode: "live-quotes",
      symbols: listings(["BATCH1", "BATCH2"]),
      quoteDeps: nonAuthDeps as any,
    }).then(
      () => null,
      (e) => e
    );
    expect(err).not.toBeInstanceOf(BusinessError);
    expect((err as Error).message).toMatch(/no live quotes/);
  });
});
