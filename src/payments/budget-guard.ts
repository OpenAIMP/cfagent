/**
 * BudgetGuard: deterministic payment validator for A2A agent calls.
 *
 * Every agent-to-agent payment goes through check() before execution.
 * The guard enforces:
 *   - dailyCap:     max total spend per agent per day (cents)
 *   - perCallCap:   max spend per single call (cents)
 *   - allowlist:    operations permitted to spend at all
 *   - agentCaps:    per-agent overrides of the default caps
 *   - idempotency:  duplicate idempotency keys are rejected
 *
 * Deterministic: no LLM, no heuristics — pure rule evaluation.
 * Used by PaymentsAgent before any payment.process call.
 */

export interface BudgetConfig {
  /** Max total spend per agent per UTC day, in cents */
  dailyCapCents: number;
  /** Max spend per single call, in cents */
  perCallCapCents: number;
  /** Operations allowed to spend (empty = none allowed) */
  allowlist: string[];
  /** Per-agent cap overrides: agentId -> { dailyCapCents, perCallCapCents } */
  agentCaps: Record<string, { dailyCapCents?: number; perCallCapCents?: number }>;
}

export interface PaymentRequest {
  agentId: string;
  operation: string;
  amountCents: number;
  /** Client-supplied idempotency key; duplicates are rejected */
  idempotencyKey: string;
}

export interface BudgetVerdict {
  allowed: boolean;
  reason?: string;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyCapCents: 5000, // $50/day default
  perCallCapCents: 1000, // $10/call default
  allowlist: [],
  agentCaps: {},
};

export class BudgetGuard {
  private config: BudgetConfig;
  /** agentId -> date (YYYY-MM-DD) -> spent cents */
  private dailySpend: Map<string, Map<string, number>> = new Map();
  /** Seen idempotency keys */
  private seenKeys: Set<string> = new Set();

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config };
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private capsFor(agentId: string): { dailyCapCents: number; perCallCapCents: number } {
    const override = this.config.agentCaps[agentId] ?? {};
    return {
      dailyCapCents: override.dailyCapCents ?? this.config.dailyCapCents,
      perCallCapCents: override.perCallCapCents ?? this.config.perCallCapCents,
    };
  }

  /**
   * Validate a payment request against all budget rules.
   * On success the spend is recorded; on failure nothing changes.
   */
  check(req: PaymentRequest): BudgetVerdict {
    // 1. Idempotency — reject replays
    if (this.seenKeys.has(req.idempotencyKey)) {
      return { allowed: false, reason: "duplicate idempotency key" };
    }

    // 2. Allowlist — operation must be permitted to spend
    if (!this.config.allowlist.includes(req.operation)) {
      return { allowed: false, reason: `operation not allowlisted: ${req.operation}` };
    }

    const caps = this.capsFor(req.agentId);

    // 3. Per-call cap
    if (req.amountCents > caps.perCallCapCents) {
      return {
        allowed: false,
        reason: `per-call cap exceeded: ${req.amountCents} > ${caps.perCallCapCents}`,
      };
    }

    // 4. Daily cap
    const today = this.todayKey();
    const agentSpend = this.dailySpend.get(req.agentId)?.get(today) ?? 0;
    if (agentSpend + req.amountCents > caps.dailyCapCents) {
      return {
        allowed: false,
        reason: `daily cap exceeded: ${agentSpend + req.amountCents} > ${caps.dailyCapCents}`,
      };
    }

    // All checks pass — record the spend
    this.seenKeys.add(req.idempotencyKey);
    if (!this.dailySpend.has(req.agentId)) {
      this.dailySpend.set(req.agentId, new Map());
    }
    this.dailySpend.get(req.agentId)!.set(today, agentSpend + req.amountCents);

    return { allowed: true };
  }

  /** Current spend for an agent today, in cents. */
  spentToday(agentId: string): number {
    return this.dailySpend.get(agentId)?.get(this.todayKey()) ?? 0;
  }

  /** Update the budget configuration. */
  updateConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
