/**
 * Issue #2439 (Agent Mesh S18, #2225 G13b) — the in-memory mesh
 * eval result store: the conformance/test double beside the D1
 * adapter (the fleet's standing adapter pattern — production
 * does NOT use this; it exists so the port's contract is testable
 * without a binding, and as the unbound-env posture in the
 * composition root).
 *
 * Same contract as the D1 adapter: recording is idempotent on
 * (runId, taskId) — the FIRST record wins.
 */
import type { MeshEvalResultStore, MeshEvalTaskResult } from "./meshEvalPorts";

export class InMemoryMeshEvalStore implements MeshEvalResultStore {
  private readonly rows: MeshEvalTaskResult[] = [];
  private readonly seen = new Set<string>();

  async record(result: MeshEvalTaskResult): Promise<void> {
    const key = JSON.stringify([result.runId, result.taskId]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.rows.push(result);
  }

  async resultsForRun(runId: string): Promise<MeshEvalTaskResult[]> {
    return this.rows
      .filter((r) => r.runId === runId)
      .sort((a, b) => a.seq - b.seq || a.startedAtMs - b.startedAtMs);
  }

  async resultsForTask(taskId: string): Promise<MeshEvalTaskResult[]> {
    return this.rows
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.seq - b.seq);
  }

  async latestForTask(taskId: string): Promise<MeshEvalTaskResult | null> {
    const rows = await this.resultsForTask(taskId);
    return rows.length > 0 ? rows[rows.length - 1] : null;
  }
}
