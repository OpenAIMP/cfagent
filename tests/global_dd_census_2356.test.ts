// @vitest-environment node
/**
 * #2356 (#1976 step 4c) — the GLOBAL D-D census pin (ADR 0022
 * D-D.2, mandated warn-first and never landed until this
 * slice; audit R-4).
 *
 * Three surfaces are counted over ALL of src/:
 *
 *  1. storage-shaped exec sites (the landed pins' pattern)
 *     ABOVE the data layer — pinned as an exact, shrink-only
 *     allow-list: every remaining file with its site count
 *     and its owning slice. A NEW above-layer site, a new
 *     file, or a count change in either direction fails.
 *  2. `(x as any).exec(` sites above the layer — same
 *     treatment (the landed pins were blind to this surface).
 *  3. D1 `prepare()` sites outside src/data/ — same
 *     treatment (never counted by any prior census).
 *
 * Plus the by-table rule (the R-2/R-3 lesson — file-list
 * pins let writers of already-ported tables survive in
 * unlisted files): for every table ported in steps 1–3 or
 * in this slice, the pin detects the table's WRITER SET
 * (INSERT / UPDATE / DELETE / CREATE TABLE / CREATE INDEX
 * statements naming the table, directly or through a
 * same-file or imported table-name constant, comments
 * stripped) across all of src/ and pins it exactly. A
 * writer of a ported table outside its port fails the pin
 * WHEREVER the file lives. Known bypasses of OTHER slices'
 * tables are named allow-list entries with owners — they
 * are not fixed here and they are not silently passed.
 *
 * And the G-7 remainder (audit §5): mas_settings is NOT
 * ported; its value-writer set (4 modules) and DDL-ensurer
 * set (3 modules) are pinned exactly so a fifth writer
 * fails the pin until the G-7 ruling lands.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_FILES: string[] = [];
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".ts")) SRC_FILES.push(path);
  }
}
walk("src");
const TEXT = new Map(SRC_FILES.map((f) => [f, readFileSync(f, "utf8")]));

/** Strip // and block comments while respecting string literals. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let mode: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1] ?? "";
    if (mode === "line") {
      if (c === "\n") { mode = null; out += c; } else out += " ";
      i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = null; out += "  "; i += 2; }
      else { out += c === "\n" ? "\n" : " "; i++; }
      continue;
    }
    if (mode) {
      out += c;
      if (c === "\\") { out += n; i += 2; continue; }
      if (c === mode) mode = null;
      i++; continue;
    }
    if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
    if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") mode = c;
    out += c; i++;
  }
  return out;
}
const STRIPPED = new Map(SRC_FILES.map((f) => [f, stripComments(TEXT.get(f)!)]));
const isAboveLayer = (f: string): boolean => !f.startsWith("src/data/");

const STORAGE_EXEC_PATTERN =
  /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;
const ANY_EXEC_PATTERN = /\(\s*[\w.[\]]+\s+as\s+any\s*\)\s*\.\s*exec\s*\(/g;
const PREPARE_PATTERN = /\.prepare\s*\(/g;

const countIn = (pattern: RegExp, file: string): number =>
  (TEXT.get(file)!.match(pattern) ?? []).length;

function aboveLayerCounts(pattern: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of SRC_FILES) {
    if (!isAboveLayer(f)) continue;
    const n = countIn(pattern, f);
    if (n > 0) out.set(f, n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Surface 1 — storage-shaped sites above the layer (shrink-only allow-list)
// ---------------------------------------------------------------------------

/** [file, sites, owner] — every entry retires only in its owner's slice. */
const STORAGE_ALLOW_LIST: Array<[string, number, string]> = [
  ["src/services/scheduledReports.ts", 24, "#2359 step 4d (canonical-report write port)"],
  ["src/agents/orchestrator/asyncJobs.ts", 23, "#2358 step 4a"],
  ["src/agents/research-agent.ts", 21, "#2361 step 4e"],
  ["src/agents/orchestrator.ts", 19, "#2359 step 4d"],
  ["src/agents/routes/payments.ts", 8, "#2360 step 4d-2"],
  ["src/agents/orchestrator/reportDispatch.ts", 7, "#2359 step 4d (confirmations) + G-7 (settings pair)"],
  ["src/services/learnings.ts", 7, "R-1 gated — NOT step 4c (two-host question open)"],
  ["src/agents/routes/maintenance.ts", 6, "#2358 step 4a (maintenance port)"],
  ["src/agents/routes/screenerPresets.ts", 4, "#2359 step 4d"],
  ["src/services/screeningFlags.ts", 4, "G-7 (mas_settings)"],
  ["src/agents/orchestrator/autopilot.ts", 3, "#2359 step 4d"],
  ["src/agents/routes/reports.ts", 3, "#2359 step 4d"],
  ["src/security/sessionStore.ts", 2, "step 5 (SessionStore / kv_store)"],
  ["src/services/masRetentionIndexes.ts", 2, "#2362 step 4f"],
  ["src/actors/cfAgentsAdapter.ts", 1, "permanent — Agents-SDK shim (ADR-out)"],
  ["src/agentic/chainExecutor.ts", 1, "#2358 step 4a (read overlay over the read port)"],
  ["src/agents/orchestrator/chatTurnHelpers.ts", 1, "#2359 step 4d"],
  ["src/agents/routes/autopilot.ts", 1, "#2359 step 4d"],
  ["src/agents/routes/workflowRuns.ts", 1, "#2358 step 4a"],
  ["src/agents/screener-agent.ts", 1, "#2361 step 4e"],
  ["src/services/asyncJobGate.ts", 1, "#2358 step 4a"],
  ["src/services/frameworkQueueIndexes.ts", 1, "#2362 step 4f"],
  ["src/services/reportSemanticIndex.ts", 1, "#2359 step 4d"],
  ["src/services/screenerPresetResolution.ts", 1, "#2359 step 4d"],
  ["src/services/shardJobs.ts", 1, "#2358 step 4a"],
];

