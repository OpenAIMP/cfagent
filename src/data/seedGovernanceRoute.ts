/**
 * Issue #1559 ([AGENTIC] slice-0 cutover) — the guarded operator
 * route for the one-time halt seed, as a pure, testable handler.
 * The Worker route in src/server.ts only wires real dependencies
 * into this function; every decision below is covered by
 * tests/governance_seed_route.test.ts.
 *
 * Decision order (same shape as the IAAA admin overview route):
 * unauthenticated → 401; non-POST → 405; unwired session (no
 * internalUserId) → 403; wired non-admin → 403 with NO data;
 * platform-admin → run the seed and return { seeded, state }.
 *
 * The seed itself is idempotent by construction (a second run is
 * a no-op returning seeded:false with the same state) and never
 * writes the durable-object setting — it writes the mirror row
 * only. This handler adds no boot logic and never auto-runs.
 */
import type { GovernedHaltState } from "./governedHalt";

export interface SeedGovernanceRouteSession {
  githubLogin?: string;
  internalUserId?: string;
}

export interface SeedGovernanceRouteDeps {
  session: SeedGovernanceRouteSession | null;
  method: string;
  isPlatformAdmin: boolean;
  tenantId: string;
  runSeed: (input: {
    tenantId: string;
    setBy: string;
  }) => Promise<{ seeded: boolean; state: GovernedHaltState }>;
}

export async function handleSeedGovernanceRoute(
  deps: SeedGovernanceRouteDeps,
): Promise<Response> {
  if (!deps.session) {
    return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
  }
  if (deps.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!deps.session.internalUserId) {
    return Response.json(
      { error: "Forbidden: governance seed requires a wired session." },
      { status: 403 },
    );
  }
  if (!deps.isPlatformAdmin) {
    return Response.json(
      { error: "Forbidden: governance seed requires platform-admin membership." },
      { status: 403 },
    );
  }
  try {
    const result = await deps.runSeed({
      tenantId: deps.tenantId,
      setBy: deps.session.githubLogin ?? deps.session.internalUserId,
    });
    return Response.json(result);
  } catch {
    // Generic error only: a failed invoke does not prove nothing
    // happened, so the operator diagnoses mirror state before
    // retrying (the second invoke reports seeded:false when the
    // row already exists). No partial data leaks here.
    return Response.json(
      { error: "Governance seed unavailable." },
      { status: 500 },
    );
  }
}
