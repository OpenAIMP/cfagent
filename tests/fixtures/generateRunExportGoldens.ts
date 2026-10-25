/**
 * GOLDEN GENERATOR for the S6 (#1065) shared-exporter pins — NOT a
 * suite test. Run once, on a pristine tree, against the LEGACY
 * exporter modules:
 *
 *   cp tests/fixtures/generateRunExportGoldens.ts tests/zz_generate_goldens.test.ts
 *   node ./node_modules/vitest/vitest.mjs run tests/zz_generate_goldens.test.ts
 *   rm tests/zz_generate_goldens.test.ts
 *
 * It writes tests/run_export_goldens.json — the byte-level captures
 * that tests/run_export_s6.test.ts pins the shared module against.
 * Regenerate ONLY from a tree where the legacy builders are the
 * source of truth (i.e. pre-S6 main); after S6 the goldens are the
 * frozen record of legacy behaviour.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  csvEscape,
  screenAllStocksCsv,
  screenExportFilename,
  screenRunJson,
  screenStandoutsCsv,
} from "../src/client/screenerExport";
import {
  scanExportFilename,
  scanExportRunFromResult,
  scanExportRunFromStored,
  scanResultsCsv,
  scanRunJson,
} from "../src/client/scannerExport";
import {
  discoveryCandidatesCsv,
  discoveryExportFilename,
  discoveryRunHasCandidates,
  discoveryRunJson,
  discoveryTriggerLabel,
  formatConstraintSetLine,
} from "../src/client/discoveryExport";
import {
  createOptionsIdeasReportXls,
  createRawOptionsIdeasXls,
  createRetrievedOptionsDataXls,
} from "../src/client/options/optionsIdeasExport";
import {
  DISCOVERY_FAILED,
  DISCOVERY_NOVIEW,
  DISCOVERY_VIEWED_PARTIAL,
  SCAN_EMPTY_FITS,
  SCAN_LIVE_RESPONSE,
  SCAN_STORED_FIT,
  SCAN_STORED_PER_NAME,
  SCREEN_BAD_TIMESTAMP,
  SCREEN_EMPTY_ALL_SECTOR,
  SCREEN_PARTIAL,
  SCREEN_RUN,
  XLS_RAW_GROUPED,
  XLS_RAW_PLAIN,
  XLS_REPORT,
  XLS_REPORT_MINIMAL,
  XLS_RETRIEVED,
} from "./fixtures/runExportFixtures";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("generate S6 goldens from the legacy builders", () => {
  it("captures every exporter's output over the fixture inputs", async () => {
    const goldens: Record<string, unknown> = {
      generatedFrom:
        "Legacy exporter modules (screenerExport, scannerExport, discoveryExport, options/optionsIdeasExport) on main f4e679ada9dce4d2f7293a0c6c03fd0a3b7fe604, over tests/fixtures/runExportFixtures.ts",
      csvEscapeCases: [
        "NVDA", 187.5, 0, null, undefined, "", "Acme, Inc", 'Say "Holdings" Co',
        "Line1\nLine2", "Carriage\rReturn", "Ünïcode ✓", "trailing,", ",leading",
      ].map((v) => csvEscape(v as any)),
      screen: {
        standoutsCsv: [SCREEN_RUN, SCREEN_PARTIAL, SCREEN_EMPTY_ALL_SECTOR].map(screenStandoutsCsv),
        allStocksCsv: [SCREEN_RUN, SCREEN_PARTIAL, SCREEN_EMPTY_ALL_SECTOR].map(screenAllStocksCsv),
        runJson: [SCREEN_RUN, SCREEN_PARTIAL].map(screenRunJson),
        filenames: [SCREEN_RUN, SCREEN_PARTIAL, SCREEN_EMPTY_ALL_SECTOR, SCREEN_BAD_TIMESTAMP].map((run) => ({
          standouts: screenExportFilename(run, "standouts"),
          allStocks: screenExportFilename(run, "all-stocks"),
          runJson: screenExportFilename(run, "run-json"),
        })),
      },
      scan: {
        storedFitRun: JSON.parse(JSON.stringify(scanExportRunFromStored(SCAN_STORED_FIT))),
        liveFitRun: JSON.parse(JSON.stringify(scanExportRunFromResult(SCAN_LIVE_RESPONSE))),
        resultsCsv: [
          scanResultsCsv(scanExportRunFromStored(SCAN_STORED_FIT)),
          scanResultsCsv(scanExportRunFromResult(SCAN_LIVE_RESPONSE)),
          scanResultsCsv(scanExportRunFromStored(SCAN_STORED_PER_NAME)),
          scanResultsCsv(scanExportRunFromStored(SCAN_EMPTY_FITS)),
        ],
        runJson: [
          scanRunJson(scanExportRunFromStored(SCAN_STORED_FIT)),
          scanRunJson(scanExportRunFromResult(SCAN_LIVE_RESPONSE)),
          scanRunJson(scanExportRunFromStored(SCAN_STORED_PER_NAME)),
          scanRunJson(scanExportRunFromStored(SCAN_EMPTY_FITS)),
        ],
        filenames: [SCAN_STORED_FIT, SCAN_STORED_PER_NAME, SCAN_EMPTY_FITS].map((stored) => {
          const run = scanExportRunFromStored(stored);
          return {
            resultsCsv: scanExportFilename(run, "results-csv"),
            runJson: scanExportFilename(run, "run-json"),
          };
        }),
      },
      discovery: {
        candidatesCsv: [DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map(discoveryCandidatesCsv),
        runJson: [DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map(discoveryRunJson),
        hasCandidates: [DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map(discoveryRunHasCandidates),
        triggerLabels: [DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map(discoveryTriggerLabel),
        constraintLines: (DISCOVERY_NOVIEW.constraintSets ?? []).map(formatConstraintSetLine),
        filenames: [DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map((run) => ({
          candidatesCsv: discoveryExportFilename(run, "candidates-csv"),
          runJson: discoveryExportFilename(run, "run-json"),
        })),
      },
      xls: {},
    };

    // XLS workbooks are binary: pin sha256 + length, and prove the
    // builder is byte-deterministic (two builds, identical hashes)
    // so a hash pin is a true byte-equivalence pin.
    const xlsCases: Record<string, () => Promise<Uint8Array>> = {
      rawPlain: () => createRawOptionsIdeasXls(XLS_RAW_PLAIN),
      rawGrouped: () => createRawOptionsIdeasXls(XLS_RAW_GROUPED),
      report: () => createOptionsIdeasReportXls(XLS_REPORT),
      reportMinimal: () => createOptionsIdeasReportXls(XLS_REPORT_MINIMAL),
      retrieved: () => createRetrievedOptionsDataXls(XLS_RETRIEVED),
    };
    const xlsGoldens: Record<string, { sha256: string; length: number }> = {};
    for (const [name, build] of Object.entries(xlsCases)) {
      const first = await build();
      const second = await build();
      expect(sha256(second), `XLS builder ${name} is not byte-deterministic`).toBe(sha256(first));
      xlsGoldens[name] = { sha256: sha256(first), length: first.length };
    }
    goldens.xls = xlsGoldens;

    writeFileSync(
      join(process.cwd(), "tests/run_export_goldens.json"),
      JSON.stringify(goldens, null, 2) + "\n",
    );
  });
});
