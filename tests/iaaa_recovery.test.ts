import { describe, it, expect } from "vitest";
import { reconcileInterruptedExecution } from "../src/security/lifecycle";

/**
 * Issue #945, Slice 6 — lifecycle verification: interrupted-execution
 * reconciliation.
 *
 * Spec §6 acceptance case: "Interrupted execution reconciles without
 * blindly repeating side effects". This is a pure ledger function:
 * it decides, from a recorded list of already-completed side effects,
 * which planned side effects a retry may still perform. It does NOT
 * execute, retry, or touch any live task, job, or side effect, and
 * it never replays a completed side effect. An execution whose
 * outcome is unknown is reported for manual review, never retried
 * on assumption.
 */

describe("iaaa recovery (#945 slice 6)", () => {
  it("returns only the not-yet-completed side effects on retry", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["send-email", "write-record", "notify-user"],
      completedSideEffectIds: ["send-email"],
      outcome: "interrupted",
    });
    expect(result.toExecute).toEqual(["write-record", "notify-user"]);
    expect(result.alreadyCompleted).toEqual(["send-email"]);
    expect(result.outcome).toBe("resume");
  });

  it("never replays a completed side effect, even if it appears twice in the ledger", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["a", "b"],
      completedSideEffectIds: ["a", "a"],
      outcome: "interrupted",
    });
    expect(result.toExecute).toEqual(["b"]);
    expect(result.alreadyCompleted).toEqual(["a"]);
    expect(result.toExecute).not.toContain("a");
  });

  it("returns nothing to execute when every planned side effect already completed", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["a", "b"],
      completedSideEffectIds: ["a", "b"],
      outcome: "interrupted",
    });
    expect(result.toExecute).toEqual([]);
    expect(result.outcome).toBe("complete");
  });

  it("returns everything to execute when nothing completed before interruption", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["a", "b"],
      completedSideEffectIds: [],
      outcome: "interrupted",
    });
    expect(result.toExecute).toEqual(["a", "b"]);
    expect(result.outcome).toBe("resume");
  });

  it("reports an interrupted execution with unknown outcome as unknown, requiring manual review", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["a", "b"],
      completedSideEffectIds: ["a"],
      outcome: "unknown",
    });
    // Must NOT blindly repeat "b" (or replay "a"): with an unknown
    // outcome, the ledger itself cannot be trusted to be complete.
    expect(result.toExecute).toEqual([]);
    expect(result.outcome).toBe("unknown-requires-manual-review");
    expect(result.reason).toMatch(/manual review/);
  });

  it("reports unknown outcome for manual review even with an empty ledger", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["a"],
      completedSideEffectIds: [],
      outcome: "unknown",
    });
    expect(result.toExecute).toEqual([]);
    expect(result.outcome).toBe("unknown-requires-manual-review");
  });

  it("reports completed side effects outside the plan instead of silently dropping them", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["a"],
      completedSideEffectIds: ["a", "surprise-effect"],
      outcome: "interrupted",
    });
    expect(result.unexpectedCompleted).toEqual(["surprise-effect"]);
    expect(result.toExecute).toEqual([]);
    expect(result.outcome).toBe("complete");
  });

  it("preserves planned order and deduplicates planned side effects", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["b", "a", "b", "c"],
      completedSideEffectIds: ["a"],
      outcome: "interrupted",
    });
    expect(result.toExecute).toEqual(["b", "c"]);
  });

  it("treats a recorded completed outcome as nothing left to do", () => {
    const result = reconcileInterruptedExecution({
      taskId: "task-1",
      plannedSideEffects: ["a"],
      completedSideEffectIds: ["a"],
      outcome: "completed",
    });
    expect(result.toExecute).toEqual([]);
    expect(result.outcome).toBe("complete");
  });
});
