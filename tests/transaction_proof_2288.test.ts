// @vitest-environment node
/**
 * Issue #2288 (#1976 step 0) — ADR 0022 D-C.5 PRIMITIVE PROOF.
 *
 * The ADR's transaction contract rests on two primitives with
 * zero usages in this codebase: DO `storage.transactionSync`
 * and D1 `batch()`. These pins are the experiment: they assert
 * the DOCUMENTED semantics of both primitives through the
 * transaction aspect (src/aspects/transactionAspect.ts), against
 * the repo's node:sqlite test doubles.
 *
 * FIDELITY — what these pins can and cannot prove (ADR D-C.5
 * caveat, stated plainly):
 *  - The DO double below implements the transactionSync
 *    contract over node:sqlite (closure runs synchronously; a
 *    throw rolls back every write in the closure; a return
 *    commits). It proves the aspect and its DO backend USE the
 *    primitive correctly — commit, rollback, nested join,
 *    honest refusal. It CANNOT detect the real
 *    DurableObjectStorage facade deviating from the contract
 *    the double implements; that residual proof runs only under
 *    workerd (tests/workers/, #2348). These pins pin the
 *    double's contract, and the control block below proves
 *    they would go RED if the primitive stopped honouring it.
 *
 * DOUBLE CORRECTION (#2455, §7 disclosure): at step 0 this
 * double modelled transactionSync as invoking its closure
 * WITH a transaction object carrying sql — a misreading of
 * the documented contract, which the aspect then implemented
 * too, so the pins proved the aspect against its own
 * assumption. The workerd proof (#2348, divergence D-1)
 * observed the real facade: the closure is invoked with NO
 * argument, and the storage's own sql handle, used inside the
 * closure, is the transaction-scoped handle. The double below
 * now implements THAT shape, and the aspect is fixed to match
 * (#2455), so these pins pin the true contract.
 *  - The D1 double's batch() implements D1's documented batch
 *    contract (one call; all-or-nothing). Per the issue, the
 *    D1 leg is pinned against BATCH semantics, never against
 *    interactive-transaction semantics — D1 has no interactive
 *    transactions, and db.transaction() is not used anywhere
 *    here (sequential BEGIN/COMMIT; migrationRunner header).
 *
 * MUTATION EVIDENCE: the "control" describe block runs the same
 * rollback expectation against a sabotaged primitive (a
 * transactionSync that runs the closure with NO transaction)
 * and asserts the write SURVIVES — i.e. the real pins' rollback
 * assertions fail against a lying primitive. A primitive stub
 * cannot pass this suite silently.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  withTransaction,
  doSqlTransactionBackend,
  d1BatchTransactionBackend,
  type TransactionOutcome,
} from "../src/aspects/transactionAspect";
import {
  DataFoundationCode,
  DataFoundationError,
} from "../src/aspects/errorCodes";

/* ------------------------------------------------------------------ */
/* Doubles                                                             */
/* ------------------------------------------------------------------ */

/**
 * DO storage double over node:sqlite: a `sql` handle plus a
 * `transactionSync` implementing the real facade's shape
 * (#2455): the closure is invoked with NO argument; writes
 * through the storage's own sql inside the closure are the
 * transaction's writes.
 */
class MockDoStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly sql = {
    exec: (query: string, ...params: unknown[]) => this.execSql(query, params),
  };

  private execSql(query: string, params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*SELECT/i.test(query)) {
      const rows = stmt.all(...(params as any[]));
      return {
        toArray: () => rows,
        rowsRead: rows.length,
        rowsWritten: 0,
      };
    }
    const info = stmt.run(...(params as any[]));
    return { toArray: () => [], rowsRead: 0, rowsWritten: info.changes };
  }

  transactionSync<T>(closure: () => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Sabotaged primitive for the control block: no transaction at all. */
class LyingDoStorage extends MockDoStorage {
  override transactionSync<T>(closure: () => T): T {
    return closure();
  }
}

/**
 * A primitive that misbehaves before the unit starts: it
 * throws a bare, non-catalog error WITHOUT ever invoking the
 * closure. The aspect must surface the typed refusal, never
 * the primitive's bare error (#2455).
 */
class ExplodingDoStorage extends MockDoStorage {
  override transactionSync<T>(_closure: () => T): T {
    throw new Error("primitive exploded before the closure");
  }
}

/**
 * A primitive that refuses in the catalog's own terms before
 * invoking the closure: its typed error must propagate
 * unchanged (#2455).
 */
class RefusingDoStorage extends MockDoStorage {
  override transactionSync<T>(_closure: () => T): T {
    throw new DataFoundationError(
      DataFoundationCode.TX_CANNOT_HONOUR,
      "test double: the store cannot honour a unit of work",
    );
  }
}

/** D1 double over node:sqlite, in the data_foundation_slice0 shape. */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  batchCalls = 0;
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    this.batchCalls += 1;
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

function outcomeRecorder() {
  const outcomes: TransactionOutcome[] = [];
  return {
    outcomes,
    emit: (o: TransactionOutcome) => outcomes.push(o),
  };
}

function doRows(storage: MockDoStorage, table: string): unknown[] {
  return storage.sql.exec(`SELECT * FROM ${table}`).toArray();
}

function d1Rows(d1: MockD1Database, table: string): unknown[] {
  return d1.sqlite.prepare(`SELECT * FROM ${table}`).all();
}

/* ------------------------------------------------------------------ */
/* DO leg                                                              */
/* ------------------------------------------------------------------ */

describe("#2288 proof — DO leg (transactionSync through the SDK-shaped facade)", () => {
  function makeStorage() {
    const storage = new MockDoStorage();
    storage.sql.exec(
      "CREATE TABLE proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
    return storage;
  }

  it("commits a wrapped multi-write atomically: every row lands", async () => {
    const storage = makeStorage();
    const rec = outcomeRecorder();
    const backend = doSqlTransactionBackend(storage as any);
    const result = await withTransaction(
      backend,
      { operationName: "proof.do.commit", emit: rec.emit },
      (unit) => {
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "first");
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "b", "second");
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(doRows(storage, "proof_items")).toHaveLength(2);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_COMMITTED,
    ]);
  });

  it("rolls back a wrapped multi-write fully when the wrapped call throws", async () => {
    const storage = makeStorage();
    const rec = outcomeRecorder();
    const backend = doSqlTransactionBackend(storage as any);
    const boom = new Error("wrapped call failed");
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.do.rollback", emit: rec.emit },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "doomed");
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(doRows(storage, "proof_items")).toHaveLength(0);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_ROLLED_BACK,
    ]);
  });

  it("nested calls join the ambient unit: one outcome, one atomic whole", async () => {
    const storage = makeStorage();
    const outer = outcomeRecorder();
    const inner = outcomeRecorder();
    const backend = doSqlTransactionBackend(storage as any);
    await withTransaction(
      backend,
      { operationName: "proof.do.outer", emit: outer.emit },
      // The DO leg's wrapped call is synchronous (transactionSync
      // contract): the nested call executes synchronously against
      // the ambient unit during the closure.
      (unit) => {
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
        void withTransaction(
          backend,
          { operationName: "proof.do.inner", emit: inner.emit },
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
    expect(doRows(storage, "proof_items")).toHaveLength(2);
    // Only the outermost unit emits; the joined call emits nothing.
    expect(outer.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_COMMITTED,
    ]);
    expect(inner.outcomes).toHaveLength(0);
  });

  it("a synchronous throw by the wrapped call rolls back nested (joined) writes too", async () => {
    const storage = makeStorage();
    const backend = doSqlTransactionBackend(storage as any);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.do.outer-throw" },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
          void withTransaction(
            backend,
            { operationName: "proof.do.inner-throw" },
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
      ),
    ).rejects.toThrow("outer failed after nested write");
    expect(doRows(storage, "proof_items")).toHaveLength(0);
  });

  it("refuses honestly when the storage has no transactionSync: nothing runs, nothing is written", async () => {
    const rec = outcomeRecorder();
    const backend = doSqlTransactionBackend({} as any);
    const fn = vi.fn();
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.do.no-primitive", emit: rec.emit },
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

  it("refuses with the typed error when transactionSync throws before invoking the closure: nothing runs (#2455)", async () => {
    const storage = new ExplodingDoStorage();
    storage.sql.exec(
      "CREATE TABLE proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
    const rec = outcomeRecorder();
    const backend = doSqlTransactionBackend(storage as any);
    const fn = vi.fn();
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.do.exploding-primitive", emit: rec.emit },
        fn,
      ),
    ).rejects.toMatchObject({
      name: "DataFoundationError",
      code: DataFoundationCode.TX_CANNOT_HONOUR,
    });
    // The rejection is the aspect's typed error (the primitive's
    // text survives only as context inside its message), never
    // the primitive's bare Error itself.
    const rejection: unknown = await withTransaction(
      backend,
      { operationName: "proof.do.exploding-primitive" },
      fn,
    ).catch((err: unknown) => err);
    expect(rejection).toBeInstanceOf(DataFoundationError);
    expect(rejection).not.toBeInstanceOf(TypeError);
    expect(fn).not.toHaveBeenCalled();
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_CANNOT_HONOUR,
    ]);
  });

  it("propagates the primitive's own catalog refusal unchanged (#2455)", async () => {
    const storage = new RefusingDoStorage();
    const backend = doSqlTransactionBackend(storage as any);
    const fn = vi.fn();
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.do.refusing-primitive" },
        fn,
      ),
    ).rejects.toMatchObject({
      name: "DataFoundationError",
      code: DataFoundationCode.TX_CANNOT_HONOUR,
      message: "test double: the store cannot honour a unit of work",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses an async wrapped call on the DO leg and rolls back its synchronous writes", async () => {
    const storage = makeStorage();
    const backend = doSqlTransactionBackend(storage as any);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.do.async" },
        async (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "sync-part");
          await Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({ code: DataFoundationCode.TX_CANNOT_HONOUR });
    expect(doRows(storage, "proof_items")).toHaveLength(0);
  });

  it("refuses a nested unit on a DIFFERENT backend (cross-store units are not claimed)", async () => {
    const d1 = new MockD1Database();
    d1.sqlite.exec(
      "CREATE TABLE proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
    const storage = makeStorage();
    const doBackend = doSqlTransactionBackend(storage as any);
    const d1Backend = d1BatchTransactionBackend(d1 as any);
    await expect(
      withTransaction(
        d1Backend,
        { operationName: "proof.cross.outer" },
        async (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
          await withTransaction(
            doBackend,
            { operationName: "proof.cross.inner" },
            () => undefined,
          );
        },
      ),
    ).rejects.toMatchObject({ code: DataFoundationCode.TX_CANNOT_HONOUR });
    // The refusal propagated out of the outer unit: its buffered
    // write was discarded, never batched.
    expect(d1.batchCalls).toBe(0);
    expect(d1Rows(d1, "proof_items")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* D1 leg                                                              */
/* ------------------------------------------------------------------ */

describe("#2288 proof — D1 leg (batch semantics, never db.transaction)", () => {
  function makeD1() {
    const d1 = new MockD1Database();
    d1.sqlite.exec(
      "CREATE TABLE proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
    return d1;
  }

  it("commits a wrapped multi-write through ONE batch() call: every row lands", async () => {
    const d1 = makeD1();
    const rec = outcomeRecorder();
    const backend = d1BatchTransactionBackend(d1 as any);
    await withTransaction(
      backend,
      { operationName: "proof.d1.commit", emit: rec.emit },
      (unit) => {
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "first");
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "b", "second");
      },
    );
    expect(d1.batchCalls).toBe(1);
    expect(d1Rows(d1, "proof_items")).toHaveLength(2);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_COMMITTED,
    ]);
  });

  it("rolls back on throw by never sending the batch: nothing lands, batch is never called", async () => {
    const d1 = makeD1();
    const rec = outcomeRecorder();
    const backend = d1BatchTransactionBackend(d1 as any);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.d1.rollback", emit: rec.emit },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "doomed");
          throw new Error("wrapped call failed");
        },
      ),
    ).rejects.toThrow("wrapped call failed");
    expect(d1.batchCalls).toBe(0);
    expect(d1Rows(d1, "proof_items")).toHaveLength(0);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_ROLLED_BACK,
    ]);
  });

  it("batch applies all-or-nothing: a failing statement leaves no partial writes", async () => {
    const d1 = makeD1();
    d1.sqlite.exec("INSERT INTO proof_items (id, note) VALUES ('x', 'pre-existing')");
    const backend = d1BatchTransactionBackend(d1 as any);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.d1.batch-atomic" },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "new");
          // PK conflict with the pre-existing row: the batch must fail whole.
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "x", "conflict");
        },
      ),
    ).rejects.toThrow();
    const rows = d1Rows(d1, "proof_items") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["x"]);
  });

  it("an awaited nested failure propagates and rolls back the whole ambient unit", async () => {
    const d1 = makeD1();
    const rec = outcomeRecorder();
    const backend = d1BatchTransactionBackend(d1 as any);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.d1.outer-throw", emit: rec.emit },
        async (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
          await withTransaction(
            backend,
            { operationName: "proof.d1.inner-throw" },
            () => {
              throw new Error("inner failed");
            },
          );
        },
      ),
    ).rejects.toThrow("inner failed");
    expect(d1.batchCalls).toBe(0);
    expect(d1Rows(d1, "proof_items")).toHaveLength(0);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_ROLLED_BACK,
    ]);
  });

  it("nested calls join the ambient unit on the D1 leg too: still one batch", async () => {
    const d1 = makeD1();
    const backend = d1BatchTransactionBackend(d1 as any);
    await withTransaction(
      backend,
      { operationName: "proof.d1.outer" },
      async (unit) => {
        unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "outer");
        await withTransaction(
          backend,
          { operationName: "proof.d1.inner" },
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
    expect(d1.batchCalls).toBe(1);
    expect(d1Rows(d1, "proof_items")).toHaveLength(2);
  });

  it("refuses honestly when the client has no batch(): nothing runs", async () => {
    const rec = outcomeRecorder();
    const backend = d1BatchTransactionBackend({ prepare: () => ({ bind: () => ({}) }) } as any);
    const fn = vi.fn();
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.d1.no-batch", emit: rec.emit },
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

describe("#2288 proof — control: the rollback pins go red against a stubbed primitive", () => {
  it("a transactionSync stubbed to run without a transaction leaves the doomed write in place", async () => {
    const storage = new LyingDoStorage();
    storage.sql.exec(
      "CREATE TABLE proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
    const backend = doSqlTransactionBackend(storage as any);
    await expect(
      withTransaction(
        backend,
        { operationName: "proof.control.lying" },
        (unit) => {
          unit.exec("INSERT INTO proof_items (id, note) VALUES (?, ?)", "a", "should-have-rolled-back");
          throw new Error("wrapped call failed");
        },
      ),
    ).rejects.toThrow("wrapped call failed");
    // Against the honest primitive this row count is 0 (the pin
    // above). Against the lying one the write survives — which
    // is exactly what makes the real rollback pin a proof and
    // not a tautology.
    expect(doRows(storage, "proof_items")).toHaveLength(1);
  });

  it("the cannot-honour error is a typed catalog error, never a bare string", () => {
    const err = new DataFoundationError(DataFoundationCode.TX_CANNOT_HONOUR);
    expect(err.code).toBe("DATA_TX_CANNOT_HONOUR");
    expect(err.toJSON().code).toBe("DATA_TX_CANNOT_HONOUR");
  });
});
