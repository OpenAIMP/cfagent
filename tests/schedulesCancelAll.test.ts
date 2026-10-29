import { describe, it, expect, vi } from "vitest";
import {
  handleSchedulesRoutes,
  type SchedulesRouteContext,
} from "../src/agents/routes/schedules";

const PATH = "/api/schedules/cancel-all";

function pausedRow(id: string) {
  return {
    id,
    callback: "autonomousOptionsAnalysis",
    payload_json: null,
    sched_type: "cron",
    cron: "30 12 * * 1-5",
    interval_seconds: null,
    time: null,
    delay_seconds: null,
    paused_at: "2026-10-29T00:00:00.000Z",
  };
}

function makeCtx(opts: {
  schedules?: Array<{ id: string; callback: string }>;
  cancel?: (id: string) => Promise<boolean>;
  pausedIds?: string[];
}) {
  const cancelled: string[] = [];
  const cancelFn =
    opts.cancel ??
    (async (id: string) => {
      cancelled.push(id);
      return true;
    });
  const sql = {
    exec: (query: string) => {
      if (query.includes("SELECT")) return (opts.pausedIds ?? []).map(pausedRow);
      return [];
    },
  };
  const ctx = {
    agentCtx: { storage: { sql } },
    audit: vi.fn(),
    listSchedules: vi.fn(async () => opts.schedules ?? []),
    cancelSchedule: vi.fn(cancelFn),
    getScheduleById: vi.fn(async () => undefined),
  } as unknown as SchedulesRouteContext;
  return { ctx, cancelled };
}

async function postCancelAll(ctx: unknown, body: Record<string, unknown>) {
  const req = new Request(`https://agent.test${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleSchedulesRoutes(
    req,
    new URL(`https://agent.test${PATH}`),
    PATH,
    "session-1",
    ctx as SchedulesRouteContext,
  );
  return { status: res!.status, body: (await res!.json()) as any };
}

const QUEUE = [
  { id: "v95599sHp", callback: "autonomousStockScreen" },
  { id: "_D6hWyU_S", callback: "executeAsyncJob" },
];

describe("POST /api/schedules/cancel-all (#2280)", () => {
  it("without confirm returns the preview and cancels nothing", async () => {
    const { ctx } = makeCtx({ schedules: QUEUE });
    const { status, body } = await postCancelAll(ctx, {});
    expect(status).toBe(200);
    expect(body.cancelled).toBe(0);
    expect(body.confirmRequired).toBe(true);
    expect(body.wouldCancelCount).toBe(2);
    expect(body.wouldCancel).toEqual(QUEUE);
    expect(ctx.cancelSchedule).not.toHaveBeenCalled();
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("with confirm cancels every listed id and audits once", async () => {
    const { ctx, cancelled } = makeCtx({ schedules: QUEUE, pausedIds: ["paused-1"] });
    const { status, body } = await postCancelAll(ctx, { confirm: true });
    expect(status).toBe(200);
    expect(body.cancelled).toBe(2);
    expect(body.cancelledIds).toEqual(["v95599sHp", "_D6hWyU_S"]);
    expect(body.failed).toEqual([]);
    expect(body.pausedPreserved).toBe(1);
    expect(cancelled).toEqual(["v95599sHp", "_D6hWyU_S"]);
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    const audit = (ctx.audit as any).mock.calls[0];
    expect(audit[0]).toBe("schedules.cancelled.all");
    expect(audit[2].cancelledCount).toBe(2);
    expect(audit[2].pausedPreserved).toBe(1);
  });

  it("a failed cancel is reported, the rest still cancel", async () => {
    const { ctx } = makeCtx({
      schedules: QUEUE,
      cancel: async (id) => {
        if (id === "v95599sHp") throw new Error("boom");
        return true;
      },
    });
    const { status, body } = await postCancelAll(ctx, { confirm: true });
    expect(status).toBe(200);
    expect(body.cancelled).toBe(1);
    expect(body.cancelledIds).toEqual(["_D6hWyU_S"]);
    expect(body.failed).toEqual([{ id: "v95599sHp", error: "boom" }]);
  });

  it("an empty queue with confirm audits a zero-count run", async () => {
    const { ctx } = makeCtx({ schedules: [] });
    const { status, body } = await postCancelAll(ctx, { confirm: true });
    expect(status).toBe(200);
    expect(body.cancelled).toBe(0);
    expect(body.cancelledIds).toEqual([]);
    expect(ctx.audit).toHaveBeenCalledTimes(1);
  });
});
