/**
 * Issue #2428 (Agent Mesh S17, #2225 G13a) — the in-memory
 * mesh trace store: the conformance/test double beside the D1
 * adapter (the fleet's standing adapter pattern — production
 * does NOT use this; it exists so the port's contract is
 * testable without a binding, and as the unbound-env posture
 * in the composition root).
 *
 * Same contract as the D1 adapter: recording is idempotent on
 * (traceId, spanId) — the FIRST record wins, a replayed record
 * of the same span is a no-op.
 */
import type { MeshTraceHop, MeshTraceStore } from "./meshTracePorts";

export class InMemoryMeshTraceStore implements MeshTraceStore {
  private readonly byTrace = new Map<string, Map<string, MeshTraceHop>>();

  async record(hop: MeshTraceHop): Promise<void> {
    let spans = this.byTrace.get(hop.traceId);
    if (!spans) {
      spans = new Map();
      this.byTrace.set(hop.traceId, spans);
    }
    if (!spans.has(hop.spanId)) spans.set(hop.spanId, hop);
  }

  async hopsFor(traceId: string): Promise<MeshTraceHop[]> {
    const spans = this.byTrace.get(traceId);
    if (!spans) return [];
    return [...spans.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  }
}
