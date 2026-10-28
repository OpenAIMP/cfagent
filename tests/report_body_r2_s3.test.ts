/**
 * Issue #338 S3: the coupled delete. The accepted design requires that
 * when a mas_reports row is deleted, its R2 body object is deleted in
 * the same scope — otherwise every row deletion strands an object.
 * mas_reports has NO pruning today (retention decision #786: KEEP —
 * pruning is a product decision), so S3 lands the primitive any future
 * deletion must use, plus the retention-record note pointing at it.
 */
import { describe, it, expect, vi } from "vitest";
import type { SqlStorage } from "../src/orm";
import {
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  getCanonicalReport,
  deleteCanonicalReport,
  reportBodyR2Key,
} from "../src/services/scheduledReports";

/** Purpose-built fake SQL (same idiom as the S1/S2 suites) + DELETE. */
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
    if (upper.startsWith("DELETE")) {
      const i = rows.findIndex((r) => r.id === args[0]);
      if (i >= 0) rows.splice(i, 1);
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
  runId: "run-338-s3",
  generationId: "gen-338-s3",
  title: "Delete probe",
  source: "research_report",
  summary: "Probe summary",
  body: { title: "Probe" },
  userLogin: "tenant@example.com",
};

describe("#338 S3 coupled delete", () => {
  it("deleting a pointer row removes the row AND its R2 object", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const stored = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: bucket }, input);
    const key = reportBodyR2Key(stored!.reportId);
    expect(objects.has(key)).toBe(true);
    const deleted = await deleteCanonicalReport(sql, { REPORTS_BUCKET: bucket }, stored!.reportId);
    expect(deleted).toBe(true);
    expect(objects.has(key)).toBe(false);
    expect(getCanonicalReport(sql, stored!.reportId)).toBeNull();
  });

  it("deleting an inline row removes the row and touches no object", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket } = createFakeBucket();
    const stored = storeReportAtGeneration(sql, input);
    const deleted = await deleteCanonicalReport(sql, { REPORTS_BUCKET: bucket }, stored!.reportId);
    expect(deleted).toBe(true);
    expect((bucket as any).delete).not.toHaveBeenCalled();
    expect(getCanonicalReport(sql, stored!.reportId)).toBeNull();
  });

  it("deleting a missing report returns false", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket } = createFakeBucket();
    expect(await deleteCanonicalReport(sql, { REPORTS_BUCKET: bucket }, "nope")).toBe(false);
  });

  it("a failed R2 delete is logged and the row is still deleted (the orphan sweep owns stranded objects)", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket, objects } = createFakeBucket();
    const stored = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: bucket }, input);
    (bucket as any).delete = vi.fn(async () => { throw new Error("R2 delete failed"); });
    const deleted = await deleteCanonicalReport(sql, { REPORTS_BUCKET: bucket }, stored!.reportId);
    expect(deleted).toBe(true);
    expect(getCanonicalReport(sql, stored!.reportId)).toBeNull();
    // The object is stranded — exactly the case the design's orphan
    // sweep follow-up exists for.
    expect(objects.has(reportBodyR2Key(stored!.reportId))).toBe(true);
  });

  it("without a bucket bound, a pointer row is still deleted (object stranded, logged)", async () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const { bucket } = createFakeBucket();
    const stored = await storeReportAtGenerationWithR2(sql, { REPORTS_BUCKET: bucket }, input);
    const deleted = await deleteCanonicalReport(sql, {}, stored!.reportId);
    expect(deleted).toBe(true);
    expect(getCanonicalReport(sql, stored!.reportId)).toBeNull();
  });
});
