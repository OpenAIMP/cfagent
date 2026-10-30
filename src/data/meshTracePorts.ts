/**
 * Issue #2428 (Agent Mesh S17, programme #2225 G13a) — the mesh
 * trace hop PORT. One trace spine across doors, workflows, and
 * agents: the trace id is the W3C trace id (#1743,
 * src/observability/observabilityPorts.ts `TraceContext.traceId`),
 * and a hop is one recorded span on that spine.
 *
 * Per-hop identity (what the trace id IS at each hop type):
 *  - ingress / turn / door / job-queue / job-execute / a2a: the
 *    W3C trace id carried by the traceparent the hop was reached
 *    under; the span is a child span of that context.
 *  - workflow-start / workflow-step / projection: the same trace
 *    id, carried by `WorkflowJobCommand.traceparent` (#1743's
 *    field, producer-stamped from this slice). Where an existing
 *    id already serves — the workflow jobId, the async-job id —
 *    the hop records it as `jobId` (the MAPPING), never a
 *    parallel id universe.
 *  - ledger: the trace id threaded beside the S16 two-part
 *    attribution into the payments ledger write.
 *
 * Port discipline (R1/R2, #1546 contract): this module names no
 * dialect and no binding. The D1 adapter
 * (src/data/d1MeshTraceAdapter.ts) is the only module that knows
 * the table's column names; the in-memory adapter
 * (src/data/inMemoryMeshTraceAdapter.ts) is the conformance/test
 * double beside it; the composition root
 * (src/data/createMeshTracePorts.ts) maps env → store and never
 * throws on an unbound store.
 *
 * Recording is idempotent on (traceId, spanId): workflow step
 * recording sits OUTSIDE the durable step callbacks (a step's
 * journal replay must not re-run side effects inside the step),
 * so a replay re-records the same deterministic span and the
 * store's conflict rule converges it to one hop.
 */

/** The hop kinds on the spine, in pipeline order. */
export const MESH_TRACE_HOP_KINDS = [
  "ingress",
  "turn",
  "door",
  "job-queue",
  "job-execute",
  "workflow-start",
  "workflow-step",
  "projection",
  "a2a",
  "ledger",
] as const;

export type MeshTraceHopKind = (typeof MESH_TRACE_HOP_KINDS)[number];

/** One recorded span on the mesh trace spine. */
export interface MeshTraceHop {
  /** The W3C trace id (32 lowercase hex) — the spine's identity. */
  traceId: string;
  /** This span's id (16 lowercase hex). Deterministic for workflow steps (replay-convergent), random elsewhere. */
  spanId: string;
  /** The parent span's id, where the hop continued a context. */
  parentSpanId?: string;
  kind: MeshTraceHopKind;
  /** Operation name (command name, step name, surface name — codes and ids only, never user material). */
  operation: string;
  timestampMs: number;
  /** Tenant scope where the emitting boundary has one (null/absent is honest scope, never fabricated — the #1743 rule). */
  tenantId?: string | null;
  /**
   * Attribution part 1 (S16, #2426): who acted — the acting
   * user's login on turn/door hops, the edge-authenticated
   * `a2a-credential:<surface>` caller on A2A hops.
   */
  caller?: string;
  /**
   * Attribution part 2 (S16): the agent/surface serving the hop
   * (door target class, A2A surface name).
   */
  agent?: string;
  /** The existing run identity this hop belongs to, where one serves (workflow jobId, async-job id) — the mapping, recorded. */
  jobId?: string;
  /** Codes/facts only (never a message, never user material). */
  note?: string;
}

/** The hop store surface: record (idempotent) + read one trace's hops. */
export interface MeshTraceStore {
  record(hop: MeshTraceHop): Promise<void>;
  hopsFor(traceId: string): Promise<MeshTraceHop[]>;
}
