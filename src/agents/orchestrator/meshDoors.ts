/**
 * Issue #2341 (Agent Mesh S5, programme #2225 G1 batch A) — typed
 * outbound doors from the orchestrator to ScheduledAgent and
 * PaymentsAgent.
 *
 * G1's discipline is the one the two existing wires already keep
 * (the ScreenerAgent typed stub, the ResearchAgent runAgentTool
 * dispatch): typed methods, explicit acting identity, honest typed
 * errors. A door resolves identity first, checks gates second,
 * dispatches third (docs/architecture/agentic/doors-and-layers.md
 * §11.1): a call whose acting identity is missing, blank, or the
 * retired synthetic literal "default" (retired by #2327 / mesh S3)
 * is refused BEFORE any stub is resolved — never defaulted, never
 * substituted.
 *
 * Addressing follows the A2A resolution precedent (#2223,
 * src/a2a/resolution.ts) and the production callers: ScheduledAgent
 * is the singleton instance "default" (the bare name would seed a
 * virgin catalogue); PaymentsAgent's live instance is "default"
 * (both production callers resolve it so, and the class is
 * instance-agnostic — its state derives from the ledger of record).
 *
 * Budget attribution: a chat-initiated budget check names
 * AGENTIC_SPEND_AGENT_ID ("orchestrator") as the budgetCheck
 * agentId. The ledger contract (#785/#896, src/payments/ledger.ts)
 * attributes orchestrator-executed outbound spend to that bucket,
 * and a check is only meaningful against the bucket the gated spend
 * will actually land in — the same reason ScheduledAgent's checks
 * name the same bucket post-S3. The acting user's login is a
 * different field: it is required, carried, and audited as the
 * check's requester; it is never the bucket.
 *
 * processPaidRequest is deliberately NOT exposed through this door
 * to the chat turn: the chat paid-request flow is S10's (G5 —
 * PaymentWorkflow with a PaymentsAgent budget check first), and
 * wiring the raw paid request here would pre-build that shape
 * beside the workflow path. The stub interface below types it for
 * completeness of the agent's surface; no door operation and no
 * turn command calls it in this slice, and no gate inside
 * PaymentsAgent (budget guard, facilitator verification,
 * idempotency) is touched.
 */

import type { Env } from "../../types";
import type { ScheduledGoal, ScheduleTick } from "../../schedule";
import {
  AGENTIC_SPEND_AGENT_ID,
  type PaymentRecord,
} from "../../payments/ledger";

// ---------------------------------------------------------------------------
// Errors — honest, typed, coded (doors-and-layers §11.1)
// ---------------------------------------------------------------------------

export type MeshDoorErrorCode =
  | "identity_required"
  | "door_unavailable"
  | "goal_not_found";

export class MeshDoorError extends Error {
  readonly code: MeshDoorErrorCode;
  constructor(code: MeshDoorErrorCode, message: string) {
    super(message);
    this.name = "MeshDoorError";
    this.code = code;
  }
}

/**
 * The door's identity gate. Returns the trimmed acting login, or
 * throws identity_required — before the caller resolves any stub.
 */
export function requireActingLogin(
  actingLogin: string | undefined | null,
): string {
  const login = typeof actingLogin === "string" ? actingLogin.trim() : "";
  if (!login || login === "default") {
    throw new MeshDoorError(
      "identity_required",
      "This door requires the chat turn's acting identity (the signed-in user's login); " +
        "no identity was supplied, or the retired synthetic identity was presented. " +
        "Refusing before dispatch — identities are never defaulted.",
    );
  }
  return login;
}

// ---------------------------------------------------------------------------
// Typed stubs — the seam. Door-local interfaces over the agents'
// real RPC surfaces (the getScreenerAgent/getResearchAgent cast
// precedent); tests fake the namespace at this boundary.
// ---------------------------------------------------------------------------

export interface ScheduledAgentDoorStub {
  listGoals(): Promise<ScheduledGoal[]>;
  triggerGoal(id: string): Promise<ScheduleTick>;
}

export interface PaymentsAgentDoorStub {
  budgetCheck(req: {
    operation: string;
    amountCents: number;
    agentId: string;
  }): Promise<{ allowed: boolean; reason?: string }>;
  todaySpent(): Promise<number>;
  listPayments(limit?: number): Promise<PaymentRecord[]>;
  /** Typed for surface completeness; NOT called by any door
   *  operation in this slice (see the header: S10/G5 owns the chat
   *  paid-request flow). */
  processPaidRequest(req: {
    agentId: string;
    operation: string;
    amountCents: number;
    idempotencyKey: string;
    paymentProof: string;
  }): Promise<PaymentRecord>;
}

