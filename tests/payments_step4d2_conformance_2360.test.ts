// @vitest-environment node
/**
 * #2360 (#1976 step 4d-2) — CONFORMANCE for the transaction
 * ledger port's four route transitions (completeWithGateway /
 * rejectWithNote / completeByIdOrGatewayRef / completeById),
 * added when the payments route's raw mas_transactions
 * statements moved behind the step-3a port (audit R-2). The
 * same exercise runs over BOTH adapters (DO-SQLite over a
 * node:sqlite double with real semantics and rowsWritten-
 * faithful cursors, and the in-memory adapter):
 *
 *  - each operation applies EXACTLY its legacy field set —
 *    fields outside the set are byte-identical afterwards;
 *  - the WHERE shapes are the legacy ones: by id; by
 *    id-OR-gateway_ref with the reference bound twice (one
 *    call can match two rows, and the count says so);
 *  - NO status guard was added: a transition over an
 *    already-completed row still matches (count 1) — the
 *    legacy UPDATEs have no status predicate, pinned as
 *    found;
 *  - a missing row matches 0 and writes nothing.
 *
 * #CDO-mha7
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DoSqliteTransactionLedgerAdapter } from "../src/data/doSqliteOrmAdapters";
import { InMemoryTransactionLedgerAdapter } from "../src/data/inMemoryOrmAdapters";
import type { TransactionLedgerPort } from "../src/data/transactionLedgerPorts";
import { SHARED_TABLE_DDL } from "../src/data/ormSchema";
import type { TransactionRecord } from "../src/types";

/** SqlStorage-shaped executor over node:sqlite (real
 *  semantics; write cursors carry rowsWritten like the DO's). */
class SqliteLedgerStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(SHARED_TABLE_DDL.mas_transactions);
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-02T02:02:02.000Z";

const baseRecord = (overrides: Partial<TransactionRecord> = {}): TransactionRecord =>
  ({
    id: "tx1",
    sessionId: "s1",
    action: "charge",
    amount: 200,
    currency: "USD",
    customer: "cust-1",
    gateway: "stripe",
    gatewayRef: "gw-1",
    status: "authorized",
    checkoutUrl: "https://pay.example/tx1",
    proposerDid: "did:ex:proposer",
    authorizerDid: "did:ex:authorizer",
    proofSignature: "sig",
    note: "original note",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }) as TransactionRecord;

