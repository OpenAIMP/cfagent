/**
 * CrossDomainSagaWorkflow — the durable cross-domain saga wrapper
 * for paid screener runs (issue #2041, S1).
 *
 * Follows the repo pattern exactly (ADR 0004 W13):
 *   - extends ThinkWorkflow, NOT WorkflowEntrypoint
 *   - agent-type parameter: `any`, following the ScreenerScreenWorkflow
 *     and PaymentWorkflow precedent. No Think agent exists for the
 *     saga in S1 (Q8 — a saga DO agent + A2A card is an open
 *     question); this class never uses agent tracking, so `any`
 *     is the honest choice today.
 *   - Thin adapter: run() validates the payload, builds deps from
 *     env, and delegates to runSagaWorkflowFlow in
 *     sagaWorkflowFlow.ts. The adapter is covered by typecheck,
 *     not by unit tests (same stance as the payment workflow).
 *
 * S1 scope ONLY: Leg 0 (payment child) + Leg 1 (observe the paid
 * screen to terminal). No journey gate (S2), no mid-run failure
 * credit (S3), no trading leg (S4), no entry route (S4). No route
 * calls this workflow yet by default: the entry route is S4, and
 * a route must NOT start a saga for free when monetization is on.
 *
 * S1 defaults (not rulings): goal-only first family (Q5 default);
 * mainnet excluded — the saga never reads MONETIZATION_NETWORK
 * and never overrides the payment leg's network (Q4 open);
 * workflow-only identity, no DO agent (Q8 open).
 *
 * Audit: the recordAudit dep posts saga rows to POST /api/audit/event
 * through the SEARCH_AGENT stub (the same endpoint the payment
 * workflow's recordEvent uses), with agent "saga" for provenance.
 * It is the saga's OWN forwarder — recordCfpayAuditEvent is NOT
 * reused: it hardcodes agent "payments" and the cfpay payload
 * shape. The forwarder THROWS on any non-2xx response, on a
 * missing SEARCH_AGENT binding, or on a missing service identity,
 * so a failed audit write fails the step (durably retried) instead
 * of letting the saga complete with an unrecorded transition.
 * That is the Q7 S2 blocking shape as far as it is reachable
 * from a workflow step — see the reachability note in
 * sagaWorkflowFlow.ts for what is NOT reachable (direct ORM
 * access from the workflow runtime).
 *
 * Params carry ids + caller-supplied identity + the caller-built
 * screener command — never credentials, never secrets, never a
 * card, never a price. The saga never invents a screener command
 * or an account.
 */

import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import { getServiceUserLogin, SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import type { WorkflowBindingLike } from "./cfWorkflowAdapter";
import { sagaLegPort, type SagaLegBinding } from "./sagaLegPort";
import {
  runSagaWorkflowFlow,
  type SagaAuditEvent,
  type SagaParams,
  type SagaWorkflowStep,
} from "./sagaWorkflowFlow";

/** Wrangler binding name for the saga workflow (wrangler.jsonc). */
export const SAGA_WORKFLOW_BINDING = "SAGA_WORKFLOW";

interface SagaAuditStub {
  fetch: (req: Request) => Promise<Response>;
}

function sagaAuditStub(env: Env): SagaAuditStub {
  const ns = (env as unknown as Record<string, unknown>)?.SEARCH_AGENT as
    | { idFromName: (name: string) => unknown; get: (id: unknown) => SagaAuditStub }
    | undefined;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    throw new Error(
      "saga audit unavailable: SEARCH_AGENT (the mas_events audit owner) is not bound",
    );
  }
  return ns.get(ns.idFromName(SHARED_ORCHESTRATOR_INSTANCE));
}

/**
 * Blocking saga audit forwarder: POSTs one saga row and throws
 * unless the endpoint stored it. The endpoint funnels through
 * the single owner recordAudit() into the chained mas_events
 * repo, so a row that lands is hash-linked.
 */
