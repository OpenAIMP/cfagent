import { describe, it, expect, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import type { ResourceUsagePort } from "../src/telemetry/resourceUsagePorts";

// Issue #2280 (slice 5): execQuery reports platform cursor totals to an
// optional sink. node:sqlite cannot produce rowsRead/rowsWritten, so the
// stub cursor carries them — these tests prove the plumbing (capture,
// consume-then-read, fingerprint, never-throw), not platform values.

function stubCursor(rows: unknown[], rowsRead: number, rowsWritten: number) {
  const cursor: any = [...rows];
  cursor.rowsRead = rowsRead;
  cursor.rowsWritten = rowsWritten;
  return cursor;
}

function makeOrm(opts: {
  rows?: unknown[];
  rowsRead?: number;
  rowsWritten?: number;
  sink?: ResourceUsagePort;
}) {
  const sql = {
    exec: () => stubCursor(opts.rows ?? [{ id: 1 }], opts.rowsRead ?? 42, opts.rowsWritten ?? 0),
  };
  const orm = new DatabaseORM(sql as any, opts.sink ? { resourceSink: opts.sink } : undefined);
  return orm;
}

describe("DatabaseORM.execQuery measurement (#2280 slice 5)", () => {
  it("reports cursor totals with the fingerprinted template to the sink", () => {
    const record = vi.fn();
    const orm = makeOrm({ sink: { record } });
    const rows = orm.execQuery("SELECT  *\n  FROM  mas_messages\n WHERE  id = ?", "m1");
    expect(rows).toEqual([{ id: 1 }]);
    expect(record).toHaveBeenCalledTimes(1);
    const event = record.mock.calls[0][0];
    expect(event.ns).toBe("orm");
    expect(event.op).toBe("query");
    expect(event.rowsRead).toBe(42);
    expect(event.rowsWritten).toBe(0);
    // Template only, whitespace collapsed — never bound values.
    expect(event.statement).toBe("SELECT * FROM mas_messages WHERE id = ?");
    expect(typeof event.timestampMs).toBe("number");
    expect(typeof event.durationMs).toBe("number");
  });

  it("without a sink behaves exactly as before", () => {
    const orm = makeOrm({});
    expect(orm.execQuery("SELECT * FROM t")).toEqual([{ id: 1 }]);
  });

  it("a throwing sink never fails the read", () => {
    const orm = makeOrm({
      sink: {
        record: () => {
          throw new Error("sink down");
        },
      },
    });
    expect(orm.execQuery("SELECT * FROM t")).toEqual([{ id: 1 }]);
  });

  it("a rejecting async sink never surfaces a rejection", async () => {
    const orm = makeOrm({
      sink: {
        record: async () => {
          throw new Error("sink down");
        },
      },
    });
    expect(orm.execQuery("SELECT * FROM t")).toEqual([{ id: 1 }]);
    // Let any unhandled rejection surface if the implementation forgot catch.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("missing cursor totals default to zero, not undefined", () => {
    const sql = { exec: () => [{ id: 9 }] };
    const record = vi.fn();
    const orm = new DatabaseORM(sql as any, { resourceSink: { record } });
    orm.execQuery("SELECT * FROM t");
    const event = record.mock.calls[0][0];
    expect(event.rowsRead).toBe(0);
    expect(event.rowsWritten).toBe(0);
  });
});
