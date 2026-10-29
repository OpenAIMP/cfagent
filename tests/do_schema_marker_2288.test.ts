// @vitest-environment node
/**
 * Issue #2288 (#1976 step 0, ADR 0022 D-A.4) — DO schema-version
 * marker pins.
 *
 * The marker gives a Durable Object instance the discipline D1
 * gets from `_migrations`: versioned, idempotent, marker-LAST
 * (a migration body that throws leaves the marker untouched, so
 * the migration is retried rather than half-recorded). The
 * double is a node:sqlite-backed SqlStorage facade in the shape
 * of tests/audit_store_atomic_1760.test.ts — real SQL semantics,
 * no hand-rolled query matcher.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  readDoSchemaVersion,
  recordDoSchemaVersion,
  reportDoSchemaVersion,
  runDoSchemaMigration,
  type DoSchemaSql,
} from "../src/data/doSchemaMarker";
import { InMemoryFleetRegistryAdapter } from "../src/data/inMemoryFleetRegistryAdapter";

function makeSql(): DoSchemaSql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        return stmt.all(...(params as any[])) as Array<
          Record<string, unknown>
        >;
      }
      stmt.run(...(params as any[]));
      return [];
    },
  };
}

describe("#2288 DO schema-version marker", () => {
  it("a fresh instance reads version 0 (no migration recorded)", () => {
    const sql = makeSql();
    expect(readDoSchemaVersion(sql)).toBe(0);
  });

  it("records and reads back a version; re-recording the same version is idempotent", () => {
    const sql = makeSql();
    recordDoSchemaVersion(sql, 3, 1000);
    expect(readDoSchemaVersion(sql)).toBe(3);
    recordDoSchemaVersion(sql, 3, 2000);
    expect(readDoSchemaVersion(sql)).toBe(3);
    recordDoSchemaVersion(sql, 4, 3000);
    expect(readDoSchemaVersion(sql)).toBe(4);
  });

  it("runDoSchemaMigration applies the body once, then reports already-applied", () => {
    const sql = makeSql();
    const apply = vi.fn(() => {
      sql.exec("CREATE TABLE IF NOT EXISTS migrated_thing (id TEXT)");
    });
    const first = runDoSchemaMigration(sql, 1, apply, 1000);
    expect(first).toEqual({ applied: true, fromVersion: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(readDoSchemaVersion(sql)).toBe(1);

    const second = runDoSchemaMigration(sql, 1, apply, 2000);
    expect(second).toEqual({ applied: false, fromVersion: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("marker-LAST: a throwing migration body leaves the marker untouched and the migration retryable", () => {
    const sql = makeSql();
    recordDoSchemaVersion(sql, 1, 1000);
    const failing = vi.fn(() => {
      throw new Error("DDL failed halfway");
    });
    expect(() => runDoSchemaMigration(sql, 2, failing, 2000)).toThrow(
      "DDL failed halfway",
    );
    // No half-recorded state: the instance still reports v1.
    expect(readDoSchemaVersion(sql)).toBe(1);

    const retry = runDoSchemaMigration(
      sql,
      2,
      () => {
        sql.exec("CREATE TABLE IF NOT EXISTS migrated_thing (id TEXT)");
      },
      3000,
    );
    expect(retry).toEqual({ applied: true, fromVersion: 1 });
    expect(readDoSchemaVersion(sql)).toBe(2);
  });

  it("reports in the fleet-registry family's shape, and the registry port accepts the report", async () => {
    const sql = makeSql();
    recordDoSchemaVersion(sql, 2, 1000);
    const report = reportDoSchemaVersion(sql, "screener", 5000);
    expect(report).toEqual({
      agentKey: "screener",
      doSchemaVersion: 2,
      reportedAtMs: 5000,
    });

    // The registry record consumes doSchemaVersion verbatim.
    const registry = new InMemoryFleetRegistryAdapter();
    await registry.upsertAgent({
      agentKey: report.agentKey,
      className: "ScreenerAgent",
      binding: "SCREENER_AGENT",
      instanceScheme: "per-login",
      migrationTag: "v9",
      operations: ["screen"],
      identity: null,
      doSchemaVersion: report.doSchemaVersion,
      updatedAtMs: report.reportedAtMs,
    });
    const stored = await registry.getAgent("screener");
    expect(stored?.doSchemaVersion).toBe(2);
  });
});
