/**
 * Issue #2460 (Agent Mesh S19, programme #2225 G13c) — the mesh
 * RSI proposal PORT. The proposal pipeline
 * (src/services/meshProposalPipeline.ts) drafts proposal records
 * against verified evidence, advances them through its lifecycle,
 * and files the ones that clear the evidence bar as GitHub
 * issues. This port is where those records live.
 *
 * Port discipline (R1/R2, #1546 contract): this module names no
 * dialect and no binding. The D1 adapter
 * (src/data/d1MeshProposalAdapter.ts) is the only module that
 * knows the agent_mesh_proposals column names; the in-memory
 * adapter (src/data/inMemoryMeshProposalAdapter.ts) is the
 * conformance/test double beside it; the composition root
 * (src/data/createMeshProposalPorts.ts) maps env → store and
 * never throws on an unbound store.
 *
 * Lifecycle: drafted → evidence-checked → filed, with
 * evidence-refused as the terminal state for a proposal whose
 * evidence did not clear the bar at check time. The refusal is
 * recorded, not discarded: the bar's verdict (with reasons) is
 * part of the row, so "why did nothing get filed?" is answerable
 * from the store. The pipeline is the only writer; transitions
 * are its calls, never a caller's direct edit.
 *
 * Filed proposals bridge into the foundation proposal ledger
 * (#2288, src/data/proposalLedgerPorts.ts) at filing time: the
 * ledger's proposed → approved → applied → verified machine,
 * with its gates recorded as data, is the downstream lifecycle
 * of a filed proposal — this store does not duplicate it.
 *
 * Evidence discipline (ADR 0011, S18 precedent): evidence refs
 * carry codes, ids, counts, and booleans only — run ids, trace
 * ids, failure names from the harness's own expectation checks.
 * Never payloads, never free text from a door response.
 */

/** Pipeline lifecycle states. */
export type MeshProposalState =
  | "drafted"
  | "evidence-checked"
  | "filed"
  | "evidence-refused";

/** States in which a proposal still blocks a duplicate for its signal. */
export const MESH_PROPOSAL_OPEN_STATES: readonly MeshProposalState[] = [
  "drafted",
  "evidence-checked",
  "filed",
];

/** Scalar evidence values, as in the eval store (S18). */
export type MeshProposalFactValue = string | number | boolean;

/** One pointer from a proposal back to the evidence that raised it. */
export interface MeshProposalEvidenceRef {
  kind: "golden-task" | "calibration" | "trace";
  /** The reachable id: an eval run id, a calibration slice key, a trace id. */
  ref: string;
  /** Scalar detail (counts, codes, ids) — no payloads. */
  detail: Record<string, MeshProposalFactValue>;
}

/** The evidence bar's verdict, recorded on the proposal at check time. */
export interface MeshProposalBarVerdict {
  passes: boolean;
  /** Named reasons for a refusal; empty when the bar passes. */
  reasons: string[];
}

/** One RSI proposal record — the row the pipeline advances. */
export interface MeshProposalRecord {
  id: string;
  /** Dedup key: one open proposal per signal (the #1742 rule). */
  signalKey: string;
  title: string;
  problem: string;
  proposedChange: string;
  expectedEffect: string;
  /**
   * What would prove this proposal wrong, in #1742's spirit.
   * Required: a proposal that cannot be falsified is not one.
   */
  falsificationCriterion: string;
  evidenceRefs: MeshProposalEvidenceRef[];
  state: MeshProposalState;
  /** Set at check time (pass or refusal); absent while drafted. */
  barVerdict?: MeshProposalBarVerdict;
  /** Set at filing time: the §5 issue this proposal became. */
  filedIssueNumber?: number;
  filedIssueUrl?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The proposal record store port. */
export interface MeshProposalStore {
  /**
   * Insert-or-replace the record by id. The pipeline is the only
   * writer and drives every transition explicitly, so a replace
   * is always a deliberate lifecycle step, never a lost update.
   */
  save(record: MeshProposalRecord): Promise<MeshProposalRecord>;
  /** One record by id, or null. */
  get(id: string): Promise<MeshProposalRecord | null>;
  /** All records, optionally filtered to one state, oldest first. */
  list(state?: MeshProposalState): Promise<MeshProposalRecord[]>;
  /**
   * The open proposal for a signal (state in
   * MESH_PROPOSAL_OPEN_STATES), or null — the dedup read.
   * An evidence-refused record is NOT open: its signal may be
   * drafted again when the evidence changes.
   */
  openForSignal(signalKey: string): Promise<MeshProposalRecord | null>;
}
