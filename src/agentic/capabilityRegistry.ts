/**
 * Issue #1395 ([AGENTIC] Phase 1, sub-issue of #1362) — capability
 * registry.
 *
 * One typed definition per capability, read by the planner, the
 * validator, and (later, Phase 5) MCP `tools/list`. Registry ONLY:
 * it does not compile goals (Phase 2), synthesize schedules
 * (Phase 3), or expose MCP tools (Phase 5). It does not duplicate
 * #1355's execution substrate and does not rebuild #1224's executor.
 *
 * Honesty rule (same as the #1070 F1 registry): `shipped` means a
 * test passes, not that an interface exists. Every shipped entry
 * names its verification test file; `tests/capability_registry.test.ts`
 * pins that rule, the worked-example chains, and the known honesty
 * cases. Seeded from the #1362 inventory
 * (~/workspace/cfagent-rsi/agentic-capabilities-inventory.md) and
 * re-verified against the merged tree at implementation time —
 * which corrected two inventory claims:
 *  - CSV generation SHIPS: `src/trading/screenerReportCsv.ts` landed
 *    with #1346 (consumed by #1355 job2.4's generate.csv shard),
 *    after the inventory was written. The inventory's "no CSV
 *    generator — planned" seed is stale and is NOT carried over.
 *  - Channel delivery SHIPS: #1279 merged and #1310 landed as
 *    #1399, so the inventory's in_flight seed is promoted, with
 *    `tests/channel_consolidation.test.ts` as its verification.
 * Still honest: `news` is contract-only (no adapter declares it),
 * vector recall has no referencing test (in_flight, not shipped),
 * and plan-level composition memory SHIPS with #1461 (Phase 4 of
 * #1362) — see the COMPOSITION_MEMORY entry below.
 */

export type RegistryStage =
  | "feed"
  | "generate"
  | "store"
  | "serve"
  | "deliver";

export type RegistryStatus = "shipped" | "in_flight" | "planned";

export interface CapabilityEntry {
  /** Stable id, e.g. `feed-dataprovider`. */
  id: string;
  stage: RegistryStage;
  /** What it does, in one line. */
  capability: string;
  /** Module / route / tool that implements it today. */
  source: string;
  /** Datasets and formats consumed. */
  inputs: string[];
  /** Datasets and formats produced. */
  outputs: string[];
  /** Identifier travelling with the output. */
  provenance: string;
  /** Lane / issue that owns it. */
  owner: string;
  status: RegistryStatus;
  /**
   * Test file reference, or null. REQUIRED before anything is marked
   * shipped: supported means a test passes, not that an interface
   * exists.
   */
  verification: string | null;
}

