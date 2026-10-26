/**
 * Issue #1743 — W3C traceparent handling for the observability
 * port. Trace context is the correlation spine: the same trace
 * id rides the HTTP ingress header, the aspect wrapper, the
 * queue envelope extension, and the workflow command, so one
 * trace id queries the whole path in Analytics Engine.
 */
import { describe, it, expect } from "vitest";
import {
  newTraceContext,
  parseTraceparent,
  formatTraceparent,
  childSpan,
  traceContextFromHeaders,
  type TraceContext,
} from "../src/observability/observabilityPorts";

const VALID =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceparent", () => {
  it("parses a valid W3C traceparent", () => {
    const ctx = parseTraceparent(VALID);
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(ctx!.spanId).toBe("00f067aa0ba902b7");
    expect(ctx!.flags).toBe("01");
    expect(ctx!.parentSpanId).toBeUndefined();
  });

  it("rejects malformed values (never throws, never invents)", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "00-short-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
    ]) {
      expect(parseTraceparent(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("formatTraceparent / round-trip", () => {
  it("formats back to the canonical header", () => {
    expect(formatTraceparent(parseTraceparent(VALID)!)).toBe(VALID);
  });

  it("newTraceContext produces valid, distinct ids", () => {
    const a = newTraceContext();
    const b = newTraceContext();
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
    expect(parseTraceparent(formatTraceparent(a))).toEqual(a);
  });
});

describe("childSpan", () => {
  it("keeps the trace, links the parent, mints a new span", () => {
    const parent = parseTraceparent(VALID)!;
    const child = childSpan(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("traceContextFromHeaders", () => {
  it("continues an incoming traceparent", () => {
    const ctx = traceContextFromHeaders({
      get: (name: string) =>
        name.toLowerCase() === "traceparent" ? VALID : null,
    });
    expect(ctx.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("starts a fresh trace when the header is absent or malformed", () => {
    for (const header of [null, "garbage"]) {
      const ctx = traceContextFromHeaders({
        get: () => header,
      });
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

export type { TraceContext };
