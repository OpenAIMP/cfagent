/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * TDD red-first. Pins the two model executors against a fake
 * Workers AI binding: the Cloudflare AI Gateway executor forwards
 * the gateway id (+ cache TTL when configured) as the 3rd-arg
 * gateway options to binding.run, and the direct executor passes
 * no gateway options at all. No real provider calls.
 */
import { describe, expect, it } from "vitest";
import { jsonSchema } from "ai";
import { CloudflareAiGatewayExecutor } from "../src/gateway/cfGatewayExecutor";
import { WorkersAiDirectExecutor } from "../src/gateway/directExecutor";

interface BindingCall {
  model: string;
  inputs: unknown;
  options: unknown;
}

function fakeBinding(calls: BindingCall[]) {
  return {
    run: async (model: string, inputs: unknown, options: unknown) => {
      calls.push({ model, inputs, options });
      return { response: "hello from model" };
    },
  };
}

describe("CloudflareAiGatewayExecutor", () => {
  it("forwards gateway id and cache TTL to binding.run", async () => {
    const calls: BindingCall[] = [];
    const executor = new CloudflareAiGatewayExecutor(fakeBinding(calls) as never, {
      id: "gw-test",
      cacheTtlSeconds: 120,
    });
    expect(executor.kind).toBe("ai-gateway");
    const result = await executor.execute({ model: "@cf/m", prompt: "hi" });
    expect(result.text).toBe("hello from model");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("@cf/m");
    const options = calls[0].options as { gateway?: { id?: string; cacheTtl?: number } } | undefined;
    expect(options?.gateway?.id).toBe("gw-test");
    expect(options?.gateway?.cacheTtl).toBe(120);
  });

  it("omits cacheTtl when unconfigured (gateway default applies)", async () => {
    const calls: BindingCall[] = [];
    const executor = new CloudflareAiGatewayExecutor(fakeBinding(calls) as never, { id: "gw-test" });
    await executor.execute({ model: "@cf/m", prompt: "hi" });
    const options = calls[0].options as { gateway?: { id?: string; cacheTtl?: number } } | undefined;
    expect(options?.gateway?.id).toBe("gw-test");
    expect(options?.gateway?.cacheTtl).toBeUndefined();
  });

  it("schema path returns the parsed object", async () => {
    const calls: BindingCall[] = [];
    const binding = {
      run: async () => ({ response: '{"score": 42}' }),
    };
    void calls;
    const executor = new CloudflareAiGatewayExecutor(binding as never, { id: "gw-test" });
    const result = await executor.execute({
      model: "@cf/m",
      prompt: "hi",
      schema: jsonSchema<{ score: number }>({
        type: "object",
        properties: { score: { type: "number" } },
        required: ["score"],
        additionalProperties: false,
      }),
    });
    expect(result.object).toEqual({ score: 42 });
  });
});

describe("WorkersAiDirectExecutor", () => {
  it("passes no gateway options to binding.run (current path, unchanged)", async () => {
    const calls: BindingCall[] = [];
    const executor = new WorkersAiDirectExecutor(fakeBinding(calls) as never);
    expect(executor.kind).toBe("direct");
    const result = await executor.execute({ model: "@cf/m", prompt: "hi" });
    expect(result.text).toBe("hello from model");
    const options = calls[0].options as { gateway?: unknown } | undefined;
    expect(options?.gateway).toBeUndefined();
  });
});
