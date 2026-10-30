/**
 * Issue #2433 (#1976 step 5b) — the production (DO
 * wire-protocol) adapter for the session family. It is a
 * client of the existing funnel exactly as today's factories
 * are: the KvLike and the lister are built by the
 * composition root (createSessionPorts.ts) from
 * createStoreKv / listStoreEntries over the SAME
 * SessionStore instance, bucket "sessions",
 * `legacyFallback: false` — so wire payloads and store_op
 * metrics behaviour are byte-identical to the flag-off path
 * by construction (same funnel, same payload shapes).
 *
 * #CDO-mha7
 */
import type { KvLike } from "../security/kvResilience";
import {
  createKvBackedSessionFamily,
  type SessionLister,
} from "./sessionFamilyKvImpl";
import type { SessionFamilyPorts } from "./sessionPorts";

export class DoSessionFamilyAdapter implements SessionFamilyPorts {
  readonly legacyFallback = false as const;
  readonly sessions: SessionFamilyPorts["sessions"];
  readonly bindings: SessionFamilyPorts["bindings"];
  readonly memberships: SessionFamilyPorts["memberships"];
  readonly accessRequests: SessionFamilyPorts["accessRequests"];
  readonly kv: KvLike;

  constructor(kv: KvLike, lister: SessionLister) {
    const family = createKvBackedSessionFamily(kv, lister);
    this.sessions = family.sessions;
    this.bindings = family.bindings;
    this.memberships = family.memberships;
    this.accessRequests = family.accessRequests;
    this.kv = family.kv;
  }
}
