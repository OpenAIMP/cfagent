/**
 * Issue #2202 — in-memory billing-policy store (test
 * double with the same port semantics as the D1 adapter).
 * It is NOT a production store: it exists so the policy
 * contract is testable without any store at all. Missing
 * rows read as seeded defaults, exactly like the D1
 * adapter's merge; an invalid stored value throws.
 */
import {
  assertBillingPolicy,
  PROPOSED_SEED_BILLING_POLICY,
  type BillingPolicy,
  type BillingPolicyStore,
} from "./billingPolicyPorts";

export class InMemoryBillingPolicyAdapter implements BillingPolicyStore {
  private values: BillingPolicy = { ...PROPOSED_SEED_BILLING_POLICY };

  async getPolicy(): Promise<BillingPolicy> {
    return assertBillingPolicy({ ...this.values });
  }

  async updatePolicy(partial: Partial<BillingPolicy>): Promise<BillingPolicy> {
    const merged = assertBillingPolicy({ ...this.values, ...partial });
    this.values = merged;
    return { ...merged };
  }
}
