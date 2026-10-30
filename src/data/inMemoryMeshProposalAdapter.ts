/**
 * Issue #2460 (Agent Mesh S19, #2225 G13c) — the in-memory mesh
 * proposal store: the conformance/test double beside the D1
 * adapter (the fleet's standing adapter pattern — production
 * does NOT use this; it exists so the port's contract is
 * testable without a binding, and as the unbound-env posture in
 * the composition root).
 *
 * Same contract as the D1 adapter: save replaces by id;
 * openForSignal returns the OLDEST open record for a signal
 * (the pipeline dedups on it, so at most one should exist).
 */
import {
  MESH_PROPOSAL_OPEN_STATES,
  type MeshProposalRecord,
  type MeshProposalState,
  type MeshProposalStore,
} from "./meshProposalPorts";

export class InMemoryMeshProposalStore implements MeshProposalStore {
  private readonly rows = new Map<string, MeshProposalRecord>();

  async save(record: MeshProposalRecord): Promise<MeshProposalRecord> {
    this.rows.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<MeshProposalRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async list(state?: MeshProposalState): Promise<MeshProposalRecord[]> {
    return [...this.rows.values()]
      .filter((r) => state === undefined || r.state === state)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
  }

  async openForSignal(signalKey: string): Promise<MeshProposalRecord | null> {
    const open = (await this.list()).filter(
      (r) =>
        r.signalKey === signalKey &&
        (MESH_PROPOSAL_OPEN_STATES as readonly string[]).includes(r.state),
    );
    return open.length > 0 ? open[0] : null;
  }
}
