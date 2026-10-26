/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * TDD red-first. Pins the LLM gateway port core: ordered failover
 * (retryable-only advance, non-retryable fail-fast, total failure
 * is a business error), per-tenant caching (tenant isolation, no
 * tenant / tools / skipCache / oversize => no cache), rate limiting
 * (no failover on limit), breaker-gated attempts (open => skip),
 * per-attempt timeouts, schema (generateObject) passthrough,
 * stats snapshots, and CloudEvents envelopes (counts only, never
 * prompts or outputs). Clock injected; no real provider calls.
 */
import { describe, expect, it } from "vitest";
import { jsonSchema } from "ai";
import {
  CoreLlmGatewayPort,
  GatewayAllProvidersFailedError,
  GatewayRateLimitedError,
  InMemoryGatewayCacheStore,
  TokenBucketGatewayRateLimiter,
  buildGatewayCacheKey,
  toGatewayEventEnvelope,
  type GatewayGenerateResult,
  type ModelExecutor,
  type ModelExecutorInput,
} from "../src/gateway/gatewayPorts";
import type { BreakerSnapshot, BreakerState, CircuitBreaker } from "../src/breakers/breakerPorts";

type ScriptStep =
  | { ok: true; text: string; object?: unknown }
  | { ok: false; error: Error };

function retryableError(message = "quota exceeded"): Error {
  const e = new Error(message);
  (e as unknown as { code: number }).code = 429;
  return e;
}

function permanentError(message = "bad credentials"): Error {
  const e = new Error(message);
  (e as unknown as { code: number }).code = 401;
  return e;
}

function fakeExecutor(
  script: ScriptStep[],
  kind: "ai-gateway" | "direct" = "direct",
): ModelExecutor & { calls: ModelExecutorInput[] } {
  const calls: ModelExecutorInput[] = [];
  let i = 0;
  return {
    kind,
    calls,
    async execute(input: ModelExecutorInput) {
      calls.push(input);
      const step = script[Math.min(i++, script.length - 1)];
      if (!step.ok) throw step.error;
      return { text: step.text, object: step.object };
    },
  };
}

function stubBreaker(open: boolean): CircuitBreaker {
  const state: BreakerState = open ? "open" : "closed";
  const snapshot: BreakerSnapshot = {
    providerId: "test-provider",
    state,
    consecutiveFailures: 0,
    totalCalls: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    totalTrips: 0,
    totalFallbacks: 0,
    totalRejected: 0,
    openedAtMs: null,
    lastFailureAtMs: null,
  };
  return {
    providerId: "test-provider",
    async execute<T>(fn: () => Promise<T>) {
      if (open) throw new Error("Breaker open: no provider call");
      const value = await fn();
      return { status: "success", value, state: "closed" };
    },
    getState: () => state,
    snapshot: () => snapshot,
    reset: () => {},
  };
}

