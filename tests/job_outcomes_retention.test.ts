/**
 * Issue #2294 — mas_job_outcomes retention.
 *
 * The outcome feed is read as `ORDER BY created_at DESC LIMIT 50`, but the
 * table had no retention decision and no `created_at` index, so every list
 * call scanned the whole history. On 2026-10-29 that scan was ~2,432 rows per
 * request on the heaviest instance, and the account exhausted its Durable
 * Object rows-read cap (#2280). This pins both halves of the fix: the index
 * exists, and the prune bounds the table by age and by row count.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  JOB_OUTCOMES_KEEP_ROWS,
  JOB_OUTCOMES_RETENTION_DEFAULT_DAYS,
  ensureJobOutcomesTable,
  pruneJobOutcomes,
} from "../src/services/jobOutcomes";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const DAY = 86_400_000;
const isoDaysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

function seed(sql: MockSqlStorage, rows: Array<[string, number]>): void {
  ensureJobOutcomesTable(sql);
  for (const [id, daysAgo] of rows) {
    sql.exec(
      "INSERT OR REPLACE INTO mas_job_outcomes (id, kind, trigger, status, scanned, matched, coded_error, report_url, pdf_key, xlsx_key, csv_key, delivery_json, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      "discovery",
      "scheduled",
      "completed",
      1,
      1,
      null,
      null,
      null,
      null,
      null,
      "{}",
      "discovery",
      isoDaysAgo(daysAgo)
    );
  }
}

const survivingIds = (sql: MockSqlStorage): string[] =>
  (Array.from(
    sql.exec("SELECT id FROM mas_job_outcomes ORDER BY created_at ASC")
  ) as Array<{ id: string }>).map((row) => row.id);

const rowCount = (sql: MockSqlStorage): number =>
  Number(
    (
      Array.from(
        sql.exec("SELECT COUNT(*) AS count FROM mas_job_outcomes")
      ) as Array<{ count: number }>
    )[0]?.count ?? 0
  );

describe("mas_job_outcomes retention (#2294)", () => {
  it("defaults to a 90-day window and a 500-row cap", () => {
    expect(JOB_OUTCOMES_RETENTION_DEFAULT_DAYS).toBe(90);
    expect(JOB_OUTCOMES_KEEP_ROWS).toBe(500);
  });

  it("deletes rows older than the window and keeps the rest", () => {
    const sql = new MockSqlStorage();
    seed(sql, [
      ["too-old", 120],
      ["just-old", 91],
      ["edge", 90],
      ["recent", 10],
    ]);

    const result = pruneJobOutcomes(sql, { now: () => NOW });

    expect(result.deletedByAge).toBe(2);
    expect(result.deletedByCap).toBe(0);
    expect(survivingIds(sql)).toEqual(["edge", "recent"]);
  });

  it("keeps only the newest N rows even when nothing is old", () => {
    const sql = new MockSqlStorage();
    const rows: Array<[string, number]> = Array.from({ length: 620 }, (_, i) => [
      `run-${String(i).padStart(3, "0")}`,
      // Newest first: index 0 is the most recent run.
      i * 0.001,
    ]);
    seed(sql, rows);

    const result = pruneJobOutcomes(sql, { retentionDays: 0, now: () => NOW });

    expect(result.deletedByAge).toBe(0);
    expect(result.deletedByCap).toBe(120);
    expect(rowCount(sql)).toBe(JOB_OUTCOMES_KEEP_ROWS);
    // Index 0 is the newest run, so the oldest 120 (run-500..run-619) went.
    expect(survivingIds(sql)).toContain("run-000");
    expect(survivingIds(sql)).toContain("run-499");
    expect(survivingIds(sql)).not.toContain("run-500");
    expect(survivingIds(sql)).not.toContain("run-619");
  });

  it("a window <= 0 disables the age prune but not the cap", () => {
    const sql = new MockSqlStorage();
    seed(sql, [
      ["ancient", 3650],
      ["fresh", 1],
    ]);

    const result = pruneJobOutcomes(sql, { retentionDays: -1, now: () => NOW });

    expect(result).toEqual({ deletedByAge: 0, deletedByCap: 0 });
    expect(survivingIds(sql)).toEqual(["ancient", "fresh"]);
  });

  it("creates the created_at index the feed orders on", () => {
    const statements: string[] = [];
    const sql = new MockSqlStorage();
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...args: unknown[]) => {
      statements.push(query);
      return exec(query, ...args);
    }) as typeof sql.exec;

    ensureJobOutcomesTable(sql);

    expect(
      statements.some((statement) =>
        /CREATE INDEX IF NOT EXISTS idx_mas_job_outcomes_created ON mas_job_outcomes\(created_at DESC\)/.test(
          statement
        )
      )
    ).toBe(true);
  });
});
