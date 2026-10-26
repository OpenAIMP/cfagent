/**
 * Issue #1701 ([AGENTIC] Slice 6) — retention-purge route
 * handler (mirrors src/data/shardJobRoute.ts).
 *
 * Pure handler: no env, no binding, no store client. The
 * server wires it to the composition root; this handler
 * decides only status codes and response shape.
 *
 * Decision order: 401 (no wired session) → 405 (non-POST)
 * → 403 (unwired session) → 403 (non-admin) → 200 (report)
 * / 500 (purge failure). The purge is a deliberate operator
 * action; it is never invoked by boot, deploy, or tick
 * logic. An unbound store is answered 503 by the server
 * wiring, not here.
 */
import type { RetentionPurgeReport } from "./retentionPorts";

export interface RetentionPurgeRouteInput {
  /** Wired session, or null when unauthenticated. */
  session: unknown;
  method: string;
  /** False when the caller lacks platform-admin membership. */
  isPlatformAdmin: boolean;
  tenantId: string;
  runPurge: (args: {
    tenantId: string;
  }) => Promise<RetentionPurgeReport>;
}

export async function handleRetentionPurgeRoute(
  input: RetentionPurgeRouteInput,
): Promise<Response> {
  if (!input.session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  if (input.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  const sessionRecord = input.session as { internalUserId?: unknown };
  if (typeof sessionRecord.internalUserId !== "string") {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (!input.isPlatformAdmin) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    const report = await input.runPurge({ tenantId: input.tenantId });
    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error(
      "[data-foundation] Retention purge failed:",
      err instanceof Error ? err.message : String(err),
    );
    return new Response(JSON.stringify({ error: "retention_purge_failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
