/**
 * Issue #291 — TradingAgent: the trading competency as agent-as-a-service.
 *
 * Owner directive (Venus, 2026-10-22): the trading competency is an
 * agent-as-a-service — an agent-as-a-tool, a Think agent, and an A2A
 * agent with its own Think workflow. It is provider-NEUTRAL: E*TRADE is
 * one provider behind the TradingPlatformRegistry seam; others (e.g.
 * Public.com) onboard by registering a platform, with no agent changes.
 * The architecture is configurable, pluggable, extensible, flexible:
 *
 * - PLUGGABLE providers — services resolve an ITradingPlatform from
 *   TradingPlatformRegistry by id and never name a broker.
 * - CONFIGURABLE — src/config/tradingAgentConfig.ts: enabled providers,
 *   default provider, per-service enablement, all env-overridable.
 * - EXTENSIBLE services — services are modules in TRADING_SERVICE_REGISTRY
 *   behind one interface. The Think tool set and the A2A operation list
 *   are GENERATED from registry + config, so the surfaces cannot drift;
 *   adding a service is one module + one registry line.
 * - FLEXIBLE invocation — one execution path (executeTradingService)
 *   behind three doors: Think tools, A2A structured operations
 *   (handleA2A), and typed RPC (executeService). A service cannot tell
 *   which door it was called through.
 *
 * Safety: trading keeps the platform HITL discipline. Screening services
 * are read-only. Order placement (arriving in later slices) flows only
 * through the existing approval path; tool/A2A trading operations are
 * preview-only unless an approved execution context is presented.
 *
 * Data locality: v1 services are broker-API operations — OAuth tokens
 * resolve from env (SessionStore), so they run inside this agent.
 * ORM-backed persistence (trade records, watchlists) stays with the
 * orchestrator; services receive any such state as call parameters.
 */

import { Think } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { resolveAiModelName } from "./model";
import type { Env } from "../types";
import {
  TradingPlatformRegistry,
  UnifiedOptionsService,
  type ITradingPlatform,
  type TradingPlatformId,
} from "../trading";
import {
  getTradingAgentConfig,
  isTradingServiceEnabled,
  type TradingAgentConfig,
} from "../config/tradingAgentConfig";

// ---------------------------------------------------------------------------
// Stable error tokens (cfpay convention, #291 A3): failures on the A2A and
// tool surfaces carry a machine-stable `code`; raw exception text from
// unclassified failures never reaches the wire (it is logged server-side
// and replaced by a generic message + the internal_error token).
// ---------------------------------------------------------------------------

export type TradingErrorToken =
  | "unknown_service"
  | "unknown_operation"
  | "missing_operation"
  | "service_disabled"
  | "provider_not_enabled"
  | "provider_not_registered"
  | "provider_unsupported"
  | "invalid_input"
  | "internal_error";

export class TradingServiceError extends Error {
  readonly code: TradingErrorToken;
  constructor(code: TradingErrorToken, message: string) {
    super(message);
    this.name = "TradingServiceError";
    this.code = code;
  }
}

