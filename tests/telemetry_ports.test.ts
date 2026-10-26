// @vitest-environment node
/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in D1)
 * — TDD red-first.
 *
 * Port conformance suite: the same contract, run unchanged
 * against the D1 adapter (over node:sqlite, same harness as
 * slices 0–3/#1740) and the in-memory adapter. A second adapter
 * passing the same suite is the independence proof: swapping
 * stores never touches telemetry domain code.
 *
 * Covers: idempotent realization writes, tenant isolation,
 * metric aggregation per dimension, the deterministic proposal
 * trigger (falsification is the signal), the governed decision
 * state machine, calibrated-prompt resolution, and the #1743
 * stream envelope builders (counts only, never prompt text).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createD1TelemetryDb,
  D1TelemetryAdapter,
  ensureTelemetrySchema,
} from "../src/telemetry/d1TelemetryAdapter";
import { InMemoryTelemetryAdapter } from "../src/telemetry/inMemoryTelemetryAdapter";
import {
  CALIBRATION_MIN_SAMPLE,
  CALIBRATION_PROPOSER,
  CalibrationError,
  TelemetryCalibrationEngine,
  aggregateMetrics,
  buildCalibrationNote,
  isSystemActor,
  toCalibrationAppliedEnvelope,
  toCalibrationProposedEnvelope,
  toRealizationRecordedEnvelope,
  type CalibrationDecisionRow,
  type MetricDimension,
  type TelemetryStore,
  type ThesisRealizationInput,
} from "../src/telemetry/telemetryPorts";

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slices 0–3/#1740). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

async function d1Store(): Promise<TelemetryStore> {
  const mock = new MockD1Database();
  const db = createD1TelemetryDb(mock as any);
  const adapter = new D1TelemetryAdapter(db);
  await ensureTelemetrySchema(db);
  return adapter;
}

function realization(
  overrides: Partial<ThesisRealizationInput> & { outcomeId: string },
): ThesisRealizationInput {
  return {
    tenantId: "primary",
    thesis: "iron-condor-bias",
    agentKey: "research",
    structure: "iron-condor",
    regime: "high-iv",
    symbol: "NVDA",
    runId: "run-1",
    reportId: null,
    chainId: null,
    predictedDirection: "up",
    realizedDirection: "up",
    directionCorrect: true,
    falsified: false,
    invalidated: false,
    pnlEstimatePerUnit: 120,
    rMultiple: 1.2,
    evaluatedAtMs: 1_760_000_000_000,
    ...overrides,
  };
}

/** 20 falsified + 10 correct realizations for one thesis slice. */
function falsifiedSlice(nFalsified = 20, nCorrect = 10): ThesisRealizationInput[] {
  const rows: ThesisRealizationInput[] = [];
  for (let i = 0; i < nFalsified; i++) {
    rows.push(
      realization({
        outcomeId: `run-f:${i}`,
        runId: `run-f`,
        predictedDirection: "up",
        realizedDirection: "down",
        directionCorrect: false,
        falsified: true,
      }),
    );
  }
  for (let i = 0; i < nCorrect; i++) {
    rows.push(
      realization({
        outcomeId: `run-c:${i}`,
        runId: `run-c`,
        predictedDirection: "up",
        realizedDirection: "up",
        directionCorrect: true,
        falsified: false,
      }),
    );
  }
  return rows;
}

