/**
 * Issue #2439 (Agent Mesh S18, programme #2225 G13b) — the mesh
 * eval result PORT. The golden-task harness
 * (src/services/meshGoldenTasks.ts) scores every run of a golden
 * task and records the result here; S19's RSI proposal pipeline
 * reads outcomes back through this same port.
 *
 * Port discipline (R1/R2, #1546 contract): this module names no
 * dialect and no binding. The D1 adapter
 * (src/data/d1MeshEvalAdapter.ts) is the only module that knows
 * the agent_mesh_eval_results column names; the in-memory adapter
 * (src/data/inMemoryMeshEvalAdapter.ts) is the conformance/test
 * double beside it; the composition root
 * (src/data/createMeshEvalPorts.ts) maps env → store and never
 * throws on an unbound store.
 *
 * Evidence discipline: a result carries codes, ids, counts, and
 * booleans only — refusal codes, trace ids, hop kinds, and the
 * task's declared facts. Never free text from a door response,
 * never payloads: the store is an outcome ledger, not a transcript.
 *
 * Recording is idempotent on (runId, taskId): the first record
 * wins, so a replayed recording of the same run converges instead
 * of double-counting (the fleet's adapter rule, S17 precedent).
 */

/** The two outcomes a golden expectation can demand. */
export type MeshEvalOutcome = "completed" | "refused";

/** What a drive can observe: a golden outcome, or a driver error. */
export type GoldenObservationOutcome = MeshEvalOutcome | "error";

/** Fact values are deliberately scalar: comparable, storable, honest. */
export type MeshEvalFactValue = string | number | boolean;

/**
 * A golden task's expectation — declared as data beside the task.
 * Every field is falsifiable: the outcome must match; a refusal
 * must carry the named code; each fact must equal the observed
 * value exactly; each named trace hop kind must appear in the
 * run's assembled S17 trace.
 */
export interface MeshEvalExpectation {
  outcome: MeshEvalOutcome;
  /** Required in effect when outcome is "refused": the refusal's code. */
  refusalCode?: string;
  /** Exact-match facts the observation must carry. */
  facts?: Record<string, MeshEvalFactValue>;
  /** Hop kinds that must appear in the assembled trace (S17). */
  traceHopKinds?: string[];
}

/** One drive's observation of a golden task run. */
export interface GoldenObservation {
  outcome: GoldenObservationOutcome;
  /** The refusal's code, when the door refused (codes only). */
  refusalCode?: string;
  /** The W3C trace id the run joined, where the path emits one. */
  traceId?: string;
  /** Scalar evidence: counts, statuses, codes, ids. */
  facts: Record<string, MeshEvalFactValue>;
  /** Driver-error detail (an error name/message), outcome "error" only. */
  detail?: string;
}

/** One scored golden-task result — the row S19 reads. */
export interface MeshEvalTaskResult {
  runId: string;
  taskId: string;
  door: string;
  className: string;
  /** Position within the run: the deterministic read-back order. */
  seq: number;
  passed: boolean;
  outcome: GoldenObservationOutcome;
  refusalCode?: string;
  /** Named expectation failures; empty when passed. */
  failures: string[];
  traceId?: string;
  /** Hop kinds in the run's assembled trace, where assembled. */
  traceHopKinds?: string[];
  /** The S17 assembly's completeness verdict, where assembled. */
  traceComplete?: boolean;
  facts: Record<string, MeshEvalFactValue>;
  startedAtMs: number;
  durationMs: number;
}

/** The eval result store port. */
export interface MeshEvalResultStore {
  /** Record one result; a duplicate (runId, taskId) is a no-op. */
  record(result: MeshEvalTaskResult): Promise<void>;
  /** All results of one run, in run order (seq). */
  resultsForRun(runId: string): Promise<MeshEvalTaskResult[]>;
  /** All recorded results for one task, oldest first. */
  resultsForTask(taskId: string): Promise<MeshEvalTaskResult[]>;
  /** The most recent result for one task, or null if never run. */
  latestForTask(taskId: string): Promise<MeshEvalTaskResult | null>;
}
