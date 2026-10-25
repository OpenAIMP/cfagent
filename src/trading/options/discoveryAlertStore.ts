/**
 * Discovery alert log (issue #18, Phase 2 — Decision 2).
 *
 * Every alert the dispatcher sends is recorded here FIRST; the
 * record is both the in-app channel's artifact (surfaces list it)
 * and the enforcement point for the two anti-spam rules:
 *
 *   - dedupe: at most one alert per (scope, symbol, thesis, day)
 *     — a setup that stays NEW across two runs in a day alerts once;
 *   - the daily cap counts records, so alerts sent by any earlier
 *     run of the same scope the same day count toward it.
 *
 * The SQL schema carries a UNIQUE constraint on the dedupe key as
 * belt-and-braces; the dispatcher checks `hasAlerted` before
 * recording, so the constraint should never be what stops a send.
 */

import type { DiscoverySignalType } from "./discoverySignals";
import type { OptionThesis } from "./strategyEngine";

export interface DiscoveryAlertRecord {
  id: string;
  /** The discovery run that produced the setup (alert linkage). */
  runId: string;
  scopeKey: string;
  symbol: string;
  thesis: OptionThesis;
  discoveryScore: number;
  /** UTC day (YYYY-MM-DD) the dedupe + cap rules key on. */
  day: string;
  /** The setup's evidence line — every alert links run + evidence. */
  evidence: string;
  firedSignals: DiscoverySignalType[];
  createdAt: string;
}

export type DiscoveryAlertRecordInput = Omit<DiscoveryAlertRecord, "id">;

export interface DiscoveryAlertStore {
  hasAlerted(scopeKey: string, symbol: string, thesis: OptionThesis, day: string): Promise<boolean>;
  countForDay(scopeKey: string, day: string): Promise<number>;
  record(input: DiscoveryAlertRecordInput): Promise<DiscoveryAlertRecord>;
  list(scopeKey: string, options?: { limit?: number }): Promise<DiscoveryAlertRecord[]>;
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  `exec` signature (the shape the sibling stores declare). */
export interface DiscoveryAlertSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

const TABLE = "mas_discovery_alerts";

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ` +
  `scope_key TEXT NOT NULL, symbol TEXT NOT NULL, thesis TEXT NOT NULL, score REAL NOT NULL, ` +
  `day TEXT NOT NULL, evidence TEXT NOT NULL, fired_signals TEXT NOT NULL, created_at TEXT NOT NULL, ` +
  `UNIQUE(scope_key, symbol, thesis, day))`;
const HAS_SQL =
  `SELECT COUNT(*) AS count FROM ${TABLE} WHERE scope_key = ? AND symbol = ? AND thesis = ? AND day = ?`;
const COUNT_DAY_SQL = `SELECT COUNT(*) AS count FROM ${TABLE} WHERE scope_key = ? AND day = ?`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, run_id, scope_key, symbol, thesis, score, day, evidence, fired_signals, created_at) ` +
  `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const LIST_SQL =
  `SELECT id, run_id, scope_key, symbol, thesis, score, day, evidence, fired_signals, created_at FROM ${TABLE} ` +
  `WHERE scope_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`;

interface AlertRow {
  id: string;
  run_id: string;
  scope_key: string;
  symbol: string;
  thesis: string;
  score: number;
  day: string;
  evidence: string;
  fired_signals: string;
  created_at: string;
}

function rowToRecord(row: AlertRow): DiscoveryAlertRecord {
  return {
    id: row.id,
    runId: row.run_id,
    scopeKey: row.scope_key,
    symbol: row.symbol,
    thesis: row.thesis as OptionThesis,
    discoveryScore: Number(row.score),
    day: row.day,
    evidence: row.evidence,
    firedSignals: JSON.parse(row.fired_signals) as DiscoverySignalType[],
    createdAt: row.created_at,
  };
}

export class SqlDiscoveryAlertStore implements DiscoveryAlertStore {
  private ensured = false;
  private readonly idFactory: () => string;

  constructor(
    private readonly sql: DiscoveryAlertSqlExecutor,
    options: { idFactory?: () => string } = {},
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    this.ensured = true;
  }

  private count(query: string, ...params: unknown[]): number {
    const rows = Array.from(this.sql.exec(query, ...params)) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  async hasAlerted(scopeKey: string, symbol: string, thesis: OptionThesis, day: string): Promise<boolean> {
    this.ensure();
    return this.count(HAS_SQL, scopeKey, symbol, thesis, day) > 0;
  }

  async countForDay(scopeKey: string, day: string): Promise<number> {
    this.ensure();
    return this.count(COUNT_DAY_SQL, scopeKey, day);
  }

  async record(input: DiscoveryAlertRecordInput): Promise<DiscoveryAlertRecord> {
    this.ensure();
    const record: DiscoveryAlertRecord = { ...input, id: `disc_alert_${this.idFactory()}` };
    this.sql.exec(
      INSERT_SQL,
      record.id,
      record.runId,
      record.scopeKey,
      record.symbol,
      record.thesis,
      record.discoveryScore,
      record.day,
      record.evidence,
      JSON.stringify(record.firedSignals),
      record.createdAt,
    );
    return record;
  }

  async list(scopeKey: string, options: { limit?: number } = {}): Promise<DiscoveryAlertRecord[]> {
    this.ensure();
    const rows = Array.from(this.sql.exec(LIST_SQL, scopeKey, options.limit ?? 25)) as AlertRow[];
    return rows.map(rowToRecord);
  }
}

export class InMemoryDiscoveryAlertStore implements DiscoveryAlertStore {
  private records: DiscoveryAlertRecord[] = [];
  private readonly idFactory: () => string;

  constructor(options: { idFactory?: () => string } = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async hasAlerted(scopeKey: string, symbol: string, thesis: OptionThesis, day: string): Promise<boolean> {
    return this.records.some(
      (r) => r.scopeKey === scopeKey && r.symbol === symbol && r.thesis === thesis && r.day === day,
    );
  }

  async countForDay(scopeKey: string, day: string): Promise<number> {
    return this.records.filter((r) => r.scopeKey === scopeKey && r.day === day).length;
  }

  async record(input: DiscoveryAlertRecordInput): Promise<DiscoveryAlertRecord> {
    const record: DiscoveryAlertRecord = { ...input, id: `disc_alert_${this.idFactory()}` };
    this.records.push(record);
    return record;
  }

  async list(scopeKey: string, options: { limit?: number } = {}): Promise<DiscoveryAlertRecord[]> {
    return this.records
      .filter((r) => r.scopeKey === scopeKey)
      .slice()
      .reverse()
      .slice(0, options.limit ?? 25);
  }
}