export const CAPABILITY_REGISTRY: CapabilityEntry[] = [
  // ---- Feed ----
  {
    id: "feed-dataprovider",
    stage: "feed",
    capability:
      "Quotes, options chains, universe screening, historical bars, and fundamentals via the DataProvider contract",
    source: "src/trading/dataProviders/contract.ts (#1118, epic #1116)",
    inputs: ["symbols", "universe definition", "provider credentials"],
    outputs: ["quotes", "options chains", "screened universe", "bars", "fundamentals"],
    provenance: "provider id + symbol",
    owner: "#1118 / #1116",
    status: "shipped",
    verification: "tests/data_provider_platform_p1.test.ts",
  },
  {
    id: "feed-dataprovider-news",
    stage: "feed",
    capability: "News articles via the DataProvider contract",
    source: "src/trading/dataProviders/contract.ts (#1118, epic #1116)",
    inputs: ["symbols"],
    outputs: ["normalized news articles"],
    provenance: "provider id + article id",
    owner: "#1118 / #1116",
    status: "planned",
    // Contract-only: the contract names `news`, but no adapter
    // declares it (contract.ts: "no declaring adapter yet") and no
    // route serves it. Must NOT seed as shipped.
    verification: null,
  },
  {
    id: "feed-screener-pipeline",
    stage: "feed",
    capability: "NASDAQ100 (and universe) screening pipeline producing scored runs",
    source: "src/trading/screenerPipeline.ts (#259, #959)",
    inputs: ["universe", "provider quotes/chains"],
    outputs: ["ScreenerRunResult"],
    provenance: "run id",
    owner: "#259 / #959",
    status: "shipped",
    verification: "tests/screener_pipeline.test.ts",
  },

  // ---- Generate ----
  {
    id: "generate-screener-pdf",
    stage: "generate",
    capability: "Screener run rendered as a stored PDF report",
    source: "src/trading/screenerReportPdf.ts",
    inputs: ["ScreenerRunResult"],
    outputs: ["PDF bytes"],
    provenance: "run id + report key",
    owner: "#259",
    status: "shipped",
    verification: "tests/screener_options_pdf_pipeline.test.ts",
  },
  {
    id: "generate-screener-xlsx",
    stage: "generate",
    capability: "Screener run rendered as a stored XLSX workbook",
    source: "src/trading/screenerReportXlsx.ts",
    inputs: ["ScreenerRunResult"],
    outputs: ["XLSX bytes"],
    provenance: "run id + report key",
    owner: "#259",
    status: "shipped",
    verification: "tests/screener_xlsx_and_sector_enrichment.test.ts",
  },
  {
    id: "generate-screener-csv",
    stage: "generate",
    capability: "Screener run rendered as a stored CSV report",
    source: "src/trading/screenerReportCsv.ts (#1346; consumed by #1355 job2.4)",
    inputs: ["ScreenerRunResult", "OptionScreenResult"],
    outputs: ["CSV bytes"],
    provenance: "run id + report key (screener:csv: / options:csv:)",
    owner: "#1346 / #1355",
    status: "shipped",
    verification: "tests/sharded_jobs_p1355.test.ts",
  },
  {
    id: "generate-options-pdf",
    stage: "generate",
    capability: "Options screen rendered as a stored PDF report",
    source: "src/trading/optionsReportPdf.ts",
    inputs: ["OptionScreenResult"],
    outputs: ["PDF bytes"],
    provenance: "run id + report key",
    owner: "#915",
    status: "shipped",
    verification: "tests/options-pdf-naming.test.ts",
  },
  {
    id: "generate-options-xlsx",
    stage: "generate",
    capability: "Options screen rendered as a stored XLSX workbook",
    source: "src/trading/optionsReportXlsx.ts",
    inputs: ["OptionScreenResult"],
    outputs: ["XLSX bytes"],
    provenance: "run id + report key",
    owner: "#915",
    status: "shipped",
    verification: "tests/options_report_xlsx.test.ts",
  },
  {
    id: "generate-research-pdf",
    stage: "generate",
    capability: "Research output rendered as a stored PDF report",
    source: "src/trading/researchReportPdf.ts",
    inputs: ["research result"],
    outputs: ["PDF bytes"],
    provenance: "run id + report key",
    owner: "research pipeline",
    status: "shipped",
    verification: "tests/research-report-pdf.test.ts",
  },

  // ---- Store ----
  {
    id: "store-mas-reports",
    stage: "store",
    capability: "Canonical report store: every generated report recorded with its key/URL",
    source: "src/services/scheduledReports.ts (storeReportAtGenerationWithR2), mas_reports",
    inputs: ["generated report + metadata"],
    outputs: ["stored report record"],
    provenance: "report id + per-run key",
    owner: "screener program",
    status: "shipped",
    verification: "tests/scheduled-reports.test.ts",
  },
  {
    id: "store-r2-binaries",
    stage: "store",
    capability: "Report binaries in the R2 screener bucket",
    source: "R2 screener bucket via src/services/scheduledReports.ts",
    inputs: ["PDF/XLSX/CSV bytes"],
    outputs: ["R2 object"],
    provenance: "report key",
    owner: "screener program",
    status: "shipped",
    verification: "tests/report_body_r2_s2.test.ts",
  },

  // ---- Serve ----
  {
    id: "serve-options-latest",
    stage: "serve",
    capability: "List completed options runs with their report URLs",
    source: "GET /api/options/latest",
    inputs: ["report key query"],
    outputs: ["run list with reportUrl"],
    provenance: "per-run key",
    owner: "options screener",
    status: "shipped",
    verification: "tests/options_latest_runs.test.ts",
  },
  {
    id: "serve-report-pdf",
    stage: "serve",
    capability: "Serve a stored report PDF by per-run key",
    source: "GET /api/options/report.pdf, GET /api/screener/report.pdf",
    inputs: ["per-run key"],
    outputs: ["PDF bytes"],
    provenance: "per-run key",
    owner: "screener program",
    status: "shipped",
    verification: "tests/scheduled_report_pdf_url.test.ts",
  },

  // ---- Deliver ----
  {
    id: "deliver-slack",
    stage: "deliver",
    capability: "Deliver a stored report to Slack",
    source: "src/events/screenerPublishers.ts (cfpay A2A primary, #951)",
    inputs: ["stored report record"],
    outputs: ["Slack message with report link"],
    provenance: "report id + Slack channel/message id",
    owner: "#951",
    status: "shipped",
    verification: "tests/screener-publishers-pdf.test.ts",
  },
  {
    id: "deliver-email",
    stage: "deliver",
    capability: "Deliver a stored report by email",
    source: "worker EMAIL.send with EMAIL_TO_ALLOWED_DOMAINS",
    inputs: ["stored report record"],
    outputs: ["email with report link"],
    provenance: "report id + recipient",
    owner: "screener program",
    status: "shipped",
    verification: "tests/screener_email_delivery_complete.test.ts",
  },
  {
    id: "deliver-channel",
    stage: "deliver",
    capability:
      "Channel delivery via NLQ: email/Slack/voice with mapped-principal identity, shared approval engine, and signed email links",
    source:
      "src/trading/channels/intake.ts, approval.ts, signedLinks.ts (#1262 Phases 1–5)",
    inputs: ["stored report record", "resolved channel principal"],
    outputs: ["channel message with report link / approval flow"],
    provenance: "report id + channel principal login",
    owner: "#1262",
    status: "shipped",
    verification: "tests/channel_consolidation.test.ts",
  },
];

