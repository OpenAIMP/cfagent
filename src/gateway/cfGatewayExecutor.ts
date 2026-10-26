/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * Cloudflare AI Gateway executor: the provider adapter. Uses the
 * existing `AI` binding via workers-ai-provider's first-class
 * gateway support (`createWorkersAI({ binding, gateway })`) so
 * the AI SDK tool loop stays intact for actor turns, and no new
 * wrangler binding is needed. The gateway id is owner-configured
 * (AI_GATEWAY_ID); this module never invents one.
 */
import { createWorkersAI } from "workers-ai-provider";
import { executeModelCall } from "./gatewayModelCall";
import type { ModelExecutor, ModelExecutorInput } from "./gatewayPorts";

export interface CloudflareGatewayOptions {
  id: string;
  cacheTtlSeconds?: number;
}

export class CloudflareAiGatewayExecutor implements ModelExecutor {
  readonly kind = "ai-gateway" as const;
  private readonly modelFor: (modelName: string) => unknown;

  constructor(
    binding: never,
    private readonly gateway: CloudflareGatewayOptions,
  ) {
    const provider = createWorkersAI({
      binding: binding as never,
      gateway: { id: gateway.id, ...(gateway.cacheTtlSeconds !== undefined ? { cacheTtl: gateway.cacheTtlSeconds } : {}) },
    });
    this.modelFor = (modelName: string) => provider(modelName);
  }

  async execute(input: ModelExecutorInput): Promise<{ text: string; object?: unknown }> {
    return executeModelCall(this.modelFor(input.model), input);
  }
}
