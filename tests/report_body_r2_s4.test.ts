/**
 * Issue #338 S4: lazy backfill on read — the design's migration path
 * ("NULL → serve inline, optionally backfill on first read"). When a
 * body-resolving read path serves an inline row while REPORTS_BUCKET is
 * bound, the body is copied to R2 and the row is rewritten to the
 * pointer shape (body "", body_r2_key set). The read itself never
 * fails because of the migration: any backfill error leaves the row
 * untouched and the inline body is served.
 */
import { describe, it, expect, vi } from "vitest";
import type { SqlStorage } from "../src/orm";
import {
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  getCanonicalReport,
  resolveCanonicalReportBodyWithBackfill,
  canonicalResearchEmailBody,
  reportBodyR2Key,
} from "../src/services/scheduledReports";
import {
  storeResearchReportCanonicalAsync,
  deliverStoredReportEmail,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";

/** Purpose-built fake SQL (S1–S3 idiom) + the backfill UPDATE shape. */
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
      if (/SET body_r2_key/.test(q)) {
        // UPDATE mas_reports SET body_r2_key = ?, body = '' WHERE id = ? AND body_r2_key IS NULL
        const row = rows.find((r) => r.id === args[1]);
        if (row && row.body_r2_key == null) {
          row.body_r2_key = args[0];
          row.body = "";
        }
        return [];
      }
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

const input = {
  runId: "run-338-s4",
  generationId: "gen-338-s4",
  title: "Backfill probe",
  source: "research_report",
  summary: "Probe summary",
  body: { title: "Probe", fileName: "probe.xlsx", attachmentBase64: "QUJD" },
  userLogin: "tenant@example.com",
};
const bodyJson = JSON.stringify(input.body);

describe("#338 S4 lazy backfill on read", () => {
  it("serving an inline row with a bucket bound migrates it to the pointer shape", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const stored = storeReportAtGeneration(sql, input);
    const hit = getCanonicalReport(sql, stored!.reportId)!;
    expect(hit.bodyR2Key).toBeNull();
    const body = await resolveCanonicalReportBodyWithBackfill(sql, { REPORTS_BUCKET: bucket }, hit);
    expect(body).toBe(bodyJson);
    const key = reportBodyR2Key(stored!.reportId);
    expect(objects.get(key)).toBe(bodyJson);
    const after = getCanonicalReport(sql, stored!.reportId)!;
    expect(after.bodyR2Key).toBe(key);
    expect(after.body).toBe("");
    // The next read resolves through the pointer.
    const again = await resolveCanonicalReportBodyWithBackfill(sql, { REPORTS_BUCKET: bucket }, after);
    expect(again).toBe(bodyJson);
    expect((bucket as any).put).toHaveBeenCalledTimes(1);
  });

  it("without a bucket, the inline body is served and the row is untouched", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const stored = storeReportAtGeneration(sql, input);
    const hit = getCanonicalReport(sql, stored!.reportId)!;
    const body = await resolveCanonicalReportBodyWithBackfill(sql, {}, hit);
    expect(body).toBe(bodyJson);
    const after = getCanonicalReport(sql, stored!.reportId)!;
    expect(after.bodyR2Key).toBeNull();
    expect(after.body).toBe(bodyJson);
  });

  it("a backfill put failure serves the inline body and leaves the row inline", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const failing = {
      put: vi.fn(async () => { throw new Error("R2 unavailable"); }),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    } as unknown as R2Bucket;
    const stored = storeReportAtGeneration(sql, input);
    const hit = getCanonicalReport(sql, stored!.reportId)!;
    const body = await resolveCanonicalReportBodyWithBackfill(sql, { REPORTS_BUCKET: failing }, hit);
    expect(body).toBe(bodyJson);
    const after = getCanonicalReport(sql, stored!.reportId)!;
    expect(after.bodyR2Key).toBeNull();
    expect(after.body).toBe(bodyJson);
  });

  it("a pointer row resolves through R2 and is never re-put", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket } = createFakeBucket();
    const stored = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: bucket }, input);
    const hit = getCanonicalReport(sql, stored!.reportId)!;
    expect(hit.bodyR2Key).not.toBeNull();
    const body = await resolveCanonicalReportBodyWithBackfill(sql, { REPORTS_BUCKET: bucket }, hit);
    expect(body).toBe(bodyJson);
    expect((bucket as any).put).toHaveBeenCalledTimes(1); // the original write only
  });

  it("delivering a stored inline report backfills its row (dispatch path)", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const sendReportEmail = vi.fn(async () => true);
    const ctx = {
      env: { REPORTS_BUCKET: bucket },
      ensureTables: () => sql,
      getOrm: () => { throw new Error("unused"); },
      reportDispatchHitlKey: "report_dispatch_hitl",
      reportConfirmationTtlMs: 86_400_000,
      sendReportEmail,
      sendReportWebhook: vi.fn(async () => ({ success: true })),
    } as unknown as ReportDispatchContext;
    // Store WITHOUT a bucket (legacy inline row), then bind the bucket
    // for the delivery read: the store happens inline, delivery migrates.
    const noBucketCtx = { ...ctx, env: {} } as unknown as ReportDispatchContext;
    const bodyJson2 = canonicalResearchEmailBody({
      title: "Weekly scan",
      fileName: "weekly.xlsx",
      attachmentBase64: "QUJD",
    });
    const stored = await storeResearchReportCanonicalAsync(noBucketCtx, bodyJson2, {
      title: "Weekly scan",
      summary: "s",
      userLogin: "venus",
    });
    expect(getCanonicalReport(sql, stored!.reportId)?.bodyR2Key).toBeNull();
    const outcome = await deliverStoredReportEmail(ctx, stored!.reportId, "a@b.com", "venus");
    expect(outcome).toBe("sent");
    const after = getCanonicalReport(sql, stored!.reportId)!;
    expect(after.bodyR2Key).toBe(reportBodyR2Key(stored!.reportId));
    expect(objects.get(after.bodyR2Key!)).toBe(bodyJson2);
  });
});
