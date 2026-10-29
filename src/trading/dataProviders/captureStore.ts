/**
 * Issue #2303 (#1976 step 1) — DELEGATION SHIM.
 *
 * The provider capture store's implementation moved into the
 * data-access layer (ADR 0022 D-I step 1; residency ruled by
 * the step-1 audit: the family's durable reader is a cross-run
 * aggregation, so the production store is D1): the record
 * types, the shared mechanics and the ProviderCaptureStore
 * port live in src/data/providerCapturePorts.ts, and the
 * DO-SQLite implementation (these functions, unchanged) lives
 * in src/data/doSqliteProviderCaptureAdapter.ts. Production
 * wiring uses the port (D1 adapter) via
 * src/data/createProviderCapturePorts.ts.
 *
 * This module re-exports the full legacy surface so every
 * existing import path and call signature keeps working. New
 * code should depend on the port, not on this shim.
 */
export * from "../../data/providerCapturePorts";
export * from "../../data/doSqliteProviderCaptureAdapter";
