/**
 * Issue #2288 (#1976 step 0) — minimal ambient declaration for
 * the ONE node:async_hooks surface the transaction aspect uses.
 *
 * Why this file exists: the repo's tsconfig loads only
 * @cloudflare/workers-types + vite/client (no @types/node), and
 * the installed workers-types does not declare node: modules,
 * so `node:async_hooks` is untyped here even though BOTH target
 * runtimes provide it: Node (tests) natively, and Workers via
 * the nodejs_compat compatibility flag (wrangler.jsonc,
 * compatibility_date 2026-09-29 — AsyncLocalStorage is part of
 * that support). Only the surface transactionAspect.ts consumes
 * is declared; this is not a general node-types shim.
 */
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
    enterWith(store: T): void;
    disable(): void;
  }
}