describe("CoreLlmGatewayPort.generate", () => {
  it("success returns text, model, provider, no cache hit, one success attempt", async () => {
    const executor = fakeExecutor([{ ok: true, text: "hello" }], "ai-gateway");
    const port = new CoreLlmGatewayPort({ executor });
    const result = await port.generate({ models: ["@cf/m"], prompt: "hi", caller: "test" });
    expect(result.text).toBe("hello");
    expect(result.model).toBe("@cf/m");
    expect(result.provider).toBe("ai-gateway");
    expect(result.cacheHit).toBe(false);
    expect(result.attempts).toEqual([{ model: "@cf/m", status: "success" }]);
    expect(executor.calls).toHaveLength(1);
  });

  it("failover advances only on retryable errors, in order", async () => {
    const executor = fakeExecutor([
      { ok: false, error: retryableError() },
      { ok: true, text: "second" },
    ]);
    const port = new CoreLlmGatewayPort({ executor });
    const result = await port.generate({ models: ["m1", "m2"], prompt: "hi", caller: "test" });
    expect(result.text).toBe("second");
    expect(result.model).toBe("m2");
    expect(result.attempts.map((a) => `${a.model}:${a.status}`)).toEqual(["m1:failed", "m2:success"]);
    expect(port.snapshot().fallbacks).toBe(1);
  });

  it("non-retryable error fails fast with a business error, no failover", async () => {
    const executor = fakeExecutor([
      { ok: false, error: permanentError() },
      { ok: true, text: "never" },
    ]);
    const port = new CoreLlmGatewayPort({ executor });
    await expect(port.generate({ models: ["m1", "m2"], prompt: "hi", caller: "test" })).rejects.toBeInstanceOf(
      GatewayAllProvidersFailedError,
    );
    expect(executor.calls).toHaveLength(1);
    expect(port.snapshot().failures).toBe(1);
  });

  it("total retryable failure is a business error, never a raw provider error", async () => {
    const executor = fakeExecutor([
      { ok: false, error: retryableError() },
      { ok: false, error: retryableError("overloaded") },
    ]);
    const port = new CoreLlmGatewayPort({ executor });
    let caught: unknown;
    try {
      await port.generate({ models: ["m1", "m2"], prompt: "hi", caller: "test" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayAllProvidersFailedError);
    expect((caught as Error).message).not.toMatch(/quota|overloaded/);
    expect(port.snapshot().failures).toBe(1);
  });

  it("cache: repeat identical call with a tenant does not re-hit the executor", async () => {
    const executor = fakeExecutor([{ ok: true, text: "cached" }]);
    const port = new CoreLlmGatewayPort({ executor, cache: new InMemoryGatewayCacheStore() });
    const input = { models: ["@cf/m"], prompt: "hi", tenantId: "tenant-a", caller: "test" };
    const first = await port.generate(input);
    const second = await port.generate(input);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.text).toBe("cached");
    expect(second.attempts).toEqual([]);
    expect(executor.calls).toHaveLength(1);
    expect(port.snapshot().cacheHits).toBe(1);
  });

  it("cache isolation: tenant B never gets tenant A's cached entry", async () => {
    const executor = fakeExecutor([{ ok: true, text: "a" }, { ok: true, text: "b" }]);
    const port = new CoreLlmGatewayPort({ executor, cache: new InMemoryGatewayCacheStore() });
    await port.generate({ models: ["@cf/m"], prompt: "hi", tenantId: "tenant-a", caller: "test" });
    const second = await port.generate({ models: ["@cf/m"], prompt: "hi", tenantId: "tenant-b", caller: "test" });
    expect(second.cacheHit).toBe(false);
    expect(second.text).toBe("b");
    expect(executor.calls).toHaveLength(2);
  });

  it("no tenant, tools, skipCache, or oversize input => never cached", async () => {
    const executor = fakeExecutor([
      { ok: true, text: "1" },
      { ok: true, text: "2" },
      { ok: true, text: "3" },
      { ok: true, text: "4" },
      { ok: true, text: "5" },
      { ok: true, text: "6" },
      { ok: true, text: "7" },
      { ok: true, text: "8" },
    ]);
    const port = new CoreLlmGatewayPort({ executor, cache: new InMemoryGatewayCacheStore() });
    const noTenant = { models: ["@cf/m"], prompt: "hi", caller: "test" };
    await port.generate(noTenant);
    await port.generate(noTenant);
    const withTools = { models: ["@cf/m"], prompt: "hi", tenantId: "t", tools: {}, caller: "test" };
    await port.generate(withTools);
    await port.generate(withTools);
    const skipped = { models: ["@cf/m"], prompt: "hi", tenantId: "t", skipCache: true, caller: "test" };
    await port.generate(skipped);
    await port.generate(skipped);
    const big = { models: ["@cf/m"], prompt: "x".repeat(9000), tenantId: "t", caller: "test" };
    await port.generate(big);
    await port.generate(big);
    expect(executor.calls).toHaveLength(8);
    expect(port.snapshot().cacheHits).toBe(0);
  });

  it("schema path passes object through; tools+schema is a programming error", async () => {
    const executor = fakeExecutor([{ ok: true, text: '{"a":1}', object: { a: 1 } }]);
    const port = new CoreLlmGatewayPort({ executor });
    const result = await port.generate({
      models: ["@cf/m"],
      prompt: "hi",
      schema: jsonSchema({ type: "object" }),
      caller: "test",
    });
    expect(result.object).toEqual({ a: 1 });
    await expect(
      port.generate({ models: ["@cf/m"], prompt: "hi", schema: {}, tools: {}, caller: "test" }),
    ).rejects.toThrow();
  });

  it("rate limit: second call is a business error, no failover, no executor call", async () => {
    const executor = fakeExecutor([{ ok: true, text: "ok" }, { ok: true, text: "never" }]);
    const limiter = new TokenBucketGatewayRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const port = new CoreLlmGatewayPort({ executor, limiter });
    await port.generate({ models: ["m1", "m2"], prompt: "hi", caller: "test" });
    await expect(port.generate({ models: ["m1", "m2"], prompt: "hi", caller: "test" })).rejects.toBeInstanceOf(
      GatewayRateLimitedError,
    );
    expect(executor.calls).toHaveLength(1);
    expect(port.snapshot().rateLimited).toBe(1);
  });

  it("breaker: open breaker skips the attempt and failover continues", async () => {
    const executor = fakeExecutor([{ ok: true, text: "second" }]);
    const port = new CoreLlmGatewayPort({ executor });
    const result = await port.generate({
      models: ["m1", "m2"],
      prompt: "hi",
      breakerFor: (model) => (model === "m1" ? stubBreaker(true) : stubBreaker(false)),
      caller: "test",
    });
    expect(result.text).toBe("second");
    expect(result.model).toBe("m2");
    expect(result.attempts.map((a) => `${a.model}:${a.status}`)).toEqual(["m1:skipped", "m2:success"]);
    expect(port.snapshot().fallbacks).toBe(1);
  });

  it("per-attempt timeout fails fast as a business error", async () => {
    const hanging: ModelExecutor = {
      kind: "direct",
      async execute(input) {
        await new Promise<void>((_resolve, reject) => {
          input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { text: "never" };
      },
    };
    const port = new CoreLlmGatewayPort({ executor: hanging });
    await expect(
      port.generate({ models: ["m1"], prompt: "hi", timeoutMs: 10, caller: "test" }),
    ).rejects.toBeInstanceOf(GatewayAllProvidersFailedError);
  });

  it("stats snapshot counts requests, attempts by model, failures", async () => {
    const executor = fakeExecutor([
      { ok: true, text: "ok" },
      { ok: false, error: retryableError() },
      { ok: false, error: retryableError() },
    ]);
    const port = new CoreLlmGatewayPort({ executor });
    await port.generate({ models: ["m1"], prompt: "hi", caller: "test" });
    await expect(port.generate({ models: ["m1", "m2"], prompt: "hi", caller: "test" })).rejects.toBeInstanceOf(
      GatewayAllProvidersFailedError,
    );
    const snap = port.snapshot();
    expect(snap.requests).toBe(2);
    expect(snap.failures).toBe(1);
    expect(snap.attemptsByModel).toMatchObject({ m1: 2, m2: 1 });
  });

  it("cache key is null without tenant, with tools, or oversize; stable otherwise", () => {
    expect(buildGatewayCacheKey({ models: ["m"], prompt: "hi" })).toBeNull();
    expect(buildGatewayCacheKey({ models: ["m"], prompt: "hi", tenantId: "t", tools: {} })).toBeNull();
    expect(buildGatewayCacheKey({ models: ["m"], prompt: "x".repeat(9001), tenantId: "t" })).toBeNull();
    const a = buildGatewayCacheKey({ models: ["m"], prompt: "hi", tenantId: "t" });
    const b = buildGatewayCacheKey({ models: ["m"], prompt: "hi", tenantId: "t" });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("envelopes carry counts only, never prompts or outputs", () => {
    const envelope = toGatewayEventEnvelope({
      type: "gateway.request_completed",
      model: "@cf/m",
      provider: "direct",
      cacheHit: false,
      attempts: 1,
      durationMs: 12,
      atMs: 1_000_000,
      seq: 7,
    });
    expect(envelope.specversion).toBe("1.0");
    expect(envelope.type).toBe("gateway.request_completed");
    expect(envelope.subject).toBe("@cf/m");
    expect(envelope.id).toContain("7");
    const data = envelope.data as Record<string, unknown>;
    expect(data).toMatchObject({ model: "@cf/m", provider: "direct", cacheHit: false, attempts: 1 });
    expect(JSON.stringify(envelope)).not.toMatch(/secret-prompt|secret-output/);
  });
});

describe("CoreLlmGatewayPort validation", () => {
  it("empty model list and prompt+messages both throw", async () => {
    const executor = fakeExecutor([{ ok: true, text: "x" }]);
    const port = new CoreLlmGatewayPort({ executor });
    await expect(port.generate({ models: [], prompt: "hi", caller: "test" })).rejects.toThrow();
    await expect(
      port.generate({ models: ["m"], prompt: "hi", messages: [{ role: "user", content: "hi" }], caller: "test" }),
    ).rejects.toThrow();
    await expect(port.generate({ models: ["m"], caller: "test" })).rejects.toThrow();
  });
});

export type { GatewayGenerateResult };
