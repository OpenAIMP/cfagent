/**
 * Issue #2303 (#1976 step 1) — DELEGATION SHIM.
 *
 * The provider-config store's implementation moved into the
 * data-access layer (ADR 0022 D-I step 1): the record types,
 * seeds and the ProviderConfigStore port live in
 * src/data/providerConfigPorts.ts, and the DO-SQLite
 * implementation (these sync functions, unchanged) lives in
 * src/data/doSqliteProviderConfigAdapter.ts. Production wiring
 * uses the port (D1 adapter) via
 * src/data/createProviderConfigPorts.ts.
 *
 * This module re-exports the full legacy surface so every
 * existing import path and sync call signature keeps working.
 * New code should depend on the port, not on this shim.
 */
export * from "../../data/providerConfigPorts";
export * from "../../data/doSqliteProviderConfigAdapter";
