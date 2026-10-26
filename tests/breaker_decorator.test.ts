/**
 * Issue #1745 ([AGENTIC] Automated market data circuit breakers).
 *
 * Pins: the withBreaker decorator layering — budget gate before any
 * provider call, breaker gate with zero spend while open, retry reuse
 * (withRetry, acquisition policy), fallback on open/budget/failure,
 * business errors (never raw provider errors) when no fallback exists,
 * and the fetchBatched chunking helper (one budgeted execution per
 * batch call, not per symbol).
 */
import { describe, expect, it, vi } from "vitest";
import { createBreakerRegistry } from "../src/breakers/breakerPorts";
import {
  BreakerBudgetExhaustedError,
  BreakerOpenError,
  fetchBatched,
  withBreaker,
} from "../src/breakers/breakerDecorator";
import type { BudgetGate } from "../src/breakers/breakerPorts";

const noSleep = async () => {};

function memBudget(limit: number): BudgetGate & { used: number } {
  let used = 0;
  return {
    get used() {
      return used;
    },
    get exhausted() {
      return used >= limit;
    },
    tryConsume() {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
  };
}

describe("withBreaker", () => {
  it("passes provider success through unchanged", async () => {
    const r = createBreakerRegistry();
    const out = await withBreaker(r.breakerFor("yahoo"), async () => "live", {
      sleep: noSleep,
    });
    expect(out).toEqual({ status: "success", value: "live", state: "closed" });
  });

  it("serves the fallback instantly while open, with zero provider calls and zero budget spend", async () => {
    const r = createBreakerRegistry();
    const b = r.breakerFor("yahoo");
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    for (let i = 0; i < 3; i++) {
      await expect(withBreaker(b, fn, { sleep: noSleep })).rejects.toThrow("boom");
    }
    expect(b.getState()).toBe("open");
    const budget = memBudget(10);
    fn.mockClear();
    const out = await withBreaker(b, fn, {
      sleep: noSleep,
      budget,
      fallback: async () => "cached",
    });
    expect(out.status).toBe("fallback");
    expect(out.value).toBe("cached");
    expect(fn).not.toHaveBeenCalled();
    expect(budget.used).toBe(0);
    expect(b.snapshot().totalFallbacks).toBe(1);
  });

  it("throws a business error while open when no fallback exists", async () => {
    const r = createBreakerRegistry();
    const b = r.breakerFor("etrade");
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(b, async () => {
          throw new Error("raw provider 500");
        }, { sleep: noSleep })
      ).rejects.toThrow("raw provider 500");
    }
    await expect(
      withBreaker(b, async () => "never", { sleep: noSleep })
    ).rejects.toThrow(BreakerOpenError);
    await expect(
      withBreaker(b, async () => "never", { sleep: noSleep })
    ).rejects.toThrow(/temporarily unavailable/);
  });

  it("budget exhaustion yields the fallback (qualified partial), never a mid-scan throw", async () => {
    const r = createBreakerRegistry();
    const b = r.breakerFor("yahoo");
    const budget = memBudget(1);
    await withBreaker(b, async () => "first", { sleep: noSleep, budget });
    expect(budget.used).toBe(1);
    const fn = vi.fn(async () => "second");
    const out = await withBreaker(b, fn, {
      sleep: noSleep,
      budget,
      fallback: async () => "fallback-value",
    });
    expect(out.status).toBe("fallback");
    expect(fn).not.toHaveBeenCalled();
  });

  it("budget exhaustion with no fallback throws a business error", async () => {
    const r = createBreakerRegistry();
    const b = r.breakerFor("yahoo");
    const budget = memBudget(0);
    await expect(
      withBreaker(b, async () => "x", { sleep: noSleep, budget })
    ).rejects.toThrow(BreakerBudgetExhaustedError);
  });

  it("spends the budget once per execute, not once per retry attempt", async () => {
    const r = createBreakerRegistry();
    const b = r.breakerFor("yahoo");
    const budget = memBudget(10);
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      withBreaker(b, fn, {
        sleep: noSleep,
        budget,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      })
    ).rejects.toThrow("boom");
    expect(fn.mock.calls.length).toBe(3);
    expect(budget.used).toBe(1);
  });

  it("retries then succeeds: retry reuse, breaker stays closed", async () => {
    const r = createBreakerRegistry();
    const b = r.breakerFor("alpaca");
    let attempts = 0;
    const out = await withBreaker(
      b,
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("flap");
        return "recovered";
      },
      {
        sleep: noSleep,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      }
    );
    expect(out.status).toBe("success");
    expect(attempts).toBe(3);
    expect(b.getState()).toBe("closed");
    expect(b.snapshot().consecutiveFailures).toBe(0);
  });

  it("a throwing fallback propagates its own error unchanged", async () => {
    const r = createBreakerRegistry();
    const b = r.breakerFor("yahoo");
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(b, async () => {
          throw new Error("boom");
        }, { sleep: noSleep })
      ).rejects.toThrow("boom");
    }
    await expect(
      withBreaker(b, async () => "never", {
        sleep: noSleep,
        fallback: async () => {
          throw new Error("cache empty");
        },
      })
    ).rejects.toThrow("cache empty");
  });

  it("emitter failure is swallowed and never fails the breaker operation", async () => {
    const r = createBreakerRegistry({
      emit: () => {
        throw new Error("emitter down");
      },
    });
    const b = r.breakerFor("yahoo");
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(b, async () => {
          throw new Error("boom");
        }, { sleep: noSleep })
      ).rejects.toThrow("boom");
    }
    expect(b.getState()).toBe("open");
  });
});

describe("fetchBatched", () => {
  it("chunks items, preserves order, and calls once per chunk", async () => {
    const seen: number[][] = [];
    const out = await fetchBatched([1, 2, 3, 4, 5], 2, async (chunk) => {
      seen.push(chunk);
      return chunk.map((n) => n * 10);
    });
    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("empty input makes no calls; chunk size clamps to at least 1", async () => {
    const fn = vi.fn(async (chunk: number[]) => chunk);
    await expect(fetchBatched([], 5, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
    await expect(fetchBatched([1, 2], 0, fn)).resolves.toEqual([1, 2]);
    expect(fn.mock.calls.length).toBe(2);
  });
});
