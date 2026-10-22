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
  type ITradingPlatform,
  type TradingPlatformId,
} from "../trading";
import {
  getTradingAgentConfig,
  isTradingServiceEnabled,
  type TradingAgentConfig,
} from "../config/tradingAgentConfig";

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
      throw new Error(
        `Provider "${platform.platformId}" does not support stock screening.`,
      );
    }
    return platform.screenMarkets(input.filter ?? {});
  },
};

/** The service registry. Add a service = one module + one line here. */
export const TRADING_SERVICE_REGISTRY: TradingServiceDef[] = [stockScreeningService];

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
    throw new Error(
      `Provider "${provider}" is not enabled for the TradingAgent ` +
        `(enabled: ${config.enabledProviders.join(", ") || "none"}).`,
    );
  }
  const registered = TradingPlatformRegistry.getRegisteredPlatforms() as string[];
  if (!registered.includes(provider)) {
    throw new Error(
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
}

/**
 * The single execution path behind every door (tool / A2A / RPC).
 * Validates the service exists and is enabled, parses the input against
 * the service schema, then executes. Errors are thrown with stable,
 * caller-safe messages; door adapters shape them for their surface.
 */
export async function executeTradingService(
  env: Env,
  config: TradingAgentConfig,
  call: TradingServiceCall,
): Promise<unknown> {
  const service = getTradingService(call.serviceId);
  if (!service) throw new Error(`Unknown trading service: "${call.serviceId}".`);
  if (!isTradingServiceEnabled(config, service.id)) {
    throw new Error(`Trading service "${service.id}" is disabled by configuration.`);
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
  return service.execute(ctx, input);
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
          });
          return JSON.stringify({ ok: true, service: service.id, result });
        } catch (err) {
          return JSON.stringify({
            ok: false,
            service: service.id,
            error: err instanceof Error ? err.message : String(err),
          });
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
  result?: unknown;
  error?: string;
}

/** Dispatch one A2A body through the single execution path. Never throws. */
export async function dispatchTradingA2A(
  env: Env,
  config: TradingAgentConfig,
  body: unknown,
): Promise<A2ADataResult> {
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return { ok: false, error: "No A2A operation found in the request body." };
  }
  const service = getTradingServiceByOperation(extracted.operation);
  if (!service) {
    return {
      ok: false,
      operation: extracted.operation,
      error: `Unknown operation: "${extracted.operation}".`,
    };
  }
  try {
    const result = await executeTradingService(env, config, {
      serviceId: service.id,
      input: extracted.args,
    });
    return { ok: true, operation: extracted.operation, service: service.id, result };
  } catch (err) {
    return {
      ok: false,
      operation: extracted.operation,
      service: service.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

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
    return executeTradingService(this.env, this.config(), call);
  }

  /** Door 2: A2A endpoint (the dispatcher in src/a2a forwards the raw request). */
  async handleA2A(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400 },
      );
    }
    const id =
      body && typeof body === "object" && "id" in body ? (body as any).id : null;
    const data = await dispatchTradingA2A(this.env, this.config(), body);
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: {
        artifacts: [{ parts: [{ kind: "data", data }] }],
      },
    });
  }
}

/** Stable per-user instance name (assets-style namespacing). */
export function tradingAgentName(userLogin: string): string {
  return userLogin === "default_trader" ? "default" : `trading:${userLogin}`;
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
