/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — feed-
 * snapshot port: the stored universe snapshot artifact — one
 * symbol's quotes + chains, with asOf + provenance,
 * tenant-scoped (consolidation #1236, feed seam).
 *
 * ADR D-0 ruled this family DO-resident behind a port: writer
 * (feedSnapshotJob) and readers (the same user's discovery
 * runs) are the same user's orchestrator flows; colocation
 * (menu property (e)) is the design — a bounded per-symbol
 * artifact, asOf-stamped (step-2 audit §2.8, judgement call
 * recorded).
 *
 * One artifact = one symbol's OptionsDataSnapshot, stored
 * verbatim. Discovery runs are per-symbol, so the artifact is
 * bounded, its asOf is unambiguous (the snapshot's own
 * screen.scannedAt), and a run resolves one artifact per
 * request symbol.
 *
 * SHAPE NOTE: this port is SYNCHRONOUS, unlike the step-1/2
 * async ports — both of its adapters are synchronous (DO
 * SQLite + in-memory), its resolver is synchronous, and no D1
 * adapter exists for the family. Forcing async would rewire
 * the discovery hot path for no behavioural gain; the port
 * keeps the shape the seam was written with.
 *
 * This module carries the record types, the pure resolver, and
 * the port interface ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteFeedSnapshotAdapter.ts (production),
 * inMemoryFeedSnapshotAdapter.ts (test double — new with this
 * port; the legacy store had no in-memory twin). The types
 * moved here from src/services/feedSnapshotStore.ts, which is
 * now a re-export shim.
 */
import type { OptionsDataSnapshot } from "../trading";

export interface FeedSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

/**
 * The load-shape a snapshot was produced with. These are the
 * SnapshotParams fields that shape WHICH contracts passed the screen;
 * a generate-time request whose filters differ from the artifact's
 * load params must NOT silently run on it (see
 * resolveFeedSnapshotForSymbol's filter-match rule). maxQuoteAgeSeconds
 * is a load-time quote filter only — generate-time freshness is the
 * artifact's maxAgeSeconds staleness rule, a separate control.
 */
export interface FeedSnapshotLoadParams {
  symbol?: string;
  minDte?: number;
  maxDte?: number;
  minVolume?: number;
  minOpenInterest?: number;
  maxSpreadPct?: number;
  maxQuoteAgeSeconds?: number;
  contractLimit?: number;
  dataMode?: string;
  expirationDteBands?: unknown;
}

export interface FeedSnapshotArtifact {
  id: string;
  userLogin: string;
  symbol: string;
  snapshot: OptionsDataSnapshot;
  asOf: string;
  dataSource: string;
  loadParams: FeedSnapshotLoadParams;
  createdAt: string;
}

/** How a run names its feed input: exact artifacts, latest, or both
 *  (artifacts win per symbol; latest covers the rest). At least one
 *  of artifacts/latest is required — enforced by the schedule schema
 *  refine and re-checked defensively by the resolver. */
export interface FeedSnapshotInput {
  artifacts?: Record<string, string>;
  latest?: boolean;
  /** Generate-time freshness bound (seconds). Absent ⇒ no staleness
   *  judgment; the artifact is used as-is with its asOf surfaced.
   *  Deliberately no default — inventing a threshold would silently
   *  judge artifacts the caller never asked to bound. */
  maxAgeSeconds?: number;
}

export interface FeedSnapshotReader {
  latest(userLogin: string, symbol: string): FeedSnapshotArtifact | undefined;
  byId(userLogin: string, id: string): FeedSnapshotArtifact | undefined;
}

/** The feed-snapshot store port (reader + the write side). */
export interface FeedSnapshotStore extends FeedSnapshotReader {
  /** Store one artifact and prune to the newest keepPerSymbol
   *  rows for its (user, symbol) — the INSERT + prune pair is
   *  one unit on the DO adapter when the host supplies the
   *  transaction-capable storage object (ADR D-C). */
  store(input: {
    userLogin: string;
    symbol: string;
    snapshot: OptionsDataSnapshot;
    asOf: string;
    dataSource: string;
    loadParams: FeedSnapshotLoadParams;
    nowIso?: string;
  }): FeedSnapshotArtifact;
}

export interface FeedSnapshotStoreOptions {
  idFactory?: () => string;
  /** Rows kept per (user, symbol) after each store. Default 10. */
  keepPerSymbol?: number;
}

/** Pick exactly the load-shaping fields off a discovery request (or
 *  any request-shaped object). Unknown fields (thesis, targets,
 *  strategy lists) never shape the chain load, so they never take
 *  part in filter matching. */
export function pickFeedLoadParams(request: {
  symbol?: unknown;
  minDte?: unknown;
  maxDte?: unknown;
  minVolume?: unknown;
  minOpenInterest?: unknown;
  maxSpreadPct?: unknown;
  maxQuoteAgeSeconds?: unknown;
  contractLimit?: unknown;
  dataMode?: unknown;
  expirationDteBands?: unknown;
}): FeedSnapshotLoadParams {
  const out: FeedSnapshotLoadParams = {};
  if (typeof request.symbol === "string" && request.symbol.trim()) {
    out.symbol = request.symbol.toUpperCase().trim();
  }
  const numeric: Array<keyof FeedSnapshotLoadParams> = [
    "minDte", "maxDte", "minVolume", "minOpenInterest",
    "maxSpreadPct", "maxQuoteAgeSeconds", "contractLimit",
  ];
  for (const key of numeric) {
    if (typeof request[key] === "number") (out as Record<string, unknown>)[key] = request[key];
  }
  if (typeof request.dataMode === "string") out.dataMode = request.dataMode;
  if (request.expirationDteBands !== undefined) out.expirationDteBands = request.expirationDteBands;
  return out;
}

function normalizeDataMode(value: unknown): unknown {
  return value === undefined ? "live" : value;
}

function filtersMatch(
  artifactParams: FeedSnapshotLoadParams,
  requestFilters: FeedSnapshotLoadParams,
): boolean {
  const keys = new Set([
    ...Object.keys(artifactParams),
    ...Object.keys(requestFilters),
  ] as Array<keyof FeedSnapshotLoadParams>);
  for (const key of keys) {
    const a = key === "dataMode"
      ? normalizeDataMode(artifactParams[key])
      : artifactParams[key];
    const b = key === "dataMode"
      ? normalizeDataMode(requestFilters[key])
      : requestFilters[key];
    // An absent dataMode is the live path (loadSnapshot: anything
    // other than "calibrated-demo" loads live), so normalization
    // above makes absent ≡ "live" on both sides.
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

export type FeedSnapshotResolution =
  | { status: "hit"; artifact: FeedSnapshotArtifact; stale: boolean }
  | { status: "missing"; reason: string };

/**
 * Resolve one symbol's feed input. Snapshot mode means snapshot mode:
 * a missing artifact or a filter mismatch is a MISSING outcome (the
 * caller fails that symbol explicitly) — never a silent live
 * fallback, which would hide the missing feed and run on different
 * data than the schedule named.
 */
export function resolveFeedSnapshotForSymbol(args: {
  store: FeedSnapshotReader;
  userLogin: string;
  symbol: string;
  input: FeedSnapshotInput;
  requestFilters: FeedSnapshotLoadParams;
  nowMs: number;
}): FeedSnapshotResolution {
  const symbol = args.symbol.toUpperCase().trim();
  let artifact: FeedSnapshotArtifact | undefined;
  if (args.input.artifacts) {
    const bySymbol: Record<string, string> = {};
    for (const [key, id] of Object.entries(args.input.artifacts)) {
      bySymbol[key.toUpperCase().trim()] = id;
    }
    const id = bySymbol[symbol];
    if (id === undefined) {
      return {
        status: "missing",
        reason: `feed snapshot missing for ${symbol}: snapshotInput.artifacts names no artifact for this symbol`,
      };
    }
    artifact = args.store.byId(args.userLogin, id);
    if (!artifact) {
      return {
        status: "missing",
        reason: `feed snapshot ${id} not found for ${symbol}`,
      };
    }
  } else if (args.input.latest) {
    artifact = args.store.latest(args.userLogin, symbol);
    if (!artifact) {
      return {
        status: "missing",
        reason: `feed snapshot missing for ${symbol}: no stored artifact`,
      };
    }
  } else {
    return {
      status: "missing",
      reason: `feed snapshot missing for ${symbol}: snapshotInput names neither artifacts nor latest`,
    };
  }
  if (!filtersMatch(artifact.loadParams, args.requestFilters)) {
    return {
      status: "missing",
      reason:
        `feed snapshot filter mismatch for ${symbol}: stored loadParams ${JSON.stringify(artifact.loadParams)} ` +
        `do not match request filters ${JSON.stringify(args.requestFilters)}`,
    };
  }
  const asOfMs = Date.parse(artifact.asOf);
  const stale =
    args.input.maxAgeSeconds !== undefined &&
    !Number.isNaN(asOfMs) &&
    args.nowMs - asOfMs > args.input.maxAgeSeconds * 1000;
  return { status: "hit", artifact, stale };
}
