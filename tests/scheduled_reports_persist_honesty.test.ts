/**
 * Issue #876 (production hotfix): scheduled screens failed loudly from
 * 2026-10-21T03:30Z because `persistScheduledReportSql` returned null —
 * while the underlying SQL error was destroyed by a bare `catch {}` and
 * `ensureScheduledReportsTable` was not self-healing against accumulated
 * table state (duplicate generation_id values break its UNIQUE INDEX;
 * legacy shapes can lack columns the INSERTs name).
 *
 * Pins (Red on pristine main, noted per test):
 *  - duplicate non-null generation_id rows: persist succeeds, the index
 *    failure is logged (naming the index), nothing throws [RED: null];
 *  - legacy-shaped table missing a column the INSERT needs (body):
 *    persist succeeds after additive reconciliation [RED: null];
 *  - store throwing on INSERT: persist returns null AND console.error
 *    carries the error's message [RED: nothing logged]; same for
 *    storeReportAtGeneration [RED: nothing logged];
 *  - recordUsageEvent (the module's other write seam) also logs [RED];
 *  - source pin: the persist seams contain logging and no bare catch.
 *
 * Characterization (passes both sides, disclosed): the healthy-store
 * test — persist returns the id, the row reads back, store dedupes on
 * generation id, and NO error is logged.
 *
 * The double below extends MockSqlStorage with the strict SQLite
 * semantics plain MockSqlStorage does not model (pattern of
 * tests/orm-mas-reports-migration.test.ts): CREATE TABLE registers the
 * parsed column shape, INSERT enforces unknown columns / NOT NULL /
 * live UNIQUE indexes, and CREATE UNIQUE INDEX over duplicate non-null
 * values throws, exactly like the DO runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockSqlStorage } from "./mock-sql";
import type { SqlStorage } from "../src/orm";
import {
  ensureScheduledReportsTable,
  persistScheduledReportSql,
  storeReportAtGeneration,
  getCanonicalReport,
  recordUsageEvent,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";

interface ColMeta {
  name: string;
  notnull: boolean;
}

type SchemaMap = Map<string, Array<{ name: string; type: string; pk: number }>>;
type TablesMap = Map<string, Array<Record<string, unknown>>>;

class StrictMasReportsSql extends MockSqlStorage {
  private reportsCols: ColMeta[] | null = null;
  private uniqueIndexCols = new Map<string, string>(); // index name -> column
  private createdIndexNames = new Set<string>();
  /** When set, every INSERT INTO mas_reports throws this error. */
  failInsertsWith: Error | null = null;

  private setReportsSchema(cols: ColMeta[], pkCol = "id"): void {
    this.reportsCols = cols.map((c) => ({ ...c }));
    const schema = (this as unknown as { schema: SchemaMap }).schema;
    schema.set(
      "mas_reports",
      cols.map((c) => ({ name: c.name, type: "TEXT", pk: c.name === pkCol ? 1 : 0 }))
    );
    const tables = (this as unknown as { tables: TablesMap }).tables;
    if (!tables.has("mas_reports")) tables.set("mas_reports", []);
  }

  private reportRows(): Array<Record<string, unknown>> {
    const tables = (this as unknown as { tables: TablesMap }).tables;
    return tables.get("mas_reports") ?? [];
  }

  /** Seed a pre-existing table shape + rows, bypassing exec enforcement. */
  seedTable(cols: ColMeta[], rows: Array<Record<string, unknown>>): void {
    this.setReportsSchema(cols);
    const tables = (this as unknown as { tables: TablesMap }).tables;
    tables.set("mas_reports", rows.map((r) => ({ ...r })));
  }

  exec(query: string, ...args: unknown[]): Iterable<unknown> {
    const q = query.trim();

    // CREATE TABLE IF NOT EXISTS mas_reports ( ... ) — register the
    // parsed shape only when the table does not already exist.
    const createMatch = q.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+mas_reports\s*\(([\s\S]*)\)/i);
    if (createMatch) {
      if (!this.reportsCols) {
        const cols: ColMeta[] = createMatch[1]
          .split(",")
          .map((def) => def.trim())
          .filter(Boolean)
          .map((def) => {
            const name = def.split(/\s+/)[0];
            return {
              name,
              notnull: /NOT\s+NULL/i.test(def) || /PRIMARY\s+KEY/i.test(def),
            };
          });
        this.setReportsSchema(cols);
      }
      return [];
    }

    // ALTER TABLE mas_reports ADD COLUMN <col> <type>
    const alterMatch = q.match(/ALTER\s+TABLE\s+mas_reports\s+ADD\s+COLUMN\s+(\w+)\s+(\w+)/i);
    if (alterMatch) {
      if (this.reportsCols && !this.reportsCols.some((c) => c.name === alterMatch[1])) {
        const next = [...this.reportsCols, { name: alterMatch[1], notnull: false }];
        this.setReportsSchema(next);
      }
      return [];
    }

    // CREATE [UNIQUE] INDEX ... ON mas_reports (<col> [DESC])
    const idxMatch = q.match(
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+mas_reports\s*\(([\w\s,]+)\)/i
    );
    if (idxMatch) {
      const unique = !!idxMatch[1];
      const name = idxMatch[2];
      const col = idxMatch[3].trim().split(/\s+/)[0];
      if (this.createdIndexNames.has(name)) return [];
      if (!this.reportsCols?.some((c) => c.name === col)) {
        throw new Error(`no such column: ${col}`);
      }
      if (unique) {
        const seen = new Set<unknown>();
        for (const row of this.reportRows()) {
          const v = row[col];
          if (v === null || v === undefined) continue;
          if (seen.has(v)) {
            throw new Error(`UNIQUE constraint failed: index '${name}'`);
          }
          seen.add(v);
        }
        this.uniqueIndexCols.set(name, col);
      }
      this.createdIndexNames.add(name);
      return [];
    }

    // INSERT INTO mas_reports (cols) VALUES (...) — strict enforcement.
    const insertMatch = q.match(/INSERT\s+INTO\s+mas_reports\s*\(([^)]*)\)\s*VALUES/i);
    if (insertMatch) {
      if (this.failInsertsWith) throw this.failInsertsWith;
      const cols = insertMatch[1].split(",").map((c) => c.trim());
      const known = new Set((this.reportsCols ?? []).map((c) => c.name));
      for (const c of cols) {
        if (!known.has(c)) {
          throw new Error(`table mas_reports has no column named ${c}`);
        }
      }
      const values = new Map<string, unknown>();
      cols.forEach((c, i) => values.set(c, args[i]));
      for (const meta of this.reportsCols ?? []) {
        if (meta.notnull) {
          const v = values.get(meta.name);
          if (v === undefined || v === null) {
            throw new Error(`NOT NULL constraint failed: mas_reports.${meta.name}`);
          }
        }
      }
      for (const col of this.uniqueIndexCols.values()) {
        const v = values.get(col);
        if (v === null || v === undefined) continue;
        if (this.reportRows().some((r) => r[col] === v)) {
          throw new Error(`UNIQUE constraint failed: mas_reports.${col}`);
        }
      }
      return super.exec(query, ...args);
    }

    return super.exec(query, ...args);
  }
}