/** Classify any thrown value into a wire-safe { code, message } pair. */
export function classifyTradingError(err: unknown): { code: TradingErrorToken; message: string } {
  if (err instanceof TradingServiceError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof z.ZodError) {
    return {
      code: "invalid_input",
      message: `Invalid input: ${err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    };
  }
  return { code: "internal_error", message: "Internal error in the trading service." };
}

/** Aspects-lite dispatch log (#291 A6): one structured line per execution. */
export function logTradingDispatch(entry: {
  correlationId: string;
  door: string;
  service: string;
  provider?: string;
  access?: string;
  ok: boolean;
  code?: string;
  durationMs: number;
}): void {
  console.info("[TradingAgent]", JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Service registry
// ---------------------------------------------------------------------------

export interface TradingServiceContext {
  env: Env;
  config: TradingAgentConfig;
  userLogin: string;
  /** Resolve the platform for a provider id (or the configured default). */
  resolvePlatform: (providerId?: string) => ITradingPlatform;
}

export interface TradingServiceDef {
  /** Stable service id (matches TradingAgentConfig.enabledServices). */
  id: string;
  /** Think tool name. */
  toolName: string;
  /** A2A structured operation name. */
  a2aOperation: string;
  /**
   * Access class (cfpay A2A_OPS convention): "read" observes, "write"
   * mutates account/portfolio state, "action" executes in the world
   * (order placement). Write/action services get the stricter gates
   * (edge auth + approval flow) as they land.
   */
  access: "read" | "write" | "action";
  description: string;
  inputSchema: z.ZodType<any>;
  execute: (ctx: TradingServiceContext, input: any) => Promise<unknown>;
}

const providerField = z
  .string()
  .optional()
  .describe("Provider id (e.g. \"etrade\"). Omit for the configured default provider.");
const userLoginField = z
  .string()
  .optional()
  .describe("User login the call acts for. Defaults to the agent instance's user.");

const stockScreeningService: TradingServiceDef = {
  id: "stock_screening",
  toolName: "screen_stocks",
  a2aOperation: "trading.screen_stocks",
  access: "read",
  description:
    "Screen stocks on a provider against price/sector/momentum filters. Read-only. " +
    "Returns the screen result (matches, filter summary, counts).",
  inputSchema: z.object({
    provider: providerField,
    userLogin: userLoginField,
    filter: z
      .object({
        sector: z.string().optional(),
        minPrice: z.number().optional(),
        maxPrice: z.number().optional(),
        exchange: z.enum(["ALL", "NASDAQ", "NYSE", "AMEX"]).optional(),
        minMarketCap: z.number().optional(),
        maxPeRatio: z.number().optional(),
        minRsi: z.number().optional(),
        maxRsi: z.number().optional(),
        minVolume: z.number().optional(),
        gainersOnly: z.boolean().optional(),
        losersOnly: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  }),
  execute: async (ctx, input) => {
    const platform = ctx.resolvePlatform(input.provider);
    if (typeof platform.screenMarkets !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not support stock screening.`,
      );
    }
    return platform.screenMarkets(input.filter ?? {});
  },
};

const optionsScreeningService: TradingServiceDef = {
  id: "options_screening",
  toolName: "screen_options",
  a2aOperation: "trading.screen_options",
  access: "read",
  description:
    "Screen options contracts across underlyings with the unified options pipeline " +
    "(the same engine behind the scanner UI): filter by underlying symbols, expiry, " +
    "moneyness, greeks and liquidity. Read-only. The pipeline is E*TRADE-backed today; " +
    "other providers return provider_unsupported until their pipeline lands.",
  inputSchema: z.object({
    provider: providerField,
    userLogin: userLoginField,
    symbols: z.array(z.string()).max(100).optional(),
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
  execute: async (ctx, input) => {
    const platform = ctx.resolvePlatform(input.provider);
    if (platform.platformId !== "etrade") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Options screening runs on the unified options pipeline, which is E*TRADE-backed ` +
          `today; provider "${platform.platformId}" does not support it yet.`,
      );
    }
    const service = new UnifiedOptionsService(ctx.env, ctx.userLogin);
    return service.execute({
      action: "screen",
      symbols: input.symbols,
      symbol: input.symbol,
      filter: input.filter as never,
      limit: input.limit,
    });
  },
};

const stockTradingService: TradingServiceDef = {
  id: "stock_trading",
  toolName: "trade_stock",
  a2aOperation: "trading.trade_stock",
  access: "action",
  description:
    "Propose a stock order (preview only): validates the intent against the provider " +
    "and returns the broker preview as a pending-approval proposal. This surface NEVER " +
    "places an order — placement happens only through the agent's approval door " +
    "(executeApprovedOrder) with an explicit authorizer identity and decision, " +
    "the cfpay proposal -> approval -> verify -> execute shape.",
  inputSchema: z.object({
    provider: providerField,
    userLogin: userLoginField,
    symbol: z.string().min(1),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]),
    quantity: z.number().positive(),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional(),
    limitPrice: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
  }),
  execute: async (ctx, input) => {
    const platform = ctx.resolvePlatform(input.provider);
    if (typeof platform.previewOrder !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not support order preview.`,
      );
    }
    const draft = await platform.previewOrder({
      assetClass: "equity",
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      orderType: input.orderType,
      limitPrice: input.limitPrice,
      stopPrice: input.stopPrice,
    });
    return {
      status: "pending_approval",
      proposal: draft,
      note:
        "Preview only — no order was placed. Placement requires an approved " +
        "decision via the TradingAgent approval door (executeApprovedOrder).",
    };
  },
};

