/**
 * Issue #2419 — externalized polling cadences (AOP).
 *
 * Every tunable in the polling migration resolves through here: the
 * server injects window.__POLLING_CONFIG__ at boot from wrangler vars,
 * the landing page interpolates the same values at render time, and
 * anything without an injected value falls back to the defaults below.
 * No polling interval literal lives in component code.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  POLLING_CONFIG_DEFAULTS,
  resolvePollingConfig,
  resolvePollingConfigFromEnv,
  getPollingConfig,
} from "../src/client/pollingConfig";

describe("polling config (#2419)", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("defaults to the documented cadences", () => {
    expect(POLLING_CONFIG_DEFAULTS).toEqual({
      quotesRestFallbackMs: 60_000,
      quotesWsReconnectBaseMs: 1_000,
      quotesWsReconnectCapMs: 30_000,
      optionsFlowsPollMs: 30_000,
      optionsLatestPollMs: 60_000,
      chatAutoRefreshFloorS: 5,
      goalTrackPollMs: 2_000,
      goalTrackDeadlineMs: 600_000,
    });
  });

  it("resolves injected values and ignores invalid ones", () => {
    const resolved = resolvePollingConfig({
      quotesRestFallbackMs: 45_000,
      optionsFlowsPollMs: "not-a-number",
      goalTrackPollMs: -5,
      chatAutoRefreshFloorS: 10,
    });
    expect(resolved.quotesRestFallbackMs).toBe(45_000);
    expect(resolved.optionsFlowsPollMs).toBe(30_000);
    expect(resolved.goalTrackPollMs).toBe(2_000);
    expect(resolved.chatAutoRefreshFloorS).toBe(10);
  });

  it("maps wrangler env var names to config keys", () => {
    const resolved = resolvePollingConfigFromEnv({
      QUOTES_REST_FALLBACK_MS: "45000",
      OPTIONS_LATEST_POLL_MS: "90000",
      CHAT_AUTO_REFRESH_FLOOR_S: "8",
    });
    expect(resolved.quotesRestFallbackMs).toBe(45_000);
    expect(resolved.optionsLatestPollMs).toBe(90_000);
    expect(resolved.chatAutoRefreshFloorS).toBe(8);
    expect(resolved.optionsFlowsPollMs).toBe(30_000);
  });

  it("reads the server-injected window config, else defaults", () => {
    (globalThis as { window?: unknown }).window = {
      __POLLING_CONFIG__: { optionsFlowsPollMs: 15_000 },
    };
    expect(getPollingConfig().optionsFlowsPollMs).toBe(15_000);
    expect(getPollingConfig().optionsLatestPollMs).toBe(60_000);
    delete (globalThis as { window?: unknown }).window;
    expect(getPollingConfig()).toEqual(POLLING_CONFIG_DEFAULTS);
  });
});
