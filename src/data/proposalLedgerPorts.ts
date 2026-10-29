/**
 * Issue #2288 (#1976 step 0, ADR 0022 D-F.4) — proposal-ledger
 * port.
 *
 * The proposal ledger is a foundation state machine:
 * proposed → approved → applied → verified, generalizing the
 * champion/challenger guard shape (survey §5.4) to every loop
 * proposal (the Sentinel #2279 is the first named writer). The
 * substrate's enforcement is structural, not disciplinary:
 *  - a transition moves exactly ONE step along the machine;
 *  - every gated transition (into approved / applied / verified)
 *    records its gate AS DATA — the acting approver and the
 *    issue/PR reference the approval stands on. A transition
 *    without a recorded gate is refused by the port
 *    (DATA_PROPOSAL_GATE_MISSING) and therefore does not exist;
 *  - transitions are append-only rows: the ledger's history is
 *    the audit trail, never an in-place rewrite.
 * Domain evaluation — whether a proposal SHOULD be approved —
 * stays in the domains, never in this port.
 *
 * Port-first (ADR 0002 R1/R2): record types, the port interface,
 * and pure helpers ONLY; no store client, no env binding, no
 * SQL. The state-machine rule lives in ONE pure helper
 * (`assertProposalTransition`) that BOTH adapters call, so the
 * D1 and in-memory implementations cannot drift on the rule
 * this family exists to enforce.
 */
import {
  DataFoundationCode,
  DataFoundationError,
} from "../aspects/errorCodes";

/** The ledger's states, in machine order. */
export const PROPOSAL_STATES = [
  "proposed",
  "approved",
  "applied",
  "verified",
] as const;

export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** One proposal row (current state; history lives in transitions). */
export interface ProposalRow {
  id: string;
  title: string;
  summary: string;
  /** The agent that proposed (G14 acting identity). */
  proposerAgent: string;
  /** The principal the proposal acts for (G14). */
  principal: string;
  state: ProposalState;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One append-only transition row — the gate, recorded as data. */
export interface ProposalTransitionRow {
  id: string;
  proposalId: string;
  /** Null only on the creation transition. */
  fromState: ProposalState | null;
  toState: ProposalState;
  /** Who performed this step (proposer, approver, applier, verifier). */
  actor: string;
  /**
   * The gate reference (issue or PR) the step stands on.
   * Required for every step after creation; null on creation.
   */
  gateRef: string | null;
  createdAtMs: number;
}

/** Caller-supplied proposal creation. */
export interface ProposeInput {
  id: string;
  title: string;
  summary: string;
  proposerAgent: string;
  principal: string;
  createdAtMs?: number;
}

/** Caller-supplied transition. */
export interface ProposalTransitionInput {
  proposalId: string;
  toState: ProposalState;
  actor: string;
  gateRef?: string | null;
  atMs?: number;
}

/**
 * The state-machine rule, shared verbatim by both adapters.
 * Throws DataFoundationError — PROPOSAL_ILLEGAL_TRANSITION for a
 * move that is not exactly one step forward, PROPOSAL_GATE_MISSING
 * for a gated step without an actor + gate reference.
 */
export function assertProposalTransition(
  fromState: ProposalState,
  toState: ProposalState,
  actor: string,
  gateRef: string | null | undefined,
): void {
  const fromIdx = PROPOSAL_STATES.indexOf(fromState);
  const toIdx = PROPOSAL_STATES.indexOf(toState);
  if (fromIdx < 0 || toIdx !== fromIdx + 1) {
    throw new DataFoundationError(
      DataFoundationCode.PROPOSAL_ILLEGAL_TRANSITION,
      `Transition ${fromState} → ${toState} is not one step of the proposal machine.`,
      { fromState, toState },
    );
  }
  if (!actor || !gateRef) {
    throw new DataFoundationError(
      DataFoundationCode.PROPOSAL_GATE_MISSING,
      `Transition ${fromState} → ${toState} requires the gate recorded as data (actor + issue/PR gate reference).`,
      { fromState, toState },
    );
  }
}

/** The proposal-ledger store surface. */
export interface ProposalLedgerStore {
  /**
   * Create a proposal in state "proposed" plus its creation
   * transition. Replaying an existing id returns the existing
   * row unchanged (at-least-once safe) and adds no transition.
   */
  propose(input: ProposeInput): Promise<ProposalRow>;
  /**
   * Advance a proposal one gated step. Throws DataFoundationError
   * on an illegal step or a missing gate; throws a plain Error
   * naming the id when the proposal does not exist.
   */
  transition(
    input: ProposalTransitionInput,
  ): Promise<ProposalTransitionRow>;
  /** One proposal by id, or null. */
  getProposal(id: string): Promise<ProposalRow | null>;
  /** Proposals, optionally filtered to one state, newest first. */
  listProposals(state?: ProposalState): Promise<ProposalRow[]>;
  /** A proposal's full transition history, oldest first. */
  listTransitions(proposalId: string): Promise<ProposalTransitionRow[]>;
}
