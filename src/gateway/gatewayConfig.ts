/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * Pure env reading for the gateway port. Kept separate from the
 * model layer so src/agents/model.ts can gain gateway options
 * without a model -> gateway -> router import cycle. All values
 * are plain Worker vars (owner-set, like AI_MODEL); blank or
 * invalid values degrade to undefined, never throw.
 *
 * Activation is owner-side: create an AI Gateway in the
 * Cloudflare dashboard and set AI_GATEWAY_ID as a plain var.
 * The id is never invented here, and the slice never writes it
 * into wrangler.jsonc.
 */

export interface GatewayEnvLike {
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_CACHE_TTL?: string;
  AI_GATEWAY_RATE_LIMIT_RPM?: string;
}

export interface GatewayConfig {
  gatewayId?: string;
  /** Gateway cache TTL in seconds (AI Gateway cacheTtl option). */
  cacheTtlSeconds?: number;
  /** Gateway rate limit in requests per minute (port-level limiter). */
  rateLimitRpm?: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveGatewayConfig(env: GatewayEnvLike): GatewayConfig {
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  return {
    gatewayId: gatewayId ? gatewayId : undefined,
    cacheTtlSeconds: parsePositiveInt(env.AI_GATEWAY_CACHE_TTL),
    rateLimitRpm: parsePositiveInt(env.AI_GATEWAY_RATE_LIMIT_RPM),
  };
}

/** Gateway options for workers-ai-provider's createWorkersAI, or undefined when no gateway is configured. */
export function getGatewayOptions(env: GatewayEnvLike): { id: string; cacheTtl?: number } | undefined {
  const config = resolveGatewayConfig(env);
  if (!config.gatewayId) return undefined;
  return { id: config.gatewayId, ...(config.cacheTtlSeconds !== undefined ? { cacheTtl: config.cacheTtlSeconds } : {}) };
}
