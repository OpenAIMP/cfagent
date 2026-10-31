/**
 * Options screener consolidation, slice 1 (issue #2528).
 *
 * Canonical artifact-key backfill on redelivery, and the single
 * canonical recorder wrapper. A keyless first write must not freeze
 * a row forever, and a redelivery must never overwrite an existing
 * key/status. TDD red→green for the backfill behaviour.
 */
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  backfillArtifactKeys,
  getCanonicalReport,
  storeReportAtGeneration,
} from "../src/services/scheduledReports";
import { recordUnifiedOptionsRun } from "../src/services/optionsServeRecord";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] & { rowsWritten?: number } {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

const base = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  generationId: "gen-1",
  userLogin: "alice",
  title: "Options scanner — bullish",
  source: "options_scanner",
  summary: "12 scanned",
  body: { trigger: "scheduled" },
  ...over,
});

describe("backfillArtifactKeys", () => {
  it("fills missing keys/statuses and never overwrites existing ones", () => {
    const merged = backfillArtifactKeys(
      JSON.stringify({ pdfKey: "options/pdf/old", pdfStatus: "generated" }),
      { xlsxKey: "options/xlsx/new", xlsxStatus: "generated", pdfKey: "options/pdf/evil" },
    );
    expect(merged).not.toBeNull();
    const body = JSON.parse(merged!);
    expect(body.pdfKey).toBe("options/pdf/old");
    expect(body.xlsxKey).toBe("options/xlsx/new");
    expect(body.xlsxStatus).toBe("generated");
  });

  it("upgrades failed to generated but never downgrades generated", () => {
    const upgraded = backfillArtifactKeys(
      JSON.stringify({ pdfStatus: "failed" }),
      { pdfKey: "k", pdfStatus: "generated" },
    );
    expect(JSON.parse(upgraded!).pdfStatus).toBe("generated");
    expect(JSON.parse(upgraded!).pdfKey).toBe("k");
    const notDowngraded = backfillArtifactKeys(
      JSON.stringify({ pdfKey: "k", pdfStatus: "generated" }),
      { pdfStatus: "failed" },
    );
    expect(notDowngraded).toBeNull();
  });

  it("returns null when nothing is missing", () => {
    expect(
      backfillArtifactKeys(
        JSON.stringify({ pdfKey: "k", pdfStatus: "generated" }),
        { pdfKey: "k2" },
      ),
    ).toBeNull();
  });

  it("fills nested report.result fields the same way", () => {
    const merged = backfillArtifactKeys(
      JSON.stringify({ report: { result: {} } }),
      { report: { result: { pdfKey: "nested-k" } } },
    );
    expect(JSON.parse(merged!).report.result.pdfKey).toBe("nested-k");
  });
});

describe("storeReportAtGeneration backfill on redelivery", () => {
  it("fills a keyless row on redelivery and keeps one row", () => {
    const sql = new SqliteTestStorage() as never;
    const first = storeReportAtGeneration(sql, base());
    expect(first?.created).toBe(true);
    const second = storeReportAtGeneration(
      sql,
      base({ body: { trigger: "scheduled", pdfKey: "options/pdf/r1", pdfStatus: "generated", xlsxKey: "options/xlsx/r1", xlsxStatus: "generated", csvKey: "options/csv/r1", csvStatus: "generated" } }),
    );
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);
    const hit = getCanonicalReport(sql, first!.reportId);
    const body = JSON.parse(hit!.body);
    expect(body.pdfKey).toBe("options/pdf/r1");
    expect(body.xlsxKey).toBe("options/xlsx/r1");
    expect(body.csvKey).toBe("options/csv/r1");
  });

  it("never overwrites an existing key on redelivery", () => {
    const sql = new SqliteTestStorage() as never;
    const first = storeReportAtGeneration(
      sql,
      base({ body: { pdfKey: "options/pdf/orig", pdfStatus: "generated" } }),
    );
    storeReportAtGeneration(
      sql,
      base({ body: { pdfKey: "options/pdf/other" } }),
    );
    const body = JSON.parse(getCanonicalReport(sql, first!.reportId)!.body);
    expect(body.pdfKey).toBe("options/pdf/orig");
  });
});

describe("recordUnifiedOptionsRun", () => {
  it("records one canonical row with trigger, mode, and artifact keys", () => {
    const orm = { storeCanonicalReport: vi.fn(() => ({ reportId: "u1", created: true })) };
    const out = recordUnifiedOptionsRun(orm, {
      runId: "options:2026-10-31T09:20:56.666Z",
      generationId: "options:2026-10-31T09:20:56.666Z",
      title: "Options scanner — bullish",
      source: "options_scanner",
      summary: "scheduled",
      trigger: "scheduled",
      strategyMode: "all",
      userLogin: "alice",
      pdfKey: "options/pdf/r1",
      pdfStatus: "generated",
      xlsxStatus: "failed",
      xlsxError: "xlsx failed",
    });
    expect(out).toEqual({ reportId: "u1", created: true });
    const call = orm.storeCanonicalReport.mock.calls[0][0];
    expect(call.userLogin).toBe("alice");
    expect(call.body.trigger).toBe("scheduled");
    expect(call.body.strategyMode).toBe("all");
    expect(call.body.pdfKey).toBe("options/pdf/r1");
    expect(call.body.xlsxStatus).toBe("failed");
    expect(call.body).not.toHaveProperty("csvKey");
  });
});
