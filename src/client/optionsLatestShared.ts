/**
 * Issue #2470 S4 — one shared poll for GET /api/options/latest.
 *
 * #2419 residual: ScheduledOptionsManager and AutonomousOptionsRuns
 * each polled this endpoint every 60s when both were mounted, so two
 * mounted components produced two network polls per cadence. This
 * module is the shared subscription the residual calls for: the
 * FIRST subscriber starts exactly one poller, every subscriber gets
 * every result, and the LAST unsubscribe stops the poller.
 *
 * Behavior preserved from #2422, exactly:
 * - Cadence from getPollingConfig().optionsLatestPollMs (externalized;
 *   read when the poller starts, not per subscriber).
 * - Hidden-pause + fetch-on-return-to-visible, via startPolling.
 * - Immediate fetch when the first subscriber mounts.
 *
 * What changes: a second subscriber mounting while the poll is live
 * receives the latest snapshot immediately and triggers NO fetch of
 * its own. A forced refresh (the runs Refresh button, the host page
 * Refresh control) fetches once and notifies all subscribers; a
 * refresh issued while a fetch is in flight coalesces onto it.
 *
 * Transport note: the fetch is a plain same-origin GET, as
 * AutonomousOptionsRuns already made it. The route reads the
 * caller's own OrchestratorAgent instance storage
 * (handleOptionsLatestRuns), so the payload is identical for every
 * subscriber in the tab; the manager's extra x-user-login /
 * x-environment headers are inert for this endpoint. GETs are never
 * queued as async jobs (#2456), so no 202-unwrapping is needed.
 */

import { startPolling } from "./polling";
import { getPollingConfig } from "./pollingConfig";
import { isAutoRefreshEnabled, subscribeAutoRefresh } from "./autoRefresh";

export interface OptionsLatestSnapshot {
  ok: boolean;
  status: number;
  runs: unknown[];
  error: string | null;
}

export type OptionsLatestListener = (snapshot: OptionsLatestSnapshot) => void;

const ENDPOINT = "/api/options/latest";

const listeners = new Set<OptionsLatestListener>();
let stopPolling: (() => void) | null = null;
let inFlight: Promise<void> | null = null;
let lastSnapshot: OptionsLatestSnapshot | null = null;
let autoRefreshUnsub: (() => void) | null = null;

/**
 * Issue #2481 — start the shared poller only while the global
 * auto-refresh switch is ON; stop it the moment the switch flips
 * OFF. The initial fetch on first subscribe is not periodic and
 * is unaffected, and refreshOptionsLatest() (manual refresh)
 * always fetches.
 */
function startPollerIfEnabled(): void {
  if (stopPolling || listeners.size === 0 || !isAutoRefreshEnabled()) return;
  const cadenceMs = getPollingConfig().optionsLatestPollMs;
  stopPolling = startPolling(() => void fetchAndNotify(), {
    fastMs: cadenceMs,
    idleMs: cadenceMs,
  });
}

function stopPoller(): void {
  stopPolling?.();
  stopPolling = null;
}

function notify(snapshot: OptionsLatestSnapshot): void {
  lastSnapshot = snapshot;
  for (const listener of [...listeners]) {
    listener(snapshot);
  }
}

async function fetchAndNotify(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await globalThis.fetch(ENDPOINT);
      const data = (await res.json().catch(() => ({}))) as {
        runs?: unknown[];
        error?: string;
      };
      notify({
        ok: res.ok,
        status: res.status,
        runs: Array.isArray(data?.runs) ? data.runs : [],
        error: res.ok ? null : data?.error || `HTTP ${res.status}`,
      });
    } catch (err) {
      notify({
        ok: false,
        status: 0,
        runs: [],
        error: err instanceof Error ? err.message : "Failed to load options runs",
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Subscribe to the shared poll. The first subscriber triggers the
 * immediate fetch and starts the cadence; a later subscriber gets
 * the latest snapshot at once with no extra fetch. Returns an
 * unsubscribe function; the last unsubscribe stops the poller.
 */
export function subscribeOptionsLatest(
  listener: OptionsLatestListener,
): () => void {
  listeners.add(listener);
  if (lastSnapshot) {
    listener(lastSnapshot);
  }
  if (listeners.size === 1) {
    void fetchAndNotify();
    startPollerIfEnabled();
    if (!autoRefreshUnsub) {
      autoRefreshUnsub = subscribeAutoRefresh((state) => {
        if (state.enabled) startPollerIfEnabled();
        else stopPoller();
      });
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPoller();
      lastSnapshot = null;
      autoRefreshUnsub?.();
      autoRefreshUnsub = null;
    }
  };
}

/**
 * Force one immediate fetch, notifying all subscribers. Coalesces
 * onto an in-flight fetch; a no-op with no subscribers (a later
 * mount fetches on subscribe).
 */
export function refreshOptionsLatest(): void {
  if (listeners.size === 0) return;
  void fetchAndNotify();
}