const SCHEDULED_AGENT_INSTANCE = "default";
const PAYMENTS_AGENT_INSTANCE = "default";

function resolveStub<T>(
  namespace: DurableObjectNamespace | undefined,
  instanceName: string,
  door: string,
): T {
  if (!namespace) {
    throw new MeshDoorError(
      "door_unavailable",
      `${door} is unavailable: its Durable Object binding is not configured in this deployment.`,
    );
  }
  return namespace.get(namespace.idFromName(instanceName)) as unknown as T;
}

export function getScheduledAgentDoor(env: Env): ScheduledAgentDoorStub {
  return resolveStub<ScheduledAgentDoorStub>(
    env.SCHEDULED_AGENT,
    SCHEDULED_AGENT_INSTANCE,
    "ScheduledAgent door",
  );
}

export function getPaymentsAgentDoor(env: Env): PaymentsAgentDoorStub {
  return resolveStub<PaymentsAgentDoorStub>(
    env.PAYMENTS_AGENT,
    PAYMENTS_AGENT_INSTANCE,
    "PaymentsAgent door",
  );
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — list/inspect the goal catalogue, trigger one
// ---------------------------------------------------------------------------

export interface ScheduledGoalsDoorResult {
  goals: ScheduledGoal[];
}

/**
 * List the scheduled-goal catalogue, or inspect one goal when
 * goalId is given. The catalogue is the shared operator catalogue
 * the session-gated /api/schedule/* routes already expose to any
 * signed-in user (ScheduledGoal carries no owner field); the door
 * mirrors that authority for an identified chat user. An unknown
 * goalId is an honest goal_not_found error, never an empty success.
 */
export async function listScheduledGoalsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  goalId?: string,
): Promise<ScheduledGoalsDoorResult> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  const goals = await door.listGoals();
  if (goalId === undefined) return { goals };
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) {
    throw new MeshDoorError(
      "goal_not_found",
      `No scheduled goal with id "${goalId}" exists in the catalogue.`,
    );
  }
  return { goals: [goal] };
}

export interface ScheduledGoalTriggerDoorResult {
  goalId: string;
  tick: ScheduleTick;
}

/**
 * Trigger one goal now. The returned tick is ScheduledAgent's own
 * outcome, verbatim: a budget-denied or skipped firing surfaces in
 * tick.errors / jobsSkipped — the door never converts it into a
 * success shape.
 */
export async function triggerScheduledGoalViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  goalId: string,
): Promise<ScheduledGoalTriggerDoorResult> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  const tick = await door.triggerGoal(goalId);
  return { goalId, tick };
}

// ---------------------------------------------------------------------------
// PaymentsAgent door — budget check + the read side
// ---------------------------------------------------------------------------

export interface PaymentBudgetDoorResult {
  allowed: boolean;
  reason?: string;
  /** The spend bucket the check was evaluated against. */
  agentId: string;
  operation: string;
  amountCents: number;
}

/**
 * Ask PaymentsAgent whether the orchestrator spend bucket may
 * spend amountCents on operation. The guard's verdict propagates
 * as-is, denial reason included; the check records nothing (only
 * processPaidRequest records, after verification).
 */
export async function checkPaymentBudgetViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { operation: string; amountCents: number },
): Promise<PaymentBudgetDoorResult> {
  requireActingLogin(actingLogin);
  const door = getPaymentsAgentDoor(env);
  const verdict = await door.budgetCheck({
    operation: input.operation,
    amountCents: input.amountCents,
    agentId: AGENTIC_SPEND_AGENT_ID,
  });
  return {
    allowed: verdict.allowed,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    agentId: AGENTIC_SPEND_AGENT_ID,
    operation: input.operation,
    amountCents: input.amountCents,
  };
}

export interface PaymentsOverviewDoorResult {
  todaySpentCents: number;
  recentPayments: PaymentRecord[];
}

/** The payments read side a turn may show: today's total spend and
 *  the most recent ledger payments, both read by PaymentsAgent from
 *  the ledger of record. */
export async function getPaymentsOverviewViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  limit = 10,
): Promise<PaymentsOverviewDoorResult> {
  requireActingLogin(actingLogin);
  const door = getPaymentsAgentDoor(env);
  const todaySpentCents = await door.todaySpent();
  const recentPayments = await door.listPayments(limit);
  return { todaySpentCents, recentPayments };
}
