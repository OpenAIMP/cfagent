/**
 * Issue #2288 (#1976 step 0) — in-memory proposal-ledger store.
 *
 * A test double with the same port semantics as the D1 adapter:
 * the conformance suite runs unchanged against both, including
 * the state-machine and gate rules (enforced through the SAME
 * assertProposalTransition helper in the port module, so the
 * rule cannot drift between adapters). NOT a production store.
 */
import {
  assertProposalTransition,
  type ProposalLedgerStore,
  type ProposalRow,
  type ProposalState,
  type ProposalTransitionInput,
  type ProposalTransitionRow,
  type ProposeInput,
} from "./proposalLedgerPorts";

export class InMemoryProposalLedgerAdapter implements ProposalLedgerStore {
  private proposals = new Map<string, ProposalRow>();
  private transitions: ProposalTransitionRow[] = [];

  async propose(input: ProposeInput): Promise<ProposalRow> {
    const existing = this.proposals.get(input.id);
    if (existing) return { ...existing };
    const atMs = input.createdAtMs ?? Date.now();
    const row: ProposalRow = {
      id: input.id,
      title: input.title,
      summary: input.summary,
      proposerAgent: input.proposerAgent,
      principal: input.principal,
      state: "proposed",
      createdAtMs: atMs,
      updatedAtMs: atMs,
    };
    this.proposals.set(row.id, row);
    this.transitions.push({
      id: `${input.id}:created`,
      proposalId: input.id,
      fromState: null,
      toState: "proposed",
      actor: input.proposerAgent,
      gateRef: null,
      createdAtMs: atMs,
    });
    return { ...row };
  }

  async transition(
    input: ProposalTransitionInput,
  ): Promise<ProposalTransitionRow> {
    const current = this.proposals.get(input.proposalId);
    if (!current) {
      throw new Error(`Proposal ${input.proposalId} does not exist.`);
    }
    assertProposalTransition(
      current.state,
      input.toState,
      input.actor,
      input.gateRef,
    );
    const atMs = input.atMs ?? Date.now();
    const row: ProposalTransitionRow = {
      id: `${input.proposalId}:${current.state}->${input.toState}:${atMs}`,
      proposalId: input.proposalId,
      fromState: current.state,
      toState: input.toState,
      actor: input.actor,
      gateRef: input.gateRef ?? null,
      createdAtMs: atMs,
    };
    this.transitions.push(row);
    this.proposals.set(current.id, {
      ...current,
      state: input.toState,
      updatedAtMs: atMs,
    });
    return { ...row };
  }

  async getProposal(id: string): Promise<ProposalRow | null> {
    const row = this.proposals.get(id);
    return row ? { ...row } : null;
  }

  async listProposals(state?: ProposalState): Promise<ProposalRow[]> {
    return [...this.proposals.values()]
      .filter((r) => (state ? r.state === state : true))
      .sort((a, b) => {
        if (a.updatedAtMs !== b.updatedAtMs)
          return b.updatedAtMs - a.updatedAtMs;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      })
      .map((r) => ({ ...r }));
  }

  async listTransitions(
    proposalId: string,
  ): Promise<ProposalTransitionRow[]> {
    return this.transitions
      .filter((t) => t.proposalId === proposalId)
      .sort((a, b) => {
        if (a.createdAtMs !== b.createdAtMs)
          return a.createdAtMs - b.createdAtMs;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((t) => ({ ...t }));
  }
}
