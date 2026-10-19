import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetKvHealth,
  createResilientKv,
  isKvLimitError,
  kvHealth,
} from "../src/security/kvResilience";

/**
 * Issue #329 — the outage behind 1101 was a KV quota throw escaping the Worker.
 * These tests pin the wrapper's contract: reads fail as misses, the breaker
 * stops the Worker from re-hitting KV after a quota error, and writes/deletes
 * cannot throw either.
 */
const QUOTA_ERROR = "KV get() limit exceeded for the day.";

function makeKv(overrides: Partial<{ get: any; put: any; delete: any }> = {}) {
  return {
    get: vi.fn(async () => null as string | null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("resilient KV (#329)", () => {
  beforeEach(() => {
    __resetKvHealth();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetKvHealth();
  });

  it("reads through to KV when healthy", async () => {
    const kv = makeKv({ get: vi.fn(async () => "value") });
    const safe = createResilientKv(kv, "t");

    expect(await safe.get("k")).toBe("value");
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it("turns a quota throw into a miss instead of an exception", async () => {
    const kv = makeKv({
      get: vi.fn(async () => {
        throw new Error(QUOTA_ERROR);
      }),
    });
    const safe = createResilientKv(kv, "quota");

    await expect(safe.get("k")).resolves.toBeNull();
    expect(kvHealth("quota").lastError).toContain("limit exceeded");
    expect(kvHealth("quota").blockedUntil).toBeGreaterThan(Date.now());
  });

  it("stops calling KV while the breaker is open", async () => {
    const kv = makeKv({
      get: vi.fn(async () => {
        throw new Error(QUOTA_ERROR);
      }),
    });
    const safe = createResilientKv(kv, "open", { blockMs: 60_000 });

    await safe.get("a");
    await safe.get("b");
    await safe.get("c");

    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kvHealth("open").suppressedReads).toBe(2);
    await expect(safe.get("d")).resolves.toBeNull();
  });

  it("resumes after the block window", async () => {
    const get = vi.fn(async () => {
      throw new Error(QUOTA_ERROR);
    });
    const safe = createResilientKv(makeKv({ get }), "resume", { blockMs: 30_000 });

    await safe.get("a");
    expect(get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000);
    await safe.get("b");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not open the breaker for unrelated errors", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce("recovered");
    const safe = createResilientKv(makeKv({ get }), "blip");

    await expect(safe.get("a")).resolves.toBeNull();
    expect(kvHealth("blip").blockedUntil).toBe(0);
    await expect(safe.get("a")).resolves.toBe("recovered");
  });

  it("never throws from put or delete", async () => {
    const kv = makeKv({
      put: vi.fn(async () => {
        throw new Error(QUOTA_ERROR);
      }),
      delete: vi.fn(async () => {
        throw new Error(QUOTA_ERROR);
      }),
    });
    const safe = createResilientKv(kv, "writes");

    await expect(safe.put("k", "v")).resolves.toBeUndefined();
    await expect(safe.delete("k")).resolves.toBeUndefined();
  });

  it("behaves as an empty backend when no KV is bound", async () => {
    const safe = createResilientKv(undefined, "none");
    await expect(safe.get("k")).resolves.toBeNull();
    await expect(safe.put("k", "v")).resolves.toBeUndefined();
    await expect(safe.delete("k")).resolves.toBeUndefined();
  });

  it("recognises the quota wording in its common forms", () => {
    expect(isKvLimitError(new Error(QUOTA_ERROR))).toBe(true);
    expect(isKvLimitError("429 Too Many Requests")).toBe(true);
    expect(isKvLimitError(new Error("bad key"))).toBe(false);
  });
});
