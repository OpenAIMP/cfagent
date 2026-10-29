/**
 * Issue #2223 (slice 1) — OrchestratorAgent A2A dispatch.
 *
 * Serves the orchestrator card's operations for real, following the
 * TradingAgent template (src/agents/trading-agent.ts): extract the
 * operation from the body, dispatch (never throws), wrap the result
 * in an outcome with a mandatory human-readable text part.
 *
 * Execution paths (no new implementations — SURVEY §3):
 * - search.query / payments.draft / payments.confirm / tasks.create /
 *   memory.remember / memory.recall run through the MAS tool factory
 *   (src/agents/mas.ts createMAS), constructed exactly as the one
 *   production caller (src/agents/routes/searchHub.ts) constructs it.
 * - nlq.execute runs the NLQ async executor. Its ports are
 *   OrchestratorAgent-bound, so there is NO module-local default:
 *   the class injects the real executor; without one the dispatch
 *   fails honestly instead of fabricating a plan.
 *
 * Operation extraction mirrors trading's extractA2AOperation
 * envelope logic locally: importing it would couple this module to
 * the trading agent's whole module graph for one pure function.
 *
 * Honesty (SURVEY §3): tasks.create returns an UNPERSISTED draft —
 * nothing is tracked until a human confirms it; payments.draft
 * moves NO funds (status awaiting_confirmation). The outcome text
 * says both, plainly.
 */
import { createMAS, type MASOptions } from "../mas";
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../../aspects/errorCodes";
import type { Env } from "../../types";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the orchestrator card's operations
 * must equal it, and the search/tasks/memory cards must be subsets
 * (pinned in tests/a2a_orchestrator_dispatch_p2223.test.ts).
 */
export const ORCHESTRATOR_A2A_OPERATIONS = [
  "search.query",
  "payments.draft",
  "payments.confirm",
  "tasks.create",
  "memory.remember",
  "memory.recall",
  "nlq.execute",
] as const;

export type OrchestratorA2AOperation = (typeof ORCHESTRATOR_A2A_OPERATIONS)[number];

type OrchestratorA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys, the
 * same pattern as trading's TRADING_ERROR_CATALOG_CODES: unknown /
 * missing operation and invalid input are "the request named
 * something the agent does not know / cannot accept"
 * (ERR_UNKNOWN_AGENT_ERROR — the catalog has no validation class);
 * an executor failure is ERR_TOOL_EXECUTION_FAILED. No catalog keys
 * are invented here.
 */
