/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * Actor-turn adapter: plugs the gateway port into #1738's turn
 * runner WITHOUT replacing the actor port. The orchestrator uses
 * this turn function when a gateway port exists and keeps the
 * legacy generateTextModelTurn when it does not (unbound or
 * mocked AI), so actor-orchestrator parity tests are preserved.
 *
 * The turn carries no tenant, so caching is skipped (safe
 * direction) and rate limiting keys on the caller name.
 */
import type { ModelTurnFn } from "../actors/actorTurnRunner";
import type { LlmGatewayPort } from "./gatewayPorts";

export interface GatewayModelTurnOptions {
  caller?: string;
}

export function createGatewayModelTurn(port: LlmGatewayPort, opts: GatewayModelTurnOptions = {}): ModelTurnFn {
  return async (turn) => {
    const modelId = (turn.model as { modelId?: unknown } | null)?.modelId;
    if (typeof modelId !== "string" || modelId.length === 0) {
      throw new Error("Gateway turn requires a named model (modelId missing).");
    }
    const result = await port.generate({
      models: [modelId],
      ...(turn.system !== undefined ? { system: turn.system } : {}),
      messages: turn.messages,
      ...(turn.tools !== undefined ? { tools: turn.tools } : {}),
      ...(turn.maxSteps !== undefined ? { maxSteps: turn.maxSteps } : {}),
      caller: opts.caller ?? "actor-turn",
    });
    return { text: result.text };
  };
}
