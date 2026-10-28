/**
 * Issue #1758 (#1717 lifecycle wiring) — session registry.
 *
 * Scan F-16: bulk revocation could not revoke sessions it could
 * not see, because the Slice 2 store exposed no session listing
 * and lifecycle.revokePrincipal() takes caller-supplied ids. This
 * module is the listing side of that fix: it parses the SessionStore
 * Durable Object's sessions-namespace listing (see sessionStore.ts,
 * where the list op is now allowed for ns "sessions") into typed
 * registry entries, and filters them to one principal.
 *
 * This module performs no I/O and imports no Cloudflare
 * infrastructure: the caller supplies already-listed entries (in
 * production, listStoreEntries() from durableKv.ts over the
 * sessions namespace). The registry is therefore a port over a
 * list function, not a second session store — the DO remains the
 * only session backend, and this module never writes a session.
 *
 * Parsing rules (fail-silent per entry, never fail-open):
 * - The key must be a session id (the UUID shape createSession
 *   mints). Membership, binding, audit, and access-request keys
 *   share the sessions namespace but are not sessions, so a
 *   non-UUID key is skipped, not parsed as a session.
 * - The value must be JSON with a string githubLogin. A corrupt
 *   value is skipped (counted by the caller through the missing
 *   entry, never mistaken for a live session); a session record
 *   without an internalUserId is a legacy session, kept with
 *   internalUserId undefined — the wiring module decides whether
 *   a legacy session belongs to an offboarding (same login as a
 *   wired session), this module never guesses.
 */

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionRegistryEntry {
  sessionId: string;
  internalUserId?: string;
  githubLogin: string;
}

/**
 * Parse one listed store entry into a registry entry, or null when
 * the entry is not a live session record. Null is the only failure
 * signal: callers skip nulls and never treat them as sessions.
 */
export function parseSessionRegistryEntry(
  key: string,
  raw: string,
): SessionRegistryEntry | null {
  if (typeof key !== "string" || !SESSION_ID_PATTERN.test(key)) return null;
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { githubLogin?: unknown; internalUserId?: unknown };
  if (typeof record.githubLogin !== "string" || record.githubLogin === "") return null;
  const entry: SessionRegistryEntry = { sessionId: key, githubLogin: record.githubLogin };
  if (typeof record.internalUserId === "string" && record.internalUserId !== "") {
    entry.internalUserId = record.internalUserId;
  }
  return entry;
}

/** Parse a whole listing, skipping every non-session or corrupt entry. */
export function parseSessionRegistryEntries(
  entries: Array<{ key: string; value: string }>,
): SessionRegistryEntry[] {
  const found: SessionRegistryEntry[] = [];
  for (const entry of entries) {
    const parsed = parseSessionRegistryEntry(entry.key, entry.value);
    if (parsed) found.push(parsed);
  }
  return found;
}

/** The principal's wired sessions: exact internalUserId match only. */
export function sessionsForPrincipal(
  entries: SessionRegistryEntry[],
  internalUserId: string,
): SessionRegistryEntry[] {
  return entries.filter((entry) => entry.internalUserId === internalUserId);
}
