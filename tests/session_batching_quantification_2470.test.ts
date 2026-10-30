/**
 * Issue #2470 — remaining DO request optimizations under Paid.
 *
 * S1 quantification (session get+put batching), pinned in code rather
 * than built: the stale path of validateAndTouchWiredSession costs at
 * most TWO store calls (freshRead, plus persist only when the session
 * was actually touched), and persists happen at most ONCE per touch
 * interval per user per isolate. Batching the get+put into one RPC
 * would therefore save at most one store call per touch interval —
 * 1,440/day per continuously active user at the old 60s interval,
 * 288/day at the #2470 S2 300s interval — against the doc's measured
 * ~100k DO requests/day. Capturing it would need a session-aware DO
 * op duplicating the touch rule server-side (a parallel
 * implementation of touchSession), so the slice outcome is
 * verified-negligible: documented here, not built.
 *
 * S2 (touch interval 60s → 300s): the interval value itself is pinned
 * (config/session-limits.json is the single source of truth), and the
 * validator timeline below proves persist frequency moves with it
 * while expiry/idle verdicts do not.
 */
import { describe, expect, it } from "vitest";
import type { SessionData } from "../src/types";
import {
  validateAndTouchWiredSession,
  type WiredSessionStoreDeps,
} from "../src/security/iaaaEnforcement";
import { IAAA_TOUCH_MIN_INTERVAL_MS } from "../src/security/iaaaSessionActivity";
import { SESSION_LIMITS } from "../src/config/sessionLimits";

const NOW = 2_000_000_000;
// 8h, the config idle window: the timeline's oldest lastActivity gap
// (10 touch intervals = 50 min) must stay inside idle, or the
// validator denies for idle expiry before any touch is considered.
const IDLE_TIMEOUT_MS = 28_800_000;

function wiredSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    githubLogin: "octo",
    githubAvatar: "",
    githubName: "Octo",
    createdAt: NOW - 1_000,
    internalUserId: "user-1",
    providerIssuer: "https://github.com",
    providerSubject: "42",
    authTimeMs: NOW - 1_000,
    sessionVersion: 1,
    lastActivityMs: NOW - 1_000,
    ...overrides,
  };
}

/** Counting fake deps over a mutable stored record (persist updates it). */
function countingDeps(store: { current: SessionData | null }) {
  const counts = { freshReads: 0, persists: 0 };
  const deps: WiredSessionStoreDeps = {
    async freshRead() {
      counts.freshReads += 1;
      return store.current;
    },
    async persist(_id, data) {
      counts.persists += 1;
      store.current = data;
      return { ok: true };
    },
    invalidate() {},
  };
  return { deps, counts };
}

describe("S2 touch interval (#2470)", () => {
  it("is 300s in the config source of truth (was 60s)", () => {
    expect(SESSION_LIMITS.touchIntervalMs).toBe(300_000);
    expect(IAAA_TOUCH_MIN_INTERVAL_MS).toBe(300_000);
  });
});

describe("S1 stale-path store-call bound (#2470)", () => {
  it("stale + untouched costs exactly one store call (freshRead only)", async () => {
    const store = { current: wiredSession({ lastActivityMs: NOW - 1_000 }) };
    const { deps, counts } = countingDeps(store);
    const result = await validateAndTouchWiredSession(deps, store.current, "s1", NOW, {
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
    expect(result).toEqual({ wired: true, session: store.current });
    expect(counts).toEqual({ freshReads: 1, persists: 0 });
  });

  it("stale + touched costs exactly two store calls (freshRead + persist)", async () => {
    const store = {
      current: wiredSession({ lastActivityMs: NOW - 10 * IAAA_TOUCH_MIN_INTERVAL_MS }),
    };
    const { deps, counts } = countingDeps(store);
    const result = await validateAndTouchWiredSession(deps, store.current, "s1", NOW, {
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
    expect(result.wired).toBe(true);
    if (result.wired) expect(result.session?.lastActivityMs).toBe(NOW);
    expect(counts).toEqual({ freshReads: 1, persists: 1 });
  });

  it("persists at most once per touch interval across consecutive stale-path requests", async () => {
    const interval = IAAA_TOUCH_MIN_INTERVAL_MS;
    const store = {
      current: wiredSession({ lastActivityMs: NOW - 10 * interval }),
    };
    const { deps, counts } = countingDeps(store);
    const call = (at: number) =>
      validateAndTouchWiredSession(deps, store.current, "s1", at, {
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      });
    await call(NOW);
    expect(counts.persists).toBe(1);
    // Gap under one interval since the last touch: no second persist.
    await call(NOW + interval - 1);
    expect(counts.persists).toBe(1);
    // Gap of exactly one interval: the second persist lands.
    await call(NOW + interval);
    expect(counts.persists).toBe(2);
    // And the next sub-interval request does not persist again.
    await call(NOW + 2 * interval - 1);
    expect(counts.persists).toBe(2);
    expect(counts.freshReads).toBe(4);
  });

  it("touching never rescues an absolutely expired session", async () => {
    const store = {
      current: wiredSession({
        createdAt: NOW - SESSION_LIMITS.absoluteTtlSeconds * 1000 - 1_000,
        lastActivityMs: NOW - 10 * IAAA_TOUCH_MIN_INTERVAL_MS,
      }),
    };
    const { deps, counts } = countingDeps(store);
    const result = await validateAndTouchWiredSession(deps, store.current, "s1", NOW, {
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
    expect(result).toEqual({ wired: true, session: null });
    expect(counts.persists).toBe(0);
  });
});
