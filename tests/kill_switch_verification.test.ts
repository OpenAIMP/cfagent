/**
 * Issue #756 (P2-4.3) — autonomous-adaptation kill switch, verified
 * end-to-end.
 *
 * #232's promise: "Ceos can halt autonomous adaptation instantly."
 * These pins hold it three ways:
 *
 *  1. ENUMERATION. Every production file that applies adaptations
 *     (imports `applyAdaptation`) must also consult the kill switch
 *     (imports `isAdaptationHalted`) — a future adaptation path cannot
 *     silently skip the check. Callers of the weight job are
 *     enumerated by exact file set: a new entry point fails this pin
 *     until it is declared here.
 *  2. DRILL (production-shaped: real DatabaseORM over durable
 *     storage, the post-#887 route seam). Baseline run adapts → the
 *     operator sets `adaptation.killSwitch` → forced and scheduled
 *     runs apply ZERO adaptations and write ZERO audit rows → a
 *     simulated restart (fresh ORM over the same storage) is STILL
 *     halted (no auto-resume) → only an explicit operator unset
 *     resumes adaptation.
 *  3. SWITCH SEMANTICS. Unset/other values do not halt; on/1/true
 *     halt; a settings-read failure halts (fail-closed, logged).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { isAdaptationHalted, ADAPTATION_KILL_SWITCH_KEY, listAdaptationAudit } from "../src/services/adaptationAudit";
import { runStrategyWeightAdjustment, getStrategyWeight } from "../src/services/strategyWeights";
import type { TrackRecord } from "../src/services/researchTrackRecord";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const prodFiles = walk(SRC).map((p) => ({
  rel: path.relative(SRC, p).split(path.sep).join("/"),
  text: readFileSync(p, "utf8"),
}));

describe("entry-point enumeration (#756)", () => {
  it("every production file importing applyAdaptation also imports isAdaptationHalted", () => {
    const appliers = prodFiles.filter((f) => /import\s*\{[^}]*\bapplyAdaptation\b[^}]*\}\s*from/.test(f.text));
    expect(appliers.length).toBeGreaterThan(0);
    for (const f of appliers) {
      expect(f.text, `${f.rel} applies adaptations without consulting the kill switch`).toMatch(
        /import\s*\{[^}]*\bisAdaptationHalted\b[^}]*\}\s*from/
      );
    }
  });

  it("weight-job callers are exactly the enumerated delegating surfaces", () => {
    // Consolidation #1257 flip: the v1 job has NO production caller
    // left — the routes run the v2 job (pinned below). The v1 module
    // stays until the retirement PR (stagedPromotion still reads v1
    // weights for baselines), but its adjustment job is dead from
    // production; a new caller must be added here deliberately, with
    // its halt story, or this pin fails.
    const v1Callers = prodFiles
      .filter((f) => f.rel !== "services/strategyWeights.ts")
      .filter((f) => /\brunStrategyWeightAdjustment\b/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(v1Callers).toEqual([]);
    // The v2 job is the live one: the route delegates to it, it
    // self-checks the switch (halted result), and the scheduled tick
    // calls it directly. Same pin discipline as the v1 job had.
    const v2Callers = prodFiles
      .filter((f) => f.rel !== "services/strategyWeightsV2.ts")
      .filter((f) => /\brunWeightsV2Adjustment\b/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(v2Callers).toEqual(["agents/routes/screenerResearch.ts"]);
    // server.ts dispatches the route over HTTP; it names the path, not the function.
    const server = prodFiles.find((f) => f.rel === "server.ts");
    expect(server?.text).toContain("/adaptation/weights/run");
  });

  it("no production code writes the kill-switch key (resume is operator-only)", () => {
    for (const f of prodFiles) {
      expect(f.text, `${f.rel} writes the kill-switch key`).not.toMatch(
        new RegExp(`writeSetting\\(\\s*["']${ADAPTATION_KILL_SWITCH_KEY}`)
      );
      expect(f.text, `${f.rel} clears the kill-switch key`).not.toMatch(
        new RegExp(`DELETE FROM mas_settings[^;]*${ADAPTATION_KILL_SWITCH_KEY}`)
      );
    }
  });

  it("nothing writes mas_strategy_weights outside the weights service", () => {
    // Deliberately declared weights services (#1096 Phase 5): the v1
    // service (strategyWeights.ts) and the v2 service
    // (strategyWeightsV2.ts — regime-conditioned, versioned records in
    // mas_strategy_weights_v2 / mas_strategy_weight_versions). The v2
    // service's halt story: it applies only through applyAdaptation and
    // consults isAdaptationHalted before applying (pinned by the
    // applyAdaptation enumeration above and phase5_rsi_loop.test.ts).
    // Any OTHER writer of a mas_strategy_weights* table fails here.
    const weightsServices = new Set([
      "services/strategyWeights.ts",
      "services/strategyWeightsV2.ts",
    ]);
    const writers = prodFiles
      .filter((f) => !weightsServices.has(f.rel))
      .filter((f) => /INSERT[^;]*mas_strategy_weights/i.test(f.text))
      .map((f) => f.rel);
    expect(writers).toEqual([]);
  });
});

function track(): TrackRecord {
  const byStrategy = [
    { key: "Momentum", published: 40, evaluated: 40, winRate: 0.75, avgRMultiple: null },
    { key: "MeanReversion", published: 40, evaluated: 40, winRate: 0.25, avgRMultiple: null },
  ];
  return {
    published: 80, evaluated: 80, invalidated: 0, winRate: 0.5,
    directionAccuracy: null, avgPnlPerUnit: null, avgRMultiple: null,
    byStrategy, byPeriod: [], ideas: [],
  };
}

function setKillSwitch(storage: any, value: string) {
  // The orchestrator writeSetting idiom (DELETE+INSERT), as an operator
  // action through the settings store.
  storage.exec(`DELETE FROM mas_settings WHERE key = ?`, ADAPTATION_KILL_SWITCH_KEY);
  storage.exec(
    `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
    ADAPTATION_KILL_SWITCH_KEY, value, new Date().toISOString()
  );
}

const NOW = new Date("2026-10-21T12:00:00.000Z");

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("halt / resume drill (#756)", () => {
  it("halt stops every run mode, survives a restart, and only an explicit unset resumes", () => {
    const storage: any = new MockSqlStorage();
    const orm: any = new DatabaseORM(storage);

    // Baseline: adaptation works.
    const base = runStrategyWeightAdjustment(orm, track(), { now: NOW, force: true });
    expect(base.adjusted).toHaveLength(2);
    expect(getStrategyWeight(orm, "Momentum")).toBeCloseTo(1.1);
    const auditAfterBase = listAdaptationAudit(orm).length;
    expect(auditAfterBase).toBe(2);

    // Operator halts.
    setKillSwitch(storage, "on");
    expect(isAdaptationHalted(orm)).toBe(true);

    // Forced and scheduled runs both apply nothing and audit nothing.
    const forced = runStrategyWeightAdjustment(orm, track(), { now: NOW, force: true });
    expect(forced.halted).toBe(true);
    expect(forced.adjusted).toHaveLength(0);
    const scheduled = runStrategyWeightAdjustment(orm, track(), { now: NOW });
    expect(scheduled.halted).toBe(true);
    expect(listAdaptationAudit(orm).length).toBe(auditAfterBase);
    expect(getStrategyWeight(orm, "Momentum")).toBeCloseTo(1.1);

    // Simulated restart: a fresh ORM over the same durable storage is
    // still halted — no auto-resume.
    const ormAfterRestart: any = new DatabaseORM(storage);
    expect(isAdaptationHalted(ormAfterRestart)).toBe(true);
    const afterRestart = runStrategyWeightAdjustment(ormAfterRestart, track(), { now: NOW, force: true });
    expect(afterRestart.halted).toBe(true);
    expect(afterRestart.adjusted).toHaveLength(0);

    // Explicit operator resume: adaptation flows again.
    setKillSwitch(storage, "off");
    expect(isAdaptationHalted(ormAfterRestart)).toBe(false);
    const resumed = runStrategyWeightAdjustment(ormAfterRestart, track(), { now: NOW, force: true });
    expect(resumed.halted).toBeFalsy();
    expect(resumed.adjusted.length).toBeGreaterThan(0);
  });

  it("switch semantics: unset does not halt; on/1/true halt; off does not", () => {
    const storage: any = new MockSqlStorage();
    const orm: any = new DatabaseORM(storage);
    expect(isAdaptationHalted(orm)).toBe(false);
    for (const v of ["on", "1", "true", "ON", " True "]) {
      setKillSwitch(storage, v);
      expect(isAdaptationHalted(orm), `value ${JSON.stringify(v)} should halt`).toBe(true);
    }
    for (const v of ["off", "0", "false", ""]) {
      setKillSwitch(storage, v);
      expect(isAdaptationHalted(orm), `value ${JSON.stringify(v)} should not halt`).toBe(false);
    }
  });

  it("a settings-read failure halts (fail-closed) and is logged", () => {
    const brokenSql: any = {
      exec() {
        throw new Error("store unavailable");
      },
    };
    expect(isAdaptationHalted(brokenSql)).toBe(true);
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
