/**
 * Issue #1118 (P1 of epic #1116): data-provider platform surface —
 * contract, registry, provider-config store, built-in adapters, and
 * the conformance kit. Exported through the src/trading boundary
 * (src/trading/index.ts) per the #290 rule. E1 (issue #1133) adds the
 * capture store (captureStore.ts); E6 (issue #1235) adds the health +
 * metering read model over it (providerHealth.ts); E7 (issue #1248)
 * adds fetch-outcome tracking (fetchOutcome.ts — recorder port,
 * decorator, failure classifier).
 */
export * from "./contract";
export * from "./registry";
export * from "./providerConfigStore";
export * from "./lifecycle";
export * from "./adapters";
export * from "./conformance";
export * from "./captureStore";
export * from "./providerHealth";
export * from "./fetchOutcome";
