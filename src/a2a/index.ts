/**
 * PR #2 — A2A routing (main entry).
 * Re-exports agent cards and the handleA2A dispatcher.
 */
export * from "./agent-cards";

import { A2A_CARDS, A2A_CARD_PATHS, getAgentCard } from "./agent-cards";
import { resolveA2AAgent, resolveA2AInstanceName } from "./resolution";
import { authenticateA2A } from "./meshCredentials";
import { recordTraceHopBestEffort } from "../data/createMeshTracePorts";
import {
  formatTraceparent,
  newTraceContext,
} from "../observability/observabilityPorts";
import { childContextOfTraceparent } from "../observability/meshTrace";

/**
 * Route an incoming A2A request to the right DO stub.
 * GET /.well-known/agent-card.json → discovery
 * GET /a2a/<agent>/agent-card.json → per-agent card
 * POST /a2a/<agent> → JSON-RPC dispatch via handleA2A on the DO stub
 */
export async function handleA2A(request: Request, env: any): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET") {
    if ((A2A_CARD_PATHS as readonly string[]).includes(path)) {
      return Response.json({ agents: A2A_CARDS });
    }
    const card = A2A_CARDS.find((c) => c.cardPath === path);
    if (card) return Response.json(card);
    return new Response("Not found", { status: 404 });
  }

  if (request.method === "POST") {
    // Edge auth (#291 A5, cfpay parity; per-agent credentials since
    // S16, #2426): A2A dispatch requires the surface's own bearer
    // credential (env A2A_TOKEN_<SURFACE>), compared timing-safely
    // by src/a2a/meshCredentials.ts. While a surface has no
    // per-agent credential set, the shared token authenticates it
    // as a recorded TRANSITIONAL fallback (removal condition in
    // meshCredentials.ts). FAIL CLOSED — a surface with neither
    // credential configured disables its dispatch (503) rather
    // than serving it unauthenticated; a missing/wrong credential
    // is a 401. Discovery (GET cards above) stays public. This gate
    // sits ahead of agent resolution: authentication decides first,
    // and an unknown surface name gets the same 401/404 sequence
    // the shared-token edge produced.
    const match = path.match(/^\/a2a\/([\w-]+)$/);
    const authHeader = request.headers.get("authorization") ?? "";
    const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const auth = authenticateA2A(
      env as Record<string, unknown>,
      match ? match[1] : null,
      presented,
    );
    if (!auth.ok && auth.reason === "unconfigured") {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: "A2A dispatch is not configured" } },
        { status: 503 },
      );
    }
    if (!auth.ok) {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32002, message: "Unauthorized" } },
        { status: 401 },
      );
    }

    if (!match) return new Response("Not found", { status: 404 });
    // Resolution is A2A's own map (#2223, src/a2a/resolution.ts) —
    // NOT the planner's OPERATION_CATALOG, whose entries and
    // behavior belong to the planner.
    const resolution = resolveA2AAgent(match[1]);
    if (!resolution) return new Response(`Unknown agent: ${match[1]}`, { status: 404 });

    const namespace = (env as any)[resolution.binding];
    if (!namespace) return new Response(`Binding not configured: ${resolution.binding}`, { status: 500 });

    // The instance name comes from the resolution map, not the URL:
    // some agents' live state sits on a fixed instance (the shared
    // orchestrator address; ScheduledAgent's "default"), and
    // dispatching to the bare URL name would start a virgin
    // instance holding wrong state. A null
    // resolution means the agent is not configured here — fail
    // honestly instead of guessing an instance.
    const instanceName = resolveA2AInstanceName(resolution, match[1], env);
    if (instanceName === null) {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32003, message: `Agent is not configured: ${match[1]}` } },
        { status: 500 },
      );
    }

    const stub = namespace.get(namespace.idFromName(instanceName));
    if (typeof stub.handleA2A !== "function") {
      return new Response("Agent does not expose handleA2A", { status: 500 });
    }

    // Agents implement handleA2A(body, origin) and return a collected
    // { text, data } outcome (cfpay pattern): a Request cannot cross the
    // DO RPC boundary, so the body is parsed HERE at the edge and the
    // wire shape is built here too. (Passing the raw Request, the
    // original port, could never execute over RPC.)
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400 },
      );
    }
    // Mesh trace (S17, #2428): the A2A edge is an ingress — it
    // continues the caller's traceparent or mints a fresh trace
    // (#1743's ingress rule), records the a2a hop with the S16
    // two-part attribution, and hands the traceparent into the
    // dispatch as the fourth argument. Agents whose records
    // carry attribution/trace (PaymentsAgent) declare the
    // parameter; the rest ignore it. Recording is best-effort:
    // a tracing failure never fails the dispatch.
    const traceparent =
      request.headers.get("traceparent") ?? formatTraceparent(newTraceContext());
    const traceChild = childContextOfTraceparent(traceparent);
    if (traceChild) {
      await recordTraceHopBestEffort(env as Record<string, unknown>, {
        traceId: traceChild.traceId,
        spanId: traceChild.spanId,
        parentSpanId: traceChild.parentSpanId,
        kind: "a2a",
        operation: `a2a:${match[1]}`,
        timestampMs: Date.now(),
        caller: auth.attribution.caller,
        agent: auth.attribution.surface,
      });
    }

    // Two-part attribution (S16, #2426): the edge-authenticated
    // caller + the surface served ride into the dispatch as the
    // third argument. Agents whose records carry attribution
    // (PaymentsAgent) declare the parameter; the rest ignore it.
    const outcome = (await stub.handleA2A(body, url.origin, auth.attribution, traceparent)) as {
      text?: string;
      data?: unknown;
    };
    const id =
      body && typeof body === "object" && "id" in body ? (body as any).id : null;
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: {
        artifacts: [
          {
            parts: [
              { kind: "text", text: outcome?.text ?? "" },
              ...(outcome?.data !== undefined
                ? [{ kind: "data", data: outcome.data }]
                : []),
            ],
          },
        ],
      },
    });
  }

  return new Response("Method not allowed", { status: 405 });
}
