/**
 * Issue #2348 (#1976 step-0 residual) — WORKERD-LEVEL PROOF of
 * the transaction primitives.
 *
 * Step 0 (#2288) proved that the transaction aspect
 * (src/aspects/transactionAspect.ts) USES the documented
 * contracts of DO storage.transactionSync and D1 batch()
 * correctly — against node:sqlite doubles that implement those
 * contracts by construction. The residual this suite closes:
 * the doubles cannot detect the REAL workerd facades deviating
 * from the documented contracts. This suite re-runs the decisive
 * step-0 pins against the real facades, inside workerd:
 *
 *  - DO leg: scenarios execute inside a real Durable Object
 *    (tests/workers/proof-worker.ts, TxProofDurableObject)
 *    against its genuine DurableObjectStorage — real
 *    transactionSync closure semantics, real SQLite storage.
 *  - D1 leg: scenarios run here against a real D1 binding
 *    (TX_PROOF_DB, local Miniflare D1). A counting pass-through
 *    wrapper observes batch() invocations (the pin step 0
 *    asserted on its double as batchCalls) without altering the
 *    statements or their execution.
 *  - Cross-backend refusal runs inside the DO, the one place
 *    both real backends share an ambient unit.
 *
 * Run with: npm run test:workers (vitest.workers.config.mts).
 * The default suite never sees this file: it carries a
 * .workers.ts suffix under tests/workers/, outside the default
 * include pattern, and it needs the workerd runtime (it imports
 * cloudflare:test) — it would fail under Node by design.
 *
 * DIVERGENCES (contract-as-documented vs facade-as-observed):
 *
 *  D-1 (DO leg, BLOCKING — the proof's headline finding):
 *  the aspect's DoTransactionStorage models transactionSync as
 *  invoking its closure WITH a transaction object carrying sql
 *  (closure: (txn: { sql }) => T) — the shape the step-0 double
 *  implements. The real facade invokes the closure with NO
 *  argument (observed argCount 0; @cloudflare/workers-types
 *  declares transactionSync<T>(closure: () => T): T). Inside
 *  the closure, the storage's own sql is the transaction-scoped
 *  handle. Consequence: DoSqlTransactionBackend.execute reads
 *  txn.sql on an undefined argument and throws a bare TypeError
 *  on EVERY real-facade call. The throw happens inside the
 *  closure, so the transaction rolls back — nothing is ever
 *  corrupted — but no DO-leg unit can commit through the aspect
 *  against the real facade, and the failure is not the typed
 *  catalog error. Every production wrap routed through
 *  src/data/transactionRunner.ts (the DO SQLite adapters,
 *  including the step-3b champion/challenger promotion wrap)
 *  is affected. The five aspect DO-leg pins below are therefore
 *  marked it.fails: they assert the correct contract, they fail
 *  today for exactly this reason, and they turn red again the
 *  moment a corrective fix makes them pass — remove the markers
 *  in that change. Per #2348's scope the aspect is NOT fixed
 *  here; the divergence is the deliverable.
 *
 *  NOT divergences, proven against the real facades:
 *  - D1 leg: every pin green. batch() is all-or-nothing, the
 *    buffered unit is discarded unsent on throw, nested joins
 *    share one batch. The documented D1 contract is the real
 *    one.
 *  - Async-closure behaviour: the real transactionSync ACCEPTS
 *    a promise-returning closure, returns the promise, and
 *    commits the synchronous writes (observed). The aspect's
 *    async refusal is its own thenable check inside the
 *    closure, not a facade behaviour — the header contract in
 *    transactionAspect.ts already describes it that way, and
 *    the strategy remains implementable on the real facade.
 *  - Ambient joins: AsyncLocalStorage propagation is proven
 *    inside a Durable Object isolate by the cross-backend pin
 *    (the refusal can only fire if the inner call found the
 *    outer call's ambient unit) and in the test isolate by the
 *    D1 nested pins.
 *
 *  OBSERVABILITY substitutions in this port (not divergences):
 *  1. Step 0 asserted the cross-backend refusal via the D1
 *     double's batchCalls === 0. batch() invocations cannot be
 *     counted on the real facade from inside a Durable Object,
 *     so the workerd pin asserts the observable equivalent:
 *     zero rows landed in the real D1 table.
 *  2. Step 0's "storage has no transactionSync" refusal pin has
 *     no real-facade counterpart (a real DurableObjectStorage
 *     always exposes the primitive); it is kept below as an
 *     aspect-level parity pin against an empty object, exactly
 *     as in step 0, and is not evidence about the facade.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  withTransaction,
  doSqlTransactionBackend,
  d1BatchTransactionBackend,
  type TransactionOutcome,
} from "../../src/aspects/transactionAspect";
import {
  DataFoundationCode,
  DataFoundationError,
} from "../../src/aspects/errorCodes";
import type { TxProofDurableObject } from "./proof-worker";

interface TxProofEnv {
  TX_PROOF_DO: DurableObjectNamespace<TxProofDurableObject>;
  TX_PROOF_DB: D1Database;
}

const testEnv = env as unknown as TxProofEnv;

interface ProofRow {
  id: string;
  note: string;
}

function proofStub(name: string) {
  return testEnv.TX_PROOF_DO.get(testEnv.TX_PROOF_DO.idFromName(name));
}

function outcomeRecorder() {
  const outcomes: TransactionOutcome[] = [];
  return {
    outcomes,
    emit: (o: TransactionOutcome) => outcomes.push(o),
  };
}

/**
 * Pass-through facade over the REAL D1 binding that only counts
 * batch() invocations. prepare() returns the real statements;
 * batch() forwards the real statements to the real batch. The
 * atomicity under test is entirely the real D1's.
 */
