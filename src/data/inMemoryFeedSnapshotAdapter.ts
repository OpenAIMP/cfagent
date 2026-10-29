/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the feed-snapshot port, with semantics identical to the
 * DO-SQLite adapter: newest-first per (user, symbol), keep-
 * per-symbol prune on store, symbol normalization (upper +
 * trim) on every path. NEW with this port — the legacy store
 * had no in-memory twin.
 */
import type { OptionsDataSnapshot } from "../trading";
import type {
  FeedSnapshotArtifact,
  FeedSnapshotLoadParams,
  FeedSnapshotStore,
  FeedSnapshotStoreOptions,
} from "./feedSnapshotPorts";

interface FeedRow {
  artifact: FeedSnapshotArtifact;
  /** Insertion sequence — the created_at tiebreak (the SQL
   *  adapter orders created_at DESC, id DESC; ids here are
   *  sequential from the default factory, so sequence order
   *  matches that ordering for equal timestamps). */
  seq: number;
}

/** Newest-first: createdAt descending, insertion descending. */
function byNewestFirst(a: FeedRow, b: FeedRow): number {
  if (a.artifact.createdAt !== b.artifact.createdAt) {
    return a.artifact.createdAt < b.artifact.createdAt ? 1 : -1;
  }
  return b.seq - a.seq;
}

export class InMemoryFeedSnapshotStore implements FeedSnapshotStore {
  private rows: FeedRow[] = [];
  private seq = 0;
  private readonly idFactory: () => string;
  private readonly keepPerSymbol: number;

  constructor(options?: FeedSnapshotStoreOptions) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerSymbol = options?.keepPerSymbol ?? 10;
  }

  store(input: {
    userLogin: string;
    symbol: string;
    snapshot: OptionsDataSnapshot;
    asOf: string;
    dataSource: string;
    loadParams: FeedSnapshotLoadParams;
    nowIso?: string;
  }): FeedSnapshotArtifact {
    const symbol = input.symbol.toUpperCase().trim();
    const artifact: FeedSnapshotArtifact = {
      id: this.idFactory(),
      userLogin: input.userLogin,
      symbol,
      snapshot: input.snapshot,
      asOf: input.asOf,
      dataSource: input.dataSource,
      loadParams: input.loadParams,
      createdAt: input.nowIso ?? new Date().toISOString(),
    };
    this.rows.push({ artifact, seq: ++this.seq });
    const mine = this.rows
      .filter((r) => r.artifact.userLogin === input.userLogin && r.artifact.symbol === symbol)
      .sort(byNewestFirst);
    const excess = new Set(mine.slice(this.keepPerSymbol).map((r) => r.artifact.id));
    if (excess.size > 0) {
      this.rows = this.rows.filter((r) => !excess.has(r.artifact.id));
    }
    return artifact;
  }

  latest(userLogin: string, symbol: string): FeedSnapshotArtifact | undefined {
    const normalized = symbol.toUpperCase().trim();
    return this.rows
      .filter((r) => r.artifact.userLogin === userLogin && r.artifact.symbol === normalized)
      .sort(byNewestFirst)[0]?.artifact;
  }

  byId(userLogin: string, id: string): FeedSnapshotArtifact | undefined {
    return this.rows.find(
      (r) => r.artifact.userLogin === userLogin && r.artifact.id === id,
    )?.artifact;
  }
}
