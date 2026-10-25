/**
 * Issue #1559 ([AGENTIC] slice-0 cutover) — guarded operator route
 * for the one-time halt seed. Red-first tests: the auth gate, the
 * idempotency contract, and the seeded path through the real
 * `seedGovernanceHalt` over the in-memory adapter.
 */
import { describe, it, expect } from "vitest";
import { handleSeedGovernanceRoute } from "../src/data/seedGovernanceRoute";
import { seedGovernanceHalt } from "../src/data/governedHalt";
import type { DoSql } from "../src/data/governedHalt";
import { InMemoryGovernanceAdapter } from "../src/data/inMemoryGovernanceAdapter";

const adminSession = { githubLogin: "operator", internalUserId: "user-1" };

describe("governance seed route (#1559)", () => {
  it("refuses unauthenticated callers with 401", async () => {
    const res = await handleSeedGovernanceRoute({
      session: null,
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runSeed: async () => ({ seeded: true, state: "clear" }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses non-POST methods with 405", async () => {
    const res = await handleSeedGovernanceRoute({
      session: adminSession,
      method: "GET",
      isPlatformAdmin: true,
      tenantId: "primary",
      runSeed: async () => ({ seeded: true, state: "clear" }),
    });
    expect(res.status).toBe(405);
  });

  it("refuses unwired sessions with 403", async () => {
    const res = await handleSeedGovernanceRoute({
      session: { githubLogin: "operator" },
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runSeed: async () => ({ seeded: true, state: "clear" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses wired non-admins with 403 and never runs the seed", async () => {
    let calls = 0;
    const res = await handleSeedGovernanceRoute({
      session: adminSession,
      method: "POST",
      isPlatformAdmin: false,
      tenantId: "primary",
      runSeed: async () => {
        calls += 1;
        return { seeded: true, state: "clear" };
      },
    });
    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });

  it("seeds once, then reports seeded:false with the same state, DO untouched", async () => {
    const store = new InMemoryGovernanceAdapter();
    const writes: unknown[][] = [];
    const doSql: DoSql = {
      exec(query: string, ...args: unknown[]) {
        if (query.startsWith("INSERT") || query.startsWith("DELETE")) {
          writes.push([query, ...args]);
        }
        if (args[0] === "adaptation.killSwitch") return [{ value: "on" }];
        return [];
      },
    };
    const runSeed = () =>
      seedGovernanceHalt({
        doSql,
        writer: store,
        tenantId: "primary",
        setBy: "operator",
        nowMs: Date.now(),
      });
    const first = await handleSeedGovernanceRoute({
      session: adminSession,
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runSeed,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ seeded: true, state: "halted" });
    const second = await handleSeedGovernanceRoute({
      session: adminSession,
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runSeed,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ seeded: false, state: "halted" });
    expect(writes).toHaveLength(0);
  });

  it("answers 500 with a generic error when the seed throws", async () => {
    const res = await handleSeedGovernanceRoute({
      session: adminSession,
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runSeed: async () => {
        throw new Error("mirror unavailable");
      },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("mirror unavailable");
  });
});
