/**
 * #1077 Phase 4 — draft ledger: idempotent draft storage.
 *
 * A draft is keyed by its posting day + channel: at most one draft per
 * (date, channel). Creating a draft for a date+channel that already has
 * one returns the EXISTING draft — never a duplicate. This is what makes
 * a retried or re-fired daily tick safe: the second build replays the
 * first draft set instead of doubling it.
 *
 * Two shapes are provided, both with no DO binding and no network use:
 * - SocialLedger: the synchronous interface the Phase 4 agent uses, with
 *   MemorySocialLedger as the in-memory implementation (tests, and the
 *   reference for the wiring step).
 * - createDoSocialLedger: an async adapter over a {get, put, list}-like
 *   storage object shaped like Durable Object storage (list takes a
 *   { prefix } and returns a Map). The wiring step adapts real DO
 *   storage to DoStorageLike; Phase 4 itself binds nothing.
 */

import type { SocialDraft } from "./draft";

export type { SocialDraft };

export interface SocialLedger {
  /**
   * Methods return T | Promise<T>: a synchronous implementation (the
   * in-memory ledger) satisfies this with plain values, and an async
   * implementation (the SessionStore-backed ledger) with promises.
   * Callers MUST await every call — awaiting a plain value is
   * transparent, so sync and async stores share one call path.
   */
  getDraft(date: string, channel: string): SocialDraft | undefined | Promise<SocialDraft | undefined>;
  putDraft(draft: SocialDraft): void | Promise<void>;
  listDrafts(date: string): SocialDraft[] | Promise<SocialDraft[]>;
}

/**
 * Idempotent create: returns the stored draft for (date, channel) when
 * one exists, otherwise creates, stores, and returns a new one. The
 * create callback runs ONLY when no draft exists, so a second call can
 * never overwrite or duplicate the first draft.
 */
export async function getOrCreateDraft(
  ledger: SocialLedger,
  date: string,
  channel: string,
  create: () => SocialDraft,
): Promise<SocialDraft> {
  const existing = await ledger.getDraft(date, channel);
  if (existing) return existing;
  const draft = create();
  await ledger.putDraft(draft);
  return draft;
}

function ledgerKey(date: string, channel: string): string {
  return `social-draft:${date}:${channel}`;
}

export class MemorySocialLedger implements SocialLedger {
  private readonly byKey = new Map<string, SocialDraft>();

  getDraft(date: string, channel: string): SocialDraft | undefined {
    return this.byKey.get(ledgerKey(date, channel));
  }

  putDraft(draft: SocialDraft): void {
    this.byKey.set(ledgerKey(draft.date, draft.channel), draft);
  }

  listDrafts(date: string): SocialDraft[] {
    const prefix = `social-draft:${date}:`;
    const out: SocialDraft[] = [];
    for (const [key, draft] of this.byKey) {
      if (key.startsWith(prefix)) out.push(draft);
    }
    return out;
  }

  getOrCreateDraft(date: string, channel: string, create: () => SocialDraft): Promise<SocialDraft> {
    return getOrCreateDraft(this, date, channel, create);
  }
}

/**
 * Minimal storage shape modelled on Durable Object storage: get/put by
 * key, list by prefix returning a Map. Real DO storage's list() takes an
 * options object and returns Map<string, unknown>; the wiring step passes
 * it through unchanged.
 */
export interface DoStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  list(options: { prefix: string }): Promise<Map<string, unknown>>;
}

export interface AsyncSocialLedger {
  getDraft(date: string, channel: string): Promise<SocialDraft | undefined>;
  putDraft(draft: SocialDraft): Promise<void>;
  listDrafts(date: string): Promise<SocialDraft[]>;
  getOrCreateDraft(
    date: string,
    channel: string,
    create: () => SocialDraft,
  ): Promise<SocialDraft>;
}

const SOCIAL_DRAFT_STATUSES: readonly string[] = [
  "draft",
  "approved",
  "posted",
  "failed",
  // #1171: a dry-run publish records this, never "posted".
  "dry-run-posted",
];

/**
 * Shape guard for stored drafts (durable stores treat a value that
 * fails it as ABSENT, never as a minted draft). Besides the identity
 * fields it enforces the status union: a stored draft with an
 * unknown status string is corrupt, not publishable. All statuses
 * ever written by createDraft / approveDraft / rejectDraft /
 * publishDueDrafts are in the union, so legitimate records pass.
 */
export function isSocialDraft(value: unknown): value is SocialDraft {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SocialDraft).id === "string" &&
    typeof (value as SocialDraft).date === "string" &&
    typeof (value as SocialDraft).channel === "string" &&
    typeof (value as SocialDraft).text === "string" &&
    SOCIAL_DRAFT_STATUSES.includes((value as SocialDraft).status)
  );
}

export function createDoSocialLedger(storage: DoStorageLike): AsyncSocialLedger {
  return {
    async getDraft(date: string, channel: string) {
      const value = await storage.get(ledgerKey(date, channel));
      return isSocialDraft(value) ? value : undefined;
    },
    async putDraft(draft: SocialDraft) {
      await storage.put(ledgerKey(draft.date, draft.channel), draft);
    },
    async listDrafts(date: string) {
      const entries = await storage.list({ prefix: `social-draft:${date}:` });
      const out: SocialDraft[] = [];
      for (const value of entries.values()) {
        if (isSocialDraft(value)) out.push(value);
      }
      return out;
    },
    async getOrCreateDraft(date: string, channel: string, create: () => SocialDraft) {
      const existing = await this.getDraft(date, channel);
      if (existing) return existing;
      const draft = create();
      await this.putDraft(draft);
      return draft;
    },
  };
}