/** The step-4c families: zero above-layer sites remain. */
const STEP4C_SERVICE_FILES = [
  "src/services/goalScenarioStore.ts",
  "src/services/jobOutcomes.ts",
  "src/services/strategyReviews.ts",
  "src/services/outcomeTracking.ts",
  "src/services/screeningActivity.ts",
  "src/services/comparisonRunner.ts",
  "src/services/recommendationKernel.ts",
  "src/services/reflection.ts",
] as const;

/** The step-4c statements live in the data layer, exactly. */
const STEP4C_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/doSqliteGoalScenarioAdapter.ts", 18],
  ["src/data/doSqliteJobOutcomeAdapter.ts", 12],
  ["src/data/doSqliteStrategyReviewAdapter.ts", 6],
  ["src/data/doSqliteOutcomeTrackingAdapter.ts", 3],
  ["src/data/doSqliteComparisonLedgerAdapter.ts", 4],
  ["src/data/doSqliteScreeningActivityAdapter.ts", 5],
  ["src/data/inMemoryGoalScenarioAdapter.ts", 0],
  ["src/data/inMemoryJobOutcomeAdapter.ts", 0],
  ["src/data/inMemoryStrategyReviewAdapter.ts", 0],
  ["src/data/inMemoryOutcomeTrackingAdapter.ts", 0],
  ["src/data/inMemoryComparisonLedgerAdapter.ts", 0],
  ["src/data/inMemoryScreeningActivityAdapter.ts", 0],
  ["src/data/goalScenarioPorts.ts", 0],
  ["src/data/jobOutcomePorts.ts", 0],
  ["src/data/strategyReviewPorts.ts", 0],
  ["src/data/outcomeTrackingPorts.ts", 0],
  ["src/data/comparisonLedgerPorts.ts", 0],
  ["src/data/screeningActivityPorts.ts", 0],
  ["src/data/createEvidenceSatellitePorts.ts", 0],
];

/** The step-4b families: zero above-layer sites remain. */
const STEP4B_SERVICE_FILES = [
  "src/services/championChallenger.ts",
  "src/services/strategyWeightsV2.ts",
  "src/services/strategyPolicyState.ts",
  "src/services/adaptationAudit.ts",
  "src/services/strategyBankReselection.ts",
] as const;

/** The step-4b statements live in the data layer, exactly.
 *  (Adaptation's two mas_settings SELECTs are served by the
 *  step-3a read-only settings adapter, counted there.) */
const STEP4B_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/doSqliteChallengerAdapter.ts", 15],
  ["src/data/doSqliteStrategyWeightsAdapter.ts", 12],
  ["src/data/doSqliteStrategyPolicyAdapter.ts", 11],
  ["src/data/doSqliteAdaptationAuditAdapter.ts", 5],
  ["src/data/doSqliteReselectionAdapter.ts", 3],
  ["src/data/inMemoryChallengerAdapter.ts", 0],
  ["src/data/inMemoryStrategyWeightsAdapter.ts", 0],
  ["src/data/inMemoryStrategyPolicyAdapter.ts", 0],
  ["src/data/inMemoryAdaptationAuditAdapter.ts", 0],
  ["src/data/inMemoryReselectionAdapter.ts", 0],
  ["src/data/challengerPorts.ts", 0],
  ["src/data/strategyWeightsPorts.ts", 0],
  ["src/data/strategyPolicyPorts.ts", 0],
  ["src/data/adaptationAuditPorts.ts", 0],
  ["src/data/reselectionPorts.ts", 0],
  ["src/data/createStrategyClusterPorts.ts", 0],
];

