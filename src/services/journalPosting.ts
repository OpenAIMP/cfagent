/**
 * Issue #2155 — best-effort journal posting.
 *
 * The DO ledger stays authoritative; the journal is a D1
 * projection. A journal failure must NEVER fail the payment,
 * the ledger write, or the run: this helper catches every
 * journal error, logs it loudly, and resolves. Callers pass a
 * setup closure (adapter construction + schema ensure) so the
 * helper itself needs no env access and stays unit-testable
 * with a throwing port.
 *
 * This module imports port types only — never a store client,
 * never drizzle-orm (structural test pin).
 */
import type { JournalEntryInput, JournalPort } from "../data/journalPorts";

export async function postJournalBestEffort(
  setup: () => Promise<JournalPort | null>,
  entries: JournalEntryInput[],
): Promise<void> {
  try {
    const port = await setup();
    if (!port) {
      console.error("[journal] journal post skipped (AGENT_DB unbound); payment/ledger unaffected.");
      return;
    }
    await port.postEntries(entries);
  } catch (err) {
    console.error(
      "[journal] journal post failed — payment/ledger unaffected:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
