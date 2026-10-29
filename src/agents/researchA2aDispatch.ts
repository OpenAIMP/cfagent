/**
 * Issue #2223 (final slice) — ResearchAgent A2A dispatch.
 *
 * Serves the research card's operations for real, following the
 * TradingAgent template and the payments dispatch shape: extract
 * the operation from the body, dispatch (never throws), wrap the
 * result in an outcome with a mandatory human-readable text part.
 *
 * Instance + identity discipline (SURVEY §1.5): ResearchAgent
 * instances are research:<login>, and identity comes from the
 * request. The run methods refuse an absent login outright (issue
 * #2327 — they previously defaulted one to the literal string
 * "default", a legacy value that is NOT the #1185 service
 * identity). This dispatch threads getServiceUserLogin(env) into
 * every run request explicitly (overriding any body-supplied
 * login) and fails closed (not_configured) when no service
 * identity is configured; resolution (src/a2a/resolution.ts)
 * lands on the matching research:<login> instance and likewise
 * fails closed. No default identity is inherited through this
 * door — or any other — anymore.
 * Byte-returning getters (PDF/XLSX/CSV) stay out of the set, as
 * with screener — they do not fit the { text, data } JSON outcome.
 *
 * A run the method reports as failed ({ success: false, error })
 * surfaces as a dispatch failure carrying the method's error, with
 * the run result attached. evaluateRun receives the service
 * identity as its userLogin argument, matching the instance the
 * door resolved to.
 *
 * The executor has no module-local default: the methods are
 * ResearchAgent-bound, so the class injects its bound methods and
 * the dispatch fails honestly when no executor is configured.
 */
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import { getServiceUserLogin } from "../security/serviceIdentity";
import type { Env } from "../types";
import type {
  ResearchDiscoveryRunRequest,
  ResearchDiscoveryRunResult,
  ResearchRunRequest,
  ResearchRunResult,
  ResearchRunSummary,
} from "./research-agent";
import type { ResearchReport } from "../services/researchPipeline";
import type { ResearchConfig } from "../services/researchConfig";
import type { TrackRecord } from "../services/researchTrackRecord";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the research card's operations must
 * equal it (pinned in tests/a2a_remaining_handlers_p2223.test.ts).
 */
export const RESEARCH_A2A_OPERATIONS = [
  "research.run",
  "research.discovery",
  "research.latest",
  "research.history",
  "research.track_record",
  "research.evaluate",
  "research.config",
] as const;

export type ResearchA2AOperation = (typeof RESEARCH_A2A_OPERATIONS)[number];

type ResearchA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "not_configured"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys (the
 * slice-1 pattern): request-shape and configuration failures are
 * ERR_UNKNOWN_AGENT_ERROR; executor failures are
 * ERR_TOOL_EXECUTION_FAILED. No catalog keys are invented here.
 */