describe("global D-D census: surface 1 — storage-shaped sites above the layer", () => {
  it("the above-layer population is exactly the shrink-only allow-list", () => {
    const actual = aboveLayerCounts(STORAGE_EXEC_PATTERN);
    const expected = new Map(STORAGE_ALLOW_LIST.map(([f, n]) => [f, n]));
    expect(actual).toEqual(expected);
    const total = [...actual.values()].reduce((a, b) => a + b, 0);
    // Base (7c985ca0) measured 240; step 4c retires exactly 48
    // (the six families minus learnings' 7, which is R-1-gated)
    // → 192; step 4b (#2357) retires the strategy cluster's 48
    // → 144.
    expect(total).toBe(144);
  });

  for (const file of STEP4C_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4C_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(sites);
    });
  }

  for (const file of STEP4B_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4B_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(sites);
    });
  }
});

// ---------------------------------------------------------------------------
// Surface 2 — (x as any).exec sites above the layer
// ---------------------------------------------------------------------------

const ANY_EXEC_ALLOW_LIST: Array<[string, number, string]> = [
  ["src/agents/research-agent.ts", 1, "#2361 step 4e (facade shim)"],
  ["src/agents/screener-agent.ts", 1, "#2361 step 4e (facade shim)"],
  ["src/services/scheduledTasks.ts", 1, "#2358 step 4a (async-job gate probe)"],
];

