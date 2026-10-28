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
 * OPERATIONAL STATUS (2026-10-27, #2014 wiring):
 *   - Wrangler binding PAYMENT_WORKFLOW + Env type are added in this
 *     PR (wrangler.jsonc, src/types.ts). No route calls this workflow
 *     yet by default: the caller seam is paymentWorkflowSubmission.ts,
 *     and the route that adopts it is a reviewed wiring step — a
 *     route must NOT start a screener for free when monetization is
 *     on and the payment workflow cannot start.
 *   - Flag: Flagship feature flag "monetization" (#2043), default OFF,
 *     fail-closed. When the FLAGS binding is present, Flagship is
 *     the source of truth: the flag must exist in the Flagship
 *     dashboard with key "monetization", and turning it ON/OFF
 *     there turns monetization ON/OFF — no code change, no env
 *     change. When FLAGS is absent, the env adapter evaluates it
 *     from FEATURE_FLAGS bulk JSON, FEATURE_MONETIZATION, or the
 *     legacy MONETIZATION_ENABLED var, and is otherwise OFF.
 *     Flag OFF in PROD would mean free runs at scale — a revenue
 *     risk, not a charge risk — so PROD enablement needs COO/CTO
 *     sign-off and explicit staging-only enablement first.
 *   - Account: caller-supplied pay-per-use identity until the
 *     subscription/credits store exists (#2015/#1623). Recurring
 *     runs stay coverage_required until that store exists.
 *   - Ledger: gate ledger is in-memory in this draft; durable cfpay
 *     ledger rows in mas_transactions are Phase 4 (#2019) — see
 *     recordEvent above for why recordLedgerPayment is NOT reused
 *     (it builds x402 PaymentsAgent-origin rows only).
 *   - Failure credit: still throws (Phase 4). A screener failure
 *     after payment is loud, never a silent credit claim.
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
import { createFeatureFlagPort } from "../features/createFeatureFlagPort";
import { consumeStoreCoverage } from "../services/commercialAccounts";
import { createWorkflowPorts, type WorkflowEnv } from "./createWorkflowPorts";
import type { WorkflowJobCommand } from "./workflowPorts";

export type { PaymentWorkflowParams, PaymentWorkflowOutcome };

/** Binding name for the payment workflow (wrangler.jsonc). */
export const PAYMENT_WORKFLOW_BINDING = "PAYMENT_WORKFLOW" as const;

/**
 * Payload for the workflow: ids + caller-supplied account + the
 * caller-built screener command. The account is the caller's verified
 * identity for pay-per-use (tier PayPerUse, 0 credits, 0 included
 * runs) until the subscription/credits store exists (#2015/#1623);
 * a Subscribed account must come from that store, not from a caller
 * snapshot, and recurring runs stay coverage_required until it does.
 * The screener command is built by the caller (route / schedule
 * service, e.g. buildGoalScreenCommand) — never invented here.
 */
export interface PaymentWorkflowEventParams extends PaymentWorkflowParams {
  account: CommercialAccount;
  screenerCommand: WorkflowJobCommand;
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
        // Flagship feature flag "monetization" (#2043): OFF = free
        // path (no checkout), ON = payment gate. Fail-closed: an
        // unknown flag, a missing Flagship binding value, or a
        // Flagship error all evaluate to false in the port.
        monetizationEnabled: await createFeatureFlagPort(this.env).isEnabled(
          "monetization",
          { userId: p.userId, userLogin: p.userId },
        ),
        network: ((this.env as unknown as Record<string, unknown>).MONETIZATION_NETWORK as string) ?? "base-sepolia",
      },
    );

    const deps = {
      gate,
      account: p.account,
      startScreener: async (params: PaymentWorkflowParams) => {
        // Operational: the caller-supplied screener command goes,
        // unchanged, through the existing screener workflow port
        // (CfWorkflowAdapter, idempotent start by jobId). If the port
        // is unavailable (SCREENER_WORKFLOW or AGENT_DB unbound),
        // fail LOUD — never fall back to a direct screen after
        // payment, which would lose the workflow audit trail.
        // The OrchestratorAgent remains the caller that built this
        // command and owns the store/deliver seams downstream.
        const ports = createWorkflowPorts(this.env as unknown as WorkflowEnv);
        if (!ports) {
          throw new Error(
            `Screener workflow port unavailable for run ${params.runRequestId}: SCREENER_WORKFLOW or AGENT_DB is unbound.`,
          );
        }
        const handle = await ports.start(p.screenerCommand);
        return { workflowId: handle.workflowId };
      },
      recordEvent: async (e: { runRequestId: string; tenantId: string; type: string }) => {
        // Operational audit, honestly scoped: Workers Logs (the
        // repo's observability pipeline, enabled in wrangler.jsonc),
        // NOT mas_events and NOT mas_transactions. A durable cfpay
        // ledger row (gateway stripe, action charge, session
        // screener-payment:<runId>) is Phase 4 (#2019): the existing
        // recordLedgerPayment route builds PaymentsAgent-origin
        // x402 rows only, and reusing it for cfpay would mislabel
        // gateway and session. Until Phase 4 lands, the cfpay
        // dashboard ledger is the cross-check, and this log + the
        // workflow outcome are the in-repo record — never claimed
        // as mas_transactions.
        console.log(`[payment-workflow] ${e.type} run=${e.runRequestId} tenant=${e.tenantId}`);
      },
      issueFailureCredit: async (runRequestId: string) => {
        // Draft: failure-credit issuance is Phase 4 (#2019). Until then
        // this throws, so a screener failure after payment is visible
        // instead of silently claiming a credit that was never issued.
        throw new Error(`Failure credit not yet implemented for run ${runRequestId} (Phase 4, #2019).`);
      },
      consumeCoverage: async (use: { userId: string; paidVia: string; priceUSD: number }) => {
        // Issue #2015: consume the coverage in the account store.
        // Best-effort with loud logging (see the flow dep doc): a
        // store blip must not deny a run the user already covered.
        // free_flag_off / already_paid consume nothing.
        try {
          if (use.paidVia === "subscription_included") {
            await consumeStoreCoverage(this.env, use.userId, "included");
          } else if (use.paidVia === "credits") {
            await consumeStoreCoverage(this.env, use.userId, "credits", use.priceUSD);
          }
        } catch (err) {
          console.error(
            `[payment-workflow] coverage consumption failed for user ${use.userId} paidVia=${use.paidVia} — run proceeds, balance must be reconciled by an operator:`,
            err,
          );
        }
      },
    };

    if (!p.screenerCommand || typeof p.screenerCommand.jobId !== "string") {
      throw new Error("Payment workflow payload is missing a valid screenerCommand (jobId required).");
    }

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
        screenerCommand: p.screenerCommand,
      },
      deps,
      step as unknown as PaymentWorkflowStep,
    );
  }
}

export { PAYMENT_VERIFICATION_TIMEOUT };
