import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startPolling } from "../src/client/polling";

/**
 * Issue #329 (P1) — the 4 s `/api/jobs` poll made an idle dashboard tab cost
 * 21.6k requests/day, and both free-tier budgets are 100k/day spent
 * one-per-request. These tests pin the scheduler's contract: idle cadence when
 * nothing is in flight, fast cadence while work is queued, and no requests at
 * all while the tab is hidden.
 */
function makeDoc(initial: "visible" | "hidden" = "visible") {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial as Document["visibilityState"],
    addEventListener: (_event: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_event: string, fn: () => void) => listeners.delete(fn),
    setVisibility(state: "visible" | "hidden") {
      doc.visibilityState = state as Document["visibilityState"];
      for (const fn of listeners) fn();
    },
  };
  return doc;
}

describe("visibility-aware polling (#329 P1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses the idle cadence when no work is in flight", async () => {
    const run = vi.fn();
    const stop = startPolling(run, { fastMs: 4_000, idleMs: 20_000, doc: makeDoc() });

    await vi.advanceTimersByTimeAsync(19_000);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledTimes(1); // still idle: no 4 s poll

    stop();
  });

  it("switches to the fast cadence after the poll that discovers work", async () => {
    let busy = false;
    const run = vi.fn();
    const stop = startPolling(run, {
      fastMs: 4_000,
      idleMs: 20_000,
      isBusy: () => busy,
      doc: makeDoc(),
    });

    // Cadence is decided when the next tick is armed, so a job queued while
    // idle is picked up on the next idle poll, and every poll after that runs
    // fast until the queue clears.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(1);

    busy = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledTimes(3);

    busy = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledTimes(4); // this poll arms the idle cadence

    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledTimes(4);

    stop();
  });

  it("does not schedule anything while the tab is hidden", async () => {
    const run = vi.fn();
    const doc = makeDoc("hidden");
    const stop = startPolling(run, { fastMs: 4_000, idleMs: 20_000, doc });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).not.toHaveBeenCalled();

    stop();
  });

  it("pauses when hidden and polls immediately when visible again", async () => {
    const run = vi.fn();
    const doc = makeDoc("visible");
    const stop = startPolling(run, { fastMs: 4_000, idleMs: 20_000, doc });

    const beforeHide = vi.getTimerCount();
    expect(beforeHide).toBeGreaterThan(0);

    doc.setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();

    doc.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    stop();
  });

  it("stops on cleanup", async () => {
    const run = vi.fn();
    const doc = makeDoc();
    const stop = startPolling(run, { fastMs: 4_000, idleMs: 20_000, doc });

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).not.toHaveBeenCalled();

    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps polling when a refresh throws", async () => {
    let calls = 0;
    const stop = startPolling(
      async () => {
        calls += 1;
        throw new Error("network down");
      },
      { fastMs: 4_000, idleMs: 4_000, doc: makeDoc() }
    );

    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toBe(2);

    stop();
  });
});
