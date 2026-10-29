/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — RE-EXPORT
 * SHIM. The discovery alert store moved behind its port in the
 * data layer:
 *   - port + types: src/data/discoveryAlertPorts.ts
 *   - DO-SQLite adapter: src/data/doSqliteDiscoveryAlertAdapter.ts
 *   - in-memory adapter: src/data/inMemoryDiscoveryAlertAdapter.ts
 * This module re-exports the layer so every existing import
 * path and call signature is preserved (ADR 0022 §22 shim
 * rule). New code should import from src/data directly or
 * compose via src/data/createOptionsDiscoveryPorts.ts.
 *
 * PORT CONTRACT NOTE: dedupe is a store-level invariant on
 * every adapter — the in-memory adapter now rejects a
 * duplicate (scope, symbol, thesis, day) record just as the
 * SQL adapter's UNIQUE constraint does (the legacy in-memory
 * store accepted duplicates; see the adapter's header).
 *
 * ---
 *
 * (The original module documentation follows.)
 *
 * Discovery alert store (issue #18, Discovery epic #13 — Phase
 * 2, Decision 2: NEW setups only, discovery score ≥ 70, cap
 * 5/day).
 *
 * Every alert the dispatcher sends is recorded here FIRST; the
 * record is both the in-app channel's artifact ("an alert the
 * user can open") and the evidence the anti-spam rules run
 * against: dedupe — at most one alert per (scope, symbol,
 * thesis, day) — and the daily cap, counted from this log.
 *
 * Two implementations of DiscoveryAlertStore live behind the
 * port: SqlDiscoveryAlertStore over Durable Object SQLite
 * (dedupe rests on the schema's UNIQUE constraint, so a racing
 * duplicate record fails rather than landing twice), and an
 * in-memory implementation with identical semantics.
 */
export * from "../../data/discoveryAlertPorts";
export { SqlDiscoveryAlertStore } from "../../data/doSqliteDiscoveryAlertAdapter";
export { InMemoryDiscoveryAlertStore } from "../../data/inMemoryDiscoveryAlertAdapter";
