/**
 * Consolidation #1236 (feed seam): the stored universe snapshot
 * artifact — one symbol's quotes + chains, with asOf + provenance,
 * tenant-scoped.
 *
 * One artifact = one symbol's OptionsDataSnapshot, stored verbatim.
 * Discovery runs are per-symbol, so the artifact is bounded, its asOf
 * is unambiguous (the snapshot's own screen.scannedAt), and a run
 * resolves one artifact per request symbol. The store follows the
 * mas_discovery_runs idiom: CREATE TABLE IF NOT EXISTS + single-line
 * statements (the MockSqlStorage lesson — multi-line column lists
 * silently no-op in the shared mock).
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

const TABLE = "mas_feed_snapshots";

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, user_login TEXT NOT NULL, symbol TEXT NOT NULL, as_of TEXT NOT NULL, data_source TEXT NOT NULL, snapshot_json TEXT NOT NULL, load_params_json TEXT NOT NULL)`;
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_mas_feed_snapshots_lookup ON ${TABLE} (user_login, symbol, created_at DESC)`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, created_at, user_login, symbol, as_of, data_source, snapshot_json, load_params_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const IDS_SQL =
  `SELECT id FROM ${TABLE} WHERE user_login = ? AND symbol = ? ORDER BY created_at DESC, id DESC`;
const LATEST_SQL =
  `SELECT id, snapshot_json, as_of, data_source, load_params_json, created_at FROM ${TABLE} WHERE user_login = ? AND symbol = ? ORDER BY created_at DESC, id DESC LIMIT 1`;
const BY_ID_SQL =
  `SELECT id, snapshot_json, as_of, data_source, load_params_json, created_at FROM ${TABLE} WHERE user_login = ? AND id = ?`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

interface FeedSnapshotRow {
  id: string;
  snapshot_json: string;
  as_of: string;
  data_source: string;
  load_params_json: string;
  created_at: string;
}

function parseRow(
  row: FeedSnapshotRow,
  userLogin: string,
  symbol: string,
): FeedSnapshotArtifact {
  return {
    id: row.id,
    userLogin,
    symbol,
    snapshot: JSON.parse(row.snapshot_json) as OptionsDataSnapshot,
    asOf: row.as_of,
    dataSource: row.data_source,
    loadParams: JSON.parse(row.load_params_json) as FeedSnapshotLoadParams,
    createdAt: row.created_at,
  };
}

export interface FeedSnapshotStoreOptions {
  idFactory?: () => string;
  /** Rows kept per (user, symbol) after each store. Default 10. */
  keepPerSymbol?: number;
}

export class SqlFeedSnapshotStore implements FeedSnapshotReader {
  private readonly idFactory: () => string;
  private readonly keepPerSymbol: number;

  constructor(
    private readonly sql: FeedSqlExecutor,
    options?: FeedSnapshotStoreOptions,
  ) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerSymbol = options?.keepPerSymbol ?? 10;
  }

  private ensureTables(): void {
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
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
    this.ensureTables();
    const symbol = input.symbol.toUpperCase().trim();
    const id = this.idFactory();
    const createdAt = input.nowIso ?? new Date().toISOString();
    this.sql.exec(
      INSERT_SQL,
      id,
      createdAt,
      input.userLogin,
      symbol,
      input.asOf,
      input.dataSource,
      JSON.stringify(input.snapshot),
      JSON.stringify(input.loadParams),
    );
    // Prune one row at a time (single-id DELETEs): the shared mock
    // does not evaluate NOT IN subqueries, and per-row deletes are
    // exactly as cheap at this volume.
    const ids = Array.from(
      this.sql.exec(IDS_SQL, input.userLogin, symbol),
    ) as Array<{ id: string }>;
    for (const excess of ids.slice(this.keepPerSymbol)) {
      this.sql.exec(DELETE_SQL, excess.id);
    }
    return {
      id,
      userLogin: input.userLogin,
      symbol,
      snapshot: input.snapshot,
      asOf: input.asOf,
      dataSource: input.dataSource,
      loadParams: input.loadParams,
      createdAt,
    };
  }

  latest(userLogin: string, symbol: string): FeedSnapshotArtifact | undefined {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(LATEST_SQL, userLogin, symbol.toUpperCase().trim()),
    ) as FeedSnapshotRow[];
    const row = rows[0];
    if (!row) return undefined;
    return parseRow(row, userLogin, symbol.toUpperCase().trim());
  }

  byId(userLogin: string, id: string): FeedSnapshotArtifact | undefined {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(BY_ID_SQL, userLogin, id),
    ) as FeedSnapshotRow[];
    const row = rows[0];
    if (!row) return undefined;
    // The row's symbol is not needed beyond the stored snapshot,
    // which always carries its own symbol.
    const snapshot = JSON.parse(row.snapshot_json) as OptionsDataSnapshot;
    return parseRow(row, userLogin, snapshot.symbol);
  }
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
