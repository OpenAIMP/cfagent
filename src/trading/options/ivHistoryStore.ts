/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — RE-EXPORT
 * SHIM. The IV-history store moved behind its port in the data
 * layer:
 *   - port + types + stats math: src/data/ivHistoryPorts.ts
 *   - DO-SQLite adapter (production default):
 *     src/data/doSqliteIvHistoryAdapter.ts
 *   - D1 adapter (conformance-proven, cutover gated on the
 *     R-2 owner ruling): src/data/d1IvHistoryAdapter.ts
 *   - in-memory adapter: src/data/inMemoryIvHistoryAdapter.ts
 * This module re-exports the layer so every existing import
 * path and call signature is preserved (ADR 0022 §22 shim
 * rule). New code should import from src/data directly or
 * compose via src/data/createOptionsDiscoveryPorts.ts.
 *
 * ---
 *
 * (The original module documentation follows.)
 *
 * IV history store (issue #15, Discovery epic #13).
 *
 * The collector records one ATM IV observation per tracked name
 * per day; this store is the series those observations
 * accumulate into, and computeIvStats is the read model the
 * discovery surfaces consume: IV rank / percentile over the
 * trailing 252 observations, with an honest warming-up state
 * below 60 observations.
 *
 * The settled decision (spec §16, decision 3) is
 * self-collection in warming-up mode: no licensed backfill, no
 * fabricated or interpolated observations. A day the provider
 * failed is an absent observation. First-write-wins per
 * (symbol, date): the day's first successful observation is
 * the record; later same-day writes are ignored, so a
 * re-collection can never rewrite history.
 */
export * from "../../data/ivHistoryPorts";
export { SqlIvHistoryStore } from "../../data/doSqliteIvHistoryAdapter";
export { InMemoryIvHistoryStore } from "../../data/inMemoryIvHistoryAdapter";