const FULL_COLS: ColMeta[] = [
  { name: "id", notnull: true },
  { name: "run_id", notnull: true },
  { name: "title", notnull: true },
  { name: "source", notnull: true },
  { name: "summary", notnull: true },
  { name: "body", notnull: true },
  { name: "created_at", notnull: true },
  { name: "generation_id", notnull: false },
  { name: "user_login", notnull: false },
];

function seedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rep_seed",
    run_id: "run-seed",
    title: "Seed report",
    source: "screener",
    summary: "seed summary",
    body: "{}",
    created_at: "2026-10-01T00:00:00.000Z",
    generation_id: null,
    user_login: "default",
    ...over,
  };
}

function input(over: Partial<ScheduledReportInput> = {}): ScheduledReportInput {
  return {
    runId: "screener:2026-10-21T03:30:00Z",
    title: "Autonomous market screen — Technology",
    source: "screener",
    summary: "Scanned 100 symbols, 4 matched.",
    body: { opportunities: [{ symbol: "NVDA" }] },
    createdAt: "2026-10-21T03:30:00.000Z",
    userLogin: "tenant@example.com",
    ...over,
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;

function loggedText(): string {
  return errSpy.mock.calls
    .map((args: unknown[]) =>
      args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")
    )
    .join("\n");
}

beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
});

