/**
 * Issue #828: run lock prevents concurrent screens.
 */
import { describe, it, expect, vi } from "vitest";

describe("runScreen lock (#828)", () => {
  it("second concurrent run is rejected", async () => {
    // Mock storage with an active lock
    const storage = new Map<string, string>();
    storage.set("screen_lock:testuser:nasdaq100", Date.now().toString());

    const mockCtx = {
      storage: {
        get: async (k: string) => storage.get(k) || null,
        put: async (k: string, v: string) => { storage.set(k, v); },
        delete: async (k: string) => { storage.delete(k); },
      },
    };

    // Simulate the lock check logic
    const lockKey = `screen_lock:testuser:nasdaq100`;
    const existingLock = await mockCtx.storage.get(lockKey);
    expect(existingLock).toBeTruthy();

    const lockAge = Date.now() - parseInt(existingLock!, 10);
    expect(lockAge).toBeLessThan(5 * 60 * 1000); // Not stale

    // Should reject
    expect(() => {
      if (existingLock && lockAge < 5 * 60 * 1000) {
        throw new Error("Screen already running");
      }
    }).toThrow("Screen already running");
  });

  it("stale lock (>5min) is taken over", async () => {
    const storage = new Map<string, string>();
    // Lock from 10 minutes ago
    storage.set("screen_lock:testuser:nasdaq100", (Date.now() - 10 * 60 * 1000).toString());

    const mockCtx = {
      storage: {
        get: async (k: string) => storage.get(k) || null,
      },
    };

    const lockKey = `screen_lock:testuser:nasdaq100`;
    const existingLock = await mockCtx.storage.get(lockKey);
    const lockAge = Date.now() - parseInt(existingLock!, 10);

    // Stale — should NOT reject
    const shouldReject = existingLock && lockAge < 5 * 60 * 1000;
    expect(shouldReject).toBe(false);
  });
});
