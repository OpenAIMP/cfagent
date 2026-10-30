/**
 * Issue #2361 (#1976 step 4e) — composition root for the
 * ResearchAgent-private store family. This is the ONLY module
 * that maps a host's storage handle to the family's production
 * implementations: the agent imports this helper and the port
 * types, never a store client. It replaces the agent's
 * hand-rolled facade shim (a hand-built `{ exec }` wrapper over
 * ctx.storage.sql plus a dead DatabaseORM construction).
 *
 * The four tables live in the research instance's own storage;
 * each port is served by its own DO adapter over the shared
 * handle (one owner per table, ADR 0022 D-A). Construction
 * executes NOTHING — the family's DDL runs only through the
 * ports' ensureSchema, and only for these agent-private tables
 * (the R-7 invariant: the shared ORM schema is never touched).
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapters); client-reachable modules must import the port
 * TYPES from researchStorePorts.ts (type-only, erased at
 * compile time), never this root.
 */
import {
  DoSqliteResearchEvaluationStore,
  DoSqliteResearchRunStore,
  DoSqliteResearchSettingsStore,
  DoSqliteResearchTaskStore,
} from "./doSqliteResearchStoreAdapter";
import {
  InMemoryResearchEvaluationStore,
  InMemoryResearchRunStore,
  InMemoryResearchSettingsStore,
  InMemoryResearchTaskStore,
} from "./inMemoryResearchStoreAdapters";
import type {
  ResearchStorePorts,
  ResearchStoreSqlExecutor,
} from "./researchStorePorts";

function aggregate(
  settings: ResearchStorePorts["settings"],
  tasks: ResearchStorePorts["tasks"],
  runs: ResearchStorePorts["runs"],
  evaluations: ResearchStorePorts["evaluations"]
): ResearchStorePorts {
  return {
    settings,
    tasks,
    runs,
    evaluations,
    ensureSchema(): void {
      // The legacy ensureTables order: settings, runs,
      // evaluations, task store.
      settings.ensureSchema();
      runs.ensureSchema();
      evaluations.ensureSchema();
      tasks.ensureSchema();
    },
  };
}

/** Compose the family's ports over a host's DO storage. */
export function createResearchStorePorts(
  sql: ResearchStoreSqlExecutor
): ResearchStorePorts {
  return aggregate(
    new DoSqliteResearchSettingsStore(sql),
    new DoSqliteResearchTaskStore(sql),
    new DoSqliteResearchRunStore(sql),
    new DoSqliteResearchEvaluationStore(sql)
  );
}

/** Compose the family's in-memory ports (test doubles). */
export function createInMemoryResearchStorePorts(): ResearchStorePorts {
  return aggregate(
    new InMemoryResearchSettingsStore(),
    new InMemoryResearchTaskStore(),
    new InMemoryResearchRunStore(),
    new InMemoryResearchEvaluationStore()
  );
}
