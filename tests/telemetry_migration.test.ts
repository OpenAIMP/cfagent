// @vitest-environment node
/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — TDD red-first.
 *
 * Migration 0006 owns the agent_thesis_realizations and
 * agent_calibration_decisions DDL; the Drizzle schema maps it.
 * Mirrors the #1740 parity test: DDL authority lives in
 * exactly one migration file, and the schema must agree on
 * columns.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1TelemetryDb,
  ensureTelemetrySchema,
} from "../src/telemetry/d1TelemetryAdapter";
import {
  MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION,
  applyMigrations,
} from "../src/data/migrationRunner";
import {
  agentCalibrationDecisions,
  agentThesisRealizations,
} from "../src/data/drizzleSchema";

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slices 0–3/#1740). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

describe("migration 0006 (#1742)", () => {
  it("applies once, records _migrations, second apply is a no-op", async () => {
    const mock = new MockD1Database();
    const db = createD1TelemetryDb(mock as any);
    await applyMigrations(db, [MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION]);
    await applyMigrations(db, [MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION]);
    const rows = mock.sqlite
      .prepare("SELECT version, name FROM _migrations ORDER BY version")
      .all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 6 });
    for (const table of ["agent_thesis_realizations", "agent_calibration_decisions"]) {
      const found = mock.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(table);
      expect(found).toHaveLength(1);
    }
  });

  it("migration DDL and Drizzle schema agree on columns for both tables", () => {
    const pairs: Array<[string, unknown, string]> = [
      [
        "agent_thesis_realizations",
        agentThesisRealizations,
        MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION.sql,
      ],
      [
        "agent_calibration_decisions",
        agentCalibrationDecisions,
        MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION.sql,
      ],
    ];
    for (const [table, schema, sqlText] of pairs) {
      const rawColumns = getTableConfig(schema as any).columns as any;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: any) => c.name as string)
        : Object.keys(rawColumns).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          );
      const block = (sqlText as string)
        .split(`CREATE TABLE IF NOT EXISTS ${table} (`)[1]
        .split("\n);")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
      expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
    }
  });

  it("ensureTelemetrySchema applies the full migration list idempotently", async () => {
    const mock = new MockD1Database();
    const db = createD1TelemetryDb(mock as any);
    const first = await ensureTelemetrySchema(db);
    const second = await ensureTelemetrySchema(db);
    expect(first).toContain(6);
    expect(second).toEqual([]);
  });
});