function exercise(label: string, fresh: () => TransactionLedgerPort) {
  describe(label, () => {
    it("completeWithGateway applies exactly its field set and returns 1", () => {
      const tx = fresh();
      tx.replace(baseRecord());
      const matched = tx.completeWithGateway("tx1", {
        gatewayRef: "gw-2",
        checkoutUrl: "https://pay.example/new",
        authorizerDid: "did:ex:human",
        note: "Confirmed by human authorizer",
        updatedAt: T1,
      });
      expect(matched).toBe(1);
      const row = tx.findById("tx1")!;
      expect(row.status).toBe("completed");
      expect(row.gatewayRef).toBe("gw-2");
      expect(row.checkoutUrl).toBe("https://pay.example/new");
      expect(row.authorizerDid).toBe("did:ex:human");
      expect(row.note).toBe("Confirmed by human authorizer");
      expect(row.updatedAt).toBe(T1);
      // Outside the field set: untouched.
      expect(row.amount).toBe(200);
      expect(row.customer).toBe("cust-1");
      expect(row.proofSignature).toBe("sig");
      expect(row.createdAt).toBe(T0);
    });

    it("completeWithGateway on a missing row returns 0 and writes nothing", () => {
      const tx = fresh();
      const matched = tx.completeWithGateway("ghost", {
        gatewayRef: "gw-2",
        checkoutUrl: "",
        authorizerDid: "did:ex:human",
        note: "n",
        updatedAt: T1,
      });
      expect(matched).toBe(0);
      expect(tx.count()).toBe(0);
    });

    it("rejectWithNote applies exactly its field set and returns 1", () => {
      const tx = fresh();
      tx.replace(baseRecord());
      const matched = tx.rejectWithNote("tx1", {
        authorizerDid: "did:ex:reviewer",
        note: "Rejected by reviewer",
        updatedAt: T1,
      });
      expect(matched).toBe(1);
      const row = tx.findById("tx1")!;
      expect(row.status).toBe("rejected");
      expect(row.authorizerDid).toBe("did:ex:reviewer");
      expect(row.note).toBe("Rejected by reviewer");
      expect(row.updatedAt).toBe(T1);
      // The reject set is narrower: gateway fields untouched.
      expect(row.gatewayRef).toBe("gw-1");
      expect(row.checkoutUrl).toBe("https://pay.example/tx1");
    });

    it("rejectWithNote on a missing row returns 0", () => {
      const tx = fresh();
      expect(
        tx.rejectWithNote("ghost", {
          authorizerDid: "did:ex:reviewer",
          note: "n",
          updatedAt: T1,
        })
      ).toBe(0);
    });

    it("completeById changes only status + updatedAt; missing row returns 0", () => {
      const tx = fresh();
      tx.replace(baseRecord());
      expect(tx.completeById("tx1", T1)).toBe(1);
      const row = tx.findById("tx1")!;
      expect(row.status).toBe("completed");
      expect(row.updatedAt).toBe(T1);
      expect(row.gatewayRef).toBe("gw-1");
      expect(row.note).toBe("original note");
      expect(tx.completeById("ghost", T1)).toBe(0);
    });

    it("completeByIdOrGatewayRef matches by id, by ref, and both at once (count 2)", () => {
      const tx = fresh();
      tx.replace(baseRecord({ id: "by_id", gatewayRef: "ref_a" }));
      tx.replace(baseRecord({ id: "by_ref", gatewayRef: "SHARED" }));
      tx.replace(baseRecord({ id: "SHARED", gatewayRef: "ref_c" }));
      tx.replace(baseRecord({ id: "bystander", gatewayRef: "ref_d" }));

      expect(tx.completeByIdOrGatewayRef("by_id", T1)).toBe(1);
      expect(tx.findById("by_id")!.status).toBe("completed");
      expect(tx.findById("by_id")!.updatedAt).toBe(T1);

      // One call, two rows: id of one, gateway_ref of another.
      expect(tx.completeByIdOrGatewayRef("SHARED", T1)).toBe(2);
      expect(tx.findById("by_ref")!.status).toBe("completed");
      expect(tx.findById("SHARED")!.status).toBe("completed");

      const bystander = tx.findById("bystander")!;
      expect(bystander.status).toBe("authorized");
      expect(bystander.updatedAt).toBe(T0);

      expect(tx.completeByIdOrGatewayRef("no_such_ref", T1)).toBe(0);
    });

    it("no status guard: transitions over an already-completed row still match (as found)", () => {
      const tx = fresh();
      tx.replace(baseRecord({ status: "completed" }));
      expect(tx.completeById("tx1", T1)).toBe(1);
      expect(tx.findById("tx1")!.updatedAt).toBe(T1);
      expect(
        tx.completeWithGateway("tx1", {
          gatewayRef: "gw-9",
          checkoutUrl: "",
          authorizerDid: "did:ex:human",
          note: "again",
          updatedAt: T1,
        })
      ).toBe(1);
      expect(tx.completeByIdOrGatewayRef("tx1", T1)).toBe(1);
    });
  });
}

exercise("transaction ledger transitions — do-sqlite adapter (#2360 conformance)", () =>
  new DoSqliteTransactionLedgerAdapter(new SqliteLedgerStorage() as any)
);
exercise("transaction ledger transitions — in-memory adapter (#2360 conformance)", () =>
  new InMemoryTransactionLedgerAdapter()
);
