/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — admin-gated market graph
 * population route handler (seed-route pattern, mirroring
 * seedGovernanceRoute / seed-canonical).
 *
 * POST only, session required, platform-admin only. The matrix
 * refusal is a hard refusal: nothing is written, nothing is
 * returned. Population is idempotent (upserts): a second run
 * refreshes labels/weights and reports the same counts.
 * No boot logic, no auto-run on deploy or tick.
 */
import type {
  MarketGraphPopulationReport,
} from "./marketGraphPopulation";

export interface PopulateMarketGraphRouteSession {
  internalUserId?: string;
}

export interface PopulateMarketGraphRouteDeps {
  session: PopulateMarketGraphRouteSession | null;
  method: string;
  isPlatformAdmin: boolean;
  tenantId: string;
  runPopulate: (input: {
    tenantId: string;
  }) => Promise<MarketGraphPopulationReport & { symbols: number }>;
}

export async function handlePopulateMarketGraphRoute(
  deps: PopulateMarketGraphRouteDeps,
): Promise<Response> {
  if (!deps.session) {
    return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
  }
  if (deps.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!deps.session.internalUserId) {
    return Response.json(
      { error: "Forbidden: market graph population requires a wired session." },
      { status: 403 },
    );
  }
  if (!deps.isPlatformAdmin) {
    return Response.json(
      { error: "Forbidden: market graph population requires platform-admin membership." },
      { status: 403 },
    );
  }
  try {
    const report = await deps.runPopulate({ tenantId: deps.tenantId });
    return Response.json({ ok: true, ...report });
  } catch {
    return Response.json(
      { error: "Market graph population unavailable." },
      { status: 500 },
    );
  }
}
