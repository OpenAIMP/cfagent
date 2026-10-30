/**
 * Issue #2357 (#1976 step 4b) — the in-memory implementation
 * of the reselection port, with semantics identical to the
 * DO-SQLite adapter (append-only, tenant-scoped,
 * newest-first lists).
 */
import type {
  ReselectionProposal,
  ReselectionProposalRecord,
  ReselectionStore,
} from "./reselectionPorts";

interface ProposalRow {
  id: string;
  userLogin: string;
  regime: string;
  proposal: ReselectionProposal;
  createdAt: string;
}

export class InMemoryReselectionStore implements ReselectionStore {
  private rows: ProposalRow[] = [];

  ensureTable(): void {
    // In-memory: nothing to ensure.
  }

  insertProposal(id: string, userLogin: string, proposal: ReselectionProposal): void {
    this.rows.push({
      id,
      userLogin,
      regime: proposal.regime,
      proposal: structuredClone(proposal),
      createdAt: proposal.generatedAt,
    });
  }

  listProposals(userLogin: string, limit = 20): ReselectionProposalRecord[] {
    return this.rows
      .filter((r) => r.userLogin === userLogin)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        regime: r.regime,
        createdAt: r.createdAt,
        proposal: structuredClone(r.proposal),
      }));
  }
}
