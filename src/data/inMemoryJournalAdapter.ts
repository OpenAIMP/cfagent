/**
 * Issue #2155 — in-memory journal.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate); the chart is seeded on construction.
 */
import {
  assertBalancedPost,
  journalEntryId,
  MINIMAL_CHART,
  type JournalAccount,
  type JournalEntry,
  type JournalEntryInput,
  type JournalPort,
} from "./journalPorts";

export class InMemoryJournalAdapter implements JournalPort {
  private entries = new Map<string, JournalEntry>();
  private accounts: JournalAccount[] = [...MINIMAL_CHART];

  async postEntries(entries: JournalEntryInput[]): Promise<JournalEntry[]> {
    assertBalancedPost(entries);
    const ref = entries[0].transactionRef;
    const existing = await this.getEntriesByRef(ref);
    if (existing.length > 0) return existing;
    const now = Date.now();
    const written: JournalEntry[] = [];
    for (const e of entries) {
      const record: JournalEntry = {
        id: journalEntryId(e.transactionRef, e.accountCode),
        transactionRef: e.transactionRef,
        accountCode: e.accountCode,
        debitUSD: e.debitUSD,
        creditUSD: e.creditUSD,
        currency: e.currency,
        tenantId: e.tenantId,
        runRequestId: e.runRequestId,
        family: e.family,
        createdAtMs: now,
      };
      this.entries.set(record.id, record);
      written.push(record);
    }
    return written;
  }

  async listEntries(tenantId: string): Promise<JournalEntry[]> {
    return [...this.entries.values()]
      .filter((e) => e.tenantId === tenantId)
      .sort((a, b) =>
        a.createdAtMs !== b.createdAtMs
          ? a.createdAtMs - b.createdAtMs
          : a.id < b.id
            ? -1
            : 1,
      );
  }

  async getEntriesByRef(transactionRef: string): Promise<JournalEntry[]> {
    return [...this.entries.values()]
      .filter((e) => e.transactionRef === transactionRef)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async listAccounts(): Promise<JournalAccount[]> {
    return [...this.accounts].sort((a, b) => (a.code < b.code ? -1 : 1));
  }
}
