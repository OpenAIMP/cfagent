/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * Direct executor: the current Workers AI path, unchanged, as
 * the second adapter. Identical to the gateway executor minus
 * the gateway options, so the conformance suite runs unchanged
 * against both and unconfigured deployments behave exactly as
 * before this slice.
 */
import { createWorkersAI } from "workers-ai-provider";
import { executeModelCall } from "./gatewayModelCall";
import type { ModelExecutor, ModelExecutorInput } from "./gatewayPorts";

export class WorkersAiDirectExecutor implements ModelExecutor {
  readonly kind = "direct" as const;
  private readonly modelFor: (modelName: string) => unknown;

  constructor(binding: never) {
    const provider = createWorkersAI({ binding: binding as never });
    this.modelFor = (modelName: string) => provider(modelName);
  }

  async execute(input: ModelExecutorInput): Promise<{ text: string; object?: unknown }> {
    return executeModelCall(this.modelFor(input.model), input);
  }
}
