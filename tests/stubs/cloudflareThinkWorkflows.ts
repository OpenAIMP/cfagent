/**
 * Test stub for "@cloudflare/think/workflows" (aliased in vite.config.ts
 * alongside the bare "@cloudflare/think" stub). Provides the base class
 * shape only — workflow tests exercise the flow functions with fake
 * steps; nothing instantiates a workflow under Node.
 */
export class ThinkWorkflow<AgentType = unknown, Params = unknown> {
  protected env: unknown;
  protected ctx: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
  async run(_event: unknown, _step: unknown): Promise<unknown> {
    throw new Error("ThinkWorkflow stub: run() is not implemented under tests");
  }
}
