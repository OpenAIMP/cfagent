/**
 * Consolidation #1236 (feed seam): the feed producer — load one
 * symbol's snapshot through the panel's own live path and store it
 * as a feed artifact.
 *
 * The loader is injected (production: OptionsDataAgent.loadSnapshot;
 * tests: a fake), so the producer never touches the broker directly.
 * A snapshot that never loaded its chain is NOT stored: storing a
 * failed load as an "artifact" would let generate succeed on garbage.
 * Zero contracts with NO failure signal stores — a genuine
 * no-candidates snapshot, the same honesty rule runDiscoveryRequest
 * applies to live loads.
 */
import type { OptionsDataSnapshot } from "../trading";
import type { FeedSnapshotLoadParams } from "./feedSnapshotStore";
import type { FeedSnapshotStore } from "../data/feedSnapshotPorts";

export interface FeedSnapshotDescriptor {
  artifactId: string;
  symbol: string;
  asOf: string;
  dataSource: string;
  contractCount: number;
  loadParams: FeedSnapshotLoadParams;
}

export async function produceFeedSnapshot(args: {
  store: FeedSnapshotStore;
  userLogin: string;
  symbol: string;
  loadSnapshot: (params: FeedSnapshotLoadParams & { symbol: string }) => Promise<OptionsDataSnapshot>;
  loadParams?: FeedSnapshotLoadParams;
  nowIso?: string;
}): Promise<FeedSnapshotDescriptor> {
  const symbol = args.symbol.toUpperCase().trim();
  const loadParams: FeedSnapshotLoadParams = { symbol, ...(args.loadParams ?? {}) };
  const snapshot = await args.loadSnapshot({ ...loadParams, symbol });
  if (snapshot.validationError) {
    throw new Error(`Feed snapshot for ${symbol} not stored: ${snapshot.validationError}`);
  }
  const fetchReasons = (snapshot.screen.fetchErrors ?? [])
    .filter((e) => e.symbol === symbol)
    .map((e) => e.reason);
  if (snapshot.contracts.length === 0 && fetchReasons.length > 0) {
    throw new Error(`Feed snapshot for ${symbol} not stored: chain load failed (${fetchReasons.join("; ")})`);
  }
  const nowIso = args.nowIso ?? new Date().toISOString();
  const asOf = snapshot.screen.scannedAt ?? nowIso;
  const stored = args.store.store({
    userLogin: args.userLogin,
    symbol,
    snapshot,
    asOf,
    dataSource: snapshot.dataSource,
    loadParams,
    nowIso,
  });
  return {
    artifactId: stored.id,
    symbol,
    asOf,
    dataSource: snapshot.dataSource,
    contractCount: snapshot.contracts.length,
    loadParams,
  };
}
