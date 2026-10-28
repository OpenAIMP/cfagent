/**
 * Issue #2155 — composition root for the journal port. This is
 * the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createJournalAdapter` returns null and callers keep their
 * fail direction — journal posting is best-effort (see
 * src/services/journalPosting.ts), so a null adapter is a loud
 * log, never a thrown error. A present-but-unreadable store
 * fails at the call site, where the caller decides the
 * direction (also best-effort for the journal).
 */
import {
  createD1JournalDb,
  D1JournalAdapter,
  ensureJournalSchema,
  type JournalDb,
} from "./d1JournalAdapter";
import type { JournalPort } from "./journalPorts";

/** Build the journal adapter from Worker env, or null if unbound. */
export function createJournalAdapter(env: { AGENT_DB?: unknown }): D1JournalAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1JournalAdapter(createD1JournalDb(env.AGENT_DB as D1Database));
}

export { ensureJournalSchema };
export type { JournalDb, JournalPort };
