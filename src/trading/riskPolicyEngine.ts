/**
 * RiskPolicyEngine (issue #79).
 *
 * The policy envelope is real: limits are defined here — the single source
 * of truth shared with the server and the UI — and every autonomous action
 * is checked against them before it runs.
 *
 * Four limits:
 *  1. maxPositionNotional — no single position may exceed this notional.
 *  2. maxDailyLoss — cumulative realized loss per day may not exceed this.
 *  3. maxPortfolioHeat — total at-risk capital across open positions.
 *  4. allowedActions — the action allowlist (anything else is denied).
 *
 * The engine is pure: check() takes the proposed action + current state and
 * returns a verdict. It never places orders itself.
 */

export interface PolicyLimits {
  maxPositionNotional: number;
  maxDailyLoss: number;
  maxPortfolioHeat: number;
  allowedActions: string[];
}

export interface PolicyState {
  /** Realized P&L today (negative = loss). */
  dailyRealizedPnl: number;
  /** Current at-risk capital across open positions. */
  currentHeat: number;
}

export interface ProposedAction {
  type: string;
  /** Notional of the proposed position (0 for non-position actions). */
  notional?: number;
  /** Additional heat this action would add (0 if none). */
  addedHeat?: number;
}

export interface PolicyVerdict {
  passed: boolean;
  /** Machine-readable rule ids that were evaluated. */
  rules: string[];
  /** Human-readable reasons for a denial (empty when passed). */
  reasons: string[];
}

export const DEFAULT_POLICY_LIMITS: PolicyLimits = {
  maxPositionNotional: 200_000,
  maxDailyLoss: 50_000,
  maxPortfolioHeat: 2_000_000,
  allowedActions: [
    "screen",
    "analyze",
    "draft_order",
    "policy_check",
    "risk_guardrail",
    "rebalance_preview",
  ],
};

export class RiskPolicyEngine {
  constructor(private limits: PolicyLimits = DEFAULT_POLICY_LIMITS) {}

  getLimits(): PolicyLimits {
    return { ...this.limits, allowedActions: [...this.limits.allowedActions] };
  }

  check(action: ProposedAction, state: PolicyState): PolicyVerdict {
    const rules: string[] = [];
    const reasons: string[] = [];

    // Rule 1: action allowlist.
    rules.push("action-allowlist");
    if (!this.limits.allowedActions.includes(action.type)) {
      reasons.push(`Action '${action.type}' is not in the policy allowlist.`);
    }

    // Rule 2: per-position notional cap.
    rules.push("position-notional");
    const notional = action.notional ?? 0;
    if (notional > this.limits.maxPositionNotional) {
      reasons.push(
        `Position notional $${notional.toLocaleString()} exceeds the $${this.limits.maxPositionNotional.toLocaleString()} cap.`
      );
    }

    // Rule 3: daily loss circuit breaker.
    rules.push("daily-loss");
    if (state.dailyRealizedPnl < -this.limits.maxDailyLoss) {
      reasons.push(
        `Daily loss $${Math.abs(state.dailyRealizedPnl).toLocaleString()} exceeds the $${this.limits.maxDailyLoss.toLocaleString()} circuit breaker — trading halted.`
      );
    }

    // Rule 4: portfolio heat cap.
    rules.push("portfolio-heat");
    const projectedHeat = state.currentHeat + (action.addedHeat ?? 0);
    if (projectedHeat > this.limits.maxPortfolioHeat) {
      reasons.push(
        `Projected heat $${projectedHeat.toLocaleString()} exceeds the $${this.limits.maxPortfolioHeat.toLocaleString()} cap.`
      );
    }

    return { passed: reasons.length === 0, rules, reasons };
  }
}
