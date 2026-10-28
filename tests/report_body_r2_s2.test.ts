/**
 * Issue #338 S2: the write/read flip. New canonical reports written
 * through storeReportAtGenerationWithR2 put their body in R2
 * (reports/<reportId>.json via REPORTS_BUCKET) and keep only the
 * body_r2_key pointer in mas_reports; the research dispatch path
 * (store + stored-copy delivery) resolves the pointer on read.
 * Inline rows (NULL pointer) are a permanent read shape: every
 * pre-migration row and every no-bucket/failure fallback stays inline.
 */
import { describe, it, expect, vi } from "vitest";
import type { SqlStorage } from "../src/orm";
import {
  ensureScheduledReportsTable,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  getCanonicalReport,
  resolveCanonicalReportBody,
  canonicalResearchEmailBody,
  reportBodyR2Key,
} from "../src/services/scheduledReports";
import {
  storeResearchReportCanonicalAsync,
  deliverStoredReportEmail,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";

/** Purpose-built fake SQL (same idiom as the S1 suite). */
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
      out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const limit = Number(args[args.length - 1]);
      if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
      return out;
    }
    return [];
  };
  return { exec: exec as SqlStorage["exec"], rows, columns };
}

/** Minimal in-memory R2 bucket fake. */
function createFakeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    put: vi.fn(async (key: string, value: unknown) => {
      objects.set(key, String(value));
    }),
    get: vi.fn(async (key: string) => {
      const v = objects.get(key);
      return v === undefined ? null : { text: async () => v };
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

const input = {
  runId: "run-338-s2",
  generationId: "gen-338-s2",
  title: "R2 flip probe",
  source: "research_report",
  summary: "Probe summary",
  body: { title: "Probe", fileName: "probe.xlsx", attachmentBase64: "QUJD" },
  userLogin: "tenant@example.com",
};
const bodyJson = JSON.stringify(input.body);

describe("#338 S2 R2 write/read flip", () => {
  it("with a bucket bound, the body lands in R2 and the row keeps only the pointer", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const stored = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: bucket }, input);
    expect(stored?.created).toBe(true);
    const key = reportBodyR2Key(stored!.reportId);
    expect(objects.get(key)).toBe(bodyJson);
    const row = fake.rows.find((r) => r.id === stored!.reportId)!;
    expect(row.body_r2_key).toBe(key);
    expect(row.body).toBe("");
    const hit = getCanonicalReport(sql, stored!.reportId);
    expect(hit?.bodyR2Key).toBe(key);
    expect(await resolveCanonicalReportBody({ REPORTS_BUCKET: bucket }, hit!)).toBe(bodyJson);
  });

  it("dedupe on generation id returns the existing row and does not rewrite the R2 object", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const first = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: bucket }, input);
    const second = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: bucket }, {
      ...input,
      body: { title: "Changed", fileName: "changed.xlsx", attachmentBase64: "REVG" },
    });
    expect(second).toEqual({ reportId: first!.reportId, created: false });
    expect((bucket as any).put).toHaveBeenCalledTimes(1);
    expect(objects.get(reportBodyR2Key(first!.reportId))).toBe(bodyJson);
    expect(fake.rows).toHaveLength(1);
  });

  it("without a bucket, the write is the legacy inline write", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const stored = await storeReportAtGenerationWithR2(sql, {}, input);
    expect(stored?.created).toBe(true);
    const hit = getCanonicalReport(sql, stored!.reportId);
    expect(hit?.bodyR2Key).toBeNull();
    expect(hit?.body).toBe(bodyJson);
    expect(await resolveCanonicalReportBody({}, hit!)).toBe(bodyJson);
  });

  it("an R2 put failure falls back to the inline write (a report is never lost to the flip)", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const failing = {
      put: vi.fn(async () => { throw new Error("R2 unavailable"); }),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    } as unknown as R2Bucket;
    const stored = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: failing }, input);
    expect(stored?.created).toBe(true);
    const hit = getCanonicalReport(sql, stored!.reportId);
    expect(hit?.bodyR2Key).toBeNull();
    expect(hit?.body).toBe(bodyJson);
  });

  it("resolve fails closed to null when the pointer's object is gone or no bucket is bound", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const stored = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: bucket }, input);
    const hit = getCanonicalReport(sql, stored!.reportId)!;
    objects.clear();
    expect(await resolveCanonicalReportBody({ REPORTS_BUCKET: bucket }, hit)).toBeNull();
    expect(await resolveCanonicalReportBody({}, hit)).toBeNull();
  });

  it("the sync seam is unchanged by the refactor (still inline, still idempotent)", () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    ensureScheduledReportsTable(sql);
    const a = storeReportAtGeneration(sql, input);
    const b = storeReportAtGeneration(sql, input);
    expect(a?.created).toBe(true);
    expect(b).toEqual({ reportId: a!.reportId, created: false });
    const hit = getCanonicalReport(sql, a!.reportId);
    expect(hit?.body).toBe(bodyJson);
    expect(hit?.bodyR2Key).toBeNull();
  });
});

describe("#338 S2 research dispatch path", () => {
  function makeCtx(sql: SqlStorage, bucket: R2Bucket) {
    const sendReportEmail = vi.fn(async () => true);
    const ctx = {
      env: { REPORTS_BUCKET: bucket },
      ensureTables: () => sql,
      getOrm: () => { throw new Error("store path must not use the ORM after the flip"); },
      reportDispatchHitlKey: "report_dispatch_hitl",
      reportConfirmationTtlMs: 86_400_000,
      sendReportEmail,
      sendReportWebhook: vi.fn(async () => ({ success: true })),
    } as unknown as ReportDispatchContext;
    return { ctx, sendReportEmail };
  }

  it("stores the canonical research report in R2 and delivers the stored copy from R2", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const { ctx, sendReportEmail } = makeCtx(sql, bucket);
    const bodyJson = canonicalResearchEmailBody({
      title: "Weekly scan",
      fileName: "weekly.xlsx",
      attachmentBase64: "QUJD",
    });
    const stored = await storeResearchReportCanonicalAsync(ctx, bodyJson, {
      title: "Weekly scan",
      summary: "s",
      userLogin: "venus",
    });
    expect(stored).not.toBeNull();
    expect(objects.get(reportBodyR2Key(stored!.reportId))).toBe(bodyJson);
    const outcome = await deliverStoredReportEmail(ctx, stored!.reportId, "a@b.com", "venus");
    expect(outcome).toBe("sent");
    expect(sendReportEmail).toHaveBeenCalledWith("a@b.com", "Weekly scan", "weekly.xlsx", "QUJD", "venus");
  });

  it("delivery reports 'missing' when the R2 object behind the pointer is gone", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const { ctx } = makeCtx(sql, bucket);
    const bodyJson = canonicalResearchEmailBody({
      title: "Weekly scan",
      fileName: "weekly.xlsx",
      attachmentBase64: "QUJD",
    });
    const stored = await storeResearchReportCanonicalAsync(ctx, bodyJson, {
      title: "Weekly scan",
      summary: "s",
      userLogin: "venus",
    });
    objects.clear();
    const outcome = await deliverStoredReportEmail(ctx, stored!.reportId, "a@b.com", "venus");
    expect(outcome).toBe("missing");
  });
});
