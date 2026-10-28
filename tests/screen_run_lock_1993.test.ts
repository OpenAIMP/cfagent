/**
 * Issue #1993: atomic run lock + sharded submission gate.
 * Lock semantics are pinned against the real module with the same
 * faithful fake executor as tests/screener_run_lock.test.ts; wiring
 * is pinned by source inspection (the DO/runtime paths cannot run
 * under vitest).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  acquireScreenRunLock,
  isScreenRunning,
  releaseScreenRunLock,
} from "../src/services/screenRunLock";
import { createFakeLockSql } from "./screener_run_lock.test";

describe("atomic lock semantics (#1993)", () => {
  it("a stale-takeover race has exactly one winner", () => {
    const { exec } = createFakeLockSql();
    acquireScreenRunLock(exec, "u", "TECH", Date.now() - 10 * 60 * 1000);
    const a = acquireScreenRunLock(exec, "u", "TECH");
    const b = acquireScreenRunLock(exec, "u", "TECH");
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
  });

  it("release frees only for the holder's token", () => {
    const { exec } = createFakeLockSql();
    const first = acquireScreenRunLock(exec, "u", "TECH");
    releaseScreenRunLock(exec, "u", "TECH", "not-the-holder");
    expect(isScreenRunning(exec, "u", "TECH").running).toBe(true);
    expect(acquireScreenRunLock(exec, "u", "TECH").acquired).toBe(false);
    releaseScreenRunLock(exec, "u", "TECH", first.token);
    expect(isScreenRunning(exec, "u", "TECH").running).toBe(false);
    expect(acquireScreenRunLock(exec, "u", "TECH").acquired).toBe(true);
  });

  it("isScreenRunning ignores stale rows and absent rows", () => {
    const { exec } = createFakeLockSql();
    expect(isScreenRunning(exec, "u", "TECH").running).toBe(false);
    acquireScreenRunLock(exec, "u", "TECH", Date.now() - 10 * 60 * 1000);
    expect(isScreenRunning(exec, "u", "TECH").running).toBe(false);
    acquireScreenRunLock(exec, "u", "TECH");
    expect(isScreenRunning(exec, "u", "TECH").running).toBe(true);
  });

  it("locks are scoped per user + universe", () => {
    const { exec } = createFakeLockSql();
    expect(acquireScreenRunLock(exec, "u1", "TECH").acquired).toBe(true);
    expect(acquireScreenRunLock(exec, "u2", "TECH").acquired).toBe(true);
    expect(acquireScreenRunLock(exec, "u1", "NASDAQ100").acquired).toBe(true);
    expect(acquireScreenRunLock(exec, "u1", "TECH").acquired).toBe(false);
  });
});

describe("sharded submission gate behavior (#1993)", () => {
  // Mirrors the #1412 test's construction: mock env + ORM, stubbed
  // auth guard, stubbed agent probe. The gate itself runs against
  // the real autonomousMarketScreenSharded path.
  async function gatedService(running: boolean) {
    const { ScheduledTasksService } = await import("../src/services/scheduledTasks");
    const { DatabaseORM } = await import("../src/orm");
    const mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
    } as any;
    const service = new ScheduledTasksService(mockEnv, new DatabaseORM({ exec: () => [] } as any), "test_trader");
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({
      isScreenRunning: async () => ({ running, startedAt: running ? Date.now() : null }),
    });
    const shardSubmit = vi.fn(async () => ({
      jobId: "test-chain",
      status: "queued" as const,
      statusUrl: "https://example.test/jobs/test-chain",
    }));
    (service as any).shardSubmit = shardSubmit;
    return { service, shardSubmit };
  }

  it("refuses submission while a monolithic run holds the lock", async () => {
    const { service, shardSubmit } = await gatedService(true);
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).not.toHaveBeenCalled();
    expect((result as any).skipped).toBe(true);
    expect((result as any).skippedReason).toBe("already-running");
  });

  it("submits when no run holds the lock", async () => {
    const { service, shardSubmit } = await gatedService(false);
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe("wiring (#1993)", () => {
  const agentSrc = readFileSync("src/agents/screener-agent.ts", "utf8");
  const tasksSrc = readFileSync("src/services/scheduledTasks.ts", "utf8");

  it("runScreen acquires the SQLite lock and always releases it", () => {
    expect(agentSrc).toContain("acquireScreenRunLock(this.lockSql()");
    expect(agentSrc).toContain("releaseScreenRunLock(this.lockSql()");
    expect(agentSrc).toContain("Screen already running for");
    // The async-KV lock is gone: no screen_lock: key remains anywhere.
    expect(agentSrc).not.toContain("screen_lock:");
  });

  it("the sharded path gates submission on the lock probe", () => {
    expect(tasksSrc).toContain("isScreenRunning(universe, userLogin)");
    expect(tasksSrc).toContain('skippedReason: "already-running"');
    // Gate sits before submission: the probe precedes the shardSubmit
    // call in the sharded function.
    const sharded = tasksSrc.slice(tasksSrc.indexOf("autonomousMarketScreenSharded"));
    expect(sharded.indexOf("isScreenRunning")).toBeLessThan(sharded.indexOf("await this.shardSubmit("));
  });
});
