/**
 * Issue #2348 (#1976 step-0 residual) — TEST-ONLY worker entry for
 * the workerd transaction-primitive proof.
 *
 * This file is the `main` of tests/workers/wrangler.test.jsonc,
 * used ONLY by vitest.workers.config.mts (npm run test:workers).
 * It is never deployed: the production worker entry remains
 * src/server.ts (wrangler.jsonc), and nothing in src/ imports this
 * file. It exists so the proof suite can run the transaction
 * aspect (src/aspects/transactionAspect.ts) against the REAL
 * workerd facades — a real Durable Object's storage
 * (transactionSync + sql) and a real D1 binding (batch) — instead
 * of the node:sqlite doubles used by
 * tests/transaction_proof_2288.test.ts.
 *
 * Each RPC method below is one scenario from the step-0 pin set,
 * executed INSIDE the Durable Object against this.ctx.storage
 * (the genuine DurableObjectStorage facade), returning plain
 * JSON-able observations (rows, emitted outcome codes, error
 * shape) for the suite to assert on. The D1-leg scenarios run in
 * the suite itself against the TX_PROOF_DB binding; only the
 * cross-backend refusal scenario needs both backends inside one
 * ambient unit, so it lives here too (a DO receives the worker's
 * bindings via this.env).
 */
import { DurableObject } from "cloudflare:workers";
import {
  withTransaction,
  doSqlTransactionBackend,
  d1BatchTransactionBackend,
  type TransactionOutcome,
} from "../../src/aspects/transactionAspect";

export interface TxProofEnv {
  TX_PROOF_DO: DurableObjectNamespace<TxProofDurableObject>;
  TX_PROOF_DB: D1Database;
}

interface ProofRow {
  id: string;
  note: string;
}

export interface DoScenarioResult {
  result?: string;
  errorName?: string;
  errorCode?: string;
  errorMessage?: string;
  rows: ProofRow[];
  outcomes: string[];
  innerOutcomes?: string[];
  d1Rows?: ProofRow[];
  returnedType?: string;
}

export interface FacadeArgShape {
  argCount: number;
  firstArgType: string;
}

function outcomeRecorder() {
  const outcomes: TransactionOutcome[] = [];
  return {
    outcomes,
    codes: () => outcomes.map((o) => String(o.code)),
    emit: (o: TransactionOutcome) => outcomes.push(o),
  };
}

function errorShape(err: unknown): {
  errorName?: string;
  errorCode?: string;
  errorMessage?: string;
} {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorCode: (err as { code?: unknown }).code as string | undefined,
      errorMessage: err.message,
    };
  }
  return { errorMessage: String(err) };
}

