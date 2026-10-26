/**
 * Issue #1743 — envelope folding: the stream's ingestion path.
 * Known CloudEvents envelope types fold into ObservabilityEvents
 * by WHITELIST: only listed count/id fields survive. Prompt
 * text, thesis text, actor identities, and any other user
 * material never reach Analytics Engine, even when a producer
 * envelope happens to carry it. Unknown types and malformed
 * data fold to null (ignored, never thrown).
 */
import { describe, it, expect } from "vitest";
import {
  foldEnvelopeToEvent,
  writeEnvelopeToSink,
} from "../src/observability/observabilityPorts";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";

function envelope(
  over: Partial<MessageEnvelope> & { type: string },
): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "evt-1",
    source: "test",
    time: "2026-10-26T00:00:00.000Z",
    data: {},
    ...over,
  };
}

describe("foldEnvelopeToEvent", () => {
  it("folds telemetry.realization_recorded with counts and run scope", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "telemetry.realization_recorded",
        id: "telemetry-realization:tenant-a:run-1:SYM:struct",
        correlationid: "telemetry:run-1:SYM:struct",
        data: {
          tenantId: "tenant-a",
          outcomeId: "run-1:SYM:struct",
          agentKey: "research",
          structure: "struct",
          regime: "bull",
          directionCorrect: true,
          falsified: false,
        },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.operation).toBe("telemetry.realization");
    expect(e!.tenantId).toBe("tenant-a");
    expect(e!.runId).toBe("run-1");
    expect(e!.fields.agentKey).toBe("research");
    expect(e!.fields.falsified).toBe(false);
    expect(e!.traceId).toBe("telemetry:run-1:SYM:struct");
  });

  it("folds calibration events WITHOUT promptKey/thesis text", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "telemetry.calibration_proposed",
        id: "telemetry-calibration-proposed:dec-1",
        data: {
          tenantId: "tenant-a",
          decisionId: "dec-1",
          actorKey: "research",
          promptKey: "thesis:Secret user thesis text here",
          dimension: "thesis",
          sliceKey: "Secret user thesis text here",
          evaluated: 30,
          hits: 10,
          falsificationRate: 0.667,
        },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.fields.evaluated).toBe(30);
    expect(e!.fields.falsificationRate).toBe(0.667);
    expect(JSON.stringify(e)).not.toContain("Secret user thesis");
    expect(JSON.stringify(e)).not.toContain("promptKey");
  });

  it("folds breaker.state_changed with provider + counts", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "breaker.state_changed",
        id: "breaker-state:yahoo:open:3",
        subject: "yahoo",
        data: {
          providerId: "yahoo",
          from: "closed",
          to: "open",
          trips: 3,
          fallbacks: 1,
        },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.operation).toBe("breaker.state_changed");
    expect(e!.level).toBe("warn");
    expect(e!.fields.providerId).toBe("yahoo");
    expect(e!.fields.to).toBe("open");
    expect(e!.fields.trips).toBe(3);
  });

  it("folds gateway events with model + attempts + duration", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "gateway.fallback",
        id: "gateway:gateway.fallback:7",
        subject: "llama-3",
        data: {
          model: "llama-3",
          provider: "workers-ai",
          cacheHit: false,
          attempts: 2,
          durationMs: 1234,
        },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.operation).toBe("gateway.fallback");
    expect(e!.durationMs).toBe(1234);
    expect(e!.fields.attempts).toBe(2);
    expect(e!.fields.model).toBe("llama-3");
  });

  it("folds retrieval.completed with counts only (no tenant context exists)", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "retrieval.completed",
        id: "ret-1",
        data: { denseCount: 8, graphCount: 4, degraded: true },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.operation).toBe("retrieval.completed");
    expect(e!.tenantId).toBeNull();
    expect(e!.fields.denseCount).toBe(8);
    expect(e!.fields.degraded).toBe(true);
  });

  it("folds screener.completed/failed with delivery scope, failed as error", () => {
    const ok = foldEnvelopeToEvent(
      envelope({
        type: "screener.completed",
        subject: "del-1",
        data: {
          event: { type: "screener.completed", timestamp: "2026-10-26T00:00:00.000Z" },
          ownerLogin: "owner-1",
        },
      }),
    );
    expect(ok).not.toBeNull();
    expect(ok!.tenantId).toBe("owner-1");
    expect(ok!.level).toBe("info");
    expect(ok!.fields.deliveryId).toBe("del-1");
    const failed = foldEnvelopeToEvent(
      envelope({
        type: "screener.failed",
        subject: "del-2",
        data: {
          event: { type: "screener.failed", timestamp: "2026-10-26T00:00:00.000Z", error: "secret detail" },
        },
      }),
    );
    expect(failed).not.toBeNull();
    expect(failed!.level).toBe("error");
    expect(JSON.stringify(failed)).not.toContain("secret detail");
  });

  it("preserves an envelope traceparent as the event trace", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "gateway.cache_hit",
        traceparent:
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        data: {
          model: "m",
          provider: "workers-ai",
          cacheHit: true,
          attempts: 1,
          durationMs: 5,
        },
      }),
    );
    expect(e!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("ignores unknown types and malformed data (null, never throw)", () => {
    expect(
      foldEnvelopeToEvent(envelope({ type: "something.else", data: {} })),
    ).toBeNull();
    expect(
      foldEnvelopeToEvent(
        envelope({
          type: "retrieval.completed",
          data: { denseCount: "eight" },
        }),
      ),
    ).toBeNull();
    expect(
      foldEnvelopeToEvent(
        envelope({ type: "breaker.state_changed", data: null }),
      ),
    ).toBeNull();
  });
});

describe("writeEnvelopeToSink", () => {
  it("writes folded events and reports handled/unhandled", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const handled = await writeEnvelopeToSink(
      sink,
      envelope({
        type: "retrieval.completed",
        data: { denseCount: 1, graphCount: 0, degraded: false },
      }),
    );
    expect(handled).toBe(true);
    expect(sink.events).toHaveLength(1);
    const unhandled = await writeEnvelopeToSink(
      sink,
      envelope({ type: "nope.unknown", data: {} }),
    );
    expect(unhandled).toBe(false);
    expect(sink.events).toHaveLength(1);
  });
});
