/**
 * Issue #1517 ([AGENTIC] Lane 1, follow-up of #1362) — firing /
 * materialization wiring, pure module level.
 *
 * The production firing path must route through the Phase 6 contract
 * `shouldFireGoverned`, never through a parallel predicate. These
 * tests pin:
 *  - Materialization: ONLY an approved recurring record with a valid
 *    cron becomes a goals-list entry; pending, killed, one-shot, and
 *    cron-less records are refused.
 *  - The firing decision IS `shouldFireGoverned`: pending, killed,
 *    globally-halted, not-due, and already-consumed records never
 *    fire; an approved due record does. Each refusal carries a
 *    reason, so a blocked tick is observable, not silent.
 *  - Blocked attempts can be written through the shipped #755 audit
 *    path (`recordBlockedAdaptation`) via a fake sql shim.
 */
import { describe, it, expect } from "vitest";
import { compileGoal } from "../src/orchestrate";
import {
  synthesizeSchedule,
  approveSynthesizedRecord,
  markSynthesizedFired,
  type SynthesizedSchedule,
} from "../src/agentic/jobSynthesis";
import { killSynthesizedRecord } from "../src/agentic/chainGovernance";
import { shouldFireGoverned } from "../src/agentic/chainGovernance";
import {
  materializeSynthesizedRecord,
  decideChainFiring,
  auditBlockedChainFiring,
} from "../src/agentic/chainFiring";

function nasdaqChain() {
  const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
    budgetCents: 5000,
    budgetCapCents: 10000,
  });
  if (!chain) throw new Error("test chain did not compile");
  return chain;
}

function emailChain() {
  const chain = compileGoal("Send me yesterday's report by email", {
    budgetCents: 0,
  });
  if (!chain) throw new Error("test chain did not compile");
  return chain;
}

function approvedRecurring(): SynthesizedSchedule {
  return approveSynthesizedRecord(
    synthesizeSchedule(nasdaqChain(), { id: "synth-fire-a", cron: "0 6 * * *" }),
    "2026-10-25T05:00:00.000Z",
  );
}

function approvedOneShot(): SynthesizedSchedule {
  return approveSynthesizedRecord(
    synthesizeSchedule(emailChain(), { id: "synth-fire-one" }),
    "2026-10-25T05:00:00.000Z",
  );
}

/** Minimal fake sql: CREATE no-op + INSERT into mas_adaptation_audit. */
function makeFakeSql() {
  const rows: any[] = [];
  const sql = {
    rows,
    exec(text: string, ...params: any[]) {
      if (/^\s*CREATE/i.test(text)) return [];
      if (/INSERT INTO mas_adaptation_audit/i.test(text)) {
        const cols = /\(([^)]+)\)\s*VALUES/i.exec(text)![1]
          .split(",")
          .map((c) => c.trim());
        const row: any = {};
        params.forEach((p, i) => {
          row[cols[i]] = p;
        });
        rows.push(row);
        return [];
      }
      return [];
    },
  };
  return sql;
}

describe("chain materialization (#1517)", () => {
  it("materializes an approved recurring record as a goals-list entry, 1:1 by id", () => {
    const record = approvedRecurring();
    const goal = materializeSynthesizedRecord(record);
    expect(goal.id).toBe(record.id);
    expect(goal.name).toBe(record.goal);
    expect(goal.cron).toBe("0 6 * * *");
    expect(goal.operation).toBe("chain.execute");
    expect(goal.budgetCents).toBe(5000);
    expect(goal.enabled).toBe(true);
  });

  it("refuses pending, killed, and one-shot records", () => {
    const pending = synthesizeSchedule(nasdaqChain(), {
      id: "synth-fire-p",
      cron: "0 6 * * *",
    });
    expect(() => materializeSynthesizedRecord(pending)).toThrow(
      /only approved records materialize/,
    );
    expect(() =>
      materializeSynthesizedRecord(killSynthesizedRecord(approvedRecurring())),
    ).toThrow(/only approved records materialize/);
    expect(() => materializeSynthesizedRecord(approvedOneShot())).toThrow(
      /one-shot.*materialize|materialize.*one-shot/i,
    );
  });

  it("refuses a recurring record with no cron", () => {
    const record: SynthesizedSchedule = {
      ...approvedRecurring(),
      cron: null,
    };
    expect(() => materializeSynthesizedRecord(record)).toThrow(/cron/);
  });
});

describe("governed firing decision (#1517)", () => {
  it("is exactly shouldFireGoverned: approved + due fires, everything else does not", () => {
    const now = new Date("2026-10-25T06:00:00Z");
    const cases: Array<[SynthesizedSchedule, boolean, boolean?]> = [
      [approvedRecurring(), true, false],
      [
        synthesizeSchedule(nasdaqChain(), { id: "synth-fire-p2", cron: "0 6 * * *" }),
        false,
        false,
      ],
      [killSynthesizedRecord(approvedRecurring()), false, false],
      [approvedRecurring(), false, true],
      [approvedOneShot(), true, false],
      [markSynthesizedFired(approvedOneShot(), "2026-10-25T05:30:00.000Z"), false, false],
    ];
    for (const [record, expected, halted] of cases) {
      const decision = decideChainFiring(record, now, { halted: halted ?? false });
      expect(decision.fire).toBe(expected);
      expect(decision.fire).toBe(shouldFireGoverned(record, now, { halted: halted ?? false }));
    }
  });

  it("names the refusal reason: pending, killed, halted, not-due, already-fired", () => {
    const now = new Date("2026-10-25T06:00:00Z");
    expect(
      decideChainFiring(
        synthesizeSchedule(nasdaqChain(), { id: "synth-r-p", cron: "0 6 * * *" }),
        now,
      ).reason,
    ).toMatch(/pending/);
    expect(
      decideChainFiring(killSynthesizedRecord(approvedRecurring()), now).reason,
    ).toMatch(/killed/);
    expect(
      decideChainFiring(approvedRecurring(), now, { halted: true }).reason,
    ).toMatch(/halted/);
    expect(
      decideChainFiring(approvedRecurring(), new Date("2026-10-25T07:00:00Z")).reason,
    ).toMatch(/not due/);
    expect(
      decideChainFiring(
        markSynthesizedFired(approvedOneShot(), "2026-10-25T05:30:00.000Z"),
        now,
      ).reason,
    ).toMatch(/already fired/);
    expect(decideChainFiring(approvedRecurring(), now).reason).toMatch(
      /approved and due/,
    );
  });
});

describe("blocked-firing audit (#1517)", () => {
  it("writes a blocked #755 audit row for a killed record, via the shipped path", () => {
    const sql = makeFakeSql();
    const record = killSynthesizedRecord(approvedRecurring());
    const id = auditBlockedChainFiring(
      sql,
      record,
      "killed",
      new Date("2026-10-25T06:00:00.000Z"),
    );
    expect(typeof id).toBe("string");
    expect(sql.rows).toHaveLength(1);
    expect(sql.rows[0].subject).toBe(record.id);
    expect(sql.rows[0].status).toBe("blocked");
    expect(sql.rows[0].block_reason).toMatch(/killed/);
  });
});
