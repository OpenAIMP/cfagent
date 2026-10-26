/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — in-memory telemetry store.
 *
 * A test double with the same port semantics as the D1 adapter:
 * the port/conformance suite runs unchanged against both. It is
 * NOT a production store and NOT a second source of truth — it
 * exists so the port contract is testable without any store at
 * all. No migration concept applies here (there is no SQL to
 * migrate).
 */
import {
  aggregateMetrics,
  type CalibrationDecisionRow,
  type CalibrationDecisionStatus,
  type MetricDimension,
  type MetricSlice,
  type MetricWindow,
  type TelemetryStore,
  type ThesisRealizationInput,
  type ThesisRealizationRow,
} from "./telemetryPorts";

export class InMemoryTelemetryAdapter implements TelemetryStore {
  private realizations: ThesisRealizationRow[] = [];
  private decisions: CalibrationDecisionRow[] = [];

  async recordRealizations(
    rows: ThesisRealizationInput[],
  ): Promise<{ recorded: number; duplicates: number }> {
    let recorded = 0;
    let duplicates = 0;
    const nowMs = Date.now();
    for (const row of rows) {
      const exists = this.realizations.some(
        (r) => r.tenantId === row.tenantId && r.outcomeId === row.outcomeId,
      );
      if (exists) {
        duplicates += 1;
        continue;
      }
      this.realizations.push({ ...row, createdAtMs: nowMs });
      recorded += 1;
    }
    return { recorded, duplicates };
  }

  async queryRealizations(
    tenantId: string,
    filters?: MetricWindow & { thesis?: string; agentKey?: string },
  ): Promise<ThesisRealizationRow[]> {
    return this.realizations
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => filters?.thesis === undefined || r.thesis === filters.thesis)
      .filter((r) => filters?.agentKey === undefined || r.agentKey === filters.agentKey)
      .filter((r) => filters?.fromMs === undefined || r.evaluatedAtMs >= filters.fromMs)
      .filter((r) => filters?.toMs === undefined || r.evaluatedAtMs < filters.toMs)
      .map((r) => ({ ...r }));
  }

  async metrics(
    tenantId: string,
    dimension: MetricDimension,
    opts?: MetricWindow,
  ): Promise<MetricSlice[]> {
    const rows = await this.queryRealizations(tenantId, opts);
    return aggregateMetrics(rows, dimension, opts);
  }

  async recordDecision(row: CalibrationDecisionRow): Promise<void> {
    this.decisions.push({ ...row });
  }

  async getDecision(tenantId: string, id: string): Promise<CalibrationDecisionRow | null> {
    const found = this.decisions.find((d) => d.tenantId === tenantId && d.id === id);
    return found ? { ...found } : null;
  }

  async updateDecision(row: CalibrationDecisionRow): Promise<void> {
    const idx = this.decisions.findIndex(
      (d) => d.tenantId === row.tenantId && d.id === row.id,
    );
    if (idx >= 0) this.decisions[idx] = { ...row };
  }

  async listDecisions(
    tenantId: string,
    filters?: {
      status?: CalibrationDecisionStatus;
      actorKey?: string;
      promptKey?: string;
    },
  ): Promise<CalibrationDecisionRow[]> {
    return this.decisions
      .filter((d) => d.tenantId === tenantId)
      .filter((d) => filters?.status === undefined || d.status === filters.status)
      .filter((d) => filters?.actorKey === undefined || d.actorKey === filters.actorKey)
      .filter((d) => filters?.promptKey === undefined || d.promptKey === filters.promptKey)
      .map((d) => ({ ...d }));
  }
}
