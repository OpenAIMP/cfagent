/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — RE-EXPORT
 * SHIM. The discovery-run store moved behind its port in the
 * data layer:
 *   - port + types + visibility rule: src/data/discoveryRunPorts.ts
 *   - DO-SQLite adapter: src/data/doSqliteDiscoveryRunAdapter.ts
 *   - in-memory adapter: src/data/inMemoryDiscoveryRunAdapter.ts
 * This module re-exports the layer so every existing import
 * path and call signature is preserved (ADR 0022 §22 shim
 * rule). New code should import from src/data directly or
 * compose via src/data/createOptionsDiscoveryPorts.ts.
 *
 * ---
 *
 * (The original module documentation follows.)
 *
 * Discovery-run store (issue #126 — schedulable discovery with
 * results in UI + downloadable result sets).
 *
 * Every executed saved-request discovery run is persisted so the
 * Discovery UI can list recent runs, reload one, and download
 * its result set. The runner (src/services/discoveryService.ts)
 * derives target symbols from the user's saved requests,
 * executes one scan per derived target, and stores ONE run
 * record: the originating saved requests (the run's inputs,
 * capped at MAX_SAVED_REQUESTS_PER_RUN) plus one outcome per
 * target symbol (carrying the scan run id, so the full scan is
 * one hop away).
 *
 * This store is deliberately distinct from scanRunStore.ts:
 * that one persists the opportunity scans themselves; this one
 * persists the discovery runs that orchestrate them. A run's
 * derived counts (setups found, abstentions) are computed from
 * its outcomes at save time — never trusted from the caller —
 * so the list view's numbers always reconcile with the stored
 * outcomes.
 *
 * Two implementations of DiscoveryRunStore live behind the
 * port: SqlDiscoveryRunStore over Durable Object SQLite, and an
 * in-memory implementation with identical semantics.
 *
 * Retention and visibility follow the scan-run store exactly:
 * 365 days by created_at, capped at 1000 rows, enforced on the
 * write path relative to the run's own timestamp; a run saved
 * with a userLogin is visible only to that login, legacy
 * (unstamped) runs to every caller (issue #103) — an invisible
 * run reads as absent, never as an error.
 */
export * from "../../data/discoveryRunPorts";
export { SqlDiscoveryRunStore } from "../../data/doSqliteDiscoveryRunAdapter";
export { InMemoryDiscoveryRunStore } from "../../data/inMemoryDiscoveryRunAdapter";