describe("telemetry port conformance (#1742)", () => {
  const stores: Array<[string, () => Promise<TelemetryStore>]> = [
    ["d1", d1Store],
    ["in-memory", async () => new InMemoryTelemetryAdapter()],
  ];

  for (const [name, makeStore] of stores) {
    describe(`adapter: ${name}`, () => {
      it("records realizations idempotently (replay is a no-op)", async () => {
        const store = await makeStore();
        const row = realization({ outcomeId: "run-1:NVDA:iron-condor" });
        const first = await store.recordRealizations([row]);
        const second = await store.recordRealizations([row]);
        expect(first).toEqual({ recorded: 1, duplicates: 0 });
        expect(second).toEqual({ recorded: 0, duplicates: 1 });
        const rows = await store.queryRealizations("primary", {});
        expect(rows).toHaveLength(1);
      });

      it("isolates tenants: another tenant sees nothing", async () => {
        const store = await makeStore();
        await store.recordRealizations([
          realization({ outcomeId: "o1" }),
          realization({ outcomeId: "o2", tenantId: "other" }),
        ]);
        expect(await store.queryRealizations("primary", {})).toHaveLength(1);
        expect(await store.queryRealizations("other", {})).toHaveLength(1);
      });

      it("aggregates metrics per dimension with null rates on empty slices", async () => {
        const store = await makeStore();
        await store.recordRealizations(falsifiedSlice());
        const byThesis = await store.metrics("primary", "thesis");
        expect(byThesis).toHaveLength(1);
        expect(byThesis[0]).toMatchObject({
          key: "iron-condor-bias",
          evaluated: 30,
          hits: 10,
        });
        expect(byThesis[0].hitRate).toBeCloseTo(10 / 30);
        expect(byThesis[0].falsificationRate).toBeCloseTo(20 / 30);
        const byMonth = await store.metrics("primary", "month");
        expect(byMonth).toHaveLength(1);
        expect(byMonth[0].key).toBe("2025-10");
        expect(await store.metrics("primary", "thesis", { fromMs: 9_999_999_999_999 })).toEqual([]);
      });

      it("proposes only on the falsification trigger (sample + majority falsified)", async () => {
        const store = await makeStore();
        const engine = new TelemetryCalibrationEngine(store);
        // Each phase uses its own thesis: proposals scan (agent, thesis)
        // groups, so phases never pollute each other.
        // Below sample floor: 19 falsified, 0 correct → no proposal.
        await store.recordRealizations(
          falsifiedSlice(19, 0).map((r, i) => ({ ...r, thesis: "small-thesis", outcomeId: `small:${i}` })),
        );
        let out = await engine.proposeCalibrations("primary");
        expect(out.created).toEqual([]);
        // At floor but tied (20 falsified, 20 correct → falsification 0.5) → no proposal.
        await store.recordRealizations(
          falsifiedSlice(20, 20).map((r, i) => ({ ...r, thesis: "tied-thesis", outcomeId: `tied:${i}` })),
        );
        out = await engine.proposeCalibrations("primary");
        expect(out.created).toEqual([]);
        // Majority falsified at floor (20 falsified, 10 correct → 0.667) → one proposal.
        await store.recordRealizations(
          falsifiedSlice(20, 10).map((r, i) => ({ ...r, thesis: "bad-thesis", outcomeId: `bad:${i}` })),
        );
        out = await engine.proposeCalibrations("primary");
        expect(out.created).toHaveLength(1);
        expect(out.created[0]).toMatchObject({
          status: "proposed",
          actorKey: "research",
          dimension: "thesis",
          sliceKey: "bad-thesis",
          promptKey: "thesis:bad-thesis",
          proposedBy: CALIBRATION_PROPOSER,
        });
        expect(out.created[0].snapshot).toMatchObject({ evaluated: 30, hits: 10 });
        // Re-propose with the proposal still open → deduped, no second proposal.
        out = await engine.proposeCalibrations("primary");
        expect(out.created).toEqual([]);
        expect(out.skippedOpen).toHaveLength(1);
      });

      it("governs decisions: system actors never approve, approver != proposer, terminal states hold", async () => {
        const store = await makeStore();
        const engine = new TelemetryCalibrationEngine(store);
        await store.recordRealizations(falsifiedSlice());
        const { created } = await engine.proposeCalibrations("primary");
        const id = created[0].id;
        await expect(
          engine.decideCalibration("primary", id, "approved", "system:nightly"),
        ).rejects.toBeInstanceOf(CalibrationError);
        await expect(
          engine.decideCalibration("primary", id, "approved", CALIBRATION_PROPOSER),
        ).rejects.toBeInstanceOf(CalibrationError);
        await expect(
          engine.decideCalibration("primary", id, "approved", ""),
        ).rejects.toBeInstanceOf(CalibrationError);
        const approved = await engine.decideCalibration("primary", id, "approved", "owner:alice");
        expect(approved.status).toBe("approved");
        expect(approved.decidedBy).toBe("owner:alice");
        // Apply requires approved + human non-proposer applier.
        await expect(
          engine.applyCalibration("primary", id, "system:calibration-engine"),
        ).rejects.toBeInstanceOf(CalibrationError);
        const applied = await engine.applyCalibration("primary", id, "owner:alice");
        expect(applied.status).toBe("applied");
        expect(applied.appliedBy).toBe("owner:alice");
        // Applied resolves; rejected/expired/superseded do not.
        expect(await engine.resolveCalibratedPrompt("primary", "research", applied.promptKey)).toBe(
          applied.calibrationNote,
        );
        const superseded = await engine.supersedeCalibration("primary", id, "owner:bob");
        expect(superseded.status).toBe("superseded");
        expect(await engine.resolveCalibratedPrompt("primary", "research", applied.promptKey)).toBeNull();
        // Terminal: no further transitions.
        await expect(
          engine.decideCalibration("primary", id, "approved", "owner:carol"),
        ).rejects.toBeInstanceOf(CalibrationError);
        await expect(
          engine.applyCalibration("primary", id, "owner:carol"),
        ).rejects.toBeInstanceOf(CalibrationError);
      });

      it("resolves the latest applied note; rejected proposals never resolve", async () => {
        const store = await makeStore();
        const engine = new TelemetryCalibrationEngine(store);
        await store.recordRealizations(falsifiedSlice());
        const { created } = await engine.proposeCalibrations("primary");
        const id = created[0].id;
        await engine.decideCalibration("primary", id, "rejected", "owner:alice");
        expect(
          await engine.resolveCalibratedPrompt("primary", "research", created[0].promptKey),
        ).toBeNull();
        expect(await engine.resolveCalibratedPrompt("primary", "research", "no-such-prompt")).toBeNull();
        expect(await engine.resolveCalibratedPrompt("other-tenant", "research", created[0].promptKey)).toBeNull();
      });

      it("expires an applied note; expiry stops resolution", async () => {
        const store = await makeStore();
        const engine = new TelemetryCalibrationEngine(store);
        await store.recordRealizations(falsifiedSlice());
        const { created } = await engine.proposeCalibrations("primary");
        const id = created[0].id;
        await engine.decideCalibration("primary", id, "approved", "owner:alice");
        await engine.applyCalibration("primary", id, "owner:alice");
        const expired = await engine.expireCalibration("primary", id, "owner:alice");
        expect(expired.status).toBe("expired");
        expect(await engine.resolveCalibratedPrompt("primary", "research", created[0].promptKey)).toBeNull();
      });
    });
  }

  it("shares the dashboard's 20-sample floor vocabulary", () => {
    expect(CALIBRATION_MIN_SAMPLE).toBe(20);
  });

  it("builds deterministic calibration notes from frozen snapshots", () => {
    const note = buildCalibrationNote("thesis", "iron-condor-bias", {
      key: "iron-condor-bias",
      evaluated: 30,
      hits: 10,
      hitRate: 10 / 30,
      falsificationRate: 20 / 30,
    });
    expect(note).toContain("iron-condor-bias");
    expect(note).toContain("30");
    expect(note).toContain("33.3%");
    expect(note).toContain("66.7%");
    expect(
      buildCalibrationNote("thesis", "iron-condor-bias", {
        key: "iron-condor-bias",
        evaluated: 30,
        hits: 10,
        hitRate: 10 / 30,
        falsificationRate: 20 / 30,
      }),
    ).toBe(note);
  });

  it("classifies system actors", () => {
    expect(isSystemActor("system:calibration-engine")).toBe(true);
    expect(isSystemActor("nightly:re-selection")).toBe(true);
    expect(isSystemActor("system")).toBe(true);
    expect(isSystemActor("owner:alice")).toBe(false);
    expect(isSystemActor("")).toBe(false);
  });

  it("aggregateMetrics is dimension-correct and window-aware", () => {
    const rows = falsifiedSlice().map((r) => ({ ...r, createdAtMs: r.evaluatedAtMs }));
    const byAgent = aggregateMetrics(rows, "agent");
    expect(byAgent).toEqual([
      {
        key: "research",
        evaluated: 30,
        hits: 10,
        hitRate: 10 / 30,
        falsificationRate: 20 / 30,
      },
    ]);
    const byStructure = aggregateMetrics(rows, "structure");
    expect(byStructure[0].key).toBe("iron-condor");
    const windowed = aggregateMetrics(rows, "thesis", { fromMs: 1_760_000_000_001 });
    expect(windowed).toEqual([]);
  });

  it("stream envelopes are CloudEvents v1.0, deterministic ids, counts only", () => {
    const rec = toRealizationRecordedEnvelope({
      tenantId: "primary",
      outcomeId: "run-1:NVDA:iron-condor",
      agentKey: "research",
      structure: "iron-condor",
      regime: "high-iv",
      directionCorrect: false,
      falsified: true,
    });
    expect(rec).toMatchObject({
      specversion: "1.0",
      type: "telemetry.realization_recorded",
      source: "telemetry/calibration",
      subject: "run-1:NVDA:iron-condor",
    });
    expect(rec.id).toBe("telemetry-realization:primary:run-1:NVDA:iron-condor");
    expect(rec.id).toBe(
      toRealizationRecordedEnvelope({
        tenantId: "primary",
        outcomeId: "run-1:NVDA:iron-condor",
        agentKey: "research",
        structure: "iron-condor",
        regime: "high-iv",
        directionCorrect: false,
        falsified: true,
      }).id,
    );
    expect(JSON.stringify(rec.data)).not.toContain("iron-condor-bias");
    const decision = {
      id: "cal-1",
      tenantId: "primary",
      actorKey: "research",
      promptKey: "thesis:iron-condor-bias",
      dimension: "thesis" as MetricDimension,
      sliceKey: "iron-condor-bias",
      snapshot: { key: "iron-condor-bias", evaluated: 30, hits: 10, hitRate: 10 / 30, falsificationRate: 20 / 30 },
      falsifyingOutcomeIds: ["a", "b"],
      calibrationNote: "note",
      proposedBy: CALIBRATION_PROPOSER,
      proposedAtMs: 1,
      status: "proposed" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    } satisfies CalibrationDecisionRow;
    const proposed = toCalibrationProposedEnvelope(decision);
    expect(proposed).toMatchObject({
      specversion: "1.0",
      type: "telemetry.calibration_proposed",
      id: "telemetry-calibration-proposed:cal-1",
    });
    expect(JSON.stringify(proposed.data)).not.toContain("note");
    const applied = toCalibrationAppliedEnvelope({ ...decision, status: "applied" });
    expect(applied.type).toBe("telemetry.calibration_applied");
    expect(applied.id).toBe("telemetry-calibration-applied:cal-1");
  });
});
