/**
 * Issue #1745 ([AGENTIC] Automated market data circuit breakers).
 *
 * Pins: breaker state machine (closed → open → half-open → closed /
 * re-open), per-provider registry, policy resolution (code defaults <
 * env < settings, invalid ignored), metrics snapshots (#1742 hooks),
 * and the CloudEvents state-change envelope (same envelope as #1739,
 * id-as-idempotency-key). Clock injected — no real waiting.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BREAKER_PROVIDER_IDS,
  createBreakerRegistry,
  resolveBreakerPolicyFor,
  toBreakerStateChangeEnvelope,
  type BreakerPolicy,
  type BreakerStateChangeEvent,
} from "../src/breakers/breakerPorts";
import { InMemoryCircuitBreaker } from "../src/breakers/inMemoryBreakerAdapter";

const policy: BreakerPolicy = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxProbes: 1,
};

function clock(startMs = 1_000_000) {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const noSleep = async () => {};

describe("resolveBreakerPolicyFor", () => {
  it("defaults to threshold 3 / reset 30s / single probe", () => {
    expect(resolveBreakerPolicyFor("yahoo")).toEqual(policy);
  });

  it("env overrides defaults per provider, other providers unaffected", () => {
    const p = resolveBreakerPolicyFor("yahoo", {
      BREAKER_YAHOO_FAILURE_THRESHOLD: "2",
      BREAKER_YAHOO_RESET_TIMEOUT_MS: "5000",
    });
    expect(p).toEqual({ failureThreshold: 2, resetTimeoutMs: 5_000, halfOpenMaxProbes: 1 });
    expect(resolveBreakerPolicyFor("etrade", {
      BREAKER_YAHOO_FAILURE_THRESHOLD: "2",
    })).toEqual(policy);
  });

  it("settings override env; invalid values ignored with no throw", () => {
    const p = resolveBreakerPolicyFor(
      "nasdaq",
      { BREAKER_NASDAQ_FAILURE_THRESHOLD: "2" },
      { "breaker.nasdaq.failureThreshold": "5", "breaker.nasdaq.resetTimeoutMs": "banana" }
    );
    expect(p.failureThreshold).toBe(5);
    expect(p.resetTimeoutMs).toBe(30_000);
  });
});

describe("InMemoryCircuitBreaker state machine", () => {
  it("trips after threshold consecutive retryable failures, then rejects without calling fn", async () => {
    const c = clock();
    const b = new InMemoryCircuitBreaker("yahoo", policy, { nowMs: c.nowMs });
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(failing, { sleep: noSleep })).rejects.toThrow("boom");
    }
    expect(b.getState()).toBe("open");
    expect(b.snapshot().totalTrips).toBe(1);
    // Open breaker rejects without calling fn at all.
    const callsBefore = failing.mock.calls.length;
    await expect(
      b.execute(failing, { sleep: noSleep })
    ).rejects.toThrow(/temporarily unavailable/);
    expect(failing.mock.calls.length).toBe(callsBefore);
    await expect(b.execute(failing, { sleep: noSleep })).rejects.toThrow(
      /temporarily unavailable/
    );
    expect(failing.mock.calls.length).toBe(callsBefore);
  });

  it("counts one failure per execute, not per retry attempt", async () => {
    const c = clock();
    const b = new InMemoryCircuitBreaker("yahoo", policy, { nowMs: c.nowMs });
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      b.execute(failing, {
        sleep: noSleep,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      })
    ).rejects.toThrow("boom");
    expect(failing.mock.calls.length).toBe(3);
    expect(b.snapshot().consecutiveFailures).toBe(1);
    expect(b.getState()).toBe("closed");
  });

  it("half-open probe success closes; probe failure re-opens", async () => {
    const c = clock();
    const b = new InMemoryCircuitBreaker("etrade", policy, { nowMs: c.nowMs });
    const failing = async () => {
      throw new Error("boom");
    };
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(failing, { sleep: noSleep })).rejects.toThrow("boom");
    }
    expect(b.getState()).toBe("open");
    c.advance(30_000);
    await expect(b.execute(async () => "ok", { sleep: noSleep })).resolves.toEqual({
      status: "success",
      value: "ok",
      state: "closed",
    });
    expect(b.getState()).toBe("closed");
    // Trip again, then fail the probe.
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(failing, { sleep: noSleep })).rejects.toThrow("boom");
    }
    c.advance(30_000);
    await expect(b.execute(failing, { sleep: noSleep })).rejects.toThrow("boom");
    expect(b.getState()).toBe("open");
    // Trips: initial trip + re-trip after close + probe-failure re-open.
    expect(b.snapshot().totalTrips).toBe(3);
  });

  it("second caller during a half-open probe is rejected immediately", async () => {
    const c = clock();
    const b = new InMemoryCircuitBreaker("alpaca", policy, { nowMs: c.nowMs });
    const failing = async () => {
      throw new Error("boom");
    };
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(failing, { sleep: noSleep })).rejects.toThrow("boom");
    }
    c.advance(30_000);
    let release!: () => void;
    const probe = new Promise<string>((resolve) => {
      release = () => resolve("ok");
    });
    const first = b.execute(() => probe, { sleep: noSleep });
    await expect(
      b.execute(async () => "late", { sleep: noSleep })
    ).rejects.toThrow(/temporarily unavailable/);
    release();
    await expect(first).resolves.toMatchObject({ status: "success", value: "ok" });
    expect(b.getState()).toBe("closed");
  });

  it("permanent failures (shouldRetry false) do not count toward the trip threshold", async () => {
    const c = clock();
    const b = new InMemoryCircuitBreaker("public", policy, { nowMs: c.nowMs });
    const authFail = async () => {
      throw new Error("401 unauthorized");
    };
    for (let i = 0; i < 5; i++) {
      await expect(
        b.execute(authFail, { sleep: noSleep, shouldRetry: () => false })
      ).rejects.toThrow("401");
    }
    expect(b.snapshot().consecutiveFailures).toBe(0);
    expect(b.getState()).toBe("closed");
    expect(b.snapshot().totalFailures).toBe(5);
  });

  it("reset() returns an open breaker to closed with cleared counts", async () => {
    const c = clock();
    const b = new InMemoryCircuitBreaker("nasdaq", policy, { nowMs: c.nowMs });
    const failing = async () => {
      throw new Error("boom");
    };
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(failing, { sleep: noSleep })).rejects.toThrow("boom");
    }
    expect(b.getState()).toBe("open");
    b.reset();
    expect(b.getState()).toBe("closed");
    expect(b.snapshot().consecutiveFailures).toBe(0);
  });
});

describe("createBreakerRegistry", () => {
  it("covers the five registry provider ids with one instance each", () => {
    const r = createBreakerRegistry();
    expect([...BREAKER_PROVIDER_IDS].sort()).toEqual(
      ["alpaca", "etrade", "nasdaq", "public", "yahoo"].sort()
    );
    for (const id of BREAKER_PROVIDER_IDS) {
      expect(r.breakerFor(id)).toBe(r.breakerFor(id));
      expect(r.breakerFor(id).providerId).toBe(id);
    }
    expect(r.snapshots()).toHaveLength(5);
  });

  it("emits a state-change event on trip with counts only", async () => {
    const c = clock();
    const events: BreakerStateChangeEvent[] = [];
    const r = createBreakerRegistry({
      nowMs: c.nowMs,
      onStateChange: (e) => events.push(e),
    });
    const b = r.breakerFor("yahoo");
    const failing = async () => {
      throw new Error("boom");
    };
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(failing, { sleep: noSleep })).rejects.toThrow("boom");
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerId: "yahoo",
      from: "closed",
      to: "open",
      trips: 1,
    });
  });
});

describe("toBreakerStateChangeEnvelope", () => {
  it("builds a CloudEvents v1.0 envelope with counts-only data", () => {
    const event: BreakerStateChangeEvent = {
      providerId: "yahoo",
      from: "closed",
      to: "open",
      atMs: 1_000_000,
      transitionSeq: 7,
      trips: 1,
      fallbacks: 0,
    };
    const env = toBreakerStateChangeEnvelope(event);
    expect(env.specversion).toBe("1.0");
    expect(env.type).toBe("breaker.state_changed");
    expect(env.subject).toBe("yahoo");
    expect(env.id).toBe("breaker-state:yahoo:open:7");
    expect(env.data).toEqual({
      providerId: "yahoo",
      from: "closed",
      to: "open",
      trips: 1,
      fallbacks: 0,
    });
  });
});
