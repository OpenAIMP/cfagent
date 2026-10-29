/**
 * src/data/transactionLedgerPorts.ts — #2345 (#1976 step 3a,
 * ADR 0022 D-A): the mas_transactions port — the payment
 * ledger. DO residency (D-0 (a),(b),(e)): the ledger is
 * per-instance agent state; the cross-DO ledger write the
 * survey flagged stays as-is in this slice (named residual).
 *
 * Beyond the generic contract, the port carries replace():
 * INSERT OR REPLACE, the draft-payment write the MAS
 * draftPayment tool used to run as a raw statement in
 * agents/mas.ts (audit V-2's sibling write). The tool's
 * status transitions (completed / rejected) go through the
 * generic update() — the raw UPDATE bypasses named in the
 * audit are retired by this port.
 *
 * #CDO-mha7
 */
import type { TransactionRecord } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

export interface TransactionLedgerPort
  extends RepositoryPort<TransactionRecord> {
  /** INSERT OR REPLACE the full record; returns the record. */
  replace(record: TransactionRecord): TransactionRecord;
}
