/**
 * Issue #278: tests for durable scheduled-run report persistence and
 * retrieval (src/services/scheduledReports.ts + the mas_reports ORM
 * table). The service module is SDK-free; SQL runs against a minimal
 * in-test fake for full OR-semantics, plus one integration round trip
 * through the real DatabaseORM + MockSqlStorage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseORM, type SqlStorage } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  ensureScheduledReportsTable,
  persistScheduledReportSql,
  searchScheduledReports,
  toScheduledReportRecord,
  SCHEDULED_REPORT_MAX_BODY_CHARS,
} from "../src/services/scheduledReports";

/** Minimal fake SQL with true OR/LIKE semantics for matcher tests. */
function createFakeSql() {
  const rows: Array<Record<string, unknown>> = [];
  const exec = (query: string, ...args: unknown[]): Iterable<unknown> => {
    const q = query.trim().toUpperCase();
    if (q.startsWith("CREATE")) return [];
    if (q.startsWith("INSERT")) {
      const cols = query.match(/\(([^)]+)\)\s*VALUES/i)![1]
        .split(",")
        .map((c) => c.trim());
      const rec: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        rec[c] = args[i];
      });
      rows.push(rec);
      return [];
    }
    if (q.startsWith("SELECT")) {
      const limit = Number(args[args.length - 1]);
      const likes = (args.slice(0, -1) as string[]).map((s) =>
        String(s).replace(/%/g, "").toLowerCase()
      );
      const matched = rows.filter((r) => {
        const hay =
          `${r.title} ${r.summary} ${r.body}`.toLowerCase();
        return likes.some((t) => t.length > 0 && hay.includes(t));
      });
      matched.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at))
      );
      return matched.slice(0, limit);
    }
    return [];
  };
  return { exec: exec as SqlStorage["exec"], rows };
}

const report = (over: Partial<Parameters<typeof toScheduledReportRecord>[0]> = {}) => ({
  runId: "screener:2026-10-18T10:00:00Z",
  title: "Autonomous market screen — Technology",
  source: "screener",
  summary: "Scanned 500 symbols, 12 matched, 3 opportunities.",
  body: { opportunities: [{ symbol: "NVDA" }] },
  createdAt: "2026-10-18T10:00:00.000Z",
  userLogin: "tenant@example.com",
  ...over,
});

describe("toScheduledReportRecord", () => {
  it("assigns an id, serializes the body, defaults createdAt", () => {
    const rec = toScheduledReportRecord(report({ createdAt: undefined }));
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(rec.body)).toEqual({
      opportunities: [{ symbol: "NVDA" }],
    });
    expect(rec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("caps the body to stay far under the SQLite row limit", () => {
    const rec = toScheduledReportRecord(report({ body: { x: "y".repeat(1_000_000) } }));
    expect(rec.body.length).toBeLessThanOrEqual(SCHEDULED_REPORT_MAX_BODY_CHARS);
  });

  it("survives a non-serializable body", () => {
    const circular: any = {};
    circular.self = circular;
    const rec = toScheduledReportRecord(report({ body: circular }));
    expect(rec.body).toBe("{}");
  });
});

describe("persist + search round trip (fake SQL)", () => {
  let sql: ReturnType<typeof createFakeSql>;

  beforeEach(() => {
    sql = createFakeSql();
  });

  it("persists and retrieves by title token", () => {
    const id = persistScheduledReportSql(sql, report());
    expect(id).toBeTruthy();
    const hits = searchScheduledReports(sql, "technology");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(id);
    expect(hits[0].title).toContain("Technology");
  });

  it("matches summary and body tokens, not only titles", () => {
    persistScheduledReportSql(sql, report());
    expect(searchScheduledReports(sql, "opportunities")).toHaveLength(1);
    expect(searchScheduledReports(sql, "nvda")).toHaveLength(1);
  });

  it("returns newest first and honors the limit", () => {
    persistScheduledReportSql(sql, report({ createdAt: "2026-10-18T09:00:00.000Z" }));
    persistScheduledReportSql(sql, report({ createdAt: "2026-10-18T11:00:00.000Z" }));
    const hits = searchScheduledReports(sql, "screen", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].createdAt).toBe("2026-10-18T11:00:00.000Z");
  });

  it("returns [] for empty or noise queries", () => {
    persistScheduledReportSql(sql, report());
    expect(searchScheduledReports(sql, "")).toEqual([]);
    expect(searchScheduledReports(sql, "a an")).toEqual([]);
    expect(searchScheduledReports(sql, "zzz-no-such-thing")).toEqual([]);
  });

  it("never throws on a broken store", () => {
    const broken: SqlStorage = {
      exec: () => {
        throw new Error("boom");
      },
    };
    expect(persistScheduledReportSql(broken, report())).toBeNull();
    expect(searchScheduledReports(broken, "screen")).toEqual([]);
    // ensure* intentionally lets DDL errors propagate — both public
    // entry points above catch it. Callers must not use it raw.
    expect(() => ensureScheduledReportsTable(broken)).toThrow("boom");
  });

  it("ensureScheduledReportsTable is idempotent", () => {
    ensureScheduledReportsTable(sql);
    ensureScheduledReportsTable(sql);
    persistScheduledReportSql(sql, report());
    expect(searchScheduledReports(sql, "screen")).toHaveLength(1);
  });
});

describe("ORM integration (real DatabaseORM + MockSqlStorage)", () => {
  it("mas_reports table exists after initializeSchema and round-trips via the reports repository", () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");

    const rec = toScheduledReportRecord(report());
    orm.reports.create(rec);

    const hits = searchScheduledReports(sql, "technology");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].title).toContain("Technology");

    const tables = orm.listTables().map((t) => t.name);
    expect(tables).toContain("mas_reports");
  });
});
