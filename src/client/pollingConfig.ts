/**
 * Issue #2419 — externalized polling cadences (AOP).
 *
 * Every tunable in the polling migration resolves through here. The
 * server injects window.__POLLING_CONFIG__ at app boot from wrangler
 * vars, the landing page interpolates the same values at render time,
 * and anything without an injected value falls back to the defaults
 * below. No polling interval literal lives in component code: a
 * component reads getPollingConfig(), a test injects values through
 * resolvePollingConfig(), and the server maps env vars through
 * resolvePollingConfigFromEnv().
 *
 * This module is environment-free (no window access at import time),
 * so both the browser bundle and the Worker can import it.
 */

export interface PollingConfig {
  /** REST fallback cadence for the quotes feeds (landing + app). */
  quotesRestFallbackMs: number;
  /** Initial WebSocket reconnect delay for the quotes feeds. */
  quotesWsReconnectBaseMs: number;
  /** Cap for the exponential WebSocket reconnect backoff. */
  quotesWsReconnectCapMs: number;
  /** Options flows live-stream refresh cadence. */
  optionsFlowsPollMs: number;
  /** /api/options/latest refresh cadence (both consumers share it). */
  optionsLatestPollMs: number;
  /** Floor for the Chat global auto-refresh interval, in seconds. */
  chatAutoRefreshFloorS: number;
  /** Goal staged-run tracking poll cadence. */
  goalTrackPollMs: number;
  /** Goal staged-run tracking absolute deadline. */
  goalTrackDeadlineMs: number;
}

export const POLLING_CONFIG_DEFAULTS: PollingConfig = {
  quotesRestFallbackMs: 60_000,
  quotesWsReconnectBaseMs: 1_000,
  quotesWsReconnectCapMs: 30_000,
  optionsFlowsPollMs: 30_000,
  optionsLatestPollMs: 60_000,
  chatAutoRefreshFloorS: 5,
  goalTrackPollMs: 2_000,
  goalTrackDeadlineMs: 600_000,
};

const ENV_KEYS: Record<keyof PollingConfig, keyof PollingEnvVars> = {
  quotesRestFallbackMs: "QUOTES_REST_FALLBACK_MS",
  quotesWsReconnectBaseMs: "QUOTES_WS_RECONNECT_BASE_MS",
  quotesWsReconnectCapMs: "QUOTES_WS_RECONNECT_CAP_MS",
  optionsFlowsPollMs: "OPTIONS_FLOWS_POLL_MS",
  optionsLatestPollMs: "OPTIONS_LATEST_POLL_MS",
  chatAutoRefreshFloorS: "CHAT_AUTO_REFRESH_FLOOR_S",
  goalTrackPollMs: "GOAL_TRACK_POLL_MS",
  goalTrackDeadlineMs: "GOAL_TRACK_DEADLINE_MS",
};

/** Wrangler vars (string values) that map onto the polling config. */
export interface PollingEnvVars {
  QUOTES_REST_FALLBACK_MS?: unknown;
  QUOTES_WS_RECONNECT_BASE_MS?: unknown;
  QUOTES_WS_RECONNECT_CAP_MS?: unknown;
  OPTIONS_FLOWS_POLL_MS?: unknown;
  OPTIONS_LATEST_POLL_MS?: unknown;
  CHAT_AUTO_REFRESH_FLOOR_S?: unknown;
  GOAL_TRACK_POLL_MS?: unknown;
  GOAL_TRACK_DEADLINE_MS?: unknown;
}

function toPositiveNumber(value: unknown): number | null {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve a partial config object (injected values) over the defaults. */
export function resolvePollingConfig(raw?: Record<string, unknown> | null): PollingConfig {
  const out: PollingConfig = { ...POLLING_CONFIG_DEFAULTS };
  if (!raw) return out;
  (Object.keys(POLLING_CONFIG_DEFAULTS) as (keyof PollingConfig)[]).forEach((key) => {
    const value = toPositiveNumber(raw[key]);
    if (value !== null) out[key] = value;
  });
  return out;
}

/** Map wrangler env vars (string values) onto the config keys. */
export function resolvePollingConfigFromEnv(
  env?: PollingEnvVars | null,
): PollingConfig {
  if (!env) return { ...POLLING_CONFIG_DEFAULTS };
  const raw: Record<string, unknown> = {};
  (Object.keys(ENV_KEYS) as (keyof PollingConfig)[]).forEach((key) => {
    raw[key] = env[ENV_KEYS[key]];
  });
  return resolvePollingConfig(raw);
}

declare global {
  interface Window {
    __POLLING_CONFIG__?: Partial<PollingConfig>;
  }
}

/** Read the server-injected boot config, or the defaults when absent. */
export function getPollingConfig(): PollingConfig {
  const injected = (globalThis as { window?: Window }).window?.__POLLING_CONFIG__;
  if (injected && typeof injected === "object") {
    return resolvePollingConfig(injected as Record<string, unknown>);
  }
  return { ...POLLING_CONFIG_DEFAULTS };
}
