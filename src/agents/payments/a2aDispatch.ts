/**
 * Issue #2223 (payments slice) — PaymentsAgent A2A dispatch.
 *
 * Serves the payments card's operations for real, following the
 * TradingAgent template (src/agents/trading-agent.ts) and slice 1's
 * orchestrator dispatch (src/agents/orchestrator/a2aDispatch.ts):
 * extract the operation from the body, dispatch (never throws),
 * wrap the result in an outcome with a mandatory human-readable
 * text part.
 *
 * The card is re-scoped to the agent's REAL surface (SURVEY §6.3):
 * payments.draft does not exist on PaymentsAgent — it is a MAS tool
 * inside OrchestratorAgent and is served by the orchestrator card.
 * Naming it here returns unknown_operation, by design.
 *
 * Wire convention: the envelope's "operation" names the A2A
 * operation, so the operation being charged or budget-checked
 * travels as "op" in the body and is mapped onto the methods'
 * "operation" field by this dispatch. Nothing else is renamed:
 * argument VALUES pass to the methods unchanged.
 *
 * payments.budget_check requires the caller's "agentId" (issue
 * #2327), exactly as payments.process does: a budget check is
 * attributed to the agent it names, and this door no longer
 * forwards an anonymous check for the method to default.
 *
 * Money path (hard rule): this module performs NO verification and
 * NO recording. payments.process delegates to the executor's
 * processPaidRequest, whose own facilitator verification and
 * ledger recording (src/payments/ledger.ts) are the only path; a
 * verification failure or budget denial surfaces as a classified
 * failure result and records nothing, because the method records
 * nothing on those paths. This dispatch validates argument SHAPES
 * only (presence and types), never values.
 *
 * The executor has no module-local default: the four methods are
 * PaymentsAgent-bound (the slice-1 nlqExecute precedent), so the
 * class injects its bound methods and the dispatch fails honestly
 * when no executor is configured.
 */
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../../aspects/errorCodes";
import type { PaymentRecord } from "../../payments/ledger";
import type { Env } from "../../types";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the payments card's operations must
 * equal it (pinned in tests/a2a_payments_dispatch_p2223.test.ts).
 */
export const PAYMENTS_A2A_OPERATIONS = [
  "payments.budget_check",
  "payments.today_spent",
  "payments.list",
  "payments.process",
] as const;

export type PaymentsA2AOperation = (typeof PAYMENTS_A2A_OPERATIONS)[number];

type PaymentsA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "budget_denied"
  | "payment_verification_failed"
  | "duplicate_idempotency_key"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys, the
 * slice-1 pattern. The catalog defines no payment-specific keys
 * (verified — no keys are invented here): request-shape failures
 * are ERR_UNKNOWN_AGENT_ERROR; execution failures, including the
 * method's own budget denial, facilitator rejection, and duplicate
 * idempotency outcomes, are ERR_TOOL_EXECUTION_FAILED.
 */
const PAYMENTS_A2A_CATALOG_CODES: Record<PaymentsA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  budget_denied: AgentErrorCode.TOOL_EXECUTION_FAILED,
  payment_verification_failed: AgentErrorCode.TOOL_EXECUTION_FAILED,
  duplicate_idempotency_key: AgentErrorCode.TOOL_EXECUTION_FAILED,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function paymentsErrorCatalogCode(token: PaymentsA2AErrorToken): AgentErrorCode {
  const code = PAYMENTS_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface PaymentsA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: PaymentsA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

export interface PaymentsBudgetCheckRequest {
  operation: string;
  amountCents: number;
  agentId: string;
}

export interface PaymentsProcessRequest {
  agentId: string;
  operation: string;
  amountCents: number;
  idempotencyKey: string;
  paymentProof: string;
}

/** The PaymentsAgent method surface the dispatch delegates to. */
export interface PaymentsA2AExecutor {
  budgetCheck(req: PaymentsBudgetCheckRequest): Promise<{ allowed: boolean; reason?: string }>;
  todaySpent(): Promise<number>;
  listPayments(limit?: number): Promise<PaymentRecord[]>;
  processPaidRequest(req: PaymentsProcessRequest): Promise<PaymentRecord>;
}

export interface PaymentsA2ADeps {
  /**
   * The bound PaymentsAgent methods, injected by the class. No
   * module-local default exists (see header); without one the
   * dispatch fails honestly instead of fabricating a result.
   */
  executor?: PaymentsA2AExecutor;
}

/**
 * Extract { operation, args } from an A2A request body: either the
 * JSON-RPC message/send envelope (a data part carrying
 * { operation, ...args }) or a bare { operation, ...args } object.
 * Same envelope logic as slice 1's orchestrator dispatch (which
 * mirrors trading's extractA2AOperation; kept local for the same
 * reason — no coupling to another agent's module graph).
 */
function extractA2AOperation(
  body: unknown,
): { operation: string; args: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const parts = b.params?.message?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part?.kind === "data" && part.data && typeof part.data === "object") {
        const { operation, ...args } = part.data as Record<string, unknown>;
        if (typeof operation === "string") return { operation, args };
      }
    }
  }
  if (typeof b.operation === "string") {
    const { operation, ...args } = b;
    return { operation: operation as string, args };
  }
  return null;
}

