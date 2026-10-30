/**
 * Issue #2469 (Agent Mesh S20, programme #2225 G9) — the Agents
 * view read route handler (mirrors src/data/shardJobRoute.ts).
 *
 * Pure handler: no env, no binding, no store. The server wires it
 * to requireAuth; the handler decides only status codes and
 * response shape.
 *
 * Decision order: 401 (no wired session) → 405 (non-GET) → 200
 * (the registry payload, derived from src/agents/registry.ts at
 * request time by src/services/meshRegistryView.ts). The route is
 * read-only by construction — no method but GET is answered, and
 * the handler writes nothing.
 */
import { buildMeshRegistryView } from "../services/meshRegistryView";

export interface MeshRegistryRouteInput {
  /** Wired session, or null when unauthenticated. */
  session: unknown;
  method: string;
}

export async function handleMeshRegistryRoute(
  input: MeshRegistryRouteInput,
): Promise<Response> {
  if (!input.session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  if (input.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(buildMeshRegistryView()), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
