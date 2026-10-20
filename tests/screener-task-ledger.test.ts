/**
 * Issue #607 (phase-2 P2-3.1) — durable task records for screener runs.
 *
 * Mirrors the research ledger contract (#577) for the screener's
 * async Durable Object storage world. Unit tests run the real ScreenerTaskLedger
 * over an in-memory async store; the wiring tests pin the agent
 * integration by source evidence (the repo idiom for DO code, which
 * vitest cannot instantiate): task creation precedes screening inside
 * runScreen, and completion/escalation/cancellation follow it, so
 * every caller (broker routes, orchestrator, scheduledTasks, and
 * runSharded via runScreen) is covered.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ScreenerTaskLedger,
  evaluateScreenerOutcome,
  type ScreenerTaskStore,
} from "../src/services/screenerTaskLedger";

function memStore(): ScreenerTaskStore {
  const raw = new Map<string, string>();
  return {
    get: async (k) => (raw.has(k) ? raw.get(k)! : null),
    set: async (k, v) => void raw.set(k, v),
    list: async (prefix) =>
      [...raw.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
  };
}

let tick = 0;
let ids = 0;
function ledger(store: ScreenerTaskStore): ScreenerTaskLedger {
  tick = 0;
  ids = 0;
  return new ScreenerTaskLedger(store, {
    now: () => `2026-10-20T12:00:${String(tick++).padStart(2, "0")}.000Z`,
    newId: () => `stask-${++ids}`,
  });
}

const SCHEDULED = {
  trigger: "scheduled" as const,
  universe: "TECH",
  sector: "ALL",
  userLogin: "alice",
  idempotencyKey: "screener:scheduled:TECH:ALL:2026-10-20T12:00",
};

const GOOD_EVAL = evaluateScreenerOutcome(
  {
    success: true,
    runTimestamp: "2026-10-20T12:00:30.000Z",
    totalScanned: 100,
    matchedCount: 10,
    opportunities: 5,
    partial: false,
    qualificationPresent: false,
    error: null,
  },
  "2026-10-20T12:01:00.000Z"
);

describe("ScreenerTaskLedger lifecycle", () => {
  it("creates a queued task and round-trips through the store", async () => {
    const store = memStore();
    const { task, created } = await ledger(store).create(SCHEDULED);
    expect(created).toBe(true);
    expect(task.status).toBe("queued");
    expect(task.universe).toBe("TECH");
    expect((await ledger(store).get(task.id))?.idempotencyKey).toBe(
      SCHEDULED.idempotencyKey
    );
  });

  it("dedups the record for a scheduled slot while a task is active", async () => {
    const l = ledger(memStore());
    const first = await l.create(SCHEDULED);
    const dupe = await l.create(SCHEDULED);
    expect(dupe.created).toBe(false);
    expect(dupe.task.id).toBe(first.task.id);
    await l.claim(first.task.id);
    await l.start(first.task.id);
    await l.complete(first.task.id, {
      runTimestamp: "2026-10-20T12:00:30.000Z",
      totalScanned: 100,
      matchedCount: 10,
      opportunitiesCount: 5,
      partial: false,
      evaluation: GOOD_EVAL,
    });
    const next = await l.create(SCHEDULED);
    expect(next.created).toBe(true);
    expect(next.task.id).not.toBe(first.task.id);
  });

  it("walks to completed, recording run identity, counts, and evaluation", async () => {
    const l = ledger(memStore());
    const { task } = await l.create(SCHEDULED);
    await l.claim(task.id);
    await l.start(task.id);
    const done = await l.complete(task.id, {
      runTimestamp: "2026-10-20T12:00:30.000Z",
      totalScanned: 100,
      matchedCount: 10,
      opportunitiesCount: 5,
      partial: false,
      evaluation: GOOD_EVAL,
    });
    expect(done.status).toBe("completed");
    expect(done.runTimestamp).toBe("2026-10-20T12:00:30.000Z");
    expect(done.totalScanned).toBe(100);
    expect(done.evaluation?.verdict).toBe("pass");
    expect(done.history.map((h) => h.status)).toEqual([
      "queued",
      "claimed",
      "running",
      "completed",
    ]);
  });

  it("fail → escalate retains the error; suppressed duplicates cancel", async () => {
    const l = ledger(memStore());
    const a = await l.create(SCHEDULED);
    await l.claim(a.task.id);
    await l.start(a.task.id);
    await l.fail(a.task.id, "E*TRADE unavailable");
    const esc = await l.escalate(a.task.id, "screen failed; awaiting human review");
    expect(esc.status).toBe("escalated");
    expect(esc.error).toContain("E*TRADE unavailable");

    const b = await l.create({
      ...SCHEDULED,
      idempotencyKey: "screener:scheduled:TECH:ALL:2026-10-20T12:05",
    });
    await l.claim(b.task.id);
    await l.start(b.task.id);
    const cancelled = await l.cancel(b.task.id, "duplicate scheduled delivery suppressed");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.history.at(-1)?.note).toContain("duplicate");
  });

  it("rejects invalid transitions and unknown ids", async () => {
    const l = ledger(memStore());
    const { task } = await l.create(SCHEDULED);
    await expect(l.start(task.id)).rejects.toThrow(/cannot move from queued to running/);
    await expect(l.claim("stask-999")).rejects.toThrow(/not found/);
    expect(await l.get("stask-999")).toBeNull();
  });
});

describe("evaluateScreenerOutcome (deterministic honesty checks)", () => {
  it("passes a clean, consistent run", () => {
    expect(GOOD_EVAL.verdict).toBe("pass");
    expect(GOOD_EVAL.checks.every((c) => c.ok)).toBe(true);
  });

  it("passes a partial run that carries its qualification (#462)", () => {
    const ev = evaluateScreenerOutcome(
      {
        success: true,
        runTimestamp: "2026-10-20T12:00:30.000Z",
        totalScanned: 40,
        matchedCount: 4,
        opportunities: 2,
        partial: true,
        qualificationPresent: true,
        error: null,
      },
      "2026-10-20T12:01:00.000Z"
    );
    expect(ev.verdict).toBe("pass");
  });

  it("fails a partial run missing its qualification", () => {
    const ev = evaluateScreenerOutcome(
      {
        success: true,
        runTimestamp: "2026-10-20T12:00:30.000Z",
        totalScanned: 40,
        matchedCount: 4,
        opportunities: 2,
        partial: true,
        qualificationPresent: false,
        error: null,
      },
      "2026-10-20T12:01:00.000Z"
    );
    expect(ev.verdict).toBe("fail");
    expect(ev.checks.find((c) => c.name === "partial_qualified")?.ok).toBe(false);
  });

  it("fails a zero-scan success (zero quotes must fail honestly, #462)", () => {
    const ev = evaluateScreenerOutcome(
      {
        success: true,
        runTimestamp: "2026-10-20T12:00:30.000Z",
        totalScanned: 0,
        matchedCount: 0,
        opportunities: 0,
        partial: false,
        qualificationPresent: false,
        error: null,
      },
      "2026-10-20T12:01:00.000Z"
    );
    expect(ev.verdict).toBe("fail");
    expect(ev.checks.find((c) => c.name === "success_honest")?.ok).toBe(false);
  });

  it("fails insane counts and a failure result without an error", () => {
    const insane = evaluateScreenerOutcome(
      {
        success: true,
        runTimestamp: "2026-10-20T12:00:30.000Z",
        totalScanned: 5,
        matchedCount: 10,
        opportunities: 11,
        partial: false,
        qualificationPresent: false,
        error: null,
      },
      "2026-10-20T12:01:00.000Z"
    );
    expect(insane.checks.find((c) => c.name === "counts_sane")?.ok).toBe(false);

    const silent = evaluateScreenerOutcome(
      {
        success: false,
        runTimestamp: "2026-10-20T12:00:30.000Z",
        totalScanned: 0,
        matchedCount: 0,
        opportunities: 0,
        partial: false,
        qualificationPresent: false,
        error: null,
      },
      "2026-10-20T12:01:00.000Z"
    );
    expect(silent.verdict).toBe("fail");
    expect(silent.checks.find((c) => c.name === "error_consistent")?.ok).toBe(false);

    // A properly recorded failure (with error) evaluates consistently.
    const honest = evaluateScreenerOutcome(
      {
        success: false,
        runTimestamp: "2026-10-20T12:00:30.000Z",
        totalScanned: 0,
        matchedCount: 0,
        opportunities: 0,
        partial: false,
        qualificationPresent: false,
        error: "E*TRADE unavailable",
      },
      "2026-10-20T12:01:00.000Z"
    );
    expect(honest.verdict).toBe("pass");
  });
});

describe("screener wiring (source evidence)", () => {
  const agent = fs.readFileSync(
    path.resolve(__dirname, "../src/agents/screener-agent.ts"),
    "utf8"
  );
  const section = agent.slice(
    agent.indexOf("async runScreen("),
    agent.indexOf("async getLatest()")
  );

  it("ScreenerAgent persists the ledger in its own storage", () => {
    expect(agent).toContain("ScreenerTaskLedger");
    expect(agent).toContain("screener:task:");
    for (const m of [
      "createScreenerTask",
      "beginScreenerTask",
      "completeScreenerTask",
      "failScreenerTask",
    ]) {
      expect(agent).toContain(m);
    }
  });

  it("runScreen creates + begins before screening and resolves the task on every exit path", () => {
    const createAt = section.indexOf("createScreenerTask");
    const acquireAt = section.indexOf("acquireUniverse");
    expect(createAt).toBeGreaterThan(-1);
    expect(section).toContain("beginScreenerTask");
    expect(createAt).toBeLessThan(acquireAt);
    // Success, failure, and duplicate-suppression paths all resolve it.
    expect(section).toContain("completeScreenerTask");
    expect(section).toContain("failScreenerTask");
    expect(section).toContain("cancelScreenerTask");
    expect(section).toContain("evaluateScreenerOutcome");
    // Shards flow through runScreen, so they are covered by construction.
    expect(agent).toContain("this.runScreen({ ...req, universe })");
  });
});

describe("stale detection and sweep (#615, R4)", () => {
  const T0 = Date.parse("2026-10-20T12:00:00.000Z");
  const MIN = 60_000;

  function clockLedger(store: ScreenerTaskStore) {
    let nowMs = T0;
    let n = 0;
    const l = new ScreenerTaskLedger(store, {
      now: () => new Date(nowMs).toISOString(),
      newId: () => `stask-${++n}`,
    });
    return { l, advance: (ms: number) => { nowMs += ms; } };
  }

  const GOOD = evaluateScreenerOutcome(
    {
      success: true,
      runTimestamp: "2026-10-20T12:01:00.000Z",
      totalScanned: 10,
      matchedCount: 3,
      opportunities: 1,
      partial: false,
      qualificationPresent: false,
    },
    "2026-10-20T12:01:00.000Z"
  );

  async function runningTask(l: ScreenerTaskLedger, key: string) {
    const { task } = await l.create({ ...SCHEDULED, idempotencyKey: key });
    await l.claim(task.id);
    await l.start(task.id);
    return task.id;
  }

  async function completeTask(l: ScreenerTaskLedger, id: string) {
    await l.complete(id, {
      runTimestamp: "2026-10-20T12:01:00.000Z",
      totalScanned: 10,
      matchedCount: 3,
      opportunitiesCount: 1,
      partial: false,
      evaluation: GOOD,
    });
  }

  it("does not flag a fresh active task", async () => {
    const { l } = clockLedger(memStore());
    await runningTask(l, "k-fresh");
    expect(await l.findStale(30 * MIN)).toEqual([]);
  });

  it("flags queued, claimed and running tasks whose heartbeat aged out", async () => {
    const { l, advance } = clockLedger(memStore());
    const q = (await l.create({ ...SCHEDULED, idempotencyKey: "k-q" })).task.id;
    const c = (await l.create({ ...SCHEDULED, idempotencyKey: "k-c" })).task.id;
    await l.claim(c);
    const r = await runningTask(l, "k-r");
    advance(31 * MIN);
    expect((await l.findStale(30 * MIN)).map((t) => t.id).sort()).toEqual([c, q, r].sort());
  });

  it("never flags terminal tasks, however old", async () => {
    const { l, advance } = clockLedger(memStore());
    const done = await runningTask(l, "k-done");
    await completeTask(l, done);
    const dead = await runningTask(l, "k-dead");
    await l.fail(dead, "boom");
    advance(24 * 60 * MIN);
    expect(await l.findStale(30 * MIN)).toEqual([]);
  });

  it("a heartbeat refresh clears staleness", async () => {
    const { l, advance } = clockLedger(memStore());
    const id = await runningTask(l, "k-hb");
    advance(20 * MIN);
    await l.heartbeat(id);
    advance(20 * MIN);
    expect(await l.findStale(30 * MIN)).toEqual([]);
  });

  it("respects a custom threshold and findStale is read-only", async () => {
    const { l, advance } = clockLedger(memStore());
    const id = await runningTask(l, "k-th");
    advance(10 * MIN);
    expect((await l.findStale(5 * MIN)).map((t) => t.id)).toEqual([id]);
    expect(await l.findStale(30 * MIN)).toEqual([]);
    expect((await l.get(id))?.status).toBe("running");
  });

  it("sweepStale escalates stale tasks with the stale reason recorded", async () => {
    const { l, advance } = clockLedger(memStore());
    const id = await runningTask(l, "k-sweep");
    advance(45 * MIN);
    const swept = await l.sweepStale(30 * MIN);
    expect(swept.map((t) => t.id)).toEqual([id]);
    const after = await l.get(id);
    expect(after?.status).toBe("escalated");
    expect(after?.error).toContain("stale");
    expect(after?.error).toContain("1800000");
    expect(after?.history.map((h) => h.status)).toEqual([
      "queued", "claimed", "running", "failed", "escalated",
    ]);
  });

  it("sweepStale leaves fresh and terminal tasks untouched and does not re-sweep", async () => {
    const { l, advance } = clockLedger(memStore());
    const staleId = await runningTask(l, "k-old");
    advance(31 * MIN);
    const freshId = await runningTask(l, "k-new");
    const doneId = await runningTask(l, "k-fin");
    await completeTask(l, doneId);
    const swept = await l.sweepStale(30 * MIN);
    expect(swept.map((t) => t.id)).toEqual([staleId]);
    expect((await l.get(freshId))?.status).toBe("running");
    expect((await l.get(doneId))?.status).toBe("completed");
    expect(await l.sweepStale(30 * MIN)).toEqual([]);
  });

  it("exposes the operations on ScreenerAgent (source evidence)", () => {
    const agent = fs.readFileSync(
      path.join(process.cwd(), "src/agents/screener-agent.ts"),
      "utf8"
    );
    expect(agent).toContain("findStaleScreenerTasks");
    expect(agent).toContain("sweepStaleScreenerTasks");
    expect(agent).toContain(".findStale(");
    expect(agent).toContain(".sweepStale(");
  });
});
