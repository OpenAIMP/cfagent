/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * TDD red-first. Pins the gateway factory: null when the AI
 * binding is missing or has no run function; direct executor when
 * no gateway id is configured; Cloudflare gateway executor when
 * AI_GATEWAY_ID is set; env parsing (blank/invalid values are
 * ignored, never fatal). Composition roots are the only modules
 * mapping Worker bindings to port implementations.
 */
import { describe, expect, it } from "vitest";
import { createGatewayPorts, requireGatewayPorts } from "../src/gateway/createGatewayPorts";
import { getGatewayOptions, resolveGatewayConfig } from "../src/gateway/gatewayConfig";

// NOTE (#411 pin): the no_live_ai_binding guard scans test files
// syntactically for `AI:` sites and requires the RHS to start with
// `{}` or `{ run`. The binding stub is therefore inlined at each
// site below rather than referenced through a const identifier.
const runStub = async () => ({ response: "x" });

describe("resolveGatewayConfig", () => {
  it("parses gateway id, cache TTL seconds, and rate limit RPM", () => {
    expect(
      resolveGatewayConfig({ AI_GATEWAY_ID: " gw-1 ", AI_GATEWAY_CACHE_TTL: "120", AI_GATEWAY_RATE_LIMIT_RPM: "60" }),
    ).toEqual({ gatewayId: "gw-1", cacheTtlSeconds: 120, rateLimitRpm: 60 });
  });

  it("blank or invalid values degrade to undefined, never throw", () => {
    expect(resolveGatewayConfig({ AI_GATEWAY_ID: "  ", AI_GATEWAY_CACHE_TTL: "abc", AI_GATEWAY_RATE_LIMIT_RPM: "-5" })).toEqual({
      gatewayId: undefined,
      cacheTtlSeconds: undefined,
      rateLimitRpm: undefined,
    });
    expect(resolveGatewayConfig({})).toEqual({
      gatewayId: undefined,
      cacheTtlSeconds: undefined,
      rateLimitRpm: undefined,
    });
  });
});

describe("getGatewayOptions", () => {
  it("returns gateway options only when a gateway id is configured", () => {
    expect(getGatewayOptions({ AI_GATEWAY_ID: "gw-1", AI_GATEWAY_CACHE_TTL: "30" })).toEqual({
      id: "gw-1",
      cacheTtl: 30,
    });
    expect(getGatewayOptions({})).toBeUndefined();
    expect(getGatewayOptions({ AI_GATEWAY_ID: "   " })).toBeUndefined();
  });
});

describe("createGatewayPorts", () => {
  it("null when the AI binding is missing or has no run function", () => {
    expect(createGatewayPorts({} as never)).toBeNull();
    expect(createGatewayPorts({ AI: {} } as never)).toBeNull();
    expect(createGatewayPorts({ AI: null } as never)).toBeNull();
  });

  it("direct executor when no gateway id is configured", async () => {
    const port = createGatewayPorts({ AI: { run: runStub } } as never);
    expect(port).not.toBeNull();
    const result = await port!.generate({ models: ["@cf/m"], prompt: "hi", caller: "test" });
    expect(result.provider).toBe("direct");
  });

  it("gateway executor when AI_GATEWAY_ID is configured", async () => {
    const port = createGatewayPorts({ AI: { run: runStub }, AI_GATEWAY_ID: "gw-1" } as never);
    expect(port).not.toBeNull();
    const result = await port!.generate({ models: ["@cf/m"], prompt: "hi", caller: "test" });
    expect(result.provider).toBe("ai-gateway");
  });

  it("requireGatewayPorts throws a business error when the factory returns null", () => {
    expect(() => requireGatewayPorts({} as never)).toThrow(/AI binding/i);
  });
});
