/**
 * Issue #2223 (final slice) — SlackAgent A2A dispatch.
 *
 * Serves the slack card's operations for real, following the
 * TradingAgent template and the payments dispatch shape: extract
 * the operation from the body, dispatch (never throws), wrap the
 * result in an outcome with a mandatory human-readable text part.
 *
 * Scope (SURVEY §1.8): only the class's two domain helpers are
 * served — sendPreTradeApprovalTicket (the strict HITL approval
 * gate) and dispatchTransactionSnap. The class's onRequest Slack
 * ingress (slash commands / interactions / events) is HTTP-form
 * shaped, carries its own signature gate and principal resolution,
 * and is NOT honestly exposable as A2A operations — it stays
 * behind the worker routes, and naming it here returns
 * unknown_operation by design. This A2A door is also the class's
 * first production instantiation as a Durable Object (the binding
 * exists since #2215; ingress runs through server forwarders onto
 * orchestrator instances, untouched by this slice).
 *
 * Delivery-target discipline (as with the browser door): neither
 * helper's webhookUrl option is ever taken from A2A args — the
 * class's own dispatchTransactionSnap falls back to env
 * SLACK_WEBHOOK_URL, and the approval service resolves its target
 * from env configuration likewise. A result whose success flag is
 * false surfaces as a dispatch failure with the result attached.
 *
 * The executor has no module-local default: the methods are
 * SlackAgent-bound, so the class injects its bound methods and the
 * dispatch fails honestly when no executor is configured.
 */
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import type {
  BrowserAgentSnapResult,
  Env,
  PreTradeApprovalDraft,
  TransactionSnapData,
} from "../types";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the slack card's operations must
 * equal it (pinned in tests/a2a_remaining_handlers_p2223.test.ts).
 */
export const SLACK_A2A_OPERATIONS = [
  "slack.send_pre_trade_approval",
  "slack.dispatch_transaction_snap",
] as const;

export type SlackA2AOperation = (typeof SLACK_A2A_OPERATIONS)[number];

type SlackA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys (the
 * slice-1 pattern): request-shape failures are
 * ERR_UNKNOWN_AGENT_ERROR; executor failures are
 * ERR_TOOL_EXECUTION_FAILED. No catalog keys are invented here.
 */
const SLACK_A2A_CATALOG_CODES: Record<SlackA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function slackErrorCatalogCode(token: SlackA2AErrorToken): AgentErrorCode {
  const code = SLACK_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface SlackA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: SlackA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

/** The SlackAgent method surface the dispatch delegates to. */
export interface SlackA2AExecutor {
  sendPreTradeApprovalTicket(
    draft: PreTradeApprovalDraft,
    options: { channel?: string; threadTs?: string },
  ): Promise<{ success: boolean; payload: unknown; orderId: string }>;
  dispatchTransactionSnap(
    tx: TransactionSnapData,
    options: { channel?: string; caption?: string },
  ): Promise<BrowserAgentSnapResult>;
}

export interface SlackA2ADeps {
  /**
   * The bound SlackAgent methods, injected by the class. No
   * module-local default exists; without one the dispatch fails
   * honestly instead of fabricating a result.
   */
  executor?: SlackA2AExecutor;
}

/**
 * Extract { operation, args } from an A2A request body: either the
 * JSON-RPC message/send envelope (a data part carrying
 * { operation, ...args }) or a bare { operation, ...args } object.
 * Same envelope logic as the other #2223 dispatches (kept local —
 * no coupling to another agent's module graph).
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

class SlackA2AInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DRAFT_ACTIONS: readonly string[] = ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"];

/**
 * Validate + shape a pre-trade approval draft. The draft travels
 * under "draft" when present, else the args themselves are the
 * draft. Required fields and the action enum follow
 * PreTradeApprovalDraft; the rest pass through unchanged. No
 * webhookUrl is read anywhere in this module — see header.
 */
function draftArg(args: Record<string, unknown>, operation: string): PreTradeApprovalDraft {
  const raw = isRecord(args.draft) ? args.draft : args;
  const draft = raw as Record<string, unknown>;
  if (typeof draft.orderId !== "string" || draft.orderId.trim().length === 0) {
    throw new SlackA2AInputError(`Operation "${operation}" requires a draft with a non-empty string "orderId".`);
  }
  if (typeof draft.symbol !== "string" || draft.symbol.trim().length === 0) {
    throw new SlackA2AInputError(`Operation "${operation}" requires a draft with a non-empty string "symbol".`);
  }
  if (typeof draft.action !== "string" || !DRAFT_ACTIONS.includes(draft.action)) {
    throw new SlackA2AInputError(
      `Operation "${operation}" requires a draft "action" of ${DRAFT_ACTIONS.join(", ")}.`,
    );
  }
  if (typeof draft.quantity !== "number" || !Number.isFinite(draft.quantity) || draft.quantity <= 0) {
    throw new SlackA2AInputError(`Operation "${operation}" requires a draft with a positive numeric "quantity".`);
  }
  return draft as unknown as PreTradeApprovalDraft;
}

/**
 * Validate + shape a transaction snap (the browser door's
 * validator, kept local per the house no-coupling rule — both
 * doors snap the same TransactionSnapData shape).
 */
function snapTransactionArg(
  args: Record<string, unknown>,
  operation: string,
): TransactionSnapData {
  const raw = isRecord(args.transaction) ? args.transaction : args;
  const tx = raw as Record<string, unknown>;
  if (typeof tx.symbol !== "string" || tx.symbol.trim().length === 0) {
    throw new SlackA2AInputError(`Operation "${operation}" requires a transaction with a non-empty string "symbol".`);
  }
  if (typeof tx.transactionId !== "string" || tx.transactionId.trim().length === 0) {
    throw new SlackA2AInputError(`Operation "${operation}" requires a transaction with a non-empty string "transactionId".`);
  }
  if (typeof tx.action !== "string" || tx.action.trim().length === 0) {
    throw new SlackA2AInputError(`Operation "${operation}" requires a transaction with a non-empty string "action".`);
  }
  if (typeof tx.quantity !== "number" || !Number.isFinite(tx.quantity)) {
    throw new SlackA2AInputError(`Operation "${operation}" requires a transaction with a numeric "quantity".`);
  }
  if (typeof tx.status !== "string" || tx.status.trim().length === 0) {
    throw new SlackA2AInputError(`Operation "${operation}" requires a transaction with a non-empty string "status".`);
  }
  return tx as unknown as TransactionSnapData;
}

function optionalStringArg(
  args: Record<string, unknown>,
  key: string,
  operation: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SlackA2AInputError(`Operation "${operation}" requires "${key}" to be a string when present.`);
  }
  return value;
}