const ORCHESTRATOR_A2A_CATALOG_CODES: Record<OrchestratorA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function orchestratorErrorCatalogCode(token: OrchestratorA2AErrorToken): AgentErrorCode {
  const code = ORCHESTRATOR_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface OrchestratorA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: OrchestratorA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

export type OrchestratorMasFactory = (
  env: Env,
  ctx: { sessionId: string; sql: MASOptions["sql"]; audit: MASOptions["audit"] },
) => ReturnType<typeof createMAS>;

export interface OrchestratorA2ADeps {
  sql: MASOptions["sql"];
  audit: MASOptions["audit"];
  sessionId: string;
  /** Defaults to the real createMAS construction (searchHub.ts precedent). */
  masFactory?: OrchestratorMasFactory;
  /**
   * The NLQ executor. No module-local default exists: the NLQ ports
   * are OrchestratorAgent-bound, so the class injects the real
   * executor and nlq.execute fails honestly when it is absent.
   */
  nlqExecute?: (query: string) => Promise<unknown>;
}

const defaultMasFactory: OrchestratorMasFactory = (env, ctx) =>
  createMAS({
    env,
    sessionId: ctx.sessionId,
    requestId: crypto.randomUUID(),
    sql: ctx.sql,
    audit: ctx.audit,
  });

/**
 * Extract { operation, args } from an A2A request body: either the
 * JSON-RPC message/send envelope (a data part carrying
 * { operation, ...args }) or a bare { operation, ...args } object.
 * Same envelope logic as trading's extractA2AOperation (see header).
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

class OrchestratorA2AInputError extends Error {}

type MasTools = ReturnType<typeof createMAS>;
type MasToolName =
  | "searchKnowledge"
  | "draftPayment"
  | "createTaskDraft"
  | "confirmDraft"
  | "rememberFact"
  | "recallFacts";

/**
 * Invoke one MAS tool with the production call shape (searchHub.ts):
 * the args natively, plus ToolExecutionOptions carrying a fresh
 * toolCallId, a user message with the natural-language argument, and
 * an empty context.
 */
async function executeMasTool(
  mas: MasTools,
  toolName: MasToolName,
  args: Record<string, unknown>,
  content: string,
): Promise<unknown> {
  const tool = mas[toolName] as unknown as {
    execute: (
      a: Record<string, unknown>,
      o: {
        toolCallId: string;
        messages: Array<{ role: "user"; content: string }>;
        context: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  };
  return tool.execute(args, {
    toolCallId: crypto.randomUUID(),
    messages: [{ role: "user", content }],
    context: {},
  });
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function executeOperation(
  env: Env,
  operation: OrchestratorA2AOperation,
  args: Record<string, unknown>,
  deps: OrchestratorA2ADeps,
): Promise<unknown> {
  if (operation === "nlq.execute") {
    const query = stringArg(args, "query");
    if (query === null) {
      throw new OrchestratorA2AInputError(
        'Operation "nlq.execute" requires a non-empty string "query" argument.',
      );
    }
    if (!deps.nlqExecute) {
      // The NLQ ports live on OrchestratorAgent; without the class's
      // injected executor there is no honest way to run the query.
      throw new Error("NLQ executor is not configured for this dispatch context.");
    }
    return deps.nlqExecute(query);
  }

  const mas = (deps.masFactory ?? defaultMasFactory)(env, {
    sessionId: deps.sessionId,
    sql: deps.sql,
    audit: deps.audit,
  });

  switch (operation) {
    case "search.query": {
      const query = stringArg(args, "query");
      if (query === null) {
        throw new OrchestratorA2AInputError(
          'Operation "search.query" requires a non-empty string "query" argument.',
        );
      }
      return executeMasTool(mas, "searchKnowledge", { query }, query);
    }
    case "payments.draft": {
      const note = stringArg(args, "note");
      const content =
        note ??
        `${String(args.action ?? "payment")} ${String(args.amount ?? "")} for ${String(args.customer ?? "")}`.trim();
      return executeMasTool(mas, "draftPayment", args, content);
    }
    case "payments.confirm":
      return executeMasTool(mas, "confirmDraft", args, stringArg(args, "draftId") ?? "");
    case "tasks.create":
      return executeMasTool(mas, "createTaskDraft", args, stringArg(args, "title") ?? "");
    case "memory.remember":
      return executeMasTool(mas, "rememberFact", args, stringArg(args, "value") ?? "");
    case "memory.recall":
      return executeMasTool(mas, "recallFacts", args, stringArg(args, "filter") ?? "");
  }
}

/** Dispatch one A2A body through the orchestrator's operations. Never throws. */
export async function dispatchOrchestratorA2A(
  env: Env,
  body: unknown,
  deps: OrchestratorA2ADeps,
): Promise<OrchestratorA2ADataResult> {
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: orchestratorErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(ORCHESTRATOR_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: orchestratorErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  try {
    const result = await executeOperation(
      env,
      operation as OrchestratorA2AOperation,
      args,
      deps,
    );
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof OrchestratorA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: orchestratorErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: orchestratorErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface OrchestratorA2AOutcome {
  text: string;
  data: OrchestratorA2ADataResult;
}

function successText(data: OrchestratorA2ADataResult): string {
  const result = (data.result ?? {}) as Record<string, unknown>;
  switch (data.operation) {
    case "search.query":
      return `search.query completed: ${typeof result.count === "number" ? result.count : 0} result(s) from the knowledge search.`;
    case "payments.draft":
      return "payments.draft completed: payment draft created with status awaiting_confirmation. NO FUNDS HAVE BEEN MOVED — nothing executes until a human approves it via payments.confirm.";
    case "payments.confirm":
      return `payments.confirm completed${typeof result.status === "string" ? `: draft ${result.status}` : ""}.`;
    case "tasks.create":
      return "tasks.create completed: an UNPERSISTED task draft was created (status draft). No tracked task exists until a human confirms the draft.";
    case "memory.remember":
      return `memory.remember completed: fact stored under key "${String(result.key ?? "")}".`;
    case "memory.recall":
      return `memory.recall completed: ${typeof result.count === "number" ? result.count : 0} fact(s) recalled.`;
    case "nlq.execute":
      return "nlq.execute completed: the natural-language query was planned and executed.";
    default:
      return `${data.operation ?? "orchestrator operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function orchestratorA2AOutcome(
  data: OrchestratorA2ADataResult,
): OrchestratorA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "orchestrator operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