const optionsTradingService: TradingServiceDef = {
  id: "options_trading",
  toolName: "trade_options",
  a2aOperation: "trading.trade_options",
  access: "action",
  description:
    "Propose an options order (preview only): single-leg or multi-leg (spreads) via " +
    "optionLegs, priced from the strategy net debit when given. Returns the broker " +
    "preview as a pending-approval proposal. This surface NEVER places an order — " +
    "placement happens only through the agent's approval door (executeApprovedOrder), " +
    "shared with stock trading.",
  inputSchema: z.object({
    provider: providerField,
    userLogin: userLoginField,
    symbol: z.string().min(1),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]),
    quantity: z.number().positive(),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional(),
    limitPrice: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
    strategyNetDebit: z.number().optional(),
    optionLegs: z
      .array(
        z.object({
          underlyingSymbol: z.string().min(1),
          securityType: z.literal("OPTN"),
          side: z.enum(["BUY", "SELL"]),
          quantity: z.number().positive(),
          optionType: z.enum(["CALL", "PUT"]).optional(),
          strike: z.number().positive().optional(),
          expirationDate: z.string().optional(),
        }),
      )
      .min(1),
  }),
  execute: async (ctx, input) => {
    const platform = ctx.resolvePlatform(input.provider);
    if (typeof platform.previewOrder !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not support order preview.`,
      );
    }
    const draft = await platform.previewOrder({
      assetClass: "options",
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      orderType: input.orderType,
      limitPrice: input.limitPrice,
      stopPrice: input.stopPrice,
      optionLegs: input.optionLegs,
      strategyNetDebit: input.strategyNetDebit,
    });
    return {
      status: "pending_approval",
      proposal: draft,
      note:
        "Preview only — no order was placed. Placement requires an approved " +
        "decision via the TradingAgent approval door (executeApprovedOrder).",
    };
  },
};

/** The service registry. Add a service = one module + one line here. */
export const TRADING_SERVICE_REGISTRY: TradingServiceDef[] = [
  stockScreeningService,
  optionsScreeningService,
  stockTradingService,
  optionsTradingService,
];

export function getTradingService(serviceId: string): TradingServiceDef | undefined {
  return TRADING_SERVICE_REGISTRY.find((s) => s.id === serviceId);
}

export function getTradingServiceByOperation(
  operation: string,
): TradingServiceDef | undefined {
  return TRADING_SERVICE_REGISTRY.find((s) => s.a2aOperation === operation);
}

/** Services that are both registered and enabled — the live surface. */
export function liveTradingServices(config: TradingAgentConfig): TradingServiceDef[] {
  return TRADING_SERVICE_REGISTRY.filter((s) => isTradingServiceEnabled(config, s.id));
}

// ---------------------------------------------------------------------------
// Provider resolution + the single execution path
// ---------------------------------------------------------------------------

export function resolveTradingPlatform(
  env: Env,
  config: TradingAgentConfig,
  providerId?: string,
  userLogin = "default_trader",
): ITradingPlatform {
  const provider = (providerId ?? config.defaultProvider).toLowerCase();
  if (!config.enabledProviders.includes(provider)) {
    throw new TradingServiceError(
      "provider_not_enabled",
      `Provider "${provider}" is not enabled for the TradingAgent ` +
        `(enabled: ${config.enabledProviders.join(", ") || "none"}).`,
    );
  }
  const registered = TradingPlatformRegistry.getRegisteredPlatforms() as string[];
  if (!registered.includes(provider)) {
    throw new TradingServiceError(
      "provider_not_registered",
      `Provider "${provider}" is enabled but no platform is registered for it ` +
        `(registered: ${registered.join(", ") || "none"}).`,
    );
  }
  return TradingPlatformRegistry.getPlatform(
    provider as TradingPlatformId,
    env,
    undefined,
    userLogin,
  );
}

export interface TradingServiceCall {
  serviceId: string;
  input?: Record<string, unknown>;
  /** Which door the call came through ("tool" | "a2a" | "rpc") — logging only. */
  door?: string;
  /** Correlation id for the dispatch log; generated when absent. */
  traceId?: string;
}

/**
 * The single execution path behind every door (tool / A2A / RPC).
 * Validates the service exists and is enabled, parses the input against
 * the service schema, then executes. Failures throw TradingServiceError
 * with a stable token; adapters shape them per surface. Every execution —
 * success or failure — emits one structured dispatch log line (A6).
 */
export async function executeTradingService(
  env: Env,
  config: TradingAgentConfig,
  call: TradingServiceCall,
): Promise<unknown> {
  const correlationId = call.traceId ?? crypto.randomUUID();
  const started = Date.now();
  const service = getTradingService(call.serviceId);
  const log = (ok: boolean, code?: string) =>
    logTradingDispatch({
      correlationId,
      door: call.door ?? "rpc",
      service: call.serviceId,
      provider:
        typeof call.input?.provider === "string"
          ? (call.input.provider as string)
          : config.defaultProvider,
      access: service?.access,
      ok,
      code,
      durationMs: Date.now() - started,
    });
  try {
    if (!service) {
      throw new TradingServiceError(
        "unknown_service",
        `Unknown trading service: "${call.serviceId}".`,
      );
    }
    if (!isTradingServiceEnabled(config, service.id)) {
      throw new TradingServiceError(
        "service_disabled",
        `Trading service "${service.id}" is disabled by configuration.`,
      );
    }
    const input = service.inputSchema.parse(call.input ?? {});
    const userLogin =
      typeof input.userLogin === "string" && input.userLogin.length > 0
        ? input.userLogin
        : "default_trader";
    const ctx: TradingServiceContext = {
      env,
      config,
      userLogin,
      resolvePlatform: (providerId) =>
        resolveTradingPlatform(env, config, providerId, userLogin),
    };
    const result = await service.execute(ctx, input);
    log(true);
    return result;
  } catch (err) {
    const { code, message } = classifyTradingError(err);
    if (code === "internal_error" && !(err instanceof TradingServiceError)) {
      // The real failure stays server-side; the wire gets the token only.
      console.error("[TradingAgent] unclassified service failure:", err);
    }
    log(false, code);
    throw new TradingServiceError(code, message);
  }
}

// ---------------------------------------------------------------------------
// Door 1: Think tools (agent-as-a-tool), generated from the registry
// ---------------------------------------------------------------------------

export function buildTradingTools(env: Env, config: TradingAgentConfig): ToolSet {
  const tools: ToolSet = {};
  for (const service of liveTradingServices(config)) {
    tools[service.toolName] = tool({
      description: service.description,
      inputSchema: service.inputSchema,
      execute: async (input: any) => {
        try {
          const result = await executeTradingService(env, config, {
            serviceId: service.id,
            input,
            door: "tool",
          });
          return JSON.stringify({ ok: true, service: service.id, result });
        } catch (err) {
          const { code, message } = classifyTradingError(err);
          return JSON.stringify({ ok: false, service: service.id, code, error: message });
        }
      },
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Door 2: A2A structured operations
// ---------------------------------------------------------------------------

/**
 * Extract { operation, args } from an A2A request body: either the
 * JSON-RPC message/send envelope (a data part carrying
 * { operation, ...args } — the cfpay convention) or a bare
 * { operation, ...args } object.
 */
export function extractA2AOperation(body: unknown): { operation: string; args: Record<string, unknown> } | null {
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

export interface A2ADataResult {
  ok: boolean;
  operation?: string;
  service?: string;
  /** Stable error token (#291 A3) when ok is false. */
  code?: TradingErrorToken;
  correlationId?: string;
  result?: unknown;
  error?: string;
}

/** Dispatch one A2A body through the single execution path. Never throws. */
export async function dispatchTradingA2A(
  env: Env,
  config: TradingAgentConfig,
  body: unknown,
): Promise<A2ADataResult> {
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const service = getTradingServiceByOperation(extracted.operation);
  if (!service) {
    return {
      ok: false,
      operation: extracted.operation,
      code: "unknown_operation",
      correlationId,
      error: `Unknown operation: "${extracted.operation}".`,
    };
  }
  try {
    const result = await executeTradingService(env, config, {
      serviceId: service.id,
      input: extracted.args,
      door: "a2a",
      traceId: correlationId,
    });
    return { ok: true, operation: extracted.operation, service: service.id, correlationId, result };
  } catch (err) {
    const { code, message } = classifyTradingError(err);
    return {
      ok: false,
      operation: extracted.operation,
      service: service.id,
      code,
      correlationId,
      error: message,
    };
  }
}

/**
 * The collected A2A outcome (cfpay shape): every capability reply is
 * `{ text, data? }` — a human-readable text part is MANDATORY, the data
 * part carries the structured result. A DO method returns this plain
 * object; the HTTP transport (src/a2a) shapes it onto the wire, because
 * a Request/Response cannot cross the DO RPC boundary.
 */
export interface TradingA2AOutcome {
  text: string;
  data: A2ADataResult;
}

export function tradingA2AOutcome(data: A2ADataResult): TradingA2AOutcome {
  if (data.ok) {
    return {
      text: `${data.operation} completed${data.service ? ` (${data.service})` : ""}.`,
      data,
    };
  }
  return {
    text: `${data.operation ?? "trading operation"} failed: ${data.error ?? "unknown error"}`,
    data,
  };
}

/**
 * Extract the { text, data } reply from a collected outcome (cfpay's
 * a2aReplyFromOutcome) — the way in-process callers read an A2A result
 * without the HTTP transport.
 */
export function a2aReplyFromOutcome(outcome: unknown): { text: string; data?: unknown } {
  if (outcome && typeof outcome === "object") {
    const o = outcome as Record<string, unknown>;
    if (typeof o.text === "string") {
      return { text: o.text, data: o.data };
    }
  }
  return { text: "" };
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Order settlement — the shared core behind the approval door (T3) and the
// durable trade workflow (T3b)
// ---------------------------------------------------------------------------

/** Wrangler binding name of the trade approval workflow (#291 T3b). */
export const TRADE_WORKFLOW_BINDING = "TRADE_WORKFLOW" as const;

/** Params carried by the trade approval workflow — ids only, never credentials. */
export interface TradeApprovalParams {
  orderId: string;
  provider?: string;
  userLogin: string;
}

/** The decision event payload delivered to a waiting trade workflow. */
export interface TradeApprovalDecision {
  decision: "approved" | "rejected";
  authorizerDid: string;
  reason?: string;
}

export interface SettleTradingOrderInput {
  provider?: string;
  userLogin?: string;
  orderId: string;
  authorizerDid: string;
  decision: "approved" | "rejected";
}

/**
 * Settle one previewed order from an explicit, authorized decision:
 * validates the decision triple, resolves the platform through the
 * registry, and calls its executeOrder — which re-validates the draft
 * state and records the authorizer (claim-then-execute at the platform).
 * Shared by the synchronous approval door and the durable workflow, so
 * both paths enforce identical rules. Emits the A6 dispatch log line
 * under the caller's door name.
 */
export async function settleTradingOrder(
  env: Env,
  config: TradingAgentConfig,
  input: SettleTradingOrderInput,
  door: string,
): Promise<unknown> {
  const started = Date.now();
  const correlationId = crypto.randomUUID();
  try {
    if (!input?.orderId || typeof input.orderId !== "string") {
      throw new TradingServiceError("invalid_input", "settleTradingOrder requires an orderId.");
    }
    if (!input.authorizerDid || typeof input.authorizerDid !== "string") {
      throw new TradingServiceError(
        "invalid_input",
        "settleTradingOrder requires an authorizerDid — anonymous approvals are refused.",
      );
    }
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new TradingServiceError(
        "invalid_input",
        `settleTradingOrder decision must be "approved" or "rejected".`,
      );
    }
    const platform = resolveTradingPlatform(
      env,
      config,
      input.provider,
      input.userLogin ?? "default_trader",
    );
    if (typeof platform.executeOrder !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not support order execution.`,
      );
    }
    const result = await platform.executeOrder(input.orderId, input.authorizerDid, input.decision);
    logTradingDispatch({
      correlationId,
      door,
      service: "stock_trading",
      provider: platform.platformId,
      access: "action",
      ok: true,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    const { code, message } = classifyTradingError(err);
    logTradingDispatch({
      correlationId,
      door,
      service: "stock_trading",
      access: "action",
      ok: false,
      code,
      durationMs: Date.now() - started,
    });
    throw new TradingServiceError(code, message);
  }
}

