/**
 * Issue #2439 (Agent Mesh S18, #2225 G13b) — composition root
 * for the mesh eval result store (mirrors createMeshTracePorts,
 * S17): AGENT_DB bound → the D1 adapter over
 * agent_mesh_eval_results; unbound → a per-env in-memory store
 * (the conformance double's unbound posture — outcomes are then
 * process-local, which the caller can see from the store class).
 * Never throws on an unbound or malformed store: an eval
 * recording failure must degrade the evidence, never the run
 * being evaluated.
 */
import { D1MeshEvalAdapter, createD1MeshEvalDb } from "./d1MeshEvalAdapter";
import { InMemoryMeshEvalStore } from "./inMemoryMeshEvalAdapter";
import type { MeshEvalResultStore } from "./meshEvalPorts";
import type { Env } from "../types";

const unboundStores = new WeakMap<object, InMemoryMeshEvalStore>();

export function meshEvalStoreForEnv(env: Partial<Env>): MeshEvalResultStore {
  const d1 = (env as { AGENT_DB?: unknown }).AGENT_DB;
  if (d1) {
    try {
      return new D1MeshEvalAdapter(createD1MeshEvalDb(d1));
    } catch {
      // Fall through to the unbound posture.
    }
  }
  const key = env as object;
  let store = unboundStores.get(key);
  if (!store) {
    store = new InMemoryMeshEvalStore();
    unboundStores.set(key, store);
  }
  return store;
}
