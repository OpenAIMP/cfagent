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
 *
 * Issue #161: check() is PURE — it validates without recording. The caller
 * must invoke record() after a successful check (and after payment
 * verification) to persist the spend. State is serializable so the owning
 * Durable Object can persist it across restarts; an in-memory-only guard
 * would lose daily spend and idempotency keys on eviction.
 *
 * Issue #896: the guard's state is no longer persisted as a blob by the
 * PaymentsAgent. PaymentsAgent derives it from mas_transactions (the
 * ledger of record) via BudgetGuard.restore() on every check/record —
 * see deriveBudgetGuardState in src/payments/ledger.ts — so guard truth
 * and ledger truth cannot diverge. serialize()/restore() remain the
 * transport shape for that derived state.
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

/** Serializable guard state for Durable Object storage. */
export interface BudgetGuardState {
  /** [agentId, date YYYY-MM-DD, spent cents] — only the current day is kept */
  dailySpend: Array<[string, string, number]>;
  /** Seen idempotency keys, oldest-first, capped */
  seenKeys: string[];
}

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyCapCents: 5000, // $50/day default
  perCallCapCents: 1000, // $10/call default
  allowlist: [],
  agentCaps: {},
};

/** Max idempotency keys retained — bounds storage growth. */
const MAX_SEEN_KEYS = 2000;

export class BudgetGuard {
  private config: BudgetConfig;
  /** agentId -> date (YYYY-MM-DD) -> spent cents */
  private dailySpend: Map<string, Map<string, number>> = new Map();
  /** Seen idempotency keys (insertion-ordered) */
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
   * PURE: on success nothing is recorded — call record() to persist the spend.
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

    return { allowed: true };
  }

  /**
   * Record a validated spend. Call only after check() returned allowed AND
   * payment verification succeeded — never for a mere pre-flight check.
   */
  record(req: PaymentRequest): void {
    this.seenKeys.add(req.idempotencyKey);
    // Bound growth: drop oldest keys first (Sets preserve insertion order).
    if (this.seenKeys.size > MAX_SEEN_KEYS) {
      const excess = this.seenKeys.size - MAX_SEEN_KEYS;
      const it = this.seenKeys.values();
      for (let i = 0; i < excess; i++) {
        const oldest = it.next().value;
        if (oldest !== undefined) this.seenKeys.delete(oldest);
      }
    }
    const today = this.todayKey();
    if (!this.dailySpend.has(req.agentId)) {
      this.dailySpend.set(req.agentId, new Map());
    }
    const byDate = this.dailySpend.get(req.agentId)!;
    byDate.set(today, (byDate.get(today) ?? 0) + req.amountCents);
  }

  /** Current spend for an agent today, in cents. */
  spentToday(agentId: string): number {
    return this.dailySpend.get(agentId)?.get(this.todayKey()) ?? 0;
  }

  /** Update the budget configuration. */
  updateConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Serialize state for Durable Object storage. Only today's spend is kept
   * (older dates can never affect a future check); keys are capped.
   */
  serialize(): BudgetGuardState {
    const today = this.todayKey();
    const dailySpend: Array<[string, string, number]> = [];
    for (const [agentId, byDate] of this.dailySpend) {
      const cents = byDate.get(today) ?? 0;
      if (cents > 0) dailySpend.push([agentId, today, cents]);
    }
    return {
      dailySpend,
      seenKeys: [...this.seenKeys].slice(-MAX_SEEN_KEYS),
    };
  }

  /** Restore a guard from serialized state. */
  static restore(config: Partial<BudgetConfig>, state: BudgetGuardState | null | undefined): BudgetGuard {
    const guard = new BudgetGuard(config);
    if (!state) return guard;
    const today = guard.todayKey();
    for (const [agentId, date, cents] of state.dailySpend ?? []) {
      if (date !== today || typeof cents !== "number" || cents <= 0) continue;
      if (!guard.dailySpend.has(agentId)) guard.dailySpend.set(agentId, new Map());
      guard.dailySpend.get(agentId)!.set(date, cents);
    }
    for (const key of state.seenKeys ?? []) {
      if (typeof key === "string" && key.length > 0) guard.seenKeys.add(key);
    }
    // Enforce the cap on restore as well.
    while (guard.seenKeys.size > MAX_SEEN_KEYS) {
      const oldest = guard.seenKeys.values().next().value;
      if (oldest === undefined) break;
      guard.seenKeys.delete(oldest);
    }
    return guard;
  }
}
