/**
 * Node-side stub for the `cloudflare:workers` module.
 *
 * `src/server.ts` exports Durable Object classes, so importing the Worker in a
 * unit test resolves `cloudflare:workers` — a scheme Node's ESM loader rejects.
 * Vitest aliases that specifier here. Tests never instantiate a DO; they only
 * need the module to resolve and the base class to exist.
 */
export class DurableObject<TEnv = unknown> {
  protected ctx: any;
  protected env: TEnv;

  constructor(ctx: any, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}
