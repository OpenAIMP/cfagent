/**
 * Issue #2460 (Agent Mesh S19, #2225 G13c) — composition root
 * for the mesh proposal store (mirrors createMeshEvalPorts,
 * S18): AGENT_DB bound → the D1 adapter over
 * agent_mesh_proposals; unbound → a per-env in-memory store
 * (the conformance double's unbound posture — records are then
 * process-local, which the caller can see from the store class).
 * Never throws on an unbound or malformed store: the pipeline
 * is an improvement-loop component, and its storage failing to
 * bind must degrade the loop, never a door's runtime path.
 */
import { D1MeshProposalAdapter, createD1MeshProposalDb } from "./d1MeshProposalAdapter";
import { InMemoryMeshProposalStore } from "./inMemoryMeshProposalAdapter";
import type { MeshProposalStore } from "./meshProposalPorts";
import type { Env } from "../types";

const unboundStores = new WeakMap<object, InMemoryMeshProposalStore>();

export function meshProposalStoreForEnv(env: Partial<Env>): MeshProposalStore {
  const d1 = (env as { AGENT_DB?: unknown }).AGENT_DB;
  if (d1) {
    try {
      return new D1MeshProposalAdapter(createD1MeshProposalDb(d1));
    } catch {
      // Fall through to the unbound posture.
    }
  }
  const key = env as object;
  let store = unboundStores.get(key);
  if (!store) {
    store = new InMemoryMeshProposalStore();
    unboundStores.set(key, store);
  }
  return store;
}
