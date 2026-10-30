/**
 * Issue #2357 (#1976 step 4b) — the in-memory implementation
 * of the champion/challenger port, with semantics identical
 * to the DO-SQLite adapter (tenant-scoped reads, approvals
 * and promotion records append-only and oldest-first, the
 * active set read as the highest version).
 */
import type {
  ActiveSetWrite,
  ActiveStrategySet,
  Challenger,
  ChallengerApprovalRecord,
  ChallengerApprovalWrite,
  ChallengerEvaluation,
  ChallengerStatus,
  ChallengerStore,
  PromotionRecord,
  PromotionRecordWrite,
} from "./challengerPorts";

interface ApprovalRow extends ChallengerApprovalWrite {}
interface PromotionRow extends PromotionRecordWrite {}
interface ActiveRow extends ActiveSetWrite {}

export class InMemoryChallengerStore implements ChallengerStore {
  private challengers = new Map<string, Challenger>();
  private approvals: ApprovalRow[] = [];
  private promotions: PromotionRow[] = [];
  private activeSets: ActiveRow[] = [];

  ensureTables(): void {
    // In-memory: nothing to ensure.
  }

  getChallenger(userLogin: string, id: string): Challenger | null {
    const found = this.challengers.get(id);
    if (!found || found.userLogin !== userLogin) return null;
    return structuredClone(found);
  }

  listChallengers(userLogin: string): Challenger[] {
    return [...this.challengers.values()]
      .filter((c) => c.userLogin === userLogin)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, 200)
      .map((c) => structuredClone(c));
  }

  insertChallenger(challenger: Challenger): void {
    if (this.challengers.has(challenger.id)) {
      throw new Error(`challenger ${challenger.id} already exists (insert-or-throw)`);
    }
    this.challengers.set(challenger.id, structuredClone(challenger));
  }

  setChallengerStatus(
    challenger: Challenger,
    status: ChallengerStatus,
    evaluation: ChallengerEvaluation | null | undefined,
    now: Date,
  ): void {
    const found = this.challengers.get(challenger.id);
    if (!found || found.userLogin !== challenger.userLogin) return;
    found.status = status;
    found.evaluation =
      evaluation === undefined ? found.evaluation : evaluation;
    void now;
  }

  insertApproval(write: ChallengerApprovalWrite): void {
    this.approvals.push({ ...write });
  }

  getApprovedApprover(userLogin: string, challengerId: string): string | null {
    const rows = this.approvals.filter(
      (a) => a.challengerId === challengerId && a.userLogin === userLogin && a.decision === "approved",
    );
    if (!rows.length) return null;
    return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0].approver;
  }

  listApprovals(userLogin: string, challengerId: string): ChallengerApprovalRecord[] {
    return this.approvals
      .filter((a) => a.challengerId === challengerId && a.userLogin === userLogin)
      .map((a) => ({
        id: a.id,
        challengerId: a.challengerId,
        approver: a.approver,
        decision: a.decision,
        createdAt: a.createdAt,
      }));
  }

  insertPromotion(write: PromotionRecordWrite): void {
    this.promotions.push(structuredClone(write));
  }

  listPromotionRecords(userLogin: string, challengerId: string): PromotionRecord[] {
    return this.promotions
      .filter((p) => p.challengerId === challengerId && p.userLogin === userLogin)
      .map((p) => ({
        action: p.action,
        prior: p.prior ?? null,
        applied: p.applied ?? null,
        actor: p.actor,
        reason: p.reason,
      }));
  }

  getActiveStrategySet(userLogin: string): ActiveStrategySet | null {
    const rows = this.activeSets.filter((a) => a.userLogin === userLogin);
    if (!rows.length) return null;
    const top = [...rows].sort((a, b) => b.version - a.version)[0];
    return {
      strategies: [...top.strategies],
      version: top.version,
      challengerId: top.challengerId,
      createdAt: top.createdAt,
    };
  }

  insertActiveSet(write: ActiveSetWrite): void {
    this.activeSets.push(structuredClone(write));
  }
}
