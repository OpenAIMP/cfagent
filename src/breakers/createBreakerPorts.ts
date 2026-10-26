/**
 * Issue #1745 — breaker factory conveniences.
 *
 * defaultBreakerRegistry() is the per-isolate shared registry used
 * by production wiring that has no registry to inject (E*TRADE,
 * Nasdaq, public fetch paths). Its semantics are the documented
 * in-memory ones: state resets on isolate recycle (fail-open on
 * cold start), state is provider-scoped infrastructure state, never
 * user-scoped. Tests and call sites that need isolation use
 * createBreakerRegistry() directly with an injected clock.
 */

import {
  createBreakerRegistry,
  type BreakerRegistry,
  type BreakerRegistryOptions,
} from "./breakerPorts";

let shared: BreakerRegistry | undefined;

/** Lazily-created shared per-isolate registry (see header). */
export function defaultBreakerRegistry(
  opts: BreakerRegistryOptions = {}
): BreakerRegistry {
  if (!shared) shared = createBreakerRegistry(opts);
  return shared;
}

/** Test seam: drop the shared registry (mirrors __resetSessionCache). */
export function __resetDefaultBreakerRegistry(): void {
  shared = undefined;
}
