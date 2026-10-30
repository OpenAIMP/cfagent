/**
 * DELEGATE since issue #2362 (#1976 step 4f): the retention
 * index helper is superseded by its layer schema home at
 * src/data/masRetentionIndexSchema.ts. This module
 * re-exports it so existing import paths (the orchestrator's
 * ensureTables, the EXPLAIN pins) keep working unchanged;
 * new code should import from the data layer. The design
 * record (issue #2280 slice 3: covering indexes for the
 * nightly retention batches) lives on the layer module.
 */
export {
  MAS_EVENTS_RETENTION_SQL,
  MAS_MESSAGES_RETENTION_SQL,
  ensureMasRetentionIndexes,
} from "../data/masRetentionIndexSchema";
