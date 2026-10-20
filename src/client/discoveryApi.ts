/**
 * Client for the persisted scheduled-discovery runs (issue #126, PR-F) —
 * the read side of the backend PR-E shipped:
 *
 *  - GET /api/etrade/options/discovery-runs?limit=&offset= returns
 *    `{ count, runs }` (DiscoveryRunSummary rows, newest first);
 *  - GET /api/etrade/options/discovery-runs/:id returns the
 *    StoredDiscoveryRun directly (summary fields + the saved requests
 *    + per-symbol outcomes).
 *
 * The routes scope by the x-user-login header under the issue #103
 * visibility rule, exactly like the scan-run routes in scannerApi.ts:
 * a run owned by another login reads as the same 404 ("discovery run
 * not found") as a pruned one. Failures are non-200 `{ error: "..." }`
 * whose message is surfaced verbatim.
 *
 * Type-only imports from the server modules keep the shapes
 * single-sourced (the scannerApi pattern). All HTTP goes through
 * apiFetch, which transparently polls the worker's 202 async-job stub
 * (issue #71) — never the global fetch.
 */

import { apiFetch } from "./apiFetch";
import type {
  DiscoveryRunSummary,
  DiscoverySymbolOutcome,
  StoredDiscoveryRun,
} from "../trading";

export type { DiscoveryRunSummary, DiscoverySymbolOutcome, StoredDiscoveryRun };

const DISCOVERY_RUNS_PATH = "/api/etrade/options/discovery-runs";

function headers(env: string, userLogin?: string): Record<string, string> {
  return {
    "x-environment": env,
    ...(userLogin ? { "x-user-login": userLogin } : {}),
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Shape guard in the scannerApi idiom (issue #71): array fields a
 * partial/odd payload may omit are coerced to [] so the panel renders
 * honest empty states instead of crashing on `.map` of undefined. A
 * body that is not an object at all is an error, never a result.
 */
export function coerceDiscoveryRunSummary(data: unknown): DiscoveryRunSummary {
  if (!data || typeof data !== "object") {
    throw new Error("Unexpected discovery run shape — the run payload was incomplete.");
  }
  const raw = data as Record<string, unknown>;
  return {
    ...(raw as unknown as DiscoveryRunSummary),
    symbols: asArray<string>(raw.symbols).map((s) => String(s)),
    requestCount: asFiniteNumber(raw.requestCount, 0),
    completedCount: asFiniteNumber(raw.completedCount, 0),
    failedCount: asFiniteNumber(raw.failedCount, 0),
  };
}

function coerceOutcome(data: unknown): DiscoverySymbolOutcome {
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    ...(raw as unknown as DiscoverySymbolOutcome),
    ranked: raw.ranked === undefined ? undefined : asArray(raw.ranked),
    riskReports: raw.riskReports === undefined ? undefined : asArray(raw.riskReports),
    screenedOut: raw.screenedOut === undefined ? undefined : asArray(raw.screenedOut),
    excluded: raw.excluded === undefined ? undefined : asArray(raw.excluded),
  };
}

/** A stored discovery run ready for display: summary fields plus the
 *  saved requests and per-symbol outcomes, shape-guarded like a live
 *  response so the panel never renders an unguarded payload. */
export function coerceDiscoveryRunDetail(data: unknown): StoredDiscoveryRun {
  const summary = coerceDiscoveryRunSummary(data);
  const raw = data as Record<string, unknown>;
  return {
    ...summary,
    requests: asArray(raw.requests),
    outcomes: asArray<unknown>(raw.outcomes).map(coerceOutcome),
  };
}

/** Newest-first summaries of the signed-in user's persisted
 *  discovery runs (scheduled fires and manual triggers). */
export async function listDiscoveryRuns(
  activeEnv: string,
  userLogin?: string,
  limit?: number,
): Promise<DiscoveryRunSummary[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
  const resp = await apiFetch(`${DISCOVERY_RUNS_PATH}${query}`, { headers: headers(activeEnv, userLogin) });
  const data = (await resp.json().catch(() => ({}))) as { runs?: unknown; error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to list discovery runs (${resp.status})`);
  return asArray<unknown>(data.runs).map(coerceDiscoveryRunSummary);
}

/** One persisted run with its saved requests and outcomes. A pruned
 *  or out-of-scope id is the route's 404 "discovery run not found",
 *  surfaced verbatim. */
export async function getDiscoveryRun(
  activeEnv: string,
  userLogin: string | undefined,
  id: string,
): Promise<StoredDiscoveryRun> {
  const resp = await apiFetch(`${DISCOVERY_RUNS_PATH}/${encodeURIComponent(id)}`, {
    headers: headers(activeEnv, userLogin),
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to fetch discovery run (${resp.status})`);
  return coerceDiscoveryRunDetail(data);
}
