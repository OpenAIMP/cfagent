/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — TDD red-first.
 *
 * Pins the #1738 actor-turn plug with the REAL turn runner:
 * a beforeTurn hook consulting resolveCalibratedPrompt lands
 * the active note in the model turn's instructions; with no
 * active note (or a failing resolver) the instructions pass
 * through byte-identical — calibration never blocks a turn.
 */
import { describe, it, expect } from "vitest";
import { AgentChatTurnRunner } from "../src/actors/actorTurnRunner";
import type {
  ActorSessionPort,
  ActorTurnHooks,
  UiChatMessage,
} from "../src/actors/actorPorts";
import { InMemoryTelemetryAdapter } from "../src/telemetry/inMemoryTelemetryAdapter";
import {
  TelemetryCalibrationEngine,
  type ThesisRealizationInput,
} from "../src/telemetry/telemetryPorts";
import { applyCalibratedPromptToInstructions } from "../src/telemetry/calibratedPromptPlug";

function memorySession(): ActorSessionPort {
  const messages: UiChatMessage[] = [];
  return {
    async getMessages() {
      return [...messages];
    },
    async appendMessages(next) {
      for (const m of next) {
        const idx = messages.findIndex((x) => x.id === m.id);
        if (idx >= 0) messages[idx] = m;
        else messages.push(m);
      }
    },
    async deleteMessages(ids) {
      for (const id of ids) {
        const idx = messages.findIndex((x) => x.id === id);
        if (idx >= 0) messages.splice(idx, 1);
      }
    },
    async migrateLegacyRows() {},
    async clear() {
      messages.length = 0;
    },
  };
}

function falsifiedRow(outcomeId: string, correct: boolean): ThesisRealizationInput {
  return {
    tenantId: "primary",
    outcomeId,
    thesis: "condor-bias",
    agentKey: "research",
    structure: "iron-condor",
    regime: "high-iv",
    symbol: "NVDA",
    runId: "run-1",
    reportId: null,
    chainId: null,
    predictedDirection: "up",
    realizedDirection: correct ? "up" : "down",
    directionCorrect: correct,
    falsified: !correct,
    invalidated: false,
    pnlEstimatePerUnit: null,
    rMultiple: null,
    evaluatedAtMs: 1_760_000_000_000,
  };
}

async function engineWithAppliedNote(): Promise<TelemetryCalibrationEngine> {
  const store = new InMemoryTelemetryAdapter();
  const rows: ThesisRealizationInput[] = [];
  for (let i = 0; i < 20; i++) rows.push(falsifiedRow(`f:${i}`, false));
  for (let i = 0; i < 10; i++) rows.push(falsifiedRow(`c:${i}`, true));
  await store.recordRealizations(rows);
  const engine = new TelemetryCalibrationEngine(store);
  const { created } = await engine.proposeCalibrations("primary");
  await engine.decideCalibration("primary", created[0].id, "approved", "owner:alice");
  await engine.applyCalibration("primary", created[0].id, "owner:alice");
  return engine;
}

async function runTurnWithPlug(
  resolve: (actorKey: string, promptKey: string) => Promise<string | null>,
): Promise<string> {
  let capturedSystem = "";
  const hooks: ActorTurnHooks = {
    getModel: () => ({ modelId: "test-model" }),
    getSystemPrompt: () => "base prompt",
    getTools: () => ({}),
    beforeTurn: async () => ({
      instructions: await applyCalibratedPromptToInstructions(
        resolve,
        "research",
        "thesis:condor-bias",
        "base prompt",
      ),
    }),
    onChatResponse: async () => {},
  };
  const runner = new AgentChatTurnRunner({
    hooks,
    session: memorySession(),
    modelTurn: async (opts) => {
      capturedSystem = opts.system;
      return { text: "ok" };
    },
  });
  await runner.runTurn("hello");
  return capturedSystem;
}

describe("telemetry actor-turn plug (#1742)", () => {
  it("lands the active calibration note in the turn instructions", async () => {
    const engine = await engineWithAppliedNote();
    const system = await runTurnWithPlug((a, p) =>
      engine.resolveCalibratedPrompt("primary", a, p),
    );
    expect(system.startsWith("base prompt")).toBe(true);
    expect(system).toContain("Calibration note:");
    expect(system).toContain("condor-bias");
  });

  it("passes instructions through byte-identical with no active note", async () => {
    const store = new InMemoryTelemetryAdapter();
    const engine = new TelemetryCalibrationEngine(store);
    const system = await runTurnWithPlug((a, p) =>
      engine.resolveCalibratedPrompt("primary", a, p),
    );
    expect(system).toBe("base prompt");
  });

  it("never blocks a turn when resolution fails", async () => {
    const system = await runTurnWithPlug(async () => {
      throw new Error("D1 down");
    });
    expect(system).toBe("base prompt");
  });
});
