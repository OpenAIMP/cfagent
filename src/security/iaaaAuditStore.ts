/**
 * #945 Wiring Phase 2b-part1 — Kv-backed IAAA audit store.
 *
 * Slice 5 (iaaaAudit.ts) defined the append-only AuditStore
 * interface and a memory implementation only; this module is the
 * first durable backend, used by the logout audit hook. Events
 * live in the SessionStore Durable Object (the same store as
 * sessions and bindings) under keys prefixed "iaaa-audit:", with
 * NO expiry — audit evidence must outlive any one session. The
 * single log key cannot collide with session keys (bare UUIDs)
 * or binding keys ("iaaa-binding:").
 *
 * Append-only at the API level: this store exposes append and
 * list only. There is no update, delete, or prune operation.
 * Retention (how long events are kept) remains an open CISO/CDO
 * decision; nothing here prunes, and the log grows without bound
 * until that decision lands. At auth-event volume that is
 * acceptable; this store must NOT be used for per-request audit
 * until a bounded backend exists.
 *
 * Honest limitations (read before using this store elsewhere):
 * - Read-modify-write race: recordAuditEvent lists, then this
 *   append re-reads and rewrites the whole log. Two concurrent
 *   appends can interleave so that one event is lost or the
 *   hash chain forks. verifyChain() DETECTS a fork; it does not
 *   repair one. Auth-event volume is low, so the window is
 *   small, but a production-grade backend needs a transactional
 *   append (a later phase), not this log key.
 * - O(n) per append: the whole log is read and rewritten on
 *   every event. Again acceptable for auth events only.
 * - Corruption is loud, never silent: a log value that is not
 *   a JSON array throws on both append and list, so
 *   recordWiredAuthAudit reports AUDIT_WRITE_FAILED and the
 *   corrupt bytes are left untouched for investigation — never
 *   overwritten with a fresh log.
 */

import type { Env } from "../types";
import type { AuditStore, IaaaAuditEvent } from "./iaaaAudit";
import type { KvLike } from "./kvResilience";
import { sessionStore } from "./session";

/** Prefix for every IAAA audit key in the SessionStore DO. */
export const IAAA_AUDIT_KEY_PREFIX = "iaaa-audit:";

/** The single log key holding the JSON array of audit events. */
export const IAAA_AUDIT_LOG_KEY = `${IAAA_AUDIT_KEY_PREFIX}events`;

function corruptError(): Error {
  return new Error(
    "iaaa audit log is corrupt (not a JSON array); refusing to overwrite audit evidence",
  );
}

async function readLog(kv: KvLike): Promise<IaaaAuditEvent[]> {
  const raw = await kv.get(IAAA_AUDIT_LOG_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptError();
  }
  if (!Array.isArray(parsed)) throw corruptError();
  return parsed as IaaaAuditEvent[];
}

/** Durable AuditStore backed by a KvLike store (production: SessionStore DO). */
export function createKvAuditStore(kv: KvLike): AuditStore {
  return {
    async append(event: IaaaAuditEvent): Promise<void> {
      const events = await readLog(kv);
      events.push({ ...event });
      await kv.put(IAAA_AUDIT_LOG_KEY, JSON.stringify(events));
    },
    async list(): Promise<IaaaAuditEvent[]> {
      const events = await readLog(kv);
      return events.map((event) => ({ ...event }));
    },
  };
}

/** Production audit store: SessionStore DO, iaaa-audit: keys, no expiry. */
export function createWiredAuditStore(env: Env): AuditStore {
  return createKvAuditStore(sessionStore(env));
}