/**
 * Scheduling substrates. Recorded, NOT decided: #1362 Phase 3 settles
 * which substrate job synthesis targets. A goal today is a cron + ONE
 * operation + a budget, not a plan.
 */
export interface SchedulingSubstrate {
  id: string;
  capability: string;
  source: string;
  decision: string;
}

export const SCHEDULING_SUBSTRATES: SchedulingSubstrate[] = [
  {
    id: "schedule-scheduled-agent",
    capability: "ScheduledAgent DO goals: ScheduledGoal { cron, operation, budgetCents }",
    source: "src/agents/scheduled-agent.ts",
    decision: "Undecided — #1362 Phase 3 decides which substrate job synthesis targets.",
  },
  {
    id: "schedule-nlq-agents-api",
    capability: "NLQ scheduling via the Cloudflare Agents Schedule API",
    source: "src/schedule.ts, src/client/scheduleApi.ts",
    decision: "Undecided — #1362 Phase 3 decides which substrate job synthesis targets.",
  },
];

/**
 * Memory / vector capabilities. Not chain stages, so they live beside
 * the registry rather than inside it. The verification rule applies
 * here too: vector recall is in_flight because no test references
 * src/memory/vector-memory.ts; plan-level composition memory
 * (goal text → plan used → outcome → reuse) does not exist yet.
 */
export interface MemoryEntry {
  id: string;
  capability: string;
  source: string;
  status: RegistryStatus;
  verification: string | null;
}

export const COMPOSITION_MEMORY: MemoryEntry[] = [
  {
    id: "memory-vector-recall",
    capability: "remember(outcome) after every job; recallForPlan(goal) injects up to 8 chunks",
    source: "src/memory/vector-memory.ts",
    status: "in_flight",
    verification: null,
  },
  {
    id: "memory-report-semantic-index",
    capability: "Stored reports embedded at generation time for semantic recall",
    source: "src/services/reportSemanticIndex.ts (#337)",
    status: "shipped",
    verification: "tests/report-semantic-index.test.ts",
  },
  {
    id: "memory-plan-composition",
    capability: "Plan-level composition memory: goal text → plan used → outcome → reuse",
    source: "src/agentic/compositionMemory.ts + src/memory/vector-memory.ts rememberPlan/recallPlans (#1461, Phase 4 of #1362)",
    status: "shipped",
    verification: "tests/composition_memory.test.ts",
  },
];

/** MCP status: ~30 single-capability tools exist; chain/goal tools ship with Phase 5 (#1466). */
export const MCP_CHAIN_STATUS = {
  source: "src/mcps/openaimp/index.ts + commands.ts (per-user cfk_ keys, #180)",
  singleCapabilityTools: "shipped",
  chainTool: "shipped",
  goalTool: "shipped",
} as const;

export interface WorkedExampleStep {
  stage: RegistryStage;
  entryIds: string[];
}

export interface WorkedExample {
  id: string;
  description: string;
  steps: WorkedExampleStep[];
}

/**
 * The registry's first test: #1395's two worked examples, as chains
 * over registry entries. The NASDAQ100 → Slack chain is the full
 * chain, Slack only; yesterday's report by email is serve → deliver
 * only, reusing the stored report with no regeneration.
 */
export const WORKED_EXAMPLES: WorkedExample[] = [
  {
    id: "example-nasdaq100-slack",
    description:
      "NASDAQ100 screen → Slack: full chain, Slack only, budget-capped synthesized schedule requiring owner confirmation before it goes live",
    steps: [
      { stage: "feed", entryIds: ["feed-dataprovider", "feed-screener-pipeline"] },
      {
        stage: "generate",
        entryIds: ["generate-screener-pdf", "generate-screener-xlsx"],
      },
      { stage: "store", entryIds: ["store-mas-reports", "store-r2-binaries"] },
      { stage: "serve", entryIds: ["serve-report-pdf"] },
      { stage: "deliver", entryIds: ["deliver-slack"] },
    ],
  },
  {
    id: "example-yesterday-report-email",
    description:
      "Yesterday's report by email: serve → deliver only, stored report reused, no regeneration",
    steps: [
      { stage: "serve", entryIds: ["serve-options-latest", "serve-report-pdf"] },
      { stage: "deliver", entryIds: ["deliver-email"] },
    ],
  },
];