export class TradingAgent extends Think<Env> {
  private config(): TradingAgentConfig {
    return getTradingAgentConfig(this.env as unknown as Record<string, unknown>);
  }

  getModel() {
    return resolveAiModelName(this.env, "tradingAgent");
  }

  getSystemPrompt(): string {
    const config = this.config();
    const services = liveTradingServices(config)
      .map((s) => `- ${s.toolName}: ${s.description}`)
      .join("\n");
    return [
      "You are the TradingAgent: the platform's provider-neutral trading competency.",
      `Providers enabled: ${config.enabledProviders.join(", ")} (default: ${config.defaultProvider}). ` +
        "Never assume a broker — resolve the provider per call; a new provider onboards without any change to your services.",
      "Services available to you:",
      services || "- (none enabled)",
      "Screening is read-only. Trading actions follow the platform's human-in-the-loop approval discipline: " +
        "preview first, and execute only with an approved execution context.",
    ].join("\n");
  }

  getTools(): ToolSet {
    return buildTradingTools(this.env, this.config());
  }

  /** Door 3: typed RPC for in-process callers. */
  async executeService(call: TradingServiceCall): Promise<unknown> {
    return executeTradingService(this.env, this.config(), { ...call, door: "rpc" });
  }

  /**
   * The approval door — the ONLY path that can place an order (#291 T3,
   * cfpay proposal -> approval -> verify -> execute). Deliberately NOT a
   * registry service: no Think tool and no A2A operation reaches it. The
   * caller must present the previewed order id, an explicit authorizer
   * identity, and the decision; the platform's executeOrder re-validates
   * the draft and records the authorizer. Rejection flows through the
   * same door with decision "rejected".
   */
  async executeApprovedOrder(input: {
    provider?: string;
    userLogin?: string;
    orderId: string;
    authorizerDid: string;
    decision: "approved" | "rejected";
  }): Promise<unknown> {
    return settleTradingOrder(this.env, this.config(), input, "rpc-approval");
  }

