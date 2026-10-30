/**
 * DELEGATE since issue #2362 (#1976 step 4f): the framework
 * queue index helper is superseded by its layer schema home
 * at src/data/frameworkQueueIndexSchema.ts. This module
 * re-exports it so existing import paths (the orchestrator's
 * onStart, the EXPLAIN pins) keep working unchanged; new
 * code should import from the data layer. The design record
 * (issue #2280 slice 1: seek indexes for the framework's
 * alarm job queue) lives on the layer module.
 */
export {
  FRAMEWORK_QUEUE_INDEXES,
  ensureFrameworkQueueIndexes,
} from "../data/frameworkQueueIndexSchema";
