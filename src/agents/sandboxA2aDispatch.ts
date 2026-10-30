/**
 * Issue #2421 (Agent Mesh S15, programme #2225 G12) — SandboxAgent
 * A2A dispatch, the #2253/S1 recorded follow-up.
 *
 * Serves the sandbox card's operations for real, following the
 * scheduled/browser dispatch template (#2223 final slice): extract
 * the operation from the body, dispatch (never throws), wrap the
 * result in an outcome with a mandatory human-readable text part.
 *
 * Posture (the class header's honesty rules, carried verbatim):
 * SandboxAgent delegates to the ONE sandbox implementation,
 * ETradeSandboxService, constructed with no container backend — so
 * run_command's result in this deployment is the honest
 * not-executed shape (#121: executed:false, exitCode:null, no
 * fabricated output). This dispatch adds no execution, emulation,
 * or dressing-up of its own; the status operation exists so a
 * caller can learn the degradation BEFORE running anything.
 *
 * Input parity with the capability's other doors: the MCP command
 * (run_sandbox_command) and the agent's onRequest /run handler both
 * accept exactly { command, timeoutMs }. The request type also
 * carries envVars/workingDir, which NO existing door accepts from a
 * caller; this dispatch does not accept them either — widening the
 * input surface on one door would break gate parity, not keep it.
 *
 * Gate: the A2A edge bearer (src/a2a/index.ts) is this door's
 * enforcement point, identical to every other A2A surface — the
 * shared A2A_API_TOKEN pattern. Per-agent credentials are S16's
 * work; this surface joins its inventory via the registry census.
 *
 * The executor has no module-local default: the methods are
 * SandboxAgent-bound, so the class injects its bound methods and
 * the dispatch fails honestly when no executor is configured.
 */
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import type {
  Env,
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from "../types";
import type { SandboxAgentStatus } from "./sandbox-agent";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the sandbox card's operations must
 * equal it (pinned in tests/mesh_every_door_s15_2421.test.ts).
 */
export const SANDBOX_A2A_OPERATIONS = [
  "sandbox.status",
  "sandbox.run_command",
] as const;

export type SandboxA2AOperation = (typeof SANDBOX_A2A_OPERATIONS)[number];

type SandboxA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys (the
 * #2223 pattern): request-shape failures are
 * ERR_UNKNOWN_AGENT_ERROR; executor failures are
 * ERR_TOOL_EXECUTION_FAILED. No catalog keys are invented here.
 */
const SANDBOX_A2A_CATALOG_CODES: Record<SandboxA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function sandboxErrorCatalogCode(token: SandboxA2AErrorToken): AgentErrorCode {
  const code = SANDBOX_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface SandboxA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: SandboxA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

/** The SandboxAgent method surface the dispatch delegates to. */
export interface SandboxA2AExecutor {
  sandboxStatus(): SandboxAgentStatus;
  runCommand(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}

export interface SandboxA2ADeps {
  /**
   * The bound SandboxAgent methods, injected by the class. No
   * module-local default exists; without one the dispatch fails
   * honestly instead of fabricating a result.
   */
  executor?: SandboxA2AExecutor;
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

class SandboxA2AInputError extends Error {}

async function executeOperation(
  operation: SandboxA2AOperation,
  args: Record<string, unknown>,
  executor: SandboxA2AExecutor,
): Promise<unknown> {
  switch (operation) {
    case "sandbox.status":
      return executor.sandboxStatus();
    case "sandbox.run_command": {
      const command = args.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new SandboxA2AInputError(
          `Operation "${operation}" requires a non-empty string "command" argument.`,
        );
      }
      const request: SandboxExecutionRequest = { command };
      if (args.timeoutMs !== undefined) {
        if (
          typeof args.timeoutMs !== "number" ||
          !Number.isFinite(args.timeoutMs) ||
          args.timeoutMs <= 0
        ) {
          throw new SandboxA2AInputError(
            `Operation "${operation}" requires "timeoutMs" to be a positive number when present.`,
          );
        }
        request.timeoutMs = args.timeoutMs;
      }
      return executor.runCommand(request);
    }
  }
}

/** Dispatch one A2A body through the sandbox operations. Never throws. */
export async function dispatchSandboxA2A(
  env: Env,
  body: unknown,
  deps: SandboxA2ADeps,
): Promise<SandboxA2ADataResult> {
  void env; // The executor carries the env-bound service; env is part
  // of the template signature (scheduled / browser parity).
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: sandboxErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(SANDBOX_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: sandboxErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  const op = operation as SandboxA2AOperation;
  try {
    if (!deps.executor) {
      // The methods live on SandboxAgent; without the class's
      // injected executor there is no honest way to serve this.
      throw new Error("Sandbox executor is not configured for this dispatch context.");
    }
    const result = await executeOperation(op, args, deps.executor);
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof SandboxA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: sandboxErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: sandboxErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SandboxA2AOutcome {
  text: string;
  data: SandboxA2ADataResult;
}

function successText(data: SandboxA2ADataResult): string {
  switch (data.operation) {
    case "sandbox.status": {
      const status = (data.result ?? {}) as Partial<SandboxAgentStatus>;
      return status.backendConfigured
        ? "sandbox.status completed: a container backend IS configured; commands execute for real."
        : "sandbox.status completed: backend NOT configured — the sandbox is degraded, so run_command returns executed:false (no execution, no fabricated output) until an owner binds a container backend.";
    }
    case "sandbox.run_command": {
      const result = (data.result ?? {}) as Partial<SandboxExecutionResult>;
      return result.executed
        ? `sandbox.run_command completed: command executed, exit code ${result.exitCode ?? "unknown"}.`
        : "sandbox.run_command completed: NOT executed — no container backend is bound (executed:false, exitCode:null); no output was fabricated.";
    }
    default:
      return `${data.operation ?? "sandbox operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function sandboxA2AOutcome(data: SandboxA2ADataResult): SandboxA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "sandbox operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
