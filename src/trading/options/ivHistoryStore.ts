/**
 * IV history store (issue #15, Discovery epic #13).
 *
 * The discovery spec's IV-rank / IV-percentile inferences are only as
 * honest as the history behind them, and the settled decision (spec
 * §16, decision 3) is to self-collect from launch in "warming-up"
 * mode: no licensed backfill, and nothing fabricated or interpolated
 * — a day the provider failed is simply an absent observation, never
 * an invented one. This module is the persistence seam for that
 * collection: one record per tracked name per day (the day is the
 * America/New_York calendar date of the collection run — the
 * exchange's own day, matching how src/security/etradeOAuth.ts
 * reasons about ET dates).
 *
 * Idempotency is a hard acceptance gate: the daily job may rerun
 * (schedule retry, manual trigger, DO restart) and must never
 * duplicate or overwrite a day. Writes are therefore FIRST-WRITE-WINS
 * — the (symbol, date) primary key plus INSERT OR IGNORE — because
 * the first observation of a day is the one the day actually
 * produced; a later same-day value would be a different (intraday)
 * measurement wearing the daily record's clothes.
 *
 * Pattern follows src/trading/options/scanRunStore.ts: a Sql store
 * over Durable Object SQLite with the table ensured lazily by the
 * store, plus an InMemory twin with identical semantics for tests and
 * storeless contexts. No retention pruning: a series is one small row
 * per name per day, and the entire point of the table is a long,
 * unbroken history — pruning policy, if ever wanted, is a follow-up
 * decision, not a silent default.
 */

/** Trailing window (in observations) the rank/percentile math reads:
 *  252 ≈ one trading year of daily observations. */
export const IV_STATS_WINDOW = 252;

/** Below this many observations a name is "warming up" (spec §11):
 *  rank/percentile are still computed and returned, but consumers
 *  must treat IV-rank-dependent inference as reduced-confidence. */
export const IV_WARMING_UP_THRESHOLD = 60;

/** One day's ATM IV observation for one tracked name. */
export interface IvHistoryRecord {
  symbol: string;
  /** Collection day, YYYY-MM-DD in America/New_York. */
  date: string;
  /** ATM IV as a fraction (0.32 = 32%), derived from the live chain —
   *  see deriveAtmIv in ivCollector.ts. */
  atmIv: number;
  /** Underlying spot the chain was priced against. */
  spot: number;
  /** The expiry the ATM IV was read from (nearest eligible expiry). */
  expiryDate: string;
  /** Days from the collection instant to expiryDate (ceil, UTC). */
  dte: number;
  /** ISO timestamp of the write. */
  collectedAt: string;
}