async function executeOperation(
  operation: SlackA2AOperation,
  args: Record<string, unknown>,
  executor: SlackA2AExecutor,
): Promise<{ result: unknown; failureError?: string }> {
  switch (operation) {
    case "slack.send_pre_trade_approval": {
      const draft = draftArg(args, operation);
      const options: { channel?: string; threadTs?: string } = {};
      const channel = optionalStringArg(args, "channel", operation);
      if (channel !== undefined) options.channel = channel;
      const threadTs = optionalStringArg(args, "threadTs", operation);
      if (threadTs !== undefined) options.threadTs = threadTs;
      const result = await executor.sendPreTradeApprovalTicket(draft, options);
      if (result && result.success === false) {
        return { result, failureError: "The pre-trade approval ticket was not delivered." };
      }
      return { result };
    }
    case "slack.dispatch_transaction_snap": {
      const tx = snapTransactionArg(args, operation);
      const options: { channel?: string; caption?: string } = {};
      const channel = optionalStringArg(args, "channel", operation);
      if (channel !== undefined) options.channel = channel;
      const caption = optionalStringArg(args, "caption", operation);
      if (caption !== undefined) options.caption = caption;
      const result = await executor.dispatchTransactionSnap(tx, options);
      if (result && result.success === false) {
        return { result, failureError: result.error ?? "The transaction snap was not delivered." };
      }
      return { result };
    }
  }
}

/** Dispatch one A2A body through the slack operations. Never throws. */
export async function dispatchSlackA2A(
  env: Env,
  body: unknown,
  deps: SlackA2ADeps,
): Promise<SlackA2ADataResult> {
  void env; // The executor carries the env-bound methods; env is part
  // of the template signature (trading / payments parity).
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: slackErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(SLACK_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: slackErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  const op = operation as SlackA2AOperation;
  try {
    if (!deps.executor) {
      // The methods live on SlackAgent; without the class's
      // injected executor there is no honest way to serve this.
      throw new Error("Slack executor is not configured for this dispatch context.");
    }
    const { result, failureError } = await executeOperation(op, args, deps.executor);
    if (failureError !== undefined) {
      return {
        ok: false,
        operation,
        code: "internal_error",
        errorToken: slackErrorCatalogCode("internal_error"),
        correlationId,
        result,
        error: failureError,
      };
    }
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof SlackA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: slackErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: slackErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SlackA2AOutcome {
  text: string;
  data: SlackA2ADataResult;
}

function successText(data: SlackA2ADataResult): string {
  const result = data.result as Record<string, unknown> | null;
  switch (data.operation) {
    case "slack.send_pre_trade_approval":
      return `slack.send_pre_trade_approval completed: the pre-trade approval ticket for order ${String(result?.orderId ?? "")} was dispatched to the configured Slack destination. No trade executes without the human approval this ticket requests.`;
    case "slack.dispatch_transaction_snap":
      return `slack.dispatch_transaction_snap completed: the transaction snap was delivered to the configured Slack destination.`;
    default:
      return `${data.operation ?? "slack operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function slackA2AOutcome(data: SlackA2ADataResult): SlackA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "slack operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
