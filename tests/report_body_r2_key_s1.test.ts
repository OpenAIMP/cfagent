/**
 * Issue #338 S1: the `body_r2_key` additive column on mas_reports plus
 * store/read plumbing. Design of record: comment 6294344673 on #338
 * (accepted by Venus 2026-10-23). S1 changes NO behavior: writes still
 * store the body inline, every existing row reads back with a null
 * pointer, and the readers surface the pointer so S2 can resolve it.
 */
import { describe, it, expect } from "vitest";
import type { SqlStorage } from "../src/orm";
import {
  ensureScheduledReportsTable,
  storeReportAtGeneration,
  getCanonicalReport,
  getScheduledReportById,
  listScheduledReports,
  searchScheduledReports,
  reportBodyR2Key,
  SCHEDULED_REPORTS_TABLE,
} from "../src/services/scheduledReports";

/**
 * Purpose-built fake with real PRAGMA/ALTER bookkeeping so the additive
 * migration is observable (MockSqlStorage's PRAGMA returns [] and its
 * ALTER is a no-op, which cannot prove a column was added).
 */
function createFakeSql() {
  const baseColumns = [
    "id",
    "run_id",
    "title",
    "source",
    "summary",
    "body",
    "created_at",
    "generation_id",
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
    if (upper.startsWith("CREATE")) return []; // indexes
    if (upper.startsWith("PRAGMA")) {
      return columns.map((name) => ({ name }));
    }
    if (upper.startsWith("ALTER TABLE")) {
      const m = q.match(/ADD COLUMN\s+(\w+)/i);
      if (m && !columns.includes(m[1])) columns.push(m[1]);
      return [];
    }
    if (upper.startsWith("UPDATE")) {
      // The ensure-time user_login backfill is the only UPDATE here.
      for (const r of rows) if (r.user_login == null) r.user_login = args[0];
      return [];
    }
    if (upper.startsWith("INSERT")) {
      const cols = q
        .match(/\(([^)]+)\)\s*VALUES/i)![1]
        .split(",")
        .map((c) => c.trim());
      const rec: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        rec[c] = args[i];
      });
      rows.push(rec);
      return [];
    }
    if (upper.startsWith("SELECT")) {
      let out = [...rows];
      if (/generation_id\s*=\s*\?/.test(q)) {
        out = out.filter((r) => r.generation_id === args[0]);
        return out.map((r) => ({ id: r.id }));
      }
      if (/WHERE id\s*=\s*\?/.test(q)) {
        out = out.filter((r) => r.id === args[0]);
      }
      if (/LIKE/.test(upper)) {
        const likes = (args as string[])
          .filter((a) => typeof a === "string" && a.includes("%"))
          .map((s) => s.replace(/%/g, "").toLowerCase());
        out = out.filter((r) =>
          likes.some((t) =>
            `${r.title} ${r.summary} ${r.body}`.toLowerCase().includes(t)
          )
        );
      }
      out.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at))
      );
      const limit = Number(args[args.length - 1]);
      if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
      return out;
    }
    return [];
  };
  return {
    exec: exec as SqlStorage["exec"],
    rows,
    columns,
    table: SCHEDULED_REPORTS_TABLE,
  };
}

const input = {
  runId: "run-338",
  generationId: "gen-338",
  title: "Storage split probe",
  source: "screener",
  summary: "Probe summary",
  body: { ideas: [{ symbol: "ACME" }] },
  userLogin: "tenant@example.com",
};

describe("#338 S1 body_r2_key plumbing", () => {
  it("ensure adds the body_r2_key column additively", () => {
    const fake = createFakeSql();
    ensureScheduledReportsTable(fake as unknown as SqlStorage);
    expect(fake.columns).toContain("body_r2_key");
    // Additive only: the pre-existing shape is untouched.
    expect(fake.columns).toContain("body");
    expect(fake.columns).toContain("generation_id");
  });

  it("derives the R2 key from the report id per the accepted design", () => {
    expect(reportBodyR2Key("rep-123")).toBe("reports/rep-123.json");
  });

  it("a fresh inline write reads back with a null pointer and intact body", () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const stored = storeReportAtGeneration(sql, input);
    expect(stored?.created).toBe(true);
    const hit = getCanonicalReport(sql, stored!.reportId);
    expect(hit).not.toBeNull();
    expect(hit!.bodyR2Key).toBeNull();
    expect(JSON.parse(hit!.body)).toEqual({ ideas: [{ symbol: "ACME" }] });
  });

  it("readers surface a stored pointer (the S2 row shape) unchanged", () => {
    const fake = createFakeSql();
    const sql = fake as unknown as SqlStorage;
    const stored = storeReportAtGeneration(sql, input);
    // Simulate the S2 write shape directly: pointer set, body still the
    // stored copy until S2 flips the write path.
    const row = fake.rows.find((r) => r.id === stored!.reportId)!;
    row.body_r2_key = reportBodyR2Key(stored!.reportId);

    expect(getCanonicalReport(sql, stored!.reportId)?.bodyR2Key).toBe(
      "reports/" + stored!.reportId + ".json"
    );
    expect(getScheduledReportById(sql, stored!.reportId)?.bodyR2Key).toBe(
      "reports/" + stored!.reportId + ".json"
    );
    expect(listScheduledReports(sql)[0]?.bodyR2Key).toBe(
      "reports/" + stored!.reportId + ".json"
    );
    expect(searchScheduledReports(sql, "storage")[0]?.bodyR2Key).toBe(
      "reports/" + stored!.reportId + ".json"
    );
  });
});