function countingD1(real: D1Database) {
  let batchCalls = 0;
  const facade = {
    prepare: (query: string) => real.prepare(query),
    batch: (statements: unknown[]) => {
      batchCalls += 1;
      return real.batch(statements as D1PreparedStatement[]);
    },
  };
  return { facade, batchCalls: () => batchCalls };
}

async function resetD1(): Promise<void> {
  await testEnv.TX_PROOF_DB.exec("DELETE FROM proof_items");
}

async function d1Rows(): Promise<ProofRow[]> {
  const res = await testEnv.TX_PROOF_DB.prepare(
    "SELECT id, note FROM proof_items ORDER BY id",
  ).all<ProofRow>();
  return res.results;
}

beforeAll(async () => {
  await testEnv.TX_PROOF_DB.exec(
    "CREATE TABLE IF NOT EXISTS proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
  );
});

/* ------------------------------------------------------------------ */
/* DO leg — real DurableObjectStorage.transactionSync                  */
/* ------------------------------------------------------------------ */

describe("#2348 proof (workerd) — DO leg against the real transactionSync facade", () => {
  it.fails("commits a wrapped multi-write atomically: every row lands — DIVERGES on the real facade (header D-1)", async () => {
    const res = await proofStub("do-commit").doCommit();
    expect(res.result).toBe("done");
    expect(res.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(res.outcomes).toEqual([DataFoundationCode.TX_COMMITTED]);
  });

  it.fails("rolls back a wrapped multi-write fully when the wrapped call throws — DIVERGES on the real facade (header D-1)", async () => {
    const res = await proofStub("do-rollback").doRollbackOnThrow();
    expect(res.errorMessage).toBe("wrapped call failed");
    expect(res.rows).toHaveLength(0);
    expect(res.outcomes).toEqual([DataFoundationCode.TX_ROLLED_BACK]);
  });

  it.fails("refuses an async wrapped call on the DO leg and rolls back its synchronous writes — DIVERGES on the real facade (header D-1)", async () => {
    const res = await proofStub("do-async-refusal").doAsyncRefusal();
    expect(res.errorName).toBe("DataFoundationError");
    expect(res.errorCode).toBe(DataFoundationCode.TX_CANNOT_HONOUR);
    expect(res.rows).toHaveLength(0);
    expect(res.outcomes).toEqual([DataFoundationCode.TX_CANNOT_HONOUR]);
  });

  it.fails("nested calls join the ambient unit: one outcome, one atomic whole — DIVERGES on the real facade (header D-1)", async () => {
    const res = await proofStub("do-nested-join").doNestedJoin();
    expect(res.result).toBe("done");
    expect(res.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(res.outcomes).toEqual([DataFoundationCode.TX_COMMITTED]);
    expect(res.innerOutcomes).toEqual([]);
  });

  it.fails("a synchronous throw by the wrapped call rolls back nested (joined) writes too — DIVERGES on the real facade (header D-1)", async () => {
    const res = await proofStub("do-nested-throw").doNestedThrow();
    expect(res.errorMessage).toBe("outer failed after nested write");
    expect(res.rows).toHaveLength(0);
  });

  it("refuses a nested unit on a DIFFERENT backend (cross-store units are not claimed)", async () => {
    await resetD1();
    const res = await proofStub("do-cross-backend").doCrossBackendRefusal();
    expect(res.errorName).toBe("DataFoundationError");
    expect(res.errorCode).toBe(DataFoundationCode.TX_CANNOT_HONOUR);
    expect(res.outcomes).toEqual([DataFoundationCode.TX_CANNOT_HONOUR]);
    // The outer D1 unit's buffered write never landed: the
    // observable equivalent of step 0's batchCalls === 0.
    expect(res.d1Rows).toEqual([]);
    expect(await d1Rows()).toEqual([]);
  });

  it("refuses honestly when the storage has no transactionSync: nothing runs, nothing is written (aspect parity, not a facade pin)", async () => {
    const rec = outcomeRecorder();
    const backend = doSqlTransactionBackend({} as never);
    const fn = vi.fn();
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.workerd.do.no-primitive", emit: rec.emit },
        fn,
      ),
    ).rejects.toMatchObject({
      name: "DataFoundationError",
      code: DataFoundationCode.TX_CANNOT_HONOUR,
    });
    expect(fn).not.toHaveBeenCalled();
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_CANNOT_HONOUR,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The real transactionSync facade itself — no aspect. These pins      */
/* record the primitive's observed contract (header D-1): the shape    */
/* a corrective fix to the aspect's DO leg must be built against.      */
/* ------------------------------------------------------------------ */

describe("#2348 proof (workerd) — the real transactionSync facade, directly", () => {
  it("invokes the closure with NO argument: the storage's own sql is the transaction handle (header D-1)", async () => {
    const res = await proofStub("facade-arg-shape").facadeArgShape();
    expect(res.argCount).toBe(0);
    expect(res.firstArgType).toBe("none");
  });

  it("commits writes made through storage.sql inside the closure", async () => {
    const res = await proofStub("facade-commit").facadeCommit();
    expect(res.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("rolls back fully when the closure throws, and propagates the closure's own error", async () => {
    const res = await proofStub("facade-rollback").facadeRollbackOnThrow();
    expect(res.errorName).toBe("Error");
    expect(res.errorMessage).toBe("facade wrapped call failed");
    expect(res.rows).toHaveLength(0);
  });

  it("accepts a promise-returning closure: returns the promise and commits the synchronous writes (the aspect's async refusal is its own guard, not the facade's)", async () => {
    const res = await proofStub("facade-async-closure").facadeAsyncClosure();
    expect(res.errorMessage).toBeUndefined();
    expect(res.returnedType).toBe("promise");
    expect(res.rows.map((r) => r.id)).toEqual(["a"]);
  });
});

/* ------------------------------------------------------------------ */
/* D1 leg — real D1 batch()                                            */
/* ------------------------------------------------------------------ */

describe("#2348 proof (workerd) — D1 leg against the real batch() facade", () => {
  it("commits a wrapped multi-write through ONE batch() call: every row lands", async () => {
    await resetD1();
    const rec = outcomeRecorder();
    const d1 = countingD1(testEnv.TX_PROOF_DB);
    const backend = d1BatchTransactionBackend(d1.facade);
    await withTransaction(
      backend,
      { operationName: "proof.workerd.d1.commit", emit: rec.emit },
      (unit) => {
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "first");
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "b", "second");
      },
    );
    expect(d1.batchCalls()).toBe(1);
    expect((await d1Rows()).map((r) => r.id)).toEqual(["a", "b"]);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_COMMITTED,
    ]);
  });

  it("rolls back on throw by never sending the batch: nothing lands, batch is never called", async () => {
    await resetD1();
    const rec = outcomeRecorder();
    const d1 = countingD1(testEnv.TX_PROOF_DB);
    const backend = d1BatchTransactionBackend(d1.facade);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.workerd.d1.rollback", emit: rec.emit },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "doomed");
          throw new Error("wrapped call failed");
        },
      ),
    ).rejects.toThrow("wrapped call failed");
    expect(d1.batchCalls()).toBe(0);
    expect(await d1Rows()).toHaveLength(0);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_ROLLED_BACK,
    ]);
  });

  it("batch applies all-or-nothing: a failing statement leaves no partial writes", async () => {
    await resetD1();
    await testEnv.TX_PROOF_DB.exec(
      "INSERT INTO proof_items (id, note) VALUES ('x', 'pre-existing')",
    );
    const d1 = countingD1(testEnv.TX_PROOF_DB);
    const backend = d1BatchTransactionBackend(d1.facade);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.workerd.d1.batch-atomic" },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "new");
          // PK conflict with the pre-existing row: the batch must fail whole.
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "x", "conflict");
        },
      ),
    ).rejects.toThrow();
    expect((await d1Rows()).map((r) => r.id)).toEqual(["x"]);
  });

  it("an awaited nested failure propagates and rolls back the whole ambient unit", async () => {
    await resetD1();
    const rec = outcomeRecorder();
    const d1 = countingD1(testEnv.TX_PROOF_DB);
    const backend = d1BatchTransactionBackend(d1.facade);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.workerd.d1.outer-throw", emit: rec.emit },
        async (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
          await withTransaction(
            backend,
            { operationName: "proof.workerd.d1.inner-throw" },
            () => {
              throw new Error("inner failed");
            },
          );
        },
      ),
    ).rejects.toThrow("inner failed");
    expect(d1.batchCalls()).toBe(0);
    expect(await d1Rows()).toHaveLength(0);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_ROLLED_BACK,
    ]);
  });

  it("nested calls join the ambient unit on the D1 leg too: still one batch", async () => {
    await resetD1();
    const d1 = countingD1(testEnv.TX_PROOF_DB);
    const backend = d1BatchTransactionBackend(d1.facade);
    await withTransaction(
      backend,
      { operationName: "proof.workerd.d1.outer" },
      async (unit) => {
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
        await withTransaction(
          backend,
          { operationName: "proof.workerd.d1.inner" },
          (innerUnit) => {
            innerUnit.exec(
              "INSERT INTO proof_items (id, note) VALUES (?, ?)",
              "b",
              "inner",
            );
          },
        );
      },
    );
    expect(d1.batchCalls()).toBe(1);
    expect((await d1Rows()).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("refuses honestly when the client has no batch(): nothing runs (aspect parity, not a facade pin)", async () => {
    const rec = outcomeRecorder();
    const backend = d1BatchTransactionBackend({
      prepare: () => ({ bind: () => ({}) }),
    } as never);
    const fn = vi.fn();
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.workerd.d1.no-batch", emit: rec.emit },
        fn,
      ),
    ).rejects.toMatchObject({
      name: "DataFoundationError",
      code: DataFoundationCode.TX_CANNOT_HONOUR,
    });
    expect(fn).not.toHaveBeenCalled();
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_CANNOT_HONOUR,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Control — the pins detect a lying primitive (mutation evidence)     */
/* ------------------------------------------------------------------ */

describe("#2348 proof (workerd) — control: the pins go red against a lying primitive", () => {
  it("a transactionSync stubbed to run without a transaction leaves the doomed write in place (real DO storage)", async () => {
    const res = await proofStub("do-control-lying").doControlLying();
    expect(res.errorMessage).toBe("wrapped call failed");
    // Against the honest facade this count is 0 (the rollback pin
    // above). Against the lying one the write survives — which is
    // exactly what makes the real rollback pin a proof and not a
    // tautology, in workerd too.
    expect(res.rows).toHaveLength(1);
  });

  it("a batch() stubbed to apply statements one-by-one leaves the partial write the atomicity pin forbids (real D1)", async () => {
    await resetD1();
    await testEnv.TX_PROOF_DB.exec(
      "INSERT INTO proof_items (id, note) VALUES ('x', 'pre-existing')",
    );
    const real = testEnv.TX_PROOF_DB;
    const lying = {
      prepare: (query: string) => real.prepare(query),
      batch: async (statements: unknown[]) => {
        const results: unknown[] = [];
        for (const stmt of statements as D1PreparedStatement[]) {
          try {
            results.push(await stmt.run());
          } catch {
            // The lie: swallow the failure and keep what applied.
          }
        }
        return results;
      },
    };
    const backend = d1BatchTransactionBackend(lying);
    await withTransaction(
      backend,
      { operationName: "proof.workerd.control.lying-batch" },
      (unit) => {
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "new");
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "x", "conflict");
      },
    );
    // The honest facade rejects the batch and leaves only 'x'
    // (the atomicity pin above). The lying one resolves and 'a'
    // survives — the pin would go red against it.
    expect((await d1Rows()).map((r) => r.id)).toEqual(["a", "x"]);
  });

  it("the cannot-honour error is a typed catalog error, never a bare string", () => {
    const err = new DataFoundationError(DataFoundationCode.TX_CANNOT_HONOUR);
    expect(err.code).toBe("DATA_TX_CANNOT_HONOUR");
    expect(err.toJSON().code).toBe("DATA_TX_CANNOT_HONOUR");
  });
});

