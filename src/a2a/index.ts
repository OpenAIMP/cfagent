/**
 * PR #2 — A2A routing (main entry).
 * Re-exports agent cards and the handleA2A dispatcher.
 */
export * from "./agent-cards";

import { A2A_CARDS, A2A_CARD_PATHS, getAgentCard } from "./agent-cards";
import { catalogAgent } from "../orchestrate";

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
    const outcome = (await stub.handleA2A(body, url.origin)) as {
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
