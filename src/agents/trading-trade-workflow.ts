/**
 * TradingTradeWorkflow — the durable approval wrapper for TradingAgent
 * order proposals (issue #291, slice T3b).
 *
 * The cfpay TradeWorkflow shape, verbatim in spirit:
 *   proposal (a previewed draft, by id) -> wait for an approval event
 *   (24h) -> verify the approver (the settle core refuses anonymous
 *   decisions) -> claim-then-execute through the platform's
 *   executeOrder, which re-validates the draft state.
 *
 * Params carry ids only — never credentials (cfpay rule). The workflow
 * holds no broker state of its own; settling delegates to
 * settleTradingOrder, the same core the synchronous approval door uses,
 * so both paths enforce identical validation.
 *
 * The class is a thin adapter: run() extracts the params and delegates
 * to runTradeApprovalFlow, which is unit-testable with a fake step.
 */

import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import { getTradingAgentConfig } from "../config/tradingAgentConfig";
import {
  settleTradingOrder,
  type TradeApprovalDecision,
  type TradeApprovalParams,
  type TradingAgent,
} from "./trading-agent";

/** How long a proposal waits for its decision before lapsing. */
export const TRADE_APPROVAL_TIMEOUT = "24 hours";

/** Minimal structural step surface the flow needs (fakeable in tests). */
export interface TradeApprovalStep {
  waitForEvent(
    name: string,
    options: { type: string; timeout?: string },
  ): Promise<{ payload: TradeApprovalDecision }>;
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export type TradeApprovalOutcome =
  | { status: "settled"; orderId: string; decision: "approved" | "rejected"; result: unknown }
  | { status: "expired"; orderId: string };

/**
 * The flow: wait for the decision event, then settle exactly once
 * inside a durable step. Any failure to obtain a decision (timeout,
 * termination) ends the flow as expired and settles NOTHING — a trade
 * is placed only from an explicit, authorized decision event.
 */
export async function runTradeApprovalFlow(
  env: Env,
  params: TradeApprovalParams,
  step: TradeApprovalStep,
): Promise<TradeApprovalOutcome> {
  let decision: TradeApprovalDecision;
  try {
    const event = await step.waitForEvent("await-approval", {
      type: "approval",
      timeout: TRADE_APPROVAL_TIMEOUT,
    });
    decision = event.payload;
  } catch {
    return { status: "expired", orderId: params.orderId };
  }
  const result = await step.do("settle-trade", () =>
    settleTradingOrder(
      env,
      getTradingAgentConfig(env as unknown as Record<string, unknown>),
      {
        provider: params.provider,
        userLogin: params.userLogin,
        orderId: params.orderId,
        authorizerDid: decision.authorizerDid,
        decision: decision.decision,
        expectedTerms: decision.expectedTerms,
      },
      "workflow",
    ),
  );
  return { status: "settled", orderId: params.orderId, decision: decision.decision, result };
}

export class TradingTradeWorkflow extends ThinkWorkflow<
  TradingAgent,
  TradeApprovalParams,
  DefaultProgress,
  Env
> {
  async run(
    event: WorkflowEvent<TradeApprovalParams>,
    step: WorkflowStep,
  ): Promise<TradeApprovalOutcome> {
    // Issue #1185: the workflow acts under the order owner's login,
    // recorded in the payload at start — absent means the run fails
    // closed rather than settling under a synthetic identity.
    if (!event.payload.userLogin) {
      throw new Error("Trade approval workflow payload is missing the required userLogin (issue #1185: no default identity).");
    }
    const params: TradeApprovalParams = {
      orderId: event.payload.orderId,
      provider: event.payload.provider,
      userLogin: event.payload.userLogin,
    };
    return runTradeApprovalFlow(this.env, params, step as unknown as TradeApprovalStep);
  }
}
