/**
 * Issue #2428 (Agent Mesh S17, #2225 G13a) — composition root
 * for the mesh trace hop store. This module maps the Worker
 * environment to a store: domain code imports this helper and
 * the port types, never a binding.
 *
 * Posture (the #1743 degradation rule, applied to traces):
 *  - AGENT_DB bound → the D1 adapter (the durable, queryable
 *    hop record every runtime writes to and the read surface
 *    assembles from), schema ensured per composition.
 *  - AGENT_DB unbound → a per-env in-memory store: hops live
 *    for the isolate's lifetime and the read surface assembles
 *    what this isolate recorded. A normal, non-error state —
 *    never a throw.
 *  - Either way the store is wrapped in the sink-forwarding
 *    decorator, so every recorded hop also reaches the ADR
 *    0011 observability stream.
 *  - Recording through `recordTraceHopBestEffort` NEVER throws
 *    to the producer: a tracing failure degrades the trace,
 *    never the traced work.
 */
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { SinkForwardingTraceStore } from "../observability/meshTrace";
import { InMemoryMeshTraceStore } from "./inMemoryMeshTraceAdapter";
import {
  createD1MeshTraceDb,
  D1MeshTraceAdapter,
  ensureMeshTraceSchema,
} from "./d1MeshTraceAdapter";
import type { MeshTraceHop, MeshTraceStore } from "./meshTracePorts";

type EnvWithAgentDb = { AGENT_DB?: unknown; OBSERVABILITY?: unknown };

const inMemoryByEnv = new WeakMap<object, MeshTraceStore>();

/** Resolve the hop store for an env (always a store, never null, never throws). */
export function meshTraceStoreForEnv(env: EnvWithAgentDb): MeshTraceStore {
  if (env.AGENT_DB) {
    const db = createD1MeshTraceDb(env.AGENT_DB);
    const adapter = new D1MeshTraceAdapter(db);
    const ensured: MeshTraceStore = {
      record: async (hop) => {
        await ensureMeshTraceSchema(db);
        await adapter.record(hop);
      },
      hopsFor: async (traceId) => {
        await ensureMeshTraceSchema(db);
        return adapter.hopsFor(traceId);
      },
    };
    return new SinkForwardingTraceStore(ensured, createObservabilitySink(env));
  }
  let store = inMemoryByEnv.get(env as object);
  if (!store) {
    store = new SinkForwardingTraceStore(
      new InMemoryMeshTraceStore(),
      createObservabilitySink(env),
    );
    inMemoryByEnv.set(env as object, store);
  }
  return store;
}

/**
 * Record one hop, best-effort: any store/sink failure is
 * swallowed by design (the #1743 rule — observability never
 * fails the request). The trace degrades; the work does not.
 */
export async function recordTraceHopBestEffort(
  env: EnvWithAgentDb,
  hop: MeshTraceHop,
): Promise<void> {
  try {
    await meshTraceStoreForEnv(env).record(hop);
  } catch {
    // Degraded trace, intact work — by design.
  }
}

/** Read one trace's hops. Never throws: a store failure reads as an empty trace. */
export async function readTraceHops(
  env: EnvWithAgentDb,
  traceId: string,
): Promise<MeshTraceHop[]> {
  try {
    return await meshTraceStoreForEnv(env).hopsFor(traceId);
  } catch {
    return [];
  }
}
