/**
 * Issue #338 S2b: the screener persist producer flips to the R2 write
 * path. persistScreenerReportCanonical becomes async and stores through
 * storeReportAtGenerationWithR2: with REPORTS_BUCKET bound the screen
 * body lands in R2 and the mas_reports row keeps only the pointer; the
 * REST route contexts declare Promise<void> and await the store.
 */
import { describe, it, expect, vi } from "vitest";
import type { SqlStorage } from "../src/orm";
import {
  getCanonicalReport,
  listScheduledReports,
  reportBodyR2Key,
} from "../src/services/scheduledReports";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";

/** Purpose-built fake SQL (same idiom as the S1/S2 suites). */
function createFakeSql() {
  const baseColumns = [
    "id", "run_id", "title", "source", "summary", "body", "created_at", "generation_id",
  ];
  const columns: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const exec = (query: string, ...args: unknown[]): Iterable<unknown> => {
    const q = query.trim();
    const upper = q.toUpperCase();
    if (upper.startsWith("CREATE TABLE")) {
      if (columns.length === 0) columns.push(...baseColumns);
      return [];
    }
    if (upper.startsWith("CREATE")) return [];
    if (upper.startsWith("PRAGMA")) return columns.map((name) => ({ name }));
    if (upper.startsWith("ALTER TABLE")) {
      const m = q.match(/ADD COLUMN\s+(\w+)/i);
      if (m && !columns.includes(m[1])) columns.push(m[1]);
      return [];
    }
    if (upper.startsWith("UPDATE")) {
      for (const r of rows) if (r.user_login == null) r.user_login = args[0];
      return [];
    }
    if (upper.startsWith("INSERT")) {
      const cols = q.match(/\(([^)]+)\)\s*VALUES/i)![1].split(",").map((c) => c.trim());
      const rec: Record<string, unknown> = {};
      cols.forEach((c, i) => { rec[c] = args[i]; });
      rows.push(rec);
      return [];
    }
    if (upper.startsWith("SELECT")) {
      let out = [...rows];
      if (/generation_id\s*=\s*\?/.test(q)) {
        out = out.filter((r) => r.generation_id === args[0]);
        return out.map((r) => ({ id: r.id }));
      }
      if (/WHERE id\s*=\s*\?/.test(q)) out = out.filter((r) => r.id === args[0]);
      if (/user_login\s*=\s*\?/.test(q)) out = out.filter((r) => r.user_login === args[0]);
      out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const limit = Number(args[args.length - 1]);
      if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
      return out;
    }
    return [];
  };
  return { exec: exec as SqlStorage["exec"], rows };
}

function createFakeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    put: vi.fn(async (key: string, value: unknown) => { objects.set(key, String(value)); }),
    get: vi.fn(async (key: string) => {
      const v = objects.get(key);
      return v === undefined ? null : { text: async () => v };
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

const screenResult = {
  timestamp: "2026-10-23T14:00:00.000Z",
  universe: "ALL",
  provider: "yahoo",
  success: true,
  totalScanned: 500,
  matchedCount: 12,
  opportunities: [{ symbol: "ACME" }],
  allStocks: [{ symbol: "ACME" }],
  trigger: "manual",
  userLogin: "venus",
};

function makeCtx(sql: SqlStorage, env: Record<string, unknown>) {
  return {
    env,
    ensureTables: () => sql,
    getOrm: () => { throw new Error("screener persist must not use the ORM after the flip"); },
    reportDispatchHitlKey: "report_dispatch_hitl",
    reportConfirmationTtlMs: 86_400_000,
    sendReportEmail: vi.fn(async () => true),
    sendReportWebhook: vi.fn(async () => ({ success: true })),
  } as unknown as ReportDispatchContext;
}

describe("#338 S2b screener persist flip", () => {
  it("stores the screen body in R2 with a pointer row, provenance intact", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const ctx = makeCtx(sql, { REPORTS_BUCKET: bucket });
    await persistScreenerReportCanonical(ctx, screenResult);
    const hits = listScheduledReports(sql, { userLogin: "venus" });
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit.source).toBe("screener");
    expect(hit.runId).toBe("screener:2026-10-23T14:00:00.000Z");
    expect(hit.bodyR2Key).toBe(reportBodyR2Key(hit.id));
    expect(hit.body).toBe("");
    const body = JSON.parse(objects.get(hit.bodyR2Key!)!);
    expect(body.provider).toBe("yahoo");
    expect(body.trigger).toBe("manual");
    expect(body.opportunities).toEqual([{ symbol: "ACME" }]);
    // The canonical read + resolve path returns the same body.
    const stored = getCanonicalReport(sql, hit.id);
    expect(stored?.bodyR2Key).toBe(hit.bodyR2Key);
  });

  it("dedupes on the screener generation id (no second row, no second put)", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket } = createFakeBucket();
    const ctx = makeCtx(sql, { REPORTS_BUCKET: bucket });
    await persistScreenerReportCanonical(ctx, screenResult);
    await persistScreenerReportCanonical(ctx, screenResult);
    expect(fake.rows).toHaveLength(1);
    expect((bucket as any).put).toHaveBeenCalledTimes(1);
  });

  it("without a bucket, stores inline exactly as before", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const ctx = makeCtx(sql, {});
    await persistScreenerReportCanonical(ctx, screenResult);
    const hits = listScheduledReports(sql, { userLogin: "venus" });
    expect(hits).toHaveLength(1);
    expect(hits[0].bodyR2Key).toBeNull();
    const body = JSON.parse(hits[0].body);
    expect(body.provider).toBe("yahoo");
    expect(body.trigger).toBe("manual");
  });
});
