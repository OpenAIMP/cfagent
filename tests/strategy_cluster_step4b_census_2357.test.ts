// @vitest-environment node
/**
 * #2357 (#1976 step 4b) — strategy-cluster family census pin.
 *
 * The five cluster service modules hold ZERO storage-shaped
 * exec sites (they serve through the ports), and the family's
 * statements live in the data layer at exact counts. This is
 * the family-level companion to the global D-D pin
 * (tests/global_dd_census_2356.test.ts), whose allow-list and
 * by-table writer sets the parent updates with this slice's
 * deltas at ship time:
 *
 *  - Surface 1: the five service files leave the allow-list;
 *    the above-layer total drops 192 → 144 (exactly the
 *    family's 48).
 *  - In-layer: doSqliteStrategyWeightsAdapter 12,
 *    doSqliteStrategyPolicyAdapter 11, doSqliteChallengerAdapter
 *    15, doSqliteAdaptationAuditAdapter 5,
 *    doSqliteReselectionAdapter 3 (= 46; the remaining 2 of the
 *    family's 48 are adaptationAudit's mas_settings reads,
 *    which move onto the pre-existing step-3a settings-read
 *    adapter in doSqliteOrmAdapters.ts — its count is
 *    unchanged, the SELECT already lived there).
 *    #2390 (step 4g) update: the weights adapter drops to 11
 *    (= 45 in-layer) — its mas_settings CREATE retired to the
 *    dedicated settings port's adapter under the G-7 ruling;
 *    the statement lives on in the layer, outside this family.
 *  - By-table: the cluster's tables (mas_challengers,
 *    mas_challenger_approvals, mas_challenger_promotions,
 *    mas_strategy_bank_active, mas_strategy_weights_v2,
 *    mas_strategy_weight_versions, mas_strategy_weight_caps,
 *    mas_strategy_gates, mas_strategy_bank_proposals,
 *    mas_adaptation_audit) gain writer sets naming exactly
 *    their DO adapters (plus the pre-existing read-through in
 *    doSqliteScreeningActivityAdapter for
 *    mas_challenger_promotions — a SELECT, not a writer — and
 *    mas_settings' G-7 DDL-ensurer set changes
 *    strategyWeightsV2.ts → doSqliteStrategyWeightsAdapter.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STORAGE_EXEC_PATTERN =
  /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;

function countIn(file: string): number {
  return (readFileSync(file, "utf8").match(STORAGE_EXEC_PATTERN) ?? []).length;
}

const SERVICE_FILES = [
  "src/services/championChallenger.ts",
  "src/services/strategyWeightsV2.ts",
  "src/services/strategyPolicyState.ts",
  "src/services/strategyBankReselection.ts",
  "src/services/adaptationAudit.ts",
] as const;

const DATA_LAYER_FILES: Array<[string, number]> = [
  // 12 at 4b; 11 since #2390 (step 4g): the adapter's
  // mas_settings CREATE retired — the dedicated settings
  // port's adapter is that table's single ensurer (G-7).
  ["src/data/doSqliteStrategyWeightsAdapter.ts", 11],
  ["src/data/doSqliteStrategyPolicyAdapter.ts", 11],
  ["src/data/doSqliteChallengerAdapter.ts", 15],
  ["src/data/doSqliteAdaptationAuditAdapter.ts", 5],
  ["src/data/doSqliteReselectionAdapter.ts", 3],
  ["src/data/inMemoryStrategyWeightsAdapter.ts", 0],
  ["src/data/inMemoryStrategyPolicyAdapter.ts", 0],
  ["src/data/inMemoryChallengerAdapter.ts", 0],
  ["src/data/inMemoryAdaptationAuditAdapter.ts", 0],
  ["src/data/inMemoryReselectionAdapter.ts", 0],
  ["src/data/strategyWeightsPorts.ts", 0],
  ["src/data/strategyPolicyPorts.ts", 0],
  ["src/data/challengerPorts.ts", 0],
  ["src/data/adaptationAuditPorts.ts", 0],
  ["src/data/reselectionPorts.ts", 0],
  ["src/data/createStrategyClusterPorts.ts", 0],
];

describe("step-4b family census: services serve through the ports", () => {
  for (const file of SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites`, () => {
      expect(countIn(file)).toBe(0);
    });
  }
  for (const [file, sites] of DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(file)).toBe(sites);
    });
  }

  it("the family total is conserved: 45 in the new adapters + 2 settings reads on the 3a adapter (+1 settings CREATE retired to the settings adapter in #2390)", () => {
    const inLayer = DATA_LAYER_FILES.reduce((a, [, n]) => a + n, 0);
    expect(inLayer).toBe(45);
  });
});
