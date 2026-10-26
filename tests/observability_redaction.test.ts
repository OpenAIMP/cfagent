/**
 * Issue #1743 — PII/credential-negative pins for the stream.
 * The Analytics Engine stream must NEVER carry secrets, tokens,
 * passwords, authorization material, cookies, or session
 * material. Redaction is key-based and recursive; a sensitive
 * key maps to "***" no matter how deeply it nests. Session
 * scope rides as a truncated hash correlator (sessionRef),
 * never as the session id itself.
 */
import { describe, it, expect } from "vitest";
import {
  redactForStream,
  sessionRefFor,
} from "../src/observability/observabilityPorts";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import type { ObservabilityEvent } from "../src/observability/observabilityPorts";

function baseEvent(fields: Record<string, unknown>): ObservabilityEvent {
  return {
    type: "test.event",
    level: "info",
    operation: "test",
    tenantId: "tenant-a",
    runId: null,
    sessionRef: null,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    timestampMs: 1700000000000,
    fields,
  };
}

describe("redactForStream", () => {
  it("redacts sensitive keys at any depth", () => {
    const out = redactForStream({
      password: "hunter2",
      nested: { apiKey: "sk-live-123", ok: 1 },
      list: [{ authorization: "Bearer abc", fine: "x" }],
      token: "tok_1234567890",
      cookie: "session=abc",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      clientSecret: "shh",
      consumerKey: "ck",
      normal: "kept",
    }) as Record<string, any>;
    expect(out.password).toBe("***");
    expect(out.nested.apiKey).toBe("***");
    expect(out.nested.ok).toBe(1);
    expect(out.list[0].authorization).toBe("***");
    expect(out.list[0].fine).toBe("x");
    expect(out.token).toBe("***");
    expect(out.cookie).toBe("***");
    expect(out.sessionId).toBe("***");
    expect(out.clientSecret).toBe("***");
    expect(out.consumerKey).toBe("***");
    expect(out.normal).toBe("kept");
  });

  it("passes primitives and non-sensitive structures through", () => {
    expect(redactForStream("hello")).toBe("hello");
    expect(redactForStream(42)).toBe(42);
    expect(redactForStream(null)).toBeNull();
    expect(redactForStream({ count: 3, ok: true })).toEqual({
      count: 3,
      ok: true,
    });
  });
});

describe("sessionRefFor", () => {
  it("is deterministic, truncated, and never the session id", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const ref = sessionRefFor(id);
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(ref).not.toContain(id);
    expect(sessionRefFor(id)).toBe(ref);
    expect(sessionRefFor("550e8400-e29b-41d4-a716-446655440001")).not.toBe(
      ref,
    );
  });
});

describe("adapter-level redaction (port behavior, both adapters)", () => {
  it("in-memory adapter stores redacted fields, never raw secrets", async () => {
    const adapter = new InMemoryObservabilityAdapter();
    await adapter.write(
      baseEvent({
        password: "hunter2",
        model: "llama",
        nested: { token: "t" },
      }),
    );
    const stored = adapter.events[0];
    expect((stored.fields as Record<string, unknown>).password).toBe("***");
    expect(
      (stored.fields.nested as Record<string, unknown>).token,
    ).toBe("***");
    expect(stored.fields.model).toBe("llama");
    expect(JSON.stringify(stored)).not.toContain("hunter2");
  });
});