const RESEARCH_A2A_CATALOG_CODES: Record<ResearchA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  not_configured: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function researchErrorCatalogCode(token: ResearchA2AErrorToken): AgentErrorCode {
  const code = RESEARCH_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface ResearchA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: ResearchA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

/** The ResearchAgent method surface the dispatch delegates to. */
export interface ResearchA2AExecutor {
  runResearch(req: ResearchRunRequest): Promise<ResearchRunResult>;
  runDiscovery(req: ResearchDiscoveryRunRequest): Promise<ResearchDiscoveryRunResult>;
  getLatest(): Promise<ResearchReport | null>;
  getHistory(): Promise<ResearchRunSummary[]>;
  getTrackRecord(): Promise<TrackRecord>;
  evaluateRun(runId: string, userLogin?: string): Promise<unknown>;
  getResearchConfig(): Promise<ResearchConfig>;
}

export interface ResearchA2ADeps {
  /**
   * The bound ResearchAgent methods, injected by the class. No
   * module-local default exists; without one the dispatch fails
   * honestly instead of fabricating a result.
   */
  executor?: ResearchA2AExecutor;
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

class ResearchA2AInputError extends Error {}
class ResearchA2ANotConfiguredError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function triggerArg(args: Record<string, unknown>, operation: string): "manual" | "scheduled" {
  const value = args.trigger;
  if (value === undefined) return "manual";
  if (value === "manual" || value === "scheduled") return value;
  throw new ResearchA2AInputError(
    `Operation "${operation}" requires "trigger" to be "manual" or "scheduled" when present.`,
  );
}

function serviceLoginOrFail(env: Env, operation: string): string {
  const login = getServiceUserLogin(env);
  if (!login) {
    throw new ResearchA2ANotConfiguredError(
      `Operation "${operation}" requires a configured service identity (SERVICE_USER_LOGIN): ` +
        "A2A research runs are attributed to the service identity and fail closed without one — " +
        "the run methods' \"default\" login fallback is never inherited (issue #1185).",
    );
  }
  return login;
}

async function executeOperation(
  operation: ResearchA2AOperation,
  args: Record<string, unknown>,
  env: Env,
  executor: ResearchA2AExecutor,
): Promise<{ result: unknown; failureError?: string }> {
  switch (operation) {
    case "research.run": {
      const userLogin = serviceLoginOrFail(env, operation);
      const req: ResearchRunRequest = { trigger: triggerArg(args, operation), userLogin };
      if (args.configOverride !== undefined) {
        if (!isRecord(args.configOverride)) {
          throw new ResearchA2AInputError(`Operation "${operation}" requires "configOverride" to be an object when present.`);
        }
        req.configOverride = args.configOverride as ResearchRunRequest["configOverride"];
      }
      const result = await executor.runResearch(req);
      if (result && result.success === false) {
        return { result, failureError: result.error ?? "The research run reported success:false." };
      }
      return { result };
    }
    case "research.discovery": {
      const userLogin = serviceLoginOrFail(env, operation);
      const req: ResearchDiscoveryRunRequest = { trigger: triggerArg(args, operation), userLogin };
      if (args.symbols !== undefined) {
        if (!Array.isArray(args.symbols) || !args.symbols.every((v) => typeof v === "string")) {
          throw new ResearchA2AInputError(`Operation "${operation}" requires "symbols" to be an array of strings when present.`);
        }
        req.symbols = args.symbols as string[];
      }
      if (args.ivRank !== undefined) {
        if (args.ivRank !== null && (typeof args.ivRank !== "number" || !Number.isFinite(args.ivRank))) {
          throw new ResearchA2AInputError(`Operation "${operation}" requires "ivRank" to be a finite number or null when present.`);
        }
        req.ivRank = args.ivRank as number | null;
      }
      if (args.eventsBySymbol !== undefined) {
        if (!isRecord(args.eventsBySymbol)) {
          throw new ResearchA2AInputError(`Operation "${operation}" requires "eventsBySymbol" to be an object when present.`);
        }
        req.eventsBySymbol = args.eventsBySymbol as ResearchDiscoveryRunRequest["eventsBySymbol"];
      }
      if (args.portfolio !== undefined) {
        if (args.portfolio !== null && !isRecord(args.portfolio)) {
          throw new ResearchA2AInputError(`Operation "${operation}" requires "portfolio" to be an object or null when present.`);
        }
        req.portfolio = args.portfolio as ResearchDiscoveryRunRequest["portfolio"];
      }
      const result = await executor.runDiscovery(req);
      if (result && result.success === false) {
        return { result, failureError: result.error ?? "The discovery run reported success:false." };
      }
      return { result };
    }
    case "research.latest":
      return { result: await executor.getLatest() };
    case "research.history":
      return { result: await executor.getHistory() };
    case "research.track_record":
      return { result: await executor.getTrackRecord() };
    case "research.evaluate": {
      const runId = args.runId;
      if (typeof runId !== "string" || runId.trim().length === 0) {
        throw new ResearchA2AInputError(`Operation "${operation}" requires a non-empty string "runId" argument.`);
      }
      // The evaluation's login is the service identity when one is
      // configured (the instance this door resolved to); the
      // method's parameter is optional and never defaulted here to
      // a synthetic login.
      const userLogin = getServiceUserLogin(env) ?? undefined;
      return { result: await executor.evaluateRun(runId, userLogin) };
    }
    case "research.config":
      return { result: await executor.getResearchConfig() };
  }
}

/** Dispatch one A2A body through the research operations. Never throws. */
export async function dispatchResearchA2A(
  env: Env,
  body: unknown,
  deps: ResearchA2ADeps,
): Promise<ResearchA2ADataResult> {
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: researchErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(RESEARCH_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: researchErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  const op = operation as ResearchA2AOperation;
  try {
    if (!deps.executor) {
      // The methods live on ResearchAgent; without the class's
      // injected executor there is no honest way to serve this.
      throw new Error("Research executor is not configured for this dispatch context.");
    }
    const { result, failureError } = await executeOperation(op, args, env, deps.executor);
    if (failureError !== undefined) {
      return {
        ok: false,
        operation,
        code: "internal_error",
        errorToken: researchErrorCatalogCode("internal_error"),
        correlationId,
        result,
        error: failureError,
      };
    }
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof ResearchA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: researchErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    if (err instanceof ResearchA2ANotConfiguredError) {
      return {
        ok: false,
        operation,
        code: "not_configured",
        errorToken: researchErrorCatalogCode("not_configured"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: researchErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ResearchA2AOutcome {
  text: string;
  data: ResearchA2ADataResult;
}

function successText(data: ResearchA2ADataResult): string {
  const result = data.result as Record<string, unknown> | null;
  switch (data.operation) {
    case "research.run":
      return "research.run completed: the research run finished and its report is attached (publication stays the orchestrator's job).";
    case "research.discovery": {
      const proposals = Array.isArray(result?.proposals) ? result.proposals.length : 0;
      const persisted = typeof result?.persisted === "number" ? result.persisted : 0;
      const limitations = Array.isArray(result?.limitations) ? (result.limitations as string[]) : [];
      return `research.discovery completed: ${proposals} proposal(s), ${persisted} persisted as proposed-only${limitations.length > 0 ? `; limitations: ${limitations.join("; ")}` : ""}. Discovered goals activate only by a separate human decision.`;
    }
    case "research.latest":
      return data.result === null
        ? "research.latest completed: no research report has been recorded on this instance yet."
        : "research.latest completed: the latest research report on this instance is attached.";
    case "research.history":
      return `research.history completed: ${Array.isArray(data.result) ? data.result.length : 0} recorded run(s).`;
    case "research.track_record":
      return "research.track_record completed: the agent's recorded track record is attached.";
    case "research.evaluate":
      return data.result === null
        ? "research.evaluate completed: no evaluation exists for that run (nothing was fabricated)."
        : "research.evaluate completed: the run's evaluation is attached.";
    case "research.config":
      return "research.config completed: the agent's typed research configuration is attached.";
    default:
      return `${data.operation ?? "research operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function researchA2AOutcome(data: ResearchA2ADataResult): ResearchA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "research operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
