/**
 * Client for the data-provider lifecycle endpoints (issue #1180,
 * E4 of epic #1116; server: issue #1170 in
 * src/agents/routes/dataProviders.ts):
 *
 *   GET  /api/data-providers
 *   POST /api/data-providers/:id/register|configure|verify|enable|disable|deprovision
 *
 * The view types below mirror the server's GET shapes field-for-field
 * (providerView + routeServability there). The panel renders what the
 * API returns — servability in particular is the registry's own rule
 * computed server-side; nothing here recomputes it.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule — the
 * worker may answer with a 202 async-job stub that only apiFetch
 * resolves).
 */

import { apiFetch } from "./apiFetch";

/** Verification evidence recorded by a passing verify (E3: config.verification). */
export interface DataProviderVerification {
  verifiedAt: string;
  summary: string;
  verifiedBy: string;
}

/** One provider as the E3 GET surface serves it (providerView). */
export interface DataProviderView {
  id: string;
  adapterKind: string;
  lifecycleState: string;
  enabled: boolean;
  precedence: number;
  /** The credential REFERENCE name only — never a secret value. */
  credentialRef: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  declaredCapabilities: string[];
  verification: DataProviderVerification | null;
  /** Whether any capability route currently resolves to this provider. */
  serving: boolean;
}

/** One capability route as the E3 GET surface serves it (routeServability). */
export interface CapabilityRouteView {
  capability: string;
  primaryProviderId: string;
  gapFillProviderId: string | null;
  resolves: boolean;
  resolvedPrimaryId: string | null;
  resolvedGapFillId: string | null;
  error?: string;
}

export interface DataProvidersList {
  providers: DataProviderView[];
  routes: CapabilityRouteView[];
}

export type DataProviderActionName =
  | "configure"
  | "verify"
  | "enable"
  | "disable"
  | "deprovision";

/**
 * The actions the panel offers for a provider, mirroring the legal
 * map the E3 lifecycle service enforces (lifecycle.ts):
 *
 *   configure:   registered | configured
 *   verify:      configured
 *   enable:      verified, or disabled WITH verification evidence
 *   disable:     enabled
 *   deprovision: any state except deprovisioned (terminal)
 *
 * (register is not a per-provider action — it creates the record.)
 * The server remains the authority: it re-checks every move and the
 * panel surfaces its rejection verbatim.
 */
export function providerActions(view: DataProviderView): DataProviderActionName[] {
  switch (view.lifecycleState) {
    case "registered":
      return ["configure", "deprovision"];
    case "configured":
      return ["configure", "verify", "deprovision"];
    case "verified":
      return ["enable", "deprovision"];
    case "enabled":
      return ["disable", "deprovision"];
    case "disabled":
      return view.verification
        ? ["enable", "deprovision"]
        : ["deprovision"];
    default:
      return [];
  }
}

/** Display name: config.displayName when the record carries one, else the id. */
export function providerDisplayName(view: DataProviderView): string {
  const name = view.config?.displayName;
  return typeof name === "string" && name !== "" ? name : view.id;
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) {
    const err = new Error(data.error || `Request failed (${resp.status})`) as Error & {
      status?: number;
    };
    err.status = resp.status;
    throw err;
  }
  return data;
}

export async function fetchDataProviders(): Promise<DataProvidersList> {
  const data = await send<Partial<DataProvidersList>>("/api/data-providers");
  // Shape guard (issue #71): never hand the renderer a non-array.
  return {
    providers: Array.isArray(data?.providers) ? data.providers : [],
    routes: Array.isArray(data?.routes) ? data.routes : [],
  };
}

export async function postDataProviderAction(
  id: string,
  action: DataProviderActionName | "register",
  body?: Record<string, unknown>
): Promise<void> {
  await send<{ provider: unknown }>(
    `/api/data-providers/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      ...(body !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }
  );
}

/** Timestamp rendering, same convention as the API keys panel. */
export function fmtDataProviderTime(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