export class TxProofDurableObject extends DurableObject<TxProofEnv> {
  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
  }

  private readRows(): ProofRow[] {
    return this.ctx.storage.sql
      .exec("SELECT id, note FROM proof_items ORDER BY id")
      .toArray() as unknown as ProofRow[];
  }

  private async readD1Rows(): Promise<ProofRow[]> {
    const res = await this.env.TX_PROOF_DB.prepare(
      "SELECT id, note FROM proof_items ORDER BY id",
    ).all<ProofRow>();
    return res.results;
  }

  /** Step-0 pin: DO-leg commit — every row of the unit lands. */
  async doCommit(): Promise<DoScenarioResult> {
    this.ensureTable();
    const rec = outcomeRecorder();
    const backend = doSqlTransactionBackend(this.ctx.storage);
    try {
      const result = await withTransaction(
        backend,
        { operationName: "proof.workerd.do.commit", emit: rec.emit },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "first");
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "b", "second");
          return "done";
        },
      );
      return { result, rows: this.readRows(), outcomes: rec.codes() };
    } catch (err) {
      return { ...errorShape(err), rows: this.readRows(), outcomes: rec.codes() };
    }
  }

  /** Step-0 pin: DO-leg rollback-on-throw — no row of the unit lands. */
  async doRollbackOnThrow(): Promise<DoScenarioResult> {
    this.ensureTable();
    const rec = outcomeRecorder();
    const backend = doSqlTransactionBackend(this.ctx.storage);
    try {
      await withTransaction(
        backend,
        { operationName: "proof.workerd.do.rollback", emit: rec.emit },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "doomed");
          throw new Error("wrapped call failed");
        },
      );
      return { rows: this.readRows(), outcomes: rec.codes() };
    } catch (err) {
      return { ...errorShape(err), rows: this.readRows(), outcomes: rec.codes() };
    }
  }

  /**
   * Step-0 pin: an async wrapped call on the DO leg is refused
   * (TX_CANNOT_HONOUR) and its synchronous writes roll back.
   */
  async doAsyncRefusal(): Promise<DoScenarioResult> {
    this.ensureTable();
    const rec = outcomeRecorder();
    const backend = doSqlTransactionBackend(this.ctx.storage);
    try {
      await withTransaction(
        backend,
        { operationName: "proof.workerd.do.async", emit: rec.emit },
        async (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "sync-part");
          await Promise.resolve();
        },
      );
      return { rows: this.readRows(), outcomes: rec.codes() };
    } catch (err) {
      return { ...errorShape(err), rows: this.readRows(), outcomes: rec.codes() };
    }
  }

  /**
   * Step-0 pin: nested calls join the ambient unit — one atomic
   * whole, and only the outermost unit emits an outcome.
   */
  async doNestedJoin(): Promise<DoScenarioResult> {
    this.ensureTable();
    const outer = outcomeRecorder();
    const inner = outcomeRecorder();
    const backend = doSqlTransactionBackend(this.ctx.storage);
    try {
      const result = await withTransaction(
        backend,
        { operationName: "proof.workerd.do.outer", emit: outer.emit },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
          void withTransaction(
            backend,
            { operationName: "proof.workerd.do.inner", emit: inner.emit },
            (innerUnit) => {
              innerUnit.exec(
                "INSERT INTO proof_items (id, note) VALUES (?, ?)",
                "b",
                "inner",
              );
            },
          );
          return "done";
        },
      );
      return {
        result,
        rows: this.readRows(),
        outcomes: outer.codes(),
        innerOutcomes: inner.codes(),
      };
    } catch (err) {
      return {
        ...errorShape(err),
        rows: this.readRows(),
        outcomes: outer.codes(),
        innerOutcomes: inner.codes(),
      };
    }
  }

  /**
   * Step-0 pin: a synchronous throw by the wrapped call rolls
   * back nested (joined) writes too.
   */
  async doNestedThrow(): Promise<DoScenarioResult> {
    this.ensureTable();
    const backend = doSqlTransactionBackend(this.ctx.storage);
    try {
      await withTransaction(
        backend,
        { operationName: "proof.workerd.do.outer-throw" },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
          void withTransaction(
            backend,
            { operationName: "proof.workerd.do.inner-throw" },
            (innerUnit) => {
              innerUnit.exec(
                "INSERT INTO proof_items (id, note) VALUES (?, ?)",
                "b",
                "inner",
              );
            },
          );
          throw new Error("outer failed after nested write");
        },
      );
      return { rows: this.readRows(), outcomes: [] };
    } catch (err) {
      return { ...errorShape(err), rows: this.readRows(), outcomes: [] };
    }
  }

  /**
   * Step-0 pin: a nested unit naming a DIFFERENT backend is
   * refused (cross-store units are not claimed), and the outer
   * D1 unit's buffered write is discarded — observed here as
   * zero rows in the real D1 table afterwards (the suite cannot
   * count batch() invocations on the real facade from inside
   * the DO; zero landed rows is the observable equivalent of
   * step 0's batchCalls === 0 assertion).
   */
  async doCrossBackendRefusal(): Promise<DoScenarioResult> {
    this.ensureTable();
    const rec = outcomeRecorder();
    const doBackend = doSqlTransactionBackend(this.ctx.storage);
    const d1Backend = d1BatchTransactionBackend(this.env.TX_PROOF_DB);
    try {
      await withTransaction(
        d1Backend,
        { operationName: "proof.workerd.cross.outer", emit: rec.emit },
        async (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
          await withTransaction(
            doBackend,
            { operationName: "proof.workerd.cross.inner" },
            () => undefined,
          );
        },
      );
      return { rows: this.readRows(), outcomes: rec.codes(), d1Rows: await this.readD1Rows() };
    } catch (err) {
      return {
        ...errorShape(err),
        rows: this.readRows(),
        outcomes: rec.codes(),
        d1Rows: await this.readD1Rows(),
      };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Direct facade probes — the real transactionSync, no aspect.     */
  /* These pin the primitive's own contract (the shape a corrective  */
  /* fix to the aspect's DO leg would be built against).             */
  /* ---------------------------------------------------------------- */

  /**
   * What does the real facade pass to the transactionSync
   * closure? (The aspect's DoTransactionStorage modelled a txn
   * argument carrying sql until #2455; this probe observes the
   * truth the fix is built against: no argument at all.)
   */
  async facadeArgShape(): Promise<FacadeArgShape> {
    let argCount = -1;
    let firstArgType = "unset";
    this.ctx.storage.transactionSync(function (
      this: unknown,
      ...args: unknown[]
    ) {
      argCount = args.length;
      firstArgType = args.length === 0 ? "none" : typeof args[0];
    });
    return { argCount, firstArgType };
  }

  /** Facade contract: writes inside the closure commit. */
  async facadeCommit(): Promise<DoScenarioResult> {
    this.ensureTable();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO proof_items (id, note) VALUES (?, ?)",
        "a",
        "first",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO proof_items (id, note) VALUES (?, ?)",
        "b",
        "second",
      );
    });
    return { rows: this.readRows(), outcomes: [] };
  }

  /** Facade contract: a throwing closure rolls back fully. */
  async facadeRollbackOnThrow(): Promise<DoScenarioResult> {
    this.ensureTable();
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO proof_items (id, note) VALUES (?, ?)",
          "a",
          "doomed",
        );
        throw new Error("facade wrapped call failed");
      });
      return { rows: this.readRows(), outcomes: [] };
    } catch (err) {
      return { ...errorShape(err), rows: this.readRows(), outcomes: [] };
    }
  }

  /**
   * Facade contract: what happens when the closure RETURNS a
   * promise (the async-leak question)? Observed, then pinned by
   * the suite: whether transactionSync throws (and rolls back)
   * or accepts the promise (and commits the synchronous part).
   */
  async facadeAsyncClosure(): Promise<DoScenarioResult> {
    this.ensureTable();
    let returnedType = "not-called";
    try {
      const r: unknown = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO proof_items (id, note) VALUES (?, ?)",
          "a",
          "sync-part",
        );
        return Promise.resolve("async-tail");
      });
      returnedType = r instanceof Promise ? "promise" : typeof r;
      return { returnedType, rows: this.readRows(), outcomes: [] };
    } catch (err) {
      return {
        ...errorShape(err),
        returnedType,
        rows: this.readRows(),
        outcomes: [],
      };
    }
  }

  /**
   * CONTROL (mirrors step 0's control block): the same rollback
   * scenario run against a LYING primitive — a transactionSync
   * that runs the closure with no transaction at all, over the
   * real storage sql. The doomed write must SURVIVE. If it did
   * not, the rollback pins above could not distinguish an honest
   * primitive from a lying one, in this environment either.
   */
  async doControlLying(): Promise<DoScenarioResult> {
    this.ensureTable();
    const realSql = this.ctx.storage.sql;
    // Facade-shaped since #2455: the lying primitive exposes
    // the storage's real sql and invokes the closure with no
    // argument — it lies about the TRANSACTION, not the shape.
    const lyingStorage = {
      sql: realSql,
      transactionSync<T>(closure: () => T): T {
        return closure();
      },
    };
    const backend = doSqlTransactionBackend(lyingStorage);
    try {
      await withTransaction(
        backend,
        { operationName: "proof.workerd.control.lying" },
        (unit) => {
          unit.exec(
            "INSERT INTO proof_items (id, note) VALUES (?, ?)",
            "a",
            "should-have-rolled-back",
          );
          throw new Error("wrapped call failed");
        },
      );
      return { rows: this.readRows(), outcomes: [] };
    } catch (err) {
      return { ...errorShape(err), rows: this.readRows(), outcomes: [] };
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("cfagent tx-proof test worker (issue #2348)", {
      status: 200,
    });
  },
};