describe("global D-D census: surface 2 — (x as any).exec above the layer", () => {
  it("the population is exactly the allow-list", () => {
    const actual = aboveLayerCounts(ANY_EXEC_PATTERN);
    const expected = new Map(ANY_EXEC_ALLOW_LIST.map(([f, n]) => [f, n]));
    expect(actual).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Surface 3 — D1 prepare() sites outside src/data/
// ---------------------------------------------------------------------------

const PREPARE_ALLOW_LIST: Array<[string, number, string]> = [
  ["src/aspects/transactionAspect.ts", 1, "permanent — the aspect's own D1 leg, in-role"],
  ["src/services/quoteSourceSetting.ts", 3, "#2362 step 4f"],
  ["src/telemetry/d1ResourceUsageAdapter.ts", 3, "#2362 step 4f"],
  ["src/telemetry/resourceRollupStore.ts", 8, "#2362 step 4f"],
];

describe("global D-D census: surface 3 — prepare() outside the data layer", () => {
  it("the population is exactly the allow-list", () => {
    const actual = new Map<string, number>();
    for (const f of SRC_FILES) {
      if (!isAboveLayer(f)) continue;
      const n = countIn(PREPARE_PATTERN, f);
      if (n > 0) actual.set(f, n);
    }
    const expected = new Map(PREPARE_ALLOW_LIST.map(([f, n]) => [f, n]));
    expect(actual).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// By-table writer sets for ported tables (steps 1–3 + step 4c + step 4b)
// ---------------------------------------------------------------------------

const PORTED_TABLES = [
  // step 1
  "mas_data_providers", "mas_data_provider_routes", "mas_data_captures",
  // step 2
  "mas_opportunity_scans", "mas_discovery_runs", "mas_discovery_setup_runs",
  "mas_discovery_alerts", "mas_iv_history", "mas_strategy_profiles",
  "mas_feed_snapshots", "paused_schedules", "mas_enrichment_runs",
  // step 3a (+ marketplace)
  "mas_messages", "mas_events", "mas_memory", "mas_watchlists",
  "mas_transactions", "mas_trades", "mas_categories", "mas_external_ads",
  "mas_ads", "mas_referrals", "webhook_replay_nonces",
  "mas_options_chain_cache", "mas_reports",
  // step 4c (this slice)
  "mas_goals", "mas_scenarios", "mas_outcomes", "mas_job_outcomes",
  "mas_job_outcomes_meta", "mas_strategy_reviews", "mas_outcome_tracking",
  "mas_comparison_arm_outcomes", "mas_screening_activity",
  // step 4b (#2357)
  "mas_challengers", "mas_challenger_approvals", "mas_challenger_promotions",
  "mas_strategy_bank_active", "mas_strategy_weights_v2",
  "mas_strategy_weight_versions", "mas_strategy_weight_caps",
  "mas_strategy_gates", "mas_strategy_bank_proposals", "mas_adaptation_audit",
] as const;

/**
 * The pinned writer set per ported table: the layer files that
 * own the writes, plus NAMED bypass entries (above-layer
 * writers owned by later slices — audit R-2/R-3). A writer
 * appearing anywhere else fails the pin.
 */
const PORTED_TABLE_WRITERS: Record<string, { layer: string[]; bypass?: Record<string, string> }> = {
  mas_data_providers: { layer: ["src/data/doSqliteProviderConfigAdapter.ts"] },
  mas_data_provider_routes: { layer: ["src/data/doSqliteProviderConfigAdapter.ts"] },
  mas_data_captures: { layer: ["src/data/doSqliteProviderCaptureAdapter.ts"] },
  mas_opportunity_scans: { layer: ["src/data/doSqliteScanRunAdapter.ts"] },
  mas_discovery_runs: { layer: ["src/data/doSqliteDiscoveryRunAdapter.ts"] },
  mas_discovery_setup_runs: { layer: ["src/data/doSqliteDiscoverySetupAdapter.ts"] },
  mas_discovery_alerts: { layer: ["src/data/doSqliteDiscoveryAlertAdapter.ts"] },
  mas_iv_history: { layer: ["src/data/doSqliteIvHistoryAdapter.ts"] },
  mas_strategy_profiles: { layer: ["src/data/doSqliteStrategyProfileAdapter.ts"] },
  mas_feed_snapshots: { layer: ["src/data/doSqliteFeedSnapshotAdapter.ts"] },
  paused_schedules: {
    layer: ["src/data/doSqlitePausedScheduleAdapter.ts"],
    bypass: { "src/agents/routes/maintenance.ts": "#2358 step 4a (maintenance port)" },
  },
  mas_enrichment_runs: { layer: ["src/data/doSqliteEnrichmentAdapter.ts"] },
  mas_messages: {
    layer: ["src/data/doSqliteOrmAdapters.ts", "src/data/ormSchema.ts"],
    bypass: {
      "src/agents/orchestrator.ts": "#2359 step 4d (recordMessage bypass, audit R-3)",
      "src/services/masRetentionIndexes.ts": "#2362 step 4f (index helper into the layer)",
    },
  },
  mas_events: {
    layer: ["src/data/ormSchema.ts"],
    bypass: {
      "src/services/masRetentionIndexes.ts": "#2362 step 4f (index helper into the layer)",
    },
  },
  mas_memory: { layer: ["src/data/doSqliteOrmAdapters.ts", "src/data/ormSchema.ts"] },
  mas_watchlists: { layer: ["src/data/ormSchema.ts"] },
  mas_transactions: {
    layer: ["src/data/doSqliteOrmAdapters.ts", "src/data/ormSchema.ts"],
    bypass: {
      "src/agents/routes/payments.ts": "#2360 step 4d-2 (audit R-2)",
      "src/agents/orchestrator.ts": "#2359 step 4d (seed DELETEs)",
    },
  },
  mas_trades: { layer: ["src/data/ormFacade.ts"] },
  mas_categories: { layer: ["src/data/ormFacade.ts"] },
  mas_external_ads: { layer: ["src/data/ormFacade.ts"] },
  mas_ads: {
    layer: ["src/data/doSqliteMarketplaceAdapter.ts", "src/data/ormSchema.ts"],
    bypass: {
      "src/agents/orchestrator.ts": "#2359 step 4d (seed INSERT)",
    },
  },
  mas_referrals: { layer: ["src/data/ormSchema.ts"] },
  webhook_replay_nonces: { layer: ["src/data/ormFacade.ts"] },
  mas_options_chain_cache: { layer: ["src/data/ormFacade.ts"] },
  mas_reports: {
    layer: [],
    bypass: {
      "src/services/scheduledReports.ts": "#2359 step 4d (canonical-report WRITE port — 3c ported the read/outcome side only)",
    },
  },
  mas_goals: { layer: ["src/data/doSqliteGoalScenarioAdapter.ts"] },
  mas_scenarios: { layer: ["src/data/doSqliteGoalScenarioAdapter.ts"] },
  mas_outcomes: { layer: ["src/data/doSqliteGoalScenarioAdapter.ts"] },
  mas_job_outcomes: {
    layer: ["src/data/doSqliteJobOutcomeAdapter.ts"],
    bypass: {
      "src/agents/routes/maintenance.ts": "#2358 step 4a (maintenance port; the meta watermark is deliberately preserved by that clear)",
    },
  },
  mas_job_outcomes_meta: { layer: ["src/data/doSqliteJobOutcomeAdapter.ts"] },
  mas_strategy_reviews: { layer: ["src/data/doSqliteStrategyReviewAdapter.ts"] },
  mas_outcome_tracking: { layer: ["src/data/doSqliteOutcomeTrackingAdapter.ts"] },
  mas_comparison_arm_outcomes: { layer: ["src/data/doSqliteComparisonLedgerAdapter.ts"] },
  mas_screening_activity: { layer: ["src/data/doSqliteScreeningActivityAdapter.ts"] },
  mas_challengers: { layer: ["src/data/doSqliteChallengerAdapter.ts"] },
  mas_challenger_approvals: { layer: ["src/data/doSqliteChallengerAdapter.ts"] },
  mas_challenger_promotions: { layer: ["src/data/doSqliteChallengerAdapter.ts"] },
  mas_strategy_bank_active: { layer: ["src/data/doSqliteChallengerAdapter.ts"] },
  mas_strategy_weights_v2: { layer: ["src/data/doSqliteStrategyWeightsAdapter.ts"] },
  mas_strategy_weight_versions: { layer: ["src/data/doSqliteStrategyWeightsAdapter.ts"] },
  mas_strategy_weight_caps: { layer: ["src/data/doSqliteStrategyPolicyAdapter.ts"] },
  mas_strategy_gates: { layer: ["src/data/doSqliteStrategyPolicyAdapter.ts"] },
  mas_strategy_bank_proposals: { layer: ["src/data/doSqliteReselectionAdapter.ts"] },
  mas_adaptation_audit: { layer: ["src/data/doSqliteAdaptationAuditAdapter.ts"] },
};

const WRITE_VERB =
  "(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM|CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?[^;]*?ON)";

/** Table-name constants (name -> table) for imported consts;
 *  short ambiguous names (bare TABLE) resolve per-file only. */
const GLOBAL_CONSTANTS = new Map<string, string>();
for (const text of STRIPPED.values()) {
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*"([a-z_0-9]+)"/g)) {
    if ((PORTED_TABLES as readonly string[]).includes(m[2]) && m[1].length > 5) {
      GLOBAL_CONSTANTS.set(m[1], m[2]);
    }
  }
}

function fileWritesTable(file: string, table: string): boolean {
  const text = STRIPPED.get(file)!;
  const constants = new Map(GLOBAL_CONSTANTS);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*"([a-z_0-9]+)"/g)) {
    if ((PORTED_TABLES as readonly string[]).includes(m[2])) constants.set(m[1], m[2]);
  }
  const names = [`${table}(?![\\w])`];
  for (const [name, t] of constants) {
    if (t === table) names.push(`\\$\\{${name}\\}`);
  }
  return new RegExp(`${WRITE_VERB}\\s+(?:${names.join("|")})`, "gi").test(text);
}

describe("global D-D census: writer sets by table for ported tables", () => {
  for (const table of PORTED_TABLES) {
    it(`${table} is written only by its port (+ named bypasses)`, () => {
      const expected = PORTED_TABLE_WRITERS[table];
      const allowed = new Set([
        ...expected.layer,
        ...Object.keys(expected.bypass ?? {}),
      ]);
      const actual = SRC_FILES.filter((f) => fileWritesTable(f, table));
      expect(actual.sort()).toEqual([...allowed].sort());
    });
  }
});

// ---------------------------------------------------------------------------
// G-7 remainder — mas_settings writer sets (audit §5.3 recommendation)
// ---------------------------------------------------------------------------

describe("global D-D census: G-7 remainder — mas_settings", () => {
  it("value writers are exactly the four measured modules", () => {
    const re = /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+mas_settings(?![\w])/gi;
    const actual = SRC_FILES.filter((f) => re.test(STRIPPED.get(f)!)).sort();
    expect(actual).toEqual([
      "src/agents/orchestrator/reportDispatch.ts",
      "src/data/doSqliteEnrichmentAdapter.ts",
      "src/data/governedHalt.ts",
      "src/services/screeningFlags.ts",
    ]);
  });

  it("DDL ensurers are exactly the three measured modules", () => {
    const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+mas_settings(?![\w])/gi;
    const actual = SRC_FILES.filter((f) => re.test(STRIPPED.get(f)!)).sort();
    expect(actual).toEqual([
      "src/agents/orchestrator.ts",
      "src/data/doSqliteStrategyWeightsAdapter.ts",
      "src/services/screeningFlags.ts",
    ]);
  });
});