class PaymentsA2AInputError extends Error {}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  operation: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PaymentsA2AInputError(
      `Operation "${operation}" requires a non-empty string "${key}" argument.`,
    );
  }
  return value;
}

function amountArg(args: Record<string, unknown>, operation: string): number {
  const value = args.amountCents;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PaymentsA2AInputError(
      `Operation "${operation}" requires a numeric "amountCents" argument.`,
    );
  }
  return value;
}

async function executeOperation(
  operation: PaymentsA2AOperation,
  args: Record<string, unknown>,
  executor: PaymentsA2AExecutor,
): Promise<unknown> {
  switch (operation) {
    case "payments.budget_check": {
      const req: PaymentsBudgetCheckRequest = {
        operation: stringArg(args, "op", operation),
        amountCents: amountArg(args, operation),
        agentId: stringArg(args, "agentId", operation),
      };
      // The verdict IS the result — including { allowed: false }.
      // budgetCheck is fail-closed by design; a denial is a
      // successful check, never an error at this door.
      return executor.budgetCheck(req);
    }
    case "payments.today_spent": {
      const spentTodayCents = await executor.todaySpent();
      return { spentTodayCents };
    }
    case "payments.list": {
      let limit: number | undefined;
      if (args.limit !== undefined) {
        if (typeof args.limit !== "number" || !Number.isFinite(args.limit) || args.limit <= 0) {
          throw new PaymentsA2AInputError(
            `Operation "${operation}" requires "limit" to be a positive number when present.`,
          );
        }
        limit = args.limit;
      }
      return executor.listPayments(limit);
    }
    case "payments.process": {
      const req: PaymentsProcessRequest = {
        agentId: stringArg(args, "agentId", operation),
        operation: stringArg(args, "op", operation),
        amountCents: amountArg(args, operation),
        idempotencyKey: stringArg(args, "idempotencyKey", operation),
        paymentProof: stringArg(args, "paymentProof", operation),
      };
      // Faithful pass-through: the method validates against the
      // budget guard, verifies with the facilitator, and records
      // in the ledger of record. This dispatch adds no step.
      return executor.processPaidRequest(req);
    }
  }
}

/**
 * Classify a processPaidRequest failure by the method's own error
 * messages (the only signal it emits): budget denial, facilitator
 * rejection, and duplicate idempotency are distinct, honest
 * outcomes; anything else is an internal error.
 */
function classifyPaymentsProcessError(err: unknown): PaymentsA2AErrorToken {
  const message = err instanceof Error ? err.message : String(err);
  // Duplicate first: the guard's check denies a replayed key with
  // "Budget denied: duplicate idempotency key" before the ledger is
  // reached, so the duplicate outcome wears the budget prefix — the
  // more specific classification wins.
  if (message.includes("duplicate idempotency key")) return "duplicate_idempotency_key";
  if (message.startsWith("Budget denied")) return "budget_denied";
  if (message.startsWith("Payment verification failed")) return "payment_verification_failed";
  return "internal_error";
}

/** Dispatch one A2A body through the payments operations. Never throws. */
export async function dispatchPaymentsA2A(
  env: Env,
  body: unknown,
  deps: PaymentsA2ADeps,
): Promise<PaymentsA2ADataResult> {
  void env; // The executor carries the env-bound methods; env is part
  // of the template signature (trading / slice-1 parity).
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: paymentsErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(PAYMENTS_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: paymentsErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  const op = operation as PaymentsA2AOperation;
  try {
    if (!deps.executor) {
      // The methods live on PaymentsAgent; without the class's
      // injected executor there is no honest way to serve this.
      throw new Error("Payments executor is not configured for this dispatch context.");
    }
    const result = await executeOperation(op, args, deps.executor);
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof PaymentsA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: paymentsErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    const code =
      op === "payments.process" ? classifyPaymentsProcessError(err) : "internal_error";
    return {
      ok: false,
      operation,
      code,
      errorToken: paymentsErrorCatalogCode(code),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface PaymentsA2AOutcome {
  text: string;
  data: PaymentsA2ADataResult;
}

function successText(data: PaymentsA2ADataResult): string {
  const result = (data.result ?? {}) as Record<string, unknown>;
  switch (data.operation) {
    case "payments.budget_check":
      return result.allowed === true
        ? "payments.budget_check completed: the operation is within budget. A budget check records no spend."
        : `payments.budget_check completed: the operation is NOT within budget${typeof result.reason === "string" ? ` — ${result.reason}` : ""}. A budget check records no spend.`;
    case "payments.today_spent":
      return `payments.today_spent completed: ${typeof result.spentTodayCents === "number" ? result.spentTodayCents : 0} cents spent today across all agents.`;
    case "payments.list":
      return `payments.list completed: ${Array.isArray(data.result) ? data.result.length : 0} payment record(s) from the ledger of record.`;
    case "payments.process":
      return `payments.process completed: payment recorded in the ledger of record (idempotency key "${String(result.idempotencyKey ?? "")}", status ${String(result.status ?? "verified")}).`;
    default:
      return `${data.operation ?? "payments operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function paymentsA2AOutcome(data: PaymentsA2ADataResult): PaymentsA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "payments operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
