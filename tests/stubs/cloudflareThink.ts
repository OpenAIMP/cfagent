/**
 * Test-only Node stub for bare "@cloudflare/think" (issue #2003,
 * tracker #1951). Aliased in vite.config.ts under `test.alias` only,
 * mirroring the existing "@cloudflare/think/workflows" stub alias
 * (tests/stubs/cloudflareThinkWorkflows.ts).
 *
 * Why a FULL replacement, not a re-export: the real package's runtime
 * graph reaches workerd-only imports (notably `cloudflare:email` via
 * the agents package, and `cloudflare:workflows`-adjacent code) that
 * Node's default ESM loader rejects with `Received protocol
 * 'cloudflare:'`. Any stub that re-exported the real entry would
 * still load those internals and fail the same way — which is
 * exactly the 58-file load failure this slice fixes (Research slice
 * #1953, held PR #1990, narrowed cause). This stub imports nothing
 * at all, so the failing graph never loads under Node vitest.
 *
 * TEST-ONLY. The alias lives in vite.config.ts `test` config, which
 * the production Worker build (wrangler/esbuild) ignores, so
 * production still resolves the real @cloudflare/think 0.19.0. No
 * file under src/ may import this stub: it is test tooling, and the
 * agent-conformance harness pin asserts the vite alias points here
 * (and nowhere else).
 *
 * Filename note: this path previously held the #1738 turn stub that
 * the in-memory adapter replaced (see src/actors/
 * inMemoryActorAdapter.ts header). This is NOT that stub restored:
 * the old stub faked a turn, this one refuses turns outright (see
 * below). The path is reused because the vite alias and the
 * conformance pin both address the bare-specifier stub by it.
 *
 * What it provides — exactly what Node tests need to LOAD and to
 * exercise non-turn agent code:
 * - a constructible `Think` base class storing the Durable Object
 *   `(ctx, env)` pair, so a PortThink subclass (and, at fleet
 *   resume, a migrated agent class) can be constructed with a fake
 *   ctx and its domain RPC methods can run their real assertions
 *   against `ctx.storage` / `env`;
 * - a `lifecycle.start()` no-op, so the adapter's guarded boot call
 *   in thinkAdapter.ts passes through instead of failing on a
 *   missing lifecycle object.
 *
 * What it REFUSES — deliberately, so it can never mask a real
 * failure: `runTurn()` and `submitMessages()` throw a loud stub
 * error. A real Think turn runs under workerd only (as the O3 spike
 * #1935 proved); under Node a turn attempt must fail visibly, never
 * return a faked turn result that a test could mistake for a pass.
 */
export class Think<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  /** Lifecycle boot surface the adapter calls (guarded, start only). */
  readonly lifecycle = {
    start: async (): Promise<void> => {
      // No-op under Node tests: there is no Think session to boot.
      // The adapter proceeds to runTurn, which throws (see below),
      // so a turn attempt still fails loudly rather than silently.
    },
  };

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async runTurn(_input: unknown): Promise<never> {
    throw new Error(
      "Think stub: runTurn() is not implemented under Node tests — " +
        "a real Think turn runs under workerd, never through this stub"
    );
  }

  async submitMessages(_input: unknown): Promise<never> {
    throw new Error(
      "Think stub: submitMessages() is not implemented under Node tests — " +
        "a real Think turn runs under workerd, never through this stub"
    );
  }
}