async function recordSagaAudit(env: Env, event: SagaAuditEvent): Promise<void> {
  const stub = sagaAuditStub(env);
  // Issue #1185: the forward's identity is the configured service
  // identity — the instance constant above is only the address.
  const serviceLogin = getServiceUserLogin(env);
  if (!serviceLogin) {
    throw new Error(
      "saga audit unavailable: no service identity configured (SERVICE_USER_LOGIN) to forward under",
    );
  }
  let res: Response;
  try {
    res = await stub.fetch(
      new Request(new URL("/api/audit/event", "https://agent.internal"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-login": serviceLogin,
        },
        body: JSON.stringify({
          type: event.type,
          agent: "saga",
          payload: {
            sagaId: event.sagaId,
            runRequestId: event.runRequestId,
            tenantId: event.tenantId,
            userLogin: event.userLogin,
            family: event.family,
            ...(event.rail ? { rail: event.rail } : {}),
            ...(event.leg ? { leg: event.leg } : {}),
            ...(event.outcomeCode ? { outcomeCode: event.outcomeCode } : {}),
            ...(event.screenerWorkflowId ? { screenerWorkflowId: event.screenerWorkflowId } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
            ...(event.existing !== undefined ? { existing: event.existing } : {}),
          },
        }),
      }),
    );
  } catch (err) {
    throw new Error(
      `saga audit unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `saga audit write rejected by /api/audit/event (HTTP ${res.status}); refusing to continue unrecorded`,
    );
  }
}

function asWorkflowBinding(value: unknown): WorkflowBindingLike | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { create?: unknown }).create === "function" &&
    typeof (value as { get?: unknown }).get === "function"
  ) {
    return value as WorkflowBindingLike;
  }
  return null;
}

/** Adapt the provider step to the flow's minimal step surface. */
function adaptStep(step: WorkflowStep): SagaWorkflowStep {
  const s = step as unknown as {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: string): Promise<void>;
  };
  return {
    do: (name, fn) => s.do(name, fn),
    // Provider sleep takes whole-second strings (no ms
    // label); ceiling to seconds. Poll granularity only —
    // deadlines are enforced by the flow's clock checks.
    sleep: (name, ms) => s.sleep(name, `${Math.max(1, Math.ceil(ms / 1000))} seconds`),
  };
}

export class CrossDomainSagaWorkflow extends ThinkWorkflow<any, SagaParams, DefaultProgress, Env> {
  async run(
    event: WorkflowEvent<SagaParams>,
    step: WorkflowStep,
  ): Promise<ReturnType<typeof runSagaWorkflowFlow>> {
    const params = event.payload;
    // Issue #1185 discipline: no default identity, fail closed.
    if (!params?.sagaId || !params?.runRequestId) {
      throw new Error("Saga payload is missing sagaId or runRequestId.");
    }
    if (!params.userLogin || !params.userId || !params.email || !params.tenantId) {
      throw new Error(
        "Saga payload is missing verified userLogin, userId, email, or tenantId (no default identity).",
      );
    }
    if (params.account?.tenantId && params.tenantId !== params.account.tenantId) {
      throw new Error("Tenant mismatch: saga tenant must equal the verified account tenant.");
    }
    if (params.family !== "goal") {
      throw new Error(
        `Saga S1 is goal-only (Q5 default); family "${String(params.family)}" is not accepted yet.`,
      );
    }
    if (!params.screenerCommand || typeof params.screenerCommand.jobId !== "string" || !params.screenerCommand.jobId) {
      throw new Error("Saga payload is missing a valid screenerCommand (jobId required).");
    }

    const bindings: Partial<Record<SagaLegBinding, WorkflowBindingLike | undefined>> = {};
    const paymentBinding = asWorkflowBinding((this.env as Env).PAYMENT_WORKFLOW);
    if (paymentBinding) bindings["PAYMENT_WORKFLOW"] = paymentBinding;
    const screenerBinding = asWorkflowBinding((this.env as Env).SCREENER_WORKFLOW);
    if (screenerBinding) bindings["SCREENER_WORKFLOW"] = screenerBinding;
    const tradeBinding = asWorkflowBinding((this.env as Env).TRADE_WORKFLOW);
    if (tradeBinding) bindings["TRADE_WORKFLOW"] = tradeBinding;

    const deps = {
      legPort: sagaLegPort(bindings, params.sagaId),
      recordAudit: (auditEvent: SagaAuditEvent) => recordSagaAudit(this.env as Env, auditEvent),
      nowMs: () => Date.now(),
    };
    return runSagaWorkflowFlow(params, deps, adaptStep(step));
  }
}