  /**
   * Start the durable approval workflow for a previewed order (#291 T3b).
   * Returns the workflow id; the workflow waits up to 24h for a decision
   * delivered via decideTradeApproval, then settles through the same core
   * as the synchronous door. Fails closed when the workflow binding is
   * not configured.
   */
  async startTradeApproval(input: {
    provider?: string;
    userLogin?: string;
    orderId: string;
  }): Promise<{ workflowId: string; orderId: string; status: "awaiting_approval" }> {
    if (!input?.orderId || typeof input.orderId !== "string") {
      throw new TradingServiceError("invalid_input", "startTradeApproval requires an orderId.");
    }
    if (!(TRADE_WORKFLOW_BINDING in this.env)) {
      throw new TradingServiceError(
        "internal_error",
        "The trade approval workflow is not configured (TRADE_WORKFLOW binding missing).",
      );
    }
    const params: TradeApprovalParams = {
      orderId: input.orderId,
      provider: input.provider,
      userLogin: input.userLogin ?? "default_trader",
    };
    const workflowId = await this.runWorkflow(TRADE_WORKFLOW_BINDING, params);
    return { workflowId, orderId: input.orderId, status: "awaiting_approval" };
  }

  /**
   * Deliver a decision to a waiting trade approval workflow (#291 T3b).
   * The authorizer identity is mandatory and travels in the event payload
   * — the workflow re-verifies it at settle time through the shared core.
   */
  async decideTradeApproval(input: {
    workflowId: string;
    authorizerDid: string;
    decision: "approved" | "rejected";
    reason?: string;
  }): Promise<{ workflowId: string; delivered: true }> {
    if (!input?.workflowId || typeof input.workflowId !== "string") {
      throw new TradingServiceError("invalid_input", "decideTradeApproval requires a workflowId.");
    }
    if (!input.authorizerDid || typeof input.authorizerDid !== "string") {
      throw new TradingServiceError(
        "invalid_input",
        "decideTradeApproval requires an authorizerDid — anonymous decisions are refused.",
      );
    }
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new TradingServiceError(
        "invalid_input",
        `decideTradeApproval decision must be "approved" or "rejected".`,
      );
    }
    await this.sendWorkflowEvent(TRADE_WORKFLOW_BINDING, input.workflowId, {
      type: "approval",
      payload: {
        decision: input.decision,
        authorizerDid: input.authorizerDid,
        reason: input.reason,
      },
    });
    return { workflowId: input.workflowId, delivered: true };
  }

  /**
   * Door 2: A2A endpoint, cfpay signature — the dispatcher in src/a2a
   * parses the HTTP request at the edge and calls this with the plain
   * body + origin (a Request cannot cross the DO RPC boundary). Returns
   * the collected { text, data } outcome; the transport shapes the wire.
   */
  async handleA2A(body: unknown, origin: string): Promise<TradingA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchTradingA2A(this.env, this.config(), body);
    return tradingA2AOutcome(data);
  }
}

/**
 * The one instance-name scheme, shared by every door: the default user's
 * instance is "trading" — the same name the A2A dispatcher resolves from
 * the URL — and other users get "trading:<login>". (Before the #291 A2
 * fix, the RPC helper used "default"/"trading:<login>" while A2A used
 * "trading", forking state per door.)
 */
export function tradingAgentName(userLogin: string): string {
  return userLogin === "default_trader" ? "trading" : `trading:${userLogin}`;
}

/**
 * Caller helper: the TradingAgent stub for a user, or null when the
 * TRADING_AGENT binding is not configured (callers degrade gracefully,
 * matching the ReportAssetAgent helper pattern).
 */
export function getTradingAgentStub(env: Env, userLogin: string): any | null {
  const ns = (env as any).TRADING_AGENT;
  if (!ns) return null;
  return ns.get(ns.idFromName(tradingAgentName(userLogin)));
}
