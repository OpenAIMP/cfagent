/**
 * Issue #2361 (#1976 step 4e) — the in-memory implementations
 * of the ResearchAgent-private store ports (test doubles for
 * the conformance suite; the inMemoryOrchestratorTableAdapters.ts
 * grouping precedent). Semantics mirror the DO adapters exactly:
 * fail-soft KV reads, DELETE+INSERT overwrite (a rewritten key
 * takes a NEW position at the end of scan order, matching the
 * DO's fresh rowid), insert-or-throw on evaluation id conflict
 * (ADR D-E.1), and the run/evaluation orderings with insertion
 * sequence breaking timestamp ties (the DO's rowid order for
 * equal keys).
 */
import type {
  ResearchEvaluationInsert,
  ResearchEvaluationPort,
  ResearchRunInsert,
  ResearchRunPort,
  ResearchRunRef,
  ResearchSettingsPort,
  ResearchTaskStorePort,
} from "./researchStorePorts";

export class InMemoryResearchSettingsStore implements ResearchSettingsPort {
  private readonly values = new Map<string, string>();
  ensureSchema(): void {}
  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  set(key: string, value: string): void {
    // DELETE+INSERT: the key's scan position is its latest write.
    this.values.delete(key);
    this.values.set(key, value);
  }
}

export class InMemoryResearchTaskStore implements ResearchTaskStorePort {
  private readonly values = new Map<string, string>();
  ensureSchema(): void {}
  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.values.delete(key);
    this.values.set(key, value);
  }
  delete(key: string): void {
    this.values.delete(key);
  }
  list(prefix: string): Array<{ key: string; value: string }> {
    const out: Array<{ key: string; value: string }> = [];
    for (const [key, value] of this.values) {
      if (key.startsWith(prefix)) out.push({ key, value });
    }
    return out;
  }
}

interface StoredRun extends ResearchRunInsert {
  seq: number;
}

export class InMemoryResearchRunStore implements ResearchRunPort {
  private rows: StoredRun[] = [];
  private seq = 0;
  ensureSchema(): void {}
  replaceRun(record: ResearchRunInsert): void {
    this.rows = this.rows.filter((r) => r.runId !== record.runId);
    this.rows.push({ ...record, seq: this.seq++ });
  }
  listReportJsonValues(): unknown[] {
    return [...this.rows]
      .sort((a, b) =>
        a.createdAt === b.createdAt ? a.seq - b.seq : a.createdAt < b.createdAt ? 1 : -1
      )
      .map((r) => r.reportJson);
  }
  getReportJsonValue(runId: string): unknown {
    return this.rows.find((r) => r.runId === runId)?.reportJson;
  }
  listRunRefs(): ResearchRunRef[] {
    return this.rows.map((r) => ({ runId: r.runId, createdAt: r.createdAt }));
  }
}

interface StoredEvaluation extends ResearchEvaluationInsert {
  seq: number;
}

export class InMemoryResearchEvaluationStore implements ResearchEvaluationPort {
  private readonly rows: StoredEvaluation[] = [];
  private seq = 0;
  ensureSchema(): void {}
  insertEvaluation(record: ResearchEvaluationInsert): void {
    if (this.rows.some((r) => r.id === record.id)) {
      throw new Error("UNIQUE constraint failed: research_evaluations.id");
    }
    this.rows.push({ ...record, seq: this.seq++ });
  }
  listEvaluationJsonValues(): unknown[] {
    return [...this.rows]
      .sort((a, b) =>
        a.evaluatedAt === b.evaluatedAt
          ? a.seq - b.seq
          : a.evaluatedAt < b.evaluatedAt
            ? -1
            : 1
      )
      .map((r) => r.evaluationJson);
  }
  listEvaluatedRunIds(): unknown[] {
    return this.rows.map((r) => r.runId);
  }
}
