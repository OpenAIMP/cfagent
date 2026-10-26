/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * Composition root: the ONLY module mapping the Worker AI
 * binding to gateway port implementations (same convention as
 * src/messaging/createMessagingPorts.ts and
 * src/retrieval/createRetrievalPorts.ts).
 *
 * - Returns null when the AI binding is missing or has no run
 *   function, so callers keep their prior behavior (same guard
 *   as llmPlanning/newsSentiment's hasAi checks).
 * - Gateway executor when AI_GATEWAY_ID is configured, direct
 *   executor otherwise; the core (cache/limiter/failover/stats/
 *   events) is identical for both.
 * - The in-memory adapter is constructed explicitly by callers
 *   (tests, local dev) via CoreLlmGatewayPort — never silently
 *   substituted for a provider binding in production.
 * - Stats and cache are module singletons per isolate (same loss
 *   semantics as defaultBreakerRegistry(): an isolate recycle
 *   resets them — fail-open, never fail-closed).
 */
import { CloudflareAiGatewayExecutor } from "./cfGatewayExecutor";
import { WorkersAiDirectExecutor } from "./directExecutor";
import { resolveGatewayConfig, type GatewayEnvLike } from "./gatewayConfig";
import {
  CoreLlmGatewayPort,
  GatewayStatsAccumulator,
  InMemoryGatewayCacheStore,
  TokenBucketGatewayRateLimiter,
  type GatewayCacheStore,
  type LlmGatewayPort,
  type ModelExecutor,
} from "./gatewayPorts";

export interface GatewayFactoryEnv extends GatewayEnvLike {
  AI?: { run?: unknown } | null;
}

export interface CreateGatewayPortsOptions {
  executor?: ModelExecutor;
  cache?: GatewayCacheStore;
  limiter?: TokenBucketGatewayRateLimiter;
  stats?: GatewayStatsAccumulator;
  emit?: (envelope: import("../messaging/messagingPorts").MessageEnvelope) => Promise<void>;
  log?: (message: string) => void;
  nowMs?: () => number;
}

const moduleStats = new GatewayStatsAccumulator();
const moduleCache = new InMemoryGatewayCacheStore();

/** Module-singleton stats snapshot, for telemetry summary wiring. */
export function gatewayStatsSnapshot(): import("./gatewayPorts").GatewayStatsSnapshot {
  return moduleStats.snapshot();
}

/** Test-only reset of the module-singleton stats. */
export function resetGatewayStats(): void {
  moduleStats.reset();
}

export function createGatewayPorts(
  env: GatewayFactoryEnv,
  opts: CreateGatewayPortsOptions = {},
): LlmGatewayPort | null {
  const binding = env.AI;
  if (!binding || typeof binding.run !== "function") return null;
  const config = resolveGatewayConfig(env);
  const executor =
    opts.executor ??
    (config.gatewayId
      ? new CloudflareAiGatewayExecutor(binding as never, {
          id: config.gatewayId,
          ...(config.cacheTtlSeconds !== undefined ? { cacheTtlSeconds: config.cacheTtlSeconds } : {}),
        })
      : new WorkersAiDirectExecutor(binding as never));
  const limiter =
    opts.limiter ?? (config.rateLimitRpm !== undefined
      ? new TokenBucketGatewayRateLimiter({ maxRequests: config.rateLimitRpm, windowMs: 60_000 })
      : undefined);
  return new CoreLlmGatewayPort({
    executor,
    cache: opts.cache ?? moduleCache,
    limiter,
    stats: opts.stats ?? moduleStats,
    emit: opts.emit,
    log: opts.log,
    nowMs: opts.nowMs,
  });
}

/** Like createGatewayPorts, but throws a business error instead of returning null. */
export function requireGatewayPorts(env: GatewayFactoryEnv, opts: CreateGatewayPortsOptions = {}): LlmGatewayPort {
  const port = createGatewayPorts(env, opts);
  if (!port) throw new Error("LLM gateway unavailable: AI binding is not configured.");
  return port;
}
