/**
 * Issue #1743 — Foundation-layer aspect interceptors.
 * withObservability wraps a function with tracing + logging +
 * metrics + correlation in one place: one completion event with
 * duration, or one error event with a code (never a message).
 * The wrapped function's result and error pass through
 * untouched — observability never changes behavior.
 * withRequestObservability is the HTTP boundary: it honors an
 * incoming traceparent, times the request, and returns the
 * handler's response byte-identically (parity: on vs off).
 */
import { describe, it, expect, vi } from "vitest";
import {
  withObservability,
  withRequestObservability,
  type ObservabilityAspectContext,
} from "../src/observability/aspects";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import { newTraceContext } from "../src/observability/observabilityPorts";

function ctx(
  sink: InMemoryObservabilityAdapter,
  over: Partial<ObservabilityAspectContext> = {},
): ObservabilityAspectContext {
  let now = 1000;
  return {
    sink,
    operation: "test.op",
    nowMs: () => now,
    ...over,
  };
}

describe("withObservability", () => {
  it("emits one completion event with duration and returns the result", async () => {
    const sink = new InMemoryObservabilityAdapter();
    let now = 1000;
    const c = ctx(sink, { nowMs: () => now });
    const result = await withObservability(c, async () => {
      now = 1042;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(sink.events).toHaveLength(1);
    const [e] = sink.events;
    expect(e.operation).toBe("test.op");
    expect(e.level).toBe("info");
    expect(e.durationMs).toBe(42);
    expect(e.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(e.tenantId).toBeNull();
  });

  it("carries tenant/run/session scope and an incoming trace", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const trace = newTraceContext();
    await withObservability(
      ctx(sink, {
        tenantId: "tenant-a",
        runId: "run-1",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        trace,
      }),
      async () => 1,
    );
    const [e] = sink.events;
    expect(e.tenantId).toBe("tenant-a");
    expect(e.runId).toBe("run-1");
    expect(e.traceId).toBe(trace.traceId);
    expect(e.sessionRef).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(e)).not.toContain("550e8400");
  });

  it("emits one error event with a code (never the message) and rethrows the original", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const original = new Error("db exploded with secret detail");
    (original as Error & { code?: string }).code = "DB_001";
    await expect(
      withObservability(ctx(sink), async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(sink.events).toHaveLength(1);
    const [e] = sink.events;
    expect(e.level).toBe("error");
    expect(e.errorCode).toBe("DB_001");
    expect(JSON.stringify(e)).not.toContain("db exploded");
  });

  it("uses 'unknown' for codeless errors, still without the message", async () => {
    const sink = new InMemoryObservabilityAdapter();
    await expect(
      withObservability(ctx(sink), async () => {
        throw new Error("raw failure detail");
      }),
    ).rejects.toThrow("raw failure detail");
    expect(sink.events[0].errorCode).toBe("unknown");
    expect(JSON.stringify(sink.events[0])).not.toContain("raw failure");
  });

  it("a failing sink never fails the wrapped call (degradation)", async () => {
    const failing = {
      write: () => {
        throw new Error("AE down");
      },
      writeBatch: () => {
        throw new Error("AE down");
      },
    };
    const result = await withObservability(
      ctx(failing as never),
      async () => "still-ok",
    );
    expect(result).toBe("still-ok");
  });
});

describe("withRequestObservability", () => {
  it("returns the handler response unchanged and emits one request event", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const wrapped = withRequestObservability(
      async () => new Response("hello", { status: 201 }),
      { sinkFor: () => sink, nowMs: () => 5000 },
    );
    const res = await wrapped(
      new Request("https://agent.internal/api/x", { method: "POST" }),
      {},
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hello");
    expect(sink.events).toHaveLength(1);
    const [e] = sink.events;
    expect(e.type).toBe("http.request");
    expect(e.operation).toBe("http.request");
    expect(e.fields.method).toBe("POST");
    expect(e.fields.status).toBe(201);
    expect(e.level).toBe("info");
  });

  it("continues an incoming traceparent and marks 5xx as error level", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const wrapped = withRequestObservability(
      async () => new Response("boom", { status: 500 }),
      { sinkFor: () => sink, nowMs: () => 5000 },
    );
    await wrapped(
      new Request("https://agent.internal/api/x", {
        headers: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
      {},
    );
    const [e] = sink.events;
    expect(e.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(e.level).toBe("error");
    expect(e.fields.status).toBe(500);
  });

  it("a throwing handler emits an error event and the throw propagates", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const wrapped = withRequestObservability(
      async () => {
        throw new Error("handler blew up");
      },
      { sinkFor: () => sink, nowMs: () => 5000 },
    );
    await expect(
      wrapped(new Request("https://agent.internal/api/x"), {}),
    ).rejects.toThrow("handler blew up");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].level).toBe("error");
    expect(sink.events[0].errorCode).toBe("unknown");
  });

  it("parity: the same handler with and without a sink returns the same response", async () => {
    const handler = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const req = () => new Request("https://agent.internal/api/x");
    const withSink = withRequestObservability(handler, {
      sinkFor: () => new InMemoryObservabilityAdapter(),
      nowMs: () => 5000,
    });
    const withoutSink = withRequestObservability(handler, {
      sinkFor: () => null,
      nowMs: () => 5000,
    });
    const a = await withSink(req(), {});
    const b = await withoutSink(req(), {});
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });
});

vi.stubGlobal("console", console);
