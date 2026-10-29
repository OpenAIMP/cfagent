/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — RE-EXPORT
 * SHIM. The discovery setup-run store moved behind its port in
 * the data layer:
 *   - port + types + count reconciliation:
 *     src/data/discoverySetupPorts.ts
 *   - DO-SQLite adapter: src/data/doSqliteDiscoverySetupAdapter.ts
 *   - in-memory adapter: src/data/inMemoryDiscoverySetupAdapter.ts
 * This module re-exports the layer so every existing import
 * path and call signature is preserved (ADR 0022 §22 shim
 * rule). New code should import from src/data directly or
 * compose via src/data/createOptionsDiscoveryPorts.ts.
 *
 * ---
 *
 * (The original module documentation follows.)
 *
 * Discovery setup-run store (issue #14, Options Discovery
 * epic #13 — spec §6 stage 6: run record & scheduling).
 *
 * Every run of the signal-driven discovery pipeline persists
 * its FULL item list — expressed setups AND abstentions, each
 * with its typed reason — so the run record is the audit
 * artifact for the whole pipeline: what it considered, what it
 * expressed, what it refused and why. An expressed item carries
 * the complete gate evidence (spec §3); an abstention's reason
 * is the ONLY output for that symbol (spec §3: abstention is a
 * first-class outcome, never silent omission).
 *
 * Count reconciliation (acceptance (e)): a run's counts must
 * satisfy considered = setups + abstentions + pre-screened-out
 * + errors. The store enforces it at save time — a run whose
 * counts do not reconcile is rejected before it can become the
 * run of record, because every downstream surface (the delta
 * classification in particular) trusts these numbers.
 *
 * Two implementations of DiscoverySetupStore live behind the
 * port: SqlDiscoverySetupStore over Durable Object SQLite, and
 * an in-memory implementation with identical semantics.
 *
 * Retention: 365 days by created_at, capped at 1000 rows,
 * enforced on the write path relative to the run's own
 * timestamp (same discipline as scanRunStore). Retention is
 * housekeeping, not a correctness boundary: delta
 * classification reads latestForScope, so as long as the
 * previous run of a scope survives, deltas are honest.
 *
 * Visibility (issue #103, same rule as the sibling stores): a
 * run saved with a userLogin is visible only to that login; a
 * legacy (unstamped) run is visible to every caller. An
 * invisible run reads as absent, never as an error.
 */
export * from "../../data/discoverySetupPorts";
export { SqlDiscoverySetupStore } from "../../data/doSqliteDiscoverySetupAdapter";
export { InMemoryDiscoverySetupStore } from "../../data/inMemoryDiscoverySetupAdapter";
