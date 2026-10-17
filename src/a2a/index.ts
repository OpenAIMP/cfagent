/**
 * PR #2 — A2A routing (main entry).
 * Re-exports agent cards and the handleA2A dispatcher.
 */
export * from "./a2a/agent-cards";

import { A2A_CARDS, A2A_CARD_PATHS, getAgentCard } from "./a2a/agent-cards";
import { catalogAgent } from "./orchestrate";

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
    const match = path.match(/^\/a2a\/(\w+)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const entry = catalogAgent(match[1]);
    if (!entry) return new Response(`Unknown agent: ${match[1]}`, { status: 404 });

    const namespace = (env as any)[entry.binding];
    if (!namespace) return new Response(`Binding not configured: ${entry.binding}`, { status: 500 });

    const stub = namespace.get(namespace.idFromName(match[1]));
    if (typeof stub.handleA2A !== "function") {
      return new Response("Agent does not expose handleA2A", { status: 500 });
    }
    return stub.handleA2A(request);
  }

  return new Response("Method not allowed", { status: 405 });
}
