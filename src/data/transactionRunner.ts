/**
 * src/data/transactionRunner.ts — #2337 (#1976 step 2): the
 * aspect-backed TransactionRunner (ADR 0022 D-C).
 *
 * SERVER-ONLY module: it imports the transaction aspect
 * (node:async_hooks). It is imported by the worker entry
 * (src/server.ts) and by tests — never by a module reachable
 * from the client bundle. Consumers resolve the runner
 * through transactionRunnerProvider.ts.
 */
import {
  doSqlTransactionBackend,
  withTransaction,
  type DoTransactionStorage,
  type TransactionContext,
} from "../aspects/transactionAspect";
import type { TransactionRunner } from "./transactionRunnerProvider";

function run<T>(
  storage: DoTransactionStorage,
  context: TransactionContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withTransaction(doSqlTransactionBackend(storage), context, () => fn());
}

function runSyncUnit<T>(
  storage: DoTransactionStorage,
  context: TransactionContext,
  fn: () => T,
): T {
  // The DO leg of withTransaction executes its closure
  // synchronously inside transactionSync, so a failure can be
  // captured inside the closure and rethrown synchronously —
  // the synchronous surface keeps its throw contract, and the
  // unit still rolls back as one (the aspect sees the throw).
  let failure: unknown;
  let captured = false;
  let result: T | undefined;
  void withTransaction(doSqlTransactionBackend(storage), context, () => {
    try {
      result = fn();
    } catch (err) {
      captured = true;
      failure = err;
      throw err;
    }
  }).catch(() => { /* the failure was captured synchronously above */ });
  if (captured) throw failure;
  return result as T;
}

/** The production runner: units of work over the DO backend. */
export const aspectTransactionRunner: TransactionRunner = { run, runSyncUnit };
