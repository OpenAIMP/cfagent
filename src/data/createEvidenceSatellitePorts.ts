/**
 * Issue #2356 (#1976 step 4c) — composition root for the
 * evidence-satellite family. This is the ONLY module that
 * maps a host's storage handle to the family's production
 * implementations: domain code imports this helper and the
 * port types, never a store client.
 *
 * The family's hosts hold one handle: the DO sql executor
 * (ctx.storage.sql-shaped). Every adapter executes through
 * it. Outcome tracking composes over the goal/scenario port
 * (its mas_outcomes join), built here from the same handle.
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapters); client-reachable modules must import the port
 * TYPES from the individual *Ports.ts files (type-only,
 * erased at compile time), never this root.
 */
import { DoSqliteComparisonLedgerStore } from "./doSqliteComparisonLedgerAdapter";
import { DoSqliteGoalScenarioStore } from "./doSqliteGoalScenarioAdapter";
import { DoSqliteJobOutcomeStore } from "./doSqliteJobOutcomeAdapter";
import { DoSqliteOutcomeTrackingStore } from "./doSqliteOutcomeTrackingAdapter";
import { DoSqliteScreeningActivityStore } from "./doSqliteScreeningActivityAdapter";
import { DoSqliteStrategyReviewStore } from "./doSqliteStrategyReviewAdapter";
import { InMemoryComparisonLedgerStore } from "./inMemoryComparisonLedgerAdapter";
import { InMemoryGoalScenarioStore } from "./inMemoryGoalScenarioAdapter";
import { InMemoryJobOutcomeStore } from "./inMemoryJobOutcomeAdapter";
import { InMemoryOutcomeTrackingStore } from "./inMemoryOutcomeTrackingAdapter";
import { InMemoryScreeningActivityStore } from "./inMemoryScreeningActivityAdapter";
import { InMemoryStrategyReviewStore } from "./inMemoryStrategyReviewAdapter";
import type { ComparisonLedgerStore } from "./comparisonLedgerPorts";
import type { GoalScenarioSqlExecutor, GoalScenarioStore } from "./goalScenarioPorts";
import type { JobOutcomeStore } from "./jobOutcomePorts";
import type { OutcomeTrackingStore } from "./outcomeTrackingPorts";
import type { ScreeningActivityStore } from "./screeningActivityPorts";
import type { StrategyReviewStore } from "./strategyReviewPorts";

export interface EvidenceSatellitePorts {
  goals: GoalScenarioStore;
  jobOutcomes: JobOutcomeStore;
  strategyReviews: StrategyReviewStore;
  outcomeTracking: OutcomeTrackingStore;
  comparisonLedger: ComparisonLedgerStore;
  screeningActivity: ScreeningActivityStore;
}

/** Compose the family's ports over a host's DO storage. */
export function createEvidenceSatellitePorts(
  sql: GoalScenarioSqlExecutor,
): EvidenceSatellitePorts {
  const goals = new DoSqliteGoalScenarioStore(sql);
  return {
    goals,
    jobOutcomes: new DoSqliteJobOutcomeStore(sql as never),
    strategyReviews: new DoSqliteStrategyReviewStore(sql),
    outcomeTracking: new DoSqliteOutcomeTrackingStore(sql, goals),
    comparisonLedger: new DoSqliteComparisonLedgerStore(sql),
    screeningActivity: new DoSqliteScreeningActivityStore(sql),
  };
}

/** Compose the family's ports over in-memory adapters (tests). */
export function createInMemoryEvidenceSatellitePorts(): EvidenceSatellitePorts {
  const goals = new InMemoryGoalScenarioStore();
  return {
    goals,
    jobOutcomes: new InMemoryJobOutcomeStore(),
    strategyReviews: new InMemoryStrategyReviewStore(),
    outcomeTracking: new InMemoryOutcomeTrackingStore(goals),
    comparisonLedger: new InMemoryComparisonLedgerStore(),
    screeningActivity: new InMemoryScreeningActivityStore(),
  };
}
