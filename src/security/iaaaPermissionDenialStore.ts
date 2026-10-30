/**
 * #2450 — Kv-backed per-user permission-denial store.
 *
 * Durable backend for the denial layer (permissionDenials.ts),
 * in the SessionStore Durable Object — the same store as sessions
 * and memberships. Mirrors the membership store's key conventions
 * and failure rules.
 *
 * Storage layout, two key shapes under the one prefix:
 *   iaaa-permission-deny:<denialId>          -> JSON PermissionDenial
 *   iaaa-permission-deny:user:<internalUserId> -> JSON string[] of denialIds
 * Each denial is its own record, so clearing by id works without
 * knowing the owner; the per-user index makes getDenialsByUser a
 * bounded read (denials per user are few). The prefix cannot
 * collide with membership keys ("iaaa-membership:"), session keys
 * (bare UUIDs), binding keys ("iaaa-binding:"), audit keys
 * ("iaaa-audit:"), or alias keys ("iaaa-alias:"). No expiry: a
 * denial must not silently vanish on a TTL boundary; clearing is
 * explicit, and audit history lives in the audit funnel, not here.
 *
 * Honest limitations (same family as the membership store's):
 * - Index drift: put writes the denial record, then the index.
 *   If the index write fails, the denial exists but
 *   getDenialsByUser will not see it — fail-closed (the PDP reads
 *   through the index, so a missing index entry means the denial
 *   does not apply — the same fail direction as a missing
 *   membership, and the route reports the stored denial back so
 *   the admin can see what was written). A stale index entry
 *   pointing at a deleted-or-missing record is skipped on read.
 *   Clearing reads the denial record directly, so it works even
 *   when the index is stale.
 * - Read-modify-write race: two concurrent puts for the same user
 *   can lose one index entry. Denial writes are rare (admin
 *   actions), not per-request, so the window is small.
 * - Corruption is loud, never silent: a denial record or index
 *   value that is not valid JSON (or not the expected shape)
 *   throws on read, and the corrupt bytes are left untouched for
 *   investigation, never overwritten.
 */
import type { PermissionDenial } from "./authorization";
import type { PermissionDenialStore } from "./permissionDenials";
import type { KvLike } from "./kvResilience";

/** Prefix for every permission-denial key in the SessionStore DO. */
export const IAAA_PERMISSION_DENY_KEY_PREFIX = "iaaa-permission-deny:";

function denialKey(denialId: string): string {
  return `${IAAA_PERMISSION_DENY_KEY_PREFIX}${denialId}`;
}

function userIndexKey(internalUserId: string): string {
  return `${IAAA_PERMISSION_DENY_KEY_PREFIX}user:${internalUserId}`;
}

function corruptError(what: string): Error {
  return new Error(
    `iaaa permission denial ${what} is corrupt; refusing to overwrite denial evidence`,
  );
}

async function readIndex(
  kv: KvLike,
  internalUserId: string,
): Promise<string[]> {
  const raw = await kv.get(userIndexKey(internalUserId));
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptError("index");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((id) => typeof id === "string")
  ) {
    throw corruptError("index");
  }
  return parsed as string[];
}

async function readDenial(
  kv: KvLike,
  denialId: string,
): Promise<PermissionDenial | null> {
  const raw = await kv.get(denialKey(denialId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptError("record");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).denialId !== "string" ||
    typeof (parsed as Record<string, unknown>).internalUserId !== "string" ||
    typeof (parsed as Record<string, unknown>).tenantId !== "string" ||
    typeof (parsed as Record<string, unknown>).permission !== "string" ||
    typeof (parsed as Record<string, unknown>).deniedBy !== "string" ||
    typeof (parsed as Record<string, unknown>).deniedAtMs !== "number"
  ) {
    throw corruptError("record");
  }
  return parsed as PermissionDenial;
}

export function createKvPermissionDenialStore(
  kv: KvLike,
): PermissionDenialStore {
  async function getDenialsByUser(
    internalUserId: string,
  ): Promise<PermissionDenial[]> {
    const ids = await readIndex(kv, internalUserId);
    const found: PermissionDenial[] = [];
    for (const id of ids) {
      // A stale index entry (record missing) is skipped; a
      // corrupt record throws, loudly, above.
      const denial = await readDenial(kv, id);
      if (denial) found.push({ ...denial });
    }
    return found;
  }

  return {
    getDenialsByUser,
    async putDenial(denial: PermissionDenial): Promise<PermissionDenial> {
      // Idempotent by (user, tenant, permission): a second put
      // returns the FIRST denial, keeping original attribution.
      const existing = (await getDenialsByUser(denial.internalUserId)).find(
        (d) =>
          d.tenantId === denial.tenantId && d.permission === denial.permission,
      );
      if (existing) return { ...existing };
      const record = { ...denial };
      await kv.put(denialKey(record.denialId), JSON.stringify(record));
      const ids = await readIndex(kv, denial.internalUserId);
      if (!ids.includes(record.denialId)) {
        ids.push(record.denialId);
        await kv.put(userIndexKey(denial.internalUserId), JSON.stringify(ids));
      }
      return { ...record };
    },
    async clearDenial(denialId: string): Promise<boolean> {
      const denial = await readDenial(kv, denialId);
      if (!denial) return false;
      await kv.delete(denialKey(denialId));
      const ids = await readIndex(kv, denial.internalUserId);
      const pruned = ids.filter((id) => id !== denialId);
      if (pruned.length !== ids.length) {
        await kv.put(
          userIndexKey(denial.internalUserId),
          JSON.stringify(pruned),
        );
      }
      return true;
    },
  };
}
