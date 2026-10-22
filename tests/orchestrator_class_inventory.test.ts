/**
 * Issue #992: the OrchestratorAgent class-body inventory — standing
 * gate for the #992 decomposition of src/agents/orchestrator.ts.
 *
 * #359's breakup closed at 2,802 lines; two days of feature work
 * regrew the file to 3,427 lines / 148,783 B (tip 57fedf37) because
 * nothing pinned the class body the way thin_router_inventory pins
 * the route dispatcher. #992 extracted 45 methods into eight modules
 * under src/agents/orchestrator/ (scheduleMaintenance,
 * scheduledCallbacks, nlqPorts, asyncJobs, autopilot, reportDispatch,
 * chatTurnHelpers, httpEntry). Subset 2 then extracted the
 * research-publish cluster into a ninth module (researchPublish),
 * leaving the class at 1,977 lines / 89,925 B: state/lifecycle
 * ownership, the Think lifecycle, ensureTables, the stale-task
 * sweep, autonomousOptionsAnalysis and routeRequest stay in the
 * class; the extracted clusters execute only through thin delegating
 * wrappers + the per-module context builders.
 *
 * This pin fails if:
 *  (a) orchestrator.ts grows beyond the post-refactor budget —
 *      BUDGET_LINES / BUDGET_BYTES below (the measured result plus
 *      ~5% headroom; regrowth like the post-#359 +596 lines trips it
 *      immediately);
 *  (b) execution owned by the extracted modules reappears inline in
 *      the class (the INSERT markers and store constructions below),
 *      or new schedule registrations are added inline instead of in
 *      the extracted modules (the this.schedule / this.scheduleEvery
 *      call-site counts are capped at the post-refactor counts:
 *      routeRequest's contexts, the retained arming sites, and the
 *      context builders' binding arrows);
 *  (c) any delegating wrapper disappears from the class — the SDK
 *      dispatches scheduled callbacks by method name, so every name
 *      below must stay declared on the class;
 *  (d) an extracted module loses the execution marker it owns.
 *
 * Deliberate growth updates this pin in the same change (the #359
 * pin rule); the pin's purpose is that class-body regrowth is never
 * unintentional. The one retained inline construction,
 * `new ScheduledTasksService(` for autonomousOptionsAnalysis (count
 * exactly 1), is deliberate: that method is pinned in place by
 * tests/options_latest_runs.test.ts, whose span pin asserts the
 * class-scope call form `recordOptionsRun(this.ctx.storage…`, which
 * the module-call pattern cannot reproduce. The stale-task sweep
 * pair (sweepStaleLedgerTasks / ensureStaleSweepSchedule) is
 * retained for the same reason: tests/stale-sweep-wiring.test.ts
 * asserts the class-scope form
 * `scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS…`. Both clusters stay
 * until those pins are revisited deliberately in a follow-up slice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");
const ORCH = "agents/orchestrator.ts";

/** Post-refactor budget for orchestrator.ts (result: 1,977 lines / 89,925 B). */
const BUDGET_LINES = 2075;
const BUDGET_BYTES = 94_400;

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

const DELEGATED_METHODS = [
  // scheduleMaintenance
  "getScreenerExecutionContext",
  "migrateLegacyScreenSchedules",
  "removeUnownedBaselineSchedules",
  "ensureStrategyScanSchedule",
  // scheduledCallbacks
  "autoRenewETradeTokens",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
  "collectIvHistory",
  "expireStaleOrderDraft",
  "sendScheduledReminder",
  // nlqPorts
  "nlqSchedulingPort",
  "nlqStockScreenPort",
  // asyncJobs
  "submitAsyncJob",
  "recoverQueuedAsyncJobs",
  "getAsyncJob",
  "listAsyncJobs",
  "executeAsyncJob",
  // autopilot
  "marketDateKey",
  "readAutopilotStateRaw",
  "getAutopilotState",
  "writeAutopilotState",
  "incrementAutopilotOrdersToday",
  "fetchBrokerBalanceSnapshot",
  "openNotionalForSymbol",
  "evaluateAndRecordAutopilotVerdict",
  // reportDispatch
  "readSettingRaw",
  "writeSetting",
  "getReportDispatchHitl",
  "setReportDispatchHitl",
  "createReportConfirmation",
  "getReportConfirmation",
  "decideReportConfirmation",
  "storeResearchReportCanonicalAsync",
  "confirmationDeliveryMeta",
  "deliverStoredReportEmail",
  "deliverStoredReportWebhook",
  "persistScreenerReportCanonical",
  "sendReportEmail",
  "sendReportWebhook",
  // chatTurnHelpers
  "extractMessageText",
  "createTurnTools",
  "deriveTurn",
  "assembleGrounding",
  // httpEntry
  "logChatActivity",
  "enqueueHttpRequest",
  // researchPublish
  "runResearchAndPublish",
  "deliverResearchReport",
  "sendResearchSummaryEmail",
];

describe("orchestrator class inventory (#992 standing gate)", () => {
  it("keeps orchestrator.ts within the post-refactor size budget", () => {
    const text = src(ORCH);
    const lineCount =
      text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    expect(lineCount).toBeLessThanOrEqual(BUDGET_LINES);
    expect(statSync(`src/${ORCH}`).size).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("keeps extracted execution out of the class body", () => {
    const text = src(ORCH);
    for (const marker of [
      "INSERT INTO mas_async_jobs",
      "INSERT INTO mas_policy_verdicts",
      "INSERT INTO mas_report_confirmations",
      "INSERT INTO mas_autopilot",
      "INSERT INTO mas_settings",
      "new SqlDiscoveryRunStore(",
      "new SqlIvHistoryStore(",
    ]) {
      expect(count(text, marker), marker).toBe(0);
    }
    // Deliberate retention: autonomousOptionsAnalysis only (see header).
    expect(count(text, "new ScheduledTasksService(")).toBe(1);
  });

  it("caps inline schedule registrations at the post-refactor counts", () => {
    const text = src(ORCH);
    expect(count(text, "this.schedule(")).toBeLessThanOrEqual(6);
    expect(count(text, "this.scheduleEvery(")).toBeLessThanOrEqual(3);
  });

  it("keeps every delegated method declared on the class", () => {
    const text = src(ORCH);
    for (const name of DELEGATED_METHODS) {
      const declared = new RegExp(
        `^  (private )?(async )?${name}\\(`,
        "m",
      ).test(text);
      expect(declared, name).toBe(true);
    }
  });

  it("keeps the extracted modules present with their execution markers", () => {
    expect(src("agents/orchestrator/asyncJobs.ts")).toContain(
      "INSERT INTO mas_async_jobs",
    );
    expect(src("agents/orchestrator/autopilot.ts")).toContain(
      "INSERT INTO mas_policy_verdicts",
    );
    expect(src("agents/orchestrator/reportDispatch.ts")).toContain(
      "INSERT INTO mas_report_confirmations",
    );
    expect(src("agents/orchestrator/scheduledCallbacks.ts")).toContain(
      "new SqlDiscoveryRunStore(",
    );
    expect(src("agents/orchestrator/scheduledCallbacks.ts")).toContain(
      "new SqlIvHistoryStore(",
    );
    expect(src("agents/orchestrator/researchPublish.ts")).toContain(
      "storeReportAtGeneration(",
    );
  });
});
