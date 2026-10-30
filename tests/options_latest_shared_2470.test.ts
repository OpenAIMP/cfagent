/** @vitest-environment jsdom */
/**
 * Issue #2470 S4 — double-poll dedup for /api/options/latest.
 *
 * ScheduledOptionsManager and AutonomousOptionsRuns both polled the
 * same endpoint every 60s when both were mounted (#2419 residual).
 * The shared subscription below must produce exactly ONE network
 * poll per cadence no matter how many components subscribe, while
 * keeping single-subscriber behavior identical to #2422 (immediate
 * fetch on mount, externalized cadence, hidden-pause, fetch on
 * return to visible).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function loadShared() {
  vi.resetModules();
  return (await import("../src/client/optionsLatestShared")) as typeof import(
    "../src/client/optionsLatestShared"
  );
}

describe("shared /api/options/latest subscription (#2470 S4)", () => {
  let fetchCalls: string[];
  let fetchImpl: (input: unknown) => Promise<unknown>;
  let offs: Array<() => void>;

  function track(shared: {
    subscribeOptionsLatest: (fn: (snap: unknown) => void) => () => void;
  }) {
    return (fn: (snap: unknown) => void) => {
      const off = shared.subscribeOptionsLatest(fn as never);
      offs.push(off);
      return off;
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchCalls = [];
    offs = [];
    // A previous test's poller may have left the document hidden.
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    fetchImpl = async (input: unknown) => {
      fetchCalls.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({ runs: [{ timestamp: "t1" }] }),
      };
    };
    vi.stubGlobal("fetch", vi.fn((input: unknown) => fetchImpl(input)));
    (window as any).__POLLING_CONFIG__ = { optionsLatestPollMs: 1000 };
    // Issue #2481: the shared poller is gated by the global
    // auto-refresh switch; this #2470 pin covers ON. The mirror
    // survives loadShared's resetModules, so the fresh module
    // instance reads ON; OFF gating is pinned separately in the
    // auto-refresh suite.
    window.localStorage.setItem("cfagent_global_autorefresh_enabled", "true");
  });

  afterEach(() => {
    // Unsubscribe everything: each test loads a fresh module instance
    // via resetModules, but stale instances' visibility listeners stay
    // attached to the shared document and would otherwise fetch on
    // later tests' visibility flips.
    for (const off of offs) off();
    offs = [];
    vi.unstubAllGlobals();
    delete (window as any).__POLLING_CONFIG__;
    window.localStorage.removeItem("cfagent_global_autorefresh_enabled");
    vi.useRealTimers();
  });

  it("two subscribers share one immediate fetch; the second gets the snapshot without a new fetch", async () => {
    const shared = await loadShared();
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    track(shared)((snap) => seenA.push(snap));
    track(shared)((snap) => seenB.push(snap));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toEqual(["/api/options/latest"]);
    expect(seenA.length).toBe(1);
    expect(seenB.length).toBe(1);
  });

  it("one poll per cadence serves all subscribers", async () => {
    const shared = await loadShared();
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    track(shared)((snap) => seenA.push(snap));
    track(shared)((snap) => seenB.push(snap));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchCalls.length).toBe(2);
    expect(seenA.length).toBe(2);
    expect(seenB.length).toBe(2);
  });

  it("unsubscribing all stops the poller", async () => {
    const shared = await loadShared();
    const offA = track(shared)(() => {});
    const offB = track(shared)(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls.length).toBe(1);
    offA();
    offB();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchCalls.length).toBe(1);
  });

  it("refresh coalesces with an in-flight fetch", async () => {
    const shared = await loadShared();
    let resolveFetch!: (value: unknown) => void;
    fetchImpl = (input: unknown) => {
      fetchCalls.push(String(input));
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    };
    const seen: unknown[] = [];
    track(shared)((snap) => seen.push(snap));
    shared.refreshOptionsLatest();
    shared.refreshOptionsLatest();
    expect(fetchCalls.length).toBe(1);
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ runs: [] }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.length).toBe(1);
    expect(fetchCalls.length).toBe(1);
  });

  it("an error snapshot reaches all subscribers", async () => {
    const shared = await loadShared();
    fetchImpl = async (input: unknown) => {
      fetchCalls.push(String(input));
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    };
    const seen: Array<{ ok: boolean; error: string | null }> = [];
    track(shared)((snap) => seen.push(snap));
    track(shared)((snap) => seen.push(snap));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls.length).toBe(1);
    expect(seen).toEqual([
      { ok: false, status: 500, runs: [], error: "boom" },
      { ok: false, status: 500, runs: [], error: "boom" },
    ]);
  });

  it("hidden pauses the shared poll; visible refetches once", async () => {
    const shared = await loadShared();
    track(shared)(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls.length).toBe(1);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchCalls.length).toBe(1);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls.length).toBe(2);
  });
});
