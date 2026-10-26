/**
 * Issue #1743 — production wiring pins for the stream.
 * (1) The telemetry decision-action route constructs its
 * engine with deps.emit, so an apply flows a
 * calibration_applied envelope to the sink (the route does
 * not need an injected engine for the stream to work).
 * (2) The evaluateRun projection emits one
 * realization_recorded envelope per newly recorded row, and
 * nothing on a pure re-projection (recorded 0) — emission is
 * at-least-once with deterministic ids, never a projection
 * blocker (a throwing emit is swallowed).
 */
import { describe, it, expect } from "vitest";
import { InMemoryTelemetryAdapter } from "../src/telemetry/inMemoryTelemetryAdapter";
import {
  CALIBRATION_PROPOSER,
  type CalibrationDecisionRow,
} from "../src/telemetry/telemetryPorts";
import {
  handleTelemetryDecisionActionRoute,
  type TelemetryRouteSession,
} from "../src/telemetry/telemetryRoute";
import { projectEvaluationRealizations } from "../src/telemetry/telemetryProjection";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";

const ADMIN: TelemetryRouteSession = {
  githubLogin: "owner:alice",
  internalUserId: "user-1",
};

function decisionRow(): CalibrationDecisionRow {
  return {
    id: "d1",
    tenantId: "primary",
    actorKey: "research",
    promptKey: "thesis:condor-bias",
    dimension: "thesis",
    sliceKey: "condor-bias",
    snapshot: {
      key: "condor-bias",
      evaluated: 30,
      hits: 10,
      hitRate: 10 / 30,
      falsificationRate: 20 / 30,
    },
    falsifyingOutcomeIds: ["a"],
    calibrationNote: "Calibration note: ...",
    proposedBy: CALIBRATION_PROPOSER,
    proposedAtMs: 1000,
    status: "proposed",
    createdAtMs: 1000,
    updatedAtMs: 1000,
  };
}

describe("telemetry decision-action stream wiring", () => {
  it("apply emits calibration_applied through deps.emit", async () => {
    const store = new InMemoryTelemetryAdapter();
    await store.recordDecision(decisionRow());
    const emitted: MessageEnvelope[] = [];
    const base = {
      method: "POST",
      tenantId: "primary",
      store,
      decisionId: "d1",
      session: ADMIN,
      isPlatformAdmin: true,
      emit: (envelope: MessageEnvelope) => {
        emitted.push(envelope);
      },
    };
    const decided = await handleTelemetryDecisionActionRoute({
      ...base,
      action: "decide",
      verdict: "approved",
    });
    expect(decided.status).toBe(200);
    expect(emitted).toHaveLength(0);
    const applied = await handleTelemetryDecisionActionRoute({
      ...base,
      action: "apply",
    });
    expect(applied.status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("telemetry.calibration_applied");
    expect(emitted[0].id).toBe("telemetry-calibration-applied:d1");
  });
});

describe("evaluateRun projection stream wiring", () => {
  const report = {
    runId: "run-9",
    regime: "high-iv",
    ideas: [
      {
        symbol: "NVDA",
        structure: "iron-condor",
        thesis: "condor-bias",
        outlook: "bullish",
      },
    ],
  };
  const evaluation = {
    evaluatedAt: "2025-10-10T00:00:00.000Z",
    ideas: [{ symbol: "NVDA", structure: "iron-condor", directionCorrect: false }],
  };

  it("emits one realization_recorded envelope per newly recorded row", async () => {
    const store = new InMemoryTelemetryAdapter();
    const emitted: MessageEnvelope[] = [];
    const result = await projectEvaluationRealizations(
      store,
      report,
      evaluation,
      "primary",
      undefined,
      {
        emit: (envelope) => {
          emitted.push(envelope);
        },
      },
    );
    expect(result).toEqual({ recorded: 1, duplicates: 0 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("telemetry.realization_recorded");
    expect(emitted[0].id).toBe(
      "telemetry-realization:primary:run-9:NVDA:iron-condor",
    );
  });

  it("emits nothing on a pure re-projection (recorded 0)", async () => {
    const store = new InMemoryTelemetryAdapter();
    const emitted: MessageEnvelope[] = [];
    const emit = (envelope: MessageEnvelope) => {
      emitted.push(envelope);
    };
    await projectEvaluationRealizations(store, report, evaluation, "primary", undefined, { emit });
    expect(emitted).toHaveLength(1);
    await projectEvaluationRealizations(store, report, evaluation, "primary", undefined, { emit });
    expect(emitted).toHaveLength(1);
  });

  it("a throwing emit never fails the projection", async () => {
    const store = new InMemoryTelemetryAdapter();
    const result = await projectEvaluationRealizations(
      store,
      report,
      evaluation,
      "primary",
      undefined,
      {
        emit: () => {
          throw new Error("sink down");
        },
      },
    );
    expect(result).toEqual({ recorded: 1, duplicates: 0 });
    expect((await store.queryRealizations("primary", {}))).toHaveLength(1);
  });
});
