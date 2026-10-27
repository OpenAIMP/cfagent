/**
 * PaymentWorkflow — the durable payment wrapper for screener runs
 * (Goal 1 Phase 2, #2014, draft).
 *
 * Follows the repo pattern exactly (ADR 0004 W13):
 *   - extends ThinkWorkflow, NOT WorkflowEntrypoint
 *   - NO new payment agent. PaymentsAgent already exists
 *     (src/agents/payments-agent.ts, #1957, PortThink). This workflow
 *     does not create, extend, or replace it.
 *   - Agent-type parameter: `any` in this draft, following the
 *     ScreenerScreenWorkflow precedent, where tracking goes through
 *     D1 projection rows + instance status instead of the SDK's agent
 *     tracking. The open alternative is ThinkWorkflow<PaymentsAgent, ...>
 *     — justified ONLY if the workflow actually uses this.agent
 *     (SDK agent binding + tracking). This draft does not use
 *     this.agent; it delegates to the flow core, so `any` is the
 *     honest choice today. Changing it later is a type + binding
 *     change, not a redesign, and needs CTO review.
 *   - OrchestratorAgent is a CALLER, not a base class. Like screener
 *     runs, the orchestrator triggers/creates this workflow instance
 *     and owns the store and deliver seams; this class is not an
 *     OrchestratorAgent subclass and does not extend it.
 *   - Money ops are step.do(), the human gate is waitForEvent
 *     approval before capture (backed by the #1262 approval engine
 *     in production wiring), never step.prompt().
 *   - Thin adapter: run() validates the payload, builds deps from env,
 *     and delegates to runPaymentWorkflowFlow in paymentWorkflowFlow.ts
 *
 * DRAFT LIMITS — read before wiring:
 *   - No wrangler binding is added in this draft, no route calls this
 *     workflow, and no flag enables it. Adding it to wrangler.toml and
 *     calling it from a route is a separate, reviewed wiring step.
 *   - The account here is a snapshot carried in the payload for this
 *     draft only. A real account store (subscription/credits, #2015/#1623)
 *     must replace it before any production use; a snapshot must never
 *     be trusted after a 24h payment wait without re-reading the store.
 *   - The gate ledger in this draft is in-memory (cfpayMonetization.ts).
 *     Durable ledger persistence to mas_transactions is Phase 4 (#2019).
 *     Do not rely on this draft for production money records.
 *   - Params carry ids only — never credentials, never secrets, never
 *     a card, never a cfpay key. The cfpay key is read from env here,
 *     never from params, never logged.
 */

import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import {
  CfPayMonetizationGate,
  type CommercialAccount,
  type ScreenerFamily,
} from "../services/cfpayMonetization";
import {
  PAYMENT_VERIFICATION_TIMEOUT,
  runPaymentWorkflowFlow,
  type PaymentWorkflowOutcome,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "./paymentWorkflowFlow";
import { getCfpayConfig, cfpayA2AOperation } from "../services/cfpayA2A";

export type { PaymentWorkflowParams, PaymentWorkflowOutcome };

/** Payload for the workflow: ids + a draft-only account snapshot. */
export interface PaymentWorkflowEventParams extends PaymentWorkflowParams {
  account: CommercialAccount;
}

export class PaymentWorkflow extends ThinkWorkflow<
  any,
  PaymentWorkflowEventParams,
  DefaultProgress,
  Env
> {
  async run(
    event: WorkflowEvent<PaymentWorkflowEventParams>,
    step: WorkflowStep,
  ): Promise<PaymentWorkflowOutcome> {
    const p = event.payload;
    // Issue #1185 discipline: no default identity, fail closed.
    if (!p.userId || !p.email || !p.tenantId) {
      throw new Error(
        "Payment workflow payload is missing verified userId, email, or tenantId (no default identity).",
      );
    }
    if (p.account.tenantId && p.tenantId !== p.account.tenantId) {
      throw new Error("Tenant mismatch: run tenant must equal the verified account tenant.");
    }

    const cfpay = getCfpayConfig(this.env as unknown as Record<string, unknown>);
    if (!cfpay && p.trigger !== "scheduled") {
      // A checkout path needs cfpay; coverage-only scheduled runs do not.
      // Fail closed rather than starting a screener for free at scale.
      throw new Error("Payment workflow: cfpay is not configured (CFPAY_URL / token missing).");
    }
    const gate = new CfPayMonetizationGate(
      {
        createCheckout: async (input) => {
          if (!cfpay) throw new Error("cfpay not configured");
          return cfpayA2AOperation(cfpay, "/a2a/payments", "checkout.create", {
            requestId: input.requestId,
            email: input.email,
            request: input.request,
          });
        },
        checkoutStatus: async (requestId) => {
          if (!cfpay) return { status: "unknown" };
          const res = await cfpayA2AOperation(cfpay, "/a2a/payments", "checkout.status", { requestId });
          const data = res.data as { status?: string; state?: string; paid?: boolean } | undefined;
          return { status: data?.status, state: data?.state, paid: data?.paid };
        },
      },
      {
        monetizationEnabled: (this.env as unknown as Record<string, unknown>).MONETIZATION_ENABLED === "true",
        network: ((this.env as unknown as Record<string, unknown>).MONETIZATION_NETWORK as string) ?? "base-sepolia",
      },
    );

    const deps = {
      gate,
      account: p.account,
      startScreener: async (params: PaymentWorkflowParams) => {
        // Draft, deliberately NOT a fake screener start: the
        // OrchestratorAgent (caller) owns screener start through the
        // existing screener workflow port (WorkflowJobCommand, idempotent
        // start via cfWorkflowAdapter). Inventing a command shape here
        // would be a wiring lie. The wiring step replaces this dep with
        // the orchestrator's real start, and until then a paid run
        // fails loudly here instead of claiming a screener started.
        throw new Error(
          `Screener start not yet wired for run ${params.runRequestId}: OrchestratorAgent start via the screener workflow port is the wiring step, not this draft.`,
        );
      },
      recordEvent: async (e: { runRequestId: string; tenantId: string; type: string }) => {
        // Draft: audit persistence is Phase 4 (#2019, mas_events). Until
        // then, events are carried on the outcome only — never claimed
        // as a durable audit record.
        void e;
      },
      issueFailureCredit: async (runRequestId: string) => {
        // Draft: failure-credit issuance is Phase 4 (#2019). Until then
        // this throws, so a screener failure after payment is visible
        // instead of silently claiming a credit that was never issued.
        throw new Error(`Failure credit not yet implemented for run ${runRequestId} (Phase 4, #2019).`);
      },
    };

    return runPaymentWorkflowFlow(
      {
        runRequestId: p.runRequestId,
        family: p.family as ScreenerFamily,
        trigger: p.trigger,
        scheduleKind: p.scheduleKind,
        authorizedAtSubmission: p.authorizedAtSubmission,
        tenantId: p.tenantId,
        userId: p.userId,
        email: p.email,
      },
      deps,
      step as unknown as PaymentWorkflowStep,
    );
  }
}

export { PAYMENT_VERIFICATION_TIMEOUT };