describe("issue #876 — persist seams surface the real error", () => {
  it("duplicate generation_id rows: persist succeeds, index failure is logged, nothing throws", () => {
    const sql = new StrictMasReportsSql();
    sql.seedTable(FULL_COLS, [
      seedRow({ id: "rep_a", generation_id: "gen-dup" }),
      seedRow({ id: "rep_b", generation_id: "gen-dup" }),
    ]);

    expect(() => ensureScheduledReportsTable(sql)).not.toThrow();
    expect(loggedText()).toContain("idx_mas_reports_generation");

    const id = persistScheduledReportSql(sql, input());
    expect(id).toBeTruthy();
    const stored = getCanonicalReport(sql, id as string);
    expect(stored?.title).toBe("Autonomous market screen — Technology");
  });

  it("legacy-shaped table missing `body`: persist succeeds after additive reconciliation", () => {
    const sql = new StrictMasReportsSql();
    const legacyCols = FULL_COLS.filter(
      (c) => !["body", "generation_id", "user_login"].includes(c.name)
    );
    const legacyRow = seedRow({ id: "rep_legacy" });
    delete legacyRow.body;
    delete legacyRow.generation_id;
    delete legacyRow.user_login;
    sql.seedTable(legacyCols, [legacyRow]);

    const id = persistScheduledReportSql(sql, input());
    expect(id).toBeTruthy();

    const cols = Array.from(sql.exec("PRAGMA table_info(mas_reports)")) as Array<{
      name?: unknown;
    }>;
    const names = cols.map((c) => String(c?.name));
    for (const expected of ["body", "generation_id", "user_login"]) {
      expect(names).toContain(expected);
    }
    expect(getCanonicalReport(sql, id as string)?.runId).toBe(input().runId);
  });

  it("store throwing on INSERT: persist returns null AND the error is logged with its message", () => {
    const sql = new StrictMasReportsSql();
    sql.failInsertsWith = new Error("simulated store failure: SQLITE_FULL");
    expect(persistScheduledReportSql(sql, input())).toBeNull();
    expect(loggedText()).toContain("persistScheduledReportSql");
    expect(loggedText()).toContain("SQLITE_FULL");
  });

  it("storeReportAtGeneration failure also logs (never a silent null)", () => {
    const sql = new StrictMasReportsSql();
    sql.failInsertsWith = new Error("simulated store failure: SQLITE_FULL");
    expect(storeReportAtGeneration(sql, input({ generationId: "gen-x" }))).toBeNull();
    expect(loggedText()).toContain("storeReportAtGeneration");
    expect(loggedText()).toContain("SQLITE_FULL");
  });

  it("recordUsageEvent failure is logged before returning null", () => {
    const throwingSql = {
      exec: (query: string): Iterable<unknown> => {
        if (/INSERT\s+INTO\s+usage_events/i.test(query)) {
          throw new Error("simulated metering failure: SQLITE_BUSY");
        }
        return [];
      },
    } as unknown as SqlStorage;
    expect(
      recordUsageEvent(throwingSql, {
        userLogin: "trader1",
        runId: "run-1",
        category: "research_run",
      })
    ).toBeNull();
    expect(loggedText()).toContain("recordUsageEvent");
    expect(loggedText()).toContain("SQLITE_BUSY");
  });

  it("healthy store: persist returns the id, row reads back, store dedupes, NO error logged (characterization)", () => {
    const sql = new StrictMasReportsSql();
    const id = persistScheduledReportSql(sql, input());
    expect(id).toBeTruthy();
    expect(getCanonicalReport(sql, id as string)?.title).toBe(input().title);

    const first = storeReportAtGeneration(sql, input({ generationId: "gen-h" }));
    expect(first?.created).toBe(true);
    const second = storeReportAtGeneration(sql, input({ generationId: "gen-h" }));
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);

    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("issue #876 — source pin", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/services/scheduledReports.ts", import.meta.url)),
    "utf-8"
  );
  const slice = (from: string, to: string): string => {
    const start = src.indexOf(from);
    const end = src.indexOf(to, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it("persist seams log and contain no bare catch", () => {
    const persistSrc = slice(
      "export function persistScheduledReportSql",
      "export interface ScheduledReportHit"
    );
    expect(persistSrc).toContain("console.error");
    expect(persistSrc).not.toMatch(/catch\s*\{/);

    const storeSrc = slice(
      "export function storeReportAtGeneration",
      "/** Read back the canonical stored copy"
    );
    expect(storeSrc).toContain("console.error");
    expect(storeSrc).not.toMatch(/catch\s*\{/);
  });

  it("the generation UNIQUE INDEX creation sits inside a guarded try with logging", () => {
    const ensureSrc = slice(
      "export function ensureScheduledReportsTable",
      "/** Shape a report input"
    );
    const idxPos = ensureSrc.indexOf("CREATE UNIQUE INDEX");
    expect(idxPos).toBeGreaterThan(-1);
    expect(ensureSrc.lastIndexOf("try {", idxPos)).toBeGreaterThan(-1);
    expect(ensureSrc.indexOf("catch (err)", idxPos)).toBeGreaterThan(idxPos);
    expect(ensureSrc).toContain("console.error");
    expect(ensureSrc).toContain("idx_mas_reports_generation");
  });
});
