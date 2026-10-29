/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — RE-EXPORT
 * SHIM. The strategy-profile store moved behind its port in
 * the data layer:
 *   - port + options: src/data/strategyProfilePorts.ts
 *   - DO-SQLite adapter: src/data/doSqliteStrategyProfileAdapter.ts
 *   - in-memory adapter: src/data/inMemoryStrategyProfileAdapter.ts
 * This module re-exports the layer so every existing import
 * path and call signature is preserved (ADR 0022 §22 shim
 * rule). New code should import from src/data directly or
 * compose via src/data/createOptionsDiscoveryPorts.ts.
 *
 * ---
 *
 * (The original module documentation follows.)
 *
 * Strategy profile store (issue #28): per-user saved strategy
 * profiles — name, versioned spec, timestamps. The store
 * enforces only identity and per-user name uniqueness
 * (case-insensitive, trimmed); spec VALIDATION is the caller's
 * job (validateStrategyProfile in strategyProfile.ts), and
 * routes/services validate before writing.
 *
 * Two implementations of StrategyProfileStore live behind the
 * port: SqlStrategyProfileStore over Durable Object SQLite,
 * and an in-memory implementation with identical semantics.
 * Name uniqueness is enforced inside the transaction aspect on
 * the DO adapter when the host supplies the transaction-
 * capable storage (R-3 ruling on #2337), with affected-row
 * verification by read-back (ADR D-E.2).
 */
export * from "../../data/strategyProfilePorts";
export { SqlStrategyProfileStore } from "../../data/doSqliteStrategyProfileAdapter";
export { InMemoryStrategyProfileStore } from "../../data/inMemoryStrategyProfileAdapter";
