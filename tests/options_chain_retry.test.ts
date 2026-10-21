import { describe, expect, it, vi } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { ETradeRestClient } from "../src/trading/etrade/client";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";

/**
 * Issue #915: the options chain path had no recovery from transient
 * upstream failures — one failed fetch per symbol was final, and at a
 * 100-symbol universe the #456 coverage gate turned that into a failed
 * scheduled run every hour. The stock quote path got its recovery in
 * #727 (retry the missing symbols, spaced); these tests pin the chain
 * path's equivalent: symbols that fail outright (fetch error, zero
 * chains) are retried once, sequentially, with spacing.
 */

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string, expiry: ETradeOptionExpireDate): ETradeOptionChain {
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

const THROTTLE_REASON = "E*TRADE Option Chains API Error [HTTP 429]: throttled";
const AUTH_REASON = "E*TRADE Session Expired [HTTP 401]: Token rejected on optionchains [PROD].";

/**
 * Scripted client:
 * - FLAKY: expire-dates throw on the first attempt and the unscoped
 *   fallback chain fetch returns null (a transient throttle); from the
 *   second expire-dates attempt on, everything succeeds.
 * - DEAD: every call fails with an auth rejection — never recovers.
 * - FAR: expirations exist but none inside the DTE window (a legitimate
 *   empty slice — no error, and must not be retried).
 */
function makeScriptedClient() {
  const expiry = expiryAtDte(30);
  const expireAttempts = new Map<string, number>();
  const inflight = { current: 0, maxRetryPhase: 0 };
  const client = {
    lastError: undefined as string | undefined,
    getOptionExpireDates: vi.fn(async (symbol: string) => {
      const attempt = (expireAttempts.get(symbol) ?? 0) + 1;
      expireAttempts.set(symbol, attempt);
      if (attempt >= 2) {
        inflight.current++;
        inflight.maxRetryPhase = Math.max(inflight.maxRetryPhase, inflight.current);
        await new Promise((r) => setTimeout(r, 0));
        inflight.current--;
      }
      // The real client never throws from getOptionExpireDates: failures
      // come back as an empty list with lastError set. Model that shape.
      if (symbol === "FLAKY") {
        if (attempt === 1) {
          client.lastError = THROTTLE_REASON;
          return [];
        }
        return [expiry];
      }
      if (symbol === "DEAD" || symbol === "DEAD2") {
        client.lastError = AUTH_REASON;
        return [];
      }
      if (symbol === "FAR") return [expiryAtDte(400)];
      return [expiry];
    }),
    getOptionChains: vi.fn(async (params: { symbol: string; expiryYear?: number }) => {
      const symbol = params.symbol;
      if (symbol === "DEAD" || symbol === "DEAD2") {
        client.lastError = AUTH_REASON;
        return null;
      }
      if (symbol === "FLAKY" && !params.expiryYear) {
        // First-pass unscoped fallback under the throttle: no data.
        client.lastError = THROTTLE_REASON;
        return null;
      }
      client.lastError = undefined;
      return makeChain(symbol, expiry);
    }),
  };
  return { client: client as unknown as ETradeRestClient & { lastError?: string }, expireAttempts, inflight, expiry };
}

describe("DynamicOptionsScreener chain-fetch retry (#915)", () => {
  it("recovers a symbol whose chain fetch fails transiently on the first pass", async () => {
    const { client, expireAttempts } = makeScriptedClient();
    const screener = new DynamicOptionsScreener(client);

    const result = await screener.screenOptions({ underlyingSymbols: ["FLAKY"], minDte: 0, maxDte: 90 });

    expect(result.fetchErrors?.filter((e) => e.symbol === "FLAKY") ?? []).toHaveLength(0);
    expect(result.contracts.some((c) => c.symbol === "FLAKY")).toBe(true);
    // Exactly one retry: expire-dates attempted twice for the symbol.
    expect(expireAttempts.get("FLAKY")).toBe(2);
  });

  it("keeps the failure reason for a symbol that never recovers, after exactly one retry", async () => {
    const { client, expireAttempts } = makeScriptedClient();
    const screener = new DynamicOptionsScreener(client);

    const result = await screener.screenOptions({ underlyingSymbols: ["DEAD"], minDte: 0, maxDte: 90 });

    const errors = result.fetchErrors?.filter((e) => e.symbol === "DEAD") ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("HTTP 401");
    expect(expireAttempts.get("DEAD")).toBe(2);
    expect(result.status).toBe("error");
  });

  it("does not retry a legitimate empty slice (expirations exist, none in the window)", async () => {
    const { client, expireAttempts } = makeScriptedClient();
    const screener = new DynamicOptionsScreener(client);

    const result = await screener.screenOptions({ underlyingSymbols: ["FAR"], minDte: 0, maxDte: 90 });

    expect(result.fetchErrors ?? []).toHaveLength(0);
    expect(expireAttempts.get("FAR")).toBe(1);
  });

  it("runs the retry pass sequentially with spacing between symbols", async () => {
    const { client, inflight, expireAttempts } = makeScriptedClient();
    const screener = new DynamicOptionsScreener(client);

    const started = Date.now();
    const result = await screener.screenOptions({ underlyingSymbols: ["DEAD", "DEAD2"], minDte: 0, maxDte: 90 });
    const elapsed = Date.now() - started;

    // Both symbols were retried exactly once...
    expect(expireAttempts.get("DEAD")).toBe(2);
    expect(expireAttempts.get("DEAD2")).toBe(2);
    expect(result.fetchErrors?.length).toBe(2);
    // ...one at a time (never two retry-phase fetches in flight)...
    expect(inflight.maxRetryPhase).toBe(1);
    // ...with the #727-style 500ms spacing between them.
    expect(elapsed).toBeGreaterThanOrEqual(450);
  });
});