/** Coverage accounting for one name's stored history. */
export interface IvHistoryCoverage {
  observations: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** Rank/percentile view over a stored series (pure math — see
 *  computeIvStats). Rank/percentile are null only when the series is
 *  empty; warming-up series still report computed values, qualified
 *  by the warmingUp flag rather than hidden. */
export interface IvStats {
  observations: number;
  /** observations / IV_STATS_WINDOW × 100, capped at 100. */
  coveragePct: number;
  /** observations < IV_WARMING_UP_THRESHOLD. */
  warmingUp: boolean;
  latest: IvHistoryRecord | null;
  /** (current − min) / (max − min) × 100 over the trailing window,
   *  where current is the latest observation. A degenerate window
   *  (max == min — flat series, or a single observation) reports the
   *  neutral midpoint 50: the current IV is neither high nor low
   *  relative to everything observed. */
  ivRank: number | null;
  /** Share of window observations strictly below current × 100. */
  ivPercentile: number | null;
}

export interface IvHistoryStore {
  /** Persist one day's record. Returns true when the row was
   *  written, false when (symbol, date) already existed — first
   *  write wins, so a same-day rerun is a no-op. */
  record(record: IvHistoryRecord): Promise<boolean>;
  /** The record for one (symbol, date), or null. */
  get(symbol: string, date: string): Promise<IvHistoryRecord | null>;
  /** Stored series for a symbol, NEWEST first (house list style);
   *  `limit` caps the rows returned (default: the whole series). */
  listSeries(symbol: string, options?: { limit?: number }): Promise<IvHistoryRecord[]>;
  /** Observation count and date span for a symbol. */
  coverage(symbol: string): Promise<IvHistoryCoverage>;
  /** Every symbol with at least one stored record, ascending. */
  listSymbols(): Promise<string[]>;
}

/**
 * The America/New_York calendar date (YYYY-MM-DD) of an instant —
 * the collection day a record belongs to. Same en-CA Intl idiom the
 * codebase already uses for ET dates (src/security/etradeOAuth.ts).
 * Pure and exported for tests.
 */
export function nyDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * IV rank / percentile over a stored series (pure; exported for
 * direct unit testing). "Current" is the latest record by date.
 * Rank and percentile read the trailing IV_STATS_WINDOW observations
 * (the most recent ones — older history still counts toward
 * `observations` and coverage). Percentile convention: share of
 * window observations STRICTLY below current, so ties at the current
 * value never inflate it.
 */
export function computeIvStats(records: readonly IvHistoryRecord[]): IvStats {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const observations = sorted.length;
  const latest = observations > 0 ? sorted[observations - 1] : null;
  const coveragePct = Math.min(100, (observations / IV_STATS_WINDOW) * 100);
  const warmingUp = observations < IV_WARMING_UP_THRESHOLD;
  if (!latest) {
    return { observations, coveragePct, warmingUp, latest: null, ivRank: null, ivPercentile: null };
  }
  const window = sorted.slice(-IV_STATS_WINDOW);
  const current = latest.atmIv;
  let min = Infinity;
  let max = -Infinity;
  let below = 0;
  for (const r of window) {
    if (r.atmIv < min) min = r.atmIv;
    if (r.atmIv > max) max = r.atmIv;
    if (r.atmIv < current) below++;
  }
  const ivRank = max === min ? 50 : ((current - min) / (max - min)) * 100;
  const ivPercentile = (below / window.length) * 100;
  return { observations, coveragePct, warmingUp, latest, ivRank, ivPercentile };
}

/**
 * Minimal SQL executor matching the Durable Object SqlStorage `exec`
 * signature (the same shape scanRunStore.ts declares): run a statement
 * with bound parameters, get back an iterable of row objects. The real
 * `this.ctx.storage.sql` satisfies it structurally.
 */
export interface IvSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

const TABLE = "mas_iv_history";

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (symbol TEXT NOT NULL, date TEXT NOT NULL, ` +
  `atm_iv REAL NOT NULL, spot REAL NOT NULL, expiry_date TEXT NOT NULL, dte INTEGER NOT NULL, ` +
  `collected_at TEXT NOT NULL, PRIMARY KEY (symbol, date))`;
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_mas_iv_history_symbol_date ON ${TABLE} (symbol, date DESC)`;
const GET_SQL =
  `SELECT symbol, date, atm_iv, spot, expiry_date, dte, collected_at FROM ${TABLE} WHERE symbol = ? AND date = ?`;
const INSERT_SQL =
  `INSERT OR IGNORE INTO ${TABLE} (symbol, date, atm_iv, spot, expiry_date, dte, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const SERIES_SQL =
  `SELECT symbol, date, atm_iv, spot, expiry_date, dte, collected_at FROM ${TABLE} WHERE symbol = ? ORDER BY date DESC`;
const SERIES_LIMIT_SQL =
  `SELECT symbol, date, atm_iv, spot, expiry_date, dte, collected_at FROM ${TABLE} WHERE symbol = ? ORDER BY date DESC LIMIT ?`;
const COVERAGE_SQL =
  `SELECT COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date FROM ${TABLE} WHERE symbol = ?`;
const SYMBOLS_SQL = `SELECT DISTINCT symbol FROM ${TABLE} ORDER BY symbol ASC`;

interface IvRow {
  symbol: string;
  date: string;
  atm_iv: number;
  spot: number;
  expiry_date: string;
  dte: number;
  collected_at: string;
}

function rowToRecord(row: IvRow): IvHistoryRecord {
  return {
    symbol: row.symbol,
    date: row.date,
    atmIv: Number(row.atm_iv),
    spot: Number(row.spot),
    expiryDate: row.expiry_date,
    dte: Number(row.dte),
    collectedAt: row.collected_at,
  };
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * IvHistoryStore over Durable Object SQLite. The table is ensured
 * lazily on first use (CREATE TABLE/INDEX IF NOT EXISTS), following
 * the mas_opportunity_scans pattern.
 */
export class SqlIvHistoryStore implements IvHistoryStore {
  private ensured = false;

  constructor(private readonly sql: IvSqlExecutor) {}

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
    this.ensured = true;
  }

  async record(record: IvHistoryRecord): Promise<boolean> {
    this.ensure();
    const symbol = normalizeSymbol(record.symbol);
    // First write wins: an existing (symbol, date) row is the day's
    // record, whatever a rerun computed later. The pre-check makes
    // the outcome reportable; INSERT OR IGNORE keeps the guarantee
    // even if a writer races the check.
    if (await this.get(symbol, record.date)) return false;
    this.sql.exec(
      INSERT_SQL,
      symbol,
      record.date,
      record.atmIv,
      record.spot,
      record.expiryDate,
      record.dte,
      record.collectedAt,
    );
    return true;
  }

  async get(symbol: string, date: string): Promise<IvHistoryRecord | null> {
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, normalizeSymbol(symbol), date)) as IvRow[];
    return rows.length ? rowToRecord(rows[0]) : null;
  }

  async listSeries(symbol: string, options: { limit?: number } = {}): Promise<IvHistoryRecord[]> {
    this.ensure();
    const sym = normalizeSymbol(symbol);
    const rows = (
      options.limit !== undefined
        ? Array.from(this.sql.exec(SERIES_LIMIT_SQL, sym, options.limit))
        : Array.from(this.sql.exec(SERIES_SQL, sym))
    ) as IvRow[];
    return rows.map(rowToRecord);
  }

  async coverage(symbol: string): Promise<IvHistoryCoverage> {
    this.ensure();
    const rows = Array.from(this.sql.exec(COVERAGE_SQL, normalizeSymbol(symbol))) as Array<{
      count: number;
      first_date: string | null;
      last_date: string | null;
    }>;
    const row = rows[0];
    return {
      observations: Number(row?.count ?? 0),
      firstDate: row?.first_date ?? null,
      lastDate: row?.last_date ?? null,
    };
  }

  async listSymbols(): Promise<string[]> {
    this.ensure();
    const rows = Array.from(this.sql.exec(SYMBOLS_SQL)) as Array<{ symbol: string }>;
    return rows.map((r) => r.symbol);
  }
}

/**
 * In-memory IvHistoryStore with semantics identical to
 * SqlIvHistoryStore — for tests and for contexts with no Durable
 * Object storage handle.
 */
export class InMemoryIvHistoryStore implements IvHistoryStore {
  private records = new Map<string, IvHistoryRecord>();

  private key(symbol: string, date: string): string {
    return `${normalizeSymbol(symbol)}|${date}`;
  }

  async record(record: IvHistoryRecord): Promise<boolean> {
    const key = this.key(record.symbol, record.date);
    if (this.records.has(key)) return false;
    this.records.set(key, { ...record, symbol: normalizeSymbol(record.symbol) });
    return true;
  }

  async get(symbol: string, date: string): Promise<IvHistoryRecord | null> {
    return this.records.get(this.key(symbol, date)) ?? null;
  }

  async listSeries(symbol: string, options: { limit?: number } = {}): Promise<IvHistoryRecord[]> {
    const sym = normalizeSymbol(symbol);
    const series = [...this.records.values()]
      .filter((r) => r.symbol === sym)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return options.limit !== undefined ? series.slice(0, options.limit) : series;
  }

  async coverage(symbol: string): Promise<IvHistoryCoverage> {
    const series = await this.listSeries(symbol);
    return {
      observations: series.length,
      firstDate: series.length ? series[series.length - 1].date : null,
      lastDate: series.length ? series[0].date : null,
    };
  }

  async listSymbols(): Promise<string[]> {
    return [...new Set([...this.records.values()].map((r) => r.symbol))].sort();
  }
}
