/**
 * Client for the opportunity scanner and saved strategy profiles —
 * issue #84 slice 1, surfacing the backends from #23 (scan modes),
 * #24 (fit gate) and #28 (saved strategy profiles).
 *
 * Wire shapes, pinned against the server code:
 *  - POST /api/trading/options/unified with action "opportunities"
 *    returns the service's formatForUi() envelope: the whole
 *    OpportunityScanResult spread at the TOP LEVEL of the body, plus
 *    `action`, `meta`, and `success`. A failed profile resolution comes
 *    back as `{ error: "..." }` with success:false at HTTP 200, so the
 *    error FIELD — not just the status — decides failure.
 *  - /api/etrade/options/profiles[/:id] is the #28 CRUD surface: list
 *    returns `{ count, profiles }`; create/update return the stored
 *    profile directly; validation and duplicate-name failures are
 *    400 `{ error: "..." }` whose message is surfaced verbatim.
 *
 * Type-only imports from the server modules keep the shapes
 * single-sourced (the portfolioRiskApi pattern). All HTTP goes through
 * apiFetch, which transparently polls the worker's 202 async-job stub
 * (issue #71) — never the global fetch.
 */

import { apiFetch } from "./apiFetch";
import type {
  OpportunityScanResult,
  ScanMode,
} from "../trading/options/opportunityScanner";
import type {
  StrategyProfile,
  StrategyProfileSpec,
} from "../trading/options/strategyProfile";
import type { UnifiedOptionsRequest } from "../trading/options/unifiedOptionsService";

export type { OpportunityScanResult, ScanMode, StrategyProfile, StrategyProfileSpec };

/** The unified route's UI envelope for the opportunities action:
 *  OpportunityScanResult fields at the top level (formatForUi spread),
 *  plus the envelope fields. scanRunId/persisted ride along when the
 *  route's scan-run store saved the run (issue #27). */
export interface OpportunityScanResponse extends OpportunityScanResult {
  action: string;
  success: boolean;
  scanRunId?: string;
  persisted?: boolean;
  meta?: {
    generatedAt?: string;
    environment?: string;
    cached?: boolean;
    underlyingsCount?: number;
  };
}

function headers(env: string, userLogin?: string, json = false): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "x-environment": env,
    ...(userLogin ? { "x-user-login": userLogin } : {}),
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Shape guard in the fetchAlerts idiom (issue #71): array fields a
 * partial/odd payload may omit are coerced to [] so the panel renders
 * honest empty states instead of crashing on `.map` of undefined. A
 * body that is not an object at all is an error, never a result.
 */
export function coerceScanResponse(data: unknown): OpportunityScanResponse {
  if (!data || typeof data !== "object") {
    throw new Error("Unexpected scanner response shape — the scan payload was incomplete.");
  }
  const raw = data as Record<string, unknown>;
  return {
    ...(raw as unknown as OpportunityScanResponse),
    opportunities: asArray(raw.opportunities),
    fits: asArray(raw.fits),
    borderline: asArray(raw.borderline),
    skipped: asArray(raw.skipped),
    assumptions: asArray(raw.assumptions),
    matrix: asArray(raw.matrix),
    typeRollup: asArray(raw.typeRollup),
  };
}

/** Run an opportunity scan through the unified options service. The
 *  caller builds the body (mode is always explicit — issue #84's core
 *  acceptance rule); this function pins action "opportunities". */
export async function runOpportunityScan(
  activeEnv: string,
  userLogin: string | undefined,
  body: UnifiedOptionsRequest,
): Promise<OpportunityScanResponse> {
  const resp = await apiFetch("/api/trading/options/unified", {
    method: "POST",
    headers: headers(activeEnv, userLogin, true),
    body: JSON.stringify({ ...body, action: "opportunities" }),
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Scanner request failed (${resp.status})`);
  // The unified service reports a failed profile resolution (and other
  // action errors) as an `error` field on a 200 envelope — that is a
  // failed scan, never a result with no rows.
  if (typeof data.error === "string" && data.error) throw new Error(data.error);
  return coerceScanResponse(data);
}

// Saved strategy profiles (issue #28 CRUD) ------------------------------

const PROFILES_PATH = "/api/etrade/options/profiles";

export async function listProfiles(
  activeEnv: string,
  userLogin?: string,
): Promise<StrategyProfile[]> {
  const resp = await apiFetch(PROFILES_PATH, { headers: headers(activeEnv, userLogin) });
  const data = (await resp.json().catch(() => ({}))) as { profiles?: unknown; error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to list strategy profiles (${resp.status})`);
  return asArray<StrategyProfile>(data.profiles);
}

export async function getProfile(
  activeEnv: string,
  userLogin: string | undefined,
  id: string,
): Promise<StrategyProfile> {
  const resp = await apiFetch(`${PROFILES_PATH}/${encodeURIComponent(id)}`, {
    headers: headers(activeEnv, userLogin),
  });
  const data = (await resp.json().catch(() => ({}))) as StrategyProfile & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to fetch strategy profile (${resp.status})`);
  return data;
}

export async function createProfile(
  activeEnv: string,
  userLogin: string | undefined,
  name: string,
  spec: StrategyProfileSpec,
): Promise<StrategyProfile> {
  const resp = await apiFetch(PROFILES_PATH, {
    method: "POST",
    headers: headers(activeEnv, userLogin, true),
    body: JSON.stringify({ name, ...spec }),
  });
  const data = (await resp.json().catch(() => ({}))) as StrategyProfile & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to create strategy profile (${resp.status})`);
  return data;
}

export async function updateProfile(
  activeEnv: string,
  userLogin: string | undefined,
  id: string,
  name: string,
  spec: StrategyProfileSpec,
): Promise<StrategyProfile> {
  const resp = await apiFetch(`${PROFILES_PATH}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: headers(activeEnv, userLogin, true),
    body: JSON.stringify({ name, ...spec }),
  });
  const data = (await resp.json().catch(() => ({}))) as StrategyProfile & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to update strategy profile (${resp.status})`);
  return data;
}

export async function deleteProfile(
  activeEnv: string,
  userLogin: string | undefined,
  id: string,
): Promise<void> {
  const resp = await apiFetch(`${PROFILES_PATH}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(activeEnv, userLogin),
  });
  const data = (await resp.json().catch(() => ({}))) as { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to delete strategy profile (${resp.status})`);
}
