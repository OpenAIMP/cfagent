/**
 * Issue #2433 (#1976 step 5b) — the in-memory adapter for
 * the session family (conformance / test doubles). Its
 * KvLike honours TTLs the way the DO does at the contract
 * level: an expired row reads as absent and is deleted by
 * that read (the §3.1 lazy-expiry shape, at this backend's
 * level). All family semantics run through the shared
 * Kv-backed implementation, so this adapter and the DO
 * adapter differ ONLY in the backend handle.
 *
 * #CDO-mha7
 */
import type { KvLike } from "../security/kvResilience";
import {
  createKvBackedSessionFamily,
  type SessionLister,
} from "./sessionFamilyKvImpl";
import type { SessionFamilyPorts } from "./sessionPorts";

interface Row {
  value: string;
  expiresAtMs: number | null;
}

export class InMemorySessionFamilyAdapter implements SessionFamilyPorts {
  readonly legacyFallback = false as const;
  readonly sessions: SessionFamilyPorts["sessions"];
  readonly bindings: SessionFamilyPorts["bindings"];
  readonly memberships: SessionFamilyPorts["memberships"];
  readonly accessRequests: SessionFamilyPorts["accessRequests"];
  readonly kv: KvLike;
  private readonly rows = new Map<string, Row>();

  constructor() {
    const rows = this.rows;
    const kv: KvLike = {
      async get(key) {
        const row = rows.get(key);
        if (!row) return null;
        if (row.expiresAtMs !== null && row.expiresAtMs <= Date.now()) {
          rows.delete(key);
          return null;
        }
        return row.value;
      },
      async put(key, value, options) {
        rows.set(key, {
          value,
          expiresAtMs:
            typeof options?.expirationTtl === "number"
              ? Date.now() + options.expirationTtl * 1000
              : null,
        });
      },
      async putIfAbsent(key, value) {
        const existing = rows.get(key);
        if (
          existing &&
          (existing.expiresAtMs === null || existing.expiresAtMs > Date.now())
        ) {
          return false;
        }
        rows.set(key, { value, expiresAtMs: null });
        return true;
      },
      async delete(key) {
        rows.delete(key);
      },
    };
    const lister: SessionLister = async (prefix) => {
      const out: Array<{ key: string; value: string }> = [];
      for (const [key, row] of rows) {
        if (row.expiresAtMs !== null && row.expiresAtMs <= Date.now()) continue;
        if (key.startsWith(prefix)) out.push({ key, value: row.value });
      }
      out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return out;
    };
    const family = createKvBackedSessionFamily(kv, lister);
    this.sessions = family.sessions;
    this.bindings = family.bindings;
    this.memberships = family.memberships;
    this.accessRequests = family.accessRequests;
    this.kv = family.kv;
  }
}
