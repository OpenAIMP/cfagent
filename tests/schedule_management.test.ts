/**
 * Issue #273 — schedule management core: the paused-schedule store and
 * the pure update-resolution rules behind PUT /api/schedules/:id.
 *
 * Pause semantics: the Agents SDK has no native pause, so a paused job's
 * full definition is persisted in the OrchestratorAgent's own SQLite
 * (paused_schedules) and the SDK schedule is cancelled; resume re-arms
 * from the stored definition. These tests pin the record conversions,
 * the store round-trip, and the frequency/payload update rules.
 */
import { describe, it, expect } from "vitest";
import {
  SqlPausedScheduleStore,
  scheduleToPausedRecord,
  pausedRecordToListItem,
  resolveScheduleUpdate,
  type PausedScheduleRecord,
} from "../src/services/scheduleManagement";
import { MockSqlStorage } from "./mock-sql";

const cronSchedule: any = {
  id: "sched-cron-1",
  callback: "autonomousMarketScreen",
  payload: { universe: "SP500", userLogin: "venus" },
  type: "cron",
  cron: "5 * * * *",
  time: 1760000000,
};

describe("scheduleToPausedRecord / pausedRecordToListItem (#273)", () => {
  it("captures the full definition of a cron schedule", () => {
    const rec = scheduleToPausedRecord(cronSchedule, "2026-10-20T16:00:00.000Z");
    expect(rec.id).toBe("sched-cron-1");
    expect(rec.callback).toBe("autonomousMarketScreen");
    expect(rec.payload).toEqual({ universe: "SP500", userLogin: "venus" });
    expect(rec.type).toBe("cron");
    expect(rec.cron).toBe("5 * * * *");
    expect(rec.time).toBe(1760000000);
    expect(rec.pausedAt).toBe("2026-10-20T16:00:00.000Z");
  });

  it("captures interval schedules with their intervalSeconds", () => {
    const rec = scheduleToPausedRecord(
      { id: "s2", callback: "autonomousOptionsAnalysis", payload: {}, type: "interval", intervalSeconds: 900, time: 1760000100 } as any,
      "2026-10-20T16:00:00.000Z"
    );
    expect(rec.type).toBe("interval");
    expect(rec.intervalSeconds).toBe(900);
    expect(rec.cron).toBeUndefined();
  });

  it("renders a paused record as a list item flagged paused, with no next run", () => {
    const rec = scheduleToPausedRecord(cronSchedule, "2026-10-20T16:00:00.000Z");
    const item = pausedRecordToListItem(rec);
    expect(item.id).toBe("sched-cron-1");
    expect(item.paused).toBe(true);
    expect(item.cron).toBe("5 * * * *");
    expect(item.payload).toEqual({ universe: "SP500", userLogin: "venus" });
    expect((item as any).time).toBeUndefined();
    expect((item as any).nextRun).toBeUndefined();
  });
});

describe("SqlPausedScheduleStore (#273)", () => {
  it("round-trips save → get → list → remove", () => {
    const store = new SqlPausedScheduleStore(new MockSqlStorage() as any);
    const rec: PausedScheduleRecord = {
      id: "p1",
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100" },
      type: "interval",
      intervalSeconds: 1800,
      time: 1760000200,
      pausedAt: "2026-10-20T16:00:00.000Z",
    };
    store.save(rec);
    expect(store.get("p1")).toEqual(rec);
    expect(store.list()).toEqual([rec]);
    expect(store.remove("p1")).toBe(true);
    expect(store.get("p1")).toBeUndefined();
    expect(store.remove("p1")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("save is an upsert keyed by id (re-pause / update-in-place)", () => {
    const store = new SqlPausedScheduleStore(new MockSqlStorage() as any);
    const base: PausedScheduleRecord = {
      id: "p2", callback: "cb", payload: {}, type: "cron", cron: "0 * * * *", pausedAt: "t0",
    };
    store.save(base);
    store.save({ ...base, cron: "30 9 * * *" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("p2")?.cron).toBe("30 9 * * *");
  });
});

describe("resolveScheduleUpdate (#273)", () => {
  const nowMs = Date.parse("2026-10-20T16:00:00.000Z");
  const intervalCurrent: any = {
    type: "interval", callback: "autonomousOptionsAnalysis",
    payload: { symbols: ["AAPL"] }, intervalSeconds: 3600, time: 1760003600,
  };

  it("switches an interval job to a cron timing and keeps the payload", () => {
    const r = resolveScheduleUpdate(intervalCurrent, { cron: "0 9 * * *" }, nowMs);
    expect(r).toEqual({
      ok: true,
      timing: { type: "cron", cron: "0 9 * * *" },
      payload: { symbols: ["AAPL"] },
    });
  });

  it("changes intervalSeconds and replaces the payload when one is given", () => {
    const r = resolveScheduleUpdate(
      intervalCurrent,
      { intervalSeconds: 900, payload: { symbols: ["MSFT"] } },
      nowMs
    );
    expect(r).toEqual({
      ok: true,
      timing: { type: "interval", intervalSeconds: 900 },
      payload: { symbols: ["MSFT"], trigger: "scheduled" },
    });
  });

  it("keeps the current timing for a payload-only update of a recurring job", () => {
    const r = resolveScheduleUpdate(intervalCurrent, { payload: { symbols: [] } }, nowMs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timing).toEqual({ type: "interval", intervalSeconds: 3600 });
  });

  it("rejects a malformed cron expression", () => {
    const r = resolveScheduleUpdate(intervalCurrent, { cron: "not a cron" }, nowMs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cron/i);
  });

  it("rejects a non-positive interval", () => {
    const r = resolveScheduleUpdate(intervalCurrent, { intervalSeconds: 0 }, nowMs);
    expect(r.ok).toBe(false);
  });

  it("rejects re-arming a one-time schedule whose time has passed", () => {
    const past: any = { type: "scheduled", callback: "cb", payload: {}, time: Math.floor(nowMs / 1000) - 3600 };
    const r = resolveScheduleUpdate(past, { payload: { a: 1 } }, nowMs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already|past|fired/i);
  });

  it("allows a payload-only update of a future one-time schedule", () => {
    const futureTime = Math.floor(nowMs / 1000) + 3600;
    const future: any = { type: "scheduled", callback: "cb", payload: {}, time: futureTime };
    const r = resolveScheduleUpdate(future, { payload: { a: 1 } }, nowMs);
    expect(r).toEqual({ ok: true, timing: { type: "scheduled", time: futureTime }, payload: { a: 1 } });
  });
});
