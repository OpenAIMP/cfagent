/**
 * Issue #1738 — the actor transcript store.
 *
 * Replaces Think's session store with storage owned by the actor
 * itself: one key per message plus an ordered id index, over any
 * backend matching the minimal get/put/delete shape (a DO's
 * ctx.storage in production, a Map in tests). The transcript shape
 * is unchanged (UIMessage: id/role/parts/metadata), so hygiene,
 * resend detection, and turn derivation read the same fields they
 * read from Think's session.
 *
 * Append is upsert-by-id (Think saveMessages semantics): appending
 * a full list lands only the delta — existing ids are overwritten
 * in place, new ids join the tail. The chat-activity import path
 * relies on this idempotence.
 */
import {
  legacyRowToSessionMessage,
  type ActorSessionPort,
  type LegacyChatRow,
  type UiChatMessage,
} from "./actorPorts";

/** Minimal KV backend: DO ctx.storage satisfies this directly. */
export interface SessionStorageBackend {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Map-backed backend for tests and the in-memory adapter. */
export function createMapSessionBackend(): SessionStorageBackend {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  };
}

const INDEX_KEY = "actor:session:index";
const messageKey = (id: string): string => `actor:session:message:${id}`;

export class ActorSessionStore implements ActorSessionPort {
  constructor(private readonly backend: SessionStorageBackend) {}

  private async readIndex(): Promise<string[]> {
    const index = await this.backend.get(INDEX_KEY);
    return Array.isArray(index) ? (index as string[]) : [];
  }

  async getMessages(): Promise<UiChatMessage[]> {
    const index = await this.readIndex();
    const out: UiChatMessage[] = [];
    for (const id of index) {
      const msg = (await this.backend.get(messageKey(id))) as UiChatMessage | undefined;
      if (msg && typeof msg === "object" && typeof msg.id === "string") out.push(msg);
    }
    return out;
  }

  async appendMessages(messages: UiChatMessage[]): Promise<void> {
    const index = await this.readIndex();
    const seen = new Set(index);
    for (const msg of messages ?? []) {
      if (!msg || typeof msg.id !== "string") continue;
      await this.backend.put(messageKey(msg.id), msg);
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        index.push(msg.id);
      }
    }
    await this.backend.put(INDEX_KEY, index);
  }

  async deleteMessages(ids: string[]): Promise<void> {
    const keep = new Set(ids);
    const index = (await this.readIndex()).filter((id) => !keep.has(id));
    for (const id of ids) await this.backend.delete(messageKey(id));
    await this.backend.put(INDEX_KEY, index);
  }

  async migrateLegacyRows(rows: LegacyChatRow[]): Promise<void> {
    await this.appendMessages((rows ?? []).map(legacyRowToSessionMessage));
  }

  async clear(): Promise<void> {
    const index = await this.readIndex();
    for (const id of index) await this.backend.delete(messageKey(id));
    await this.backend.put(INDEX_KEY, []);
  }
}
