/**
 * Strategy profile persistence (issue #28) — mirrors the scan-run store
 * (issue #27, src/trading/options/scanRunStore.ts): an interface, a SQL
 * implementation over the minimal Durable Object SqlStorage executor,
 * and an in-memory implementation with IDENTICAL semantics (including the
 * duplicate-name error and case-insensitive name matching) so tests and
 * non-DO contexts behave the same as production.
 *
 * The store enforces only identity and per-user name uniqueness.
 * Spec VALIDATION is the caller's job (validateStrategyProfile in
 * strategyProfile.ts) — routes and services validate before writing.
 * Specs are stored as a JSON blob so an update replaces the whole spec
 * atomically and both implementations share serialization semantics.
 */

import type { StrategyProfile, StrategyProfileSpec } from "./strategyProfile";
import type { ScanSqlExecutor } from "./scanRunStore";

export interface StrategyProfileStore {
  /** Create a profile at version 1. Throws on a duplicate name (per user, case-insensitive). */
  create(userLogin: string, name: string, spec: StrategyProfileSpec): Promise<StrategyProfile>;
  /** All of the user's profiles, name ascending. */
  list(userLogin: string): Promise<StrategyProfile[]>;
  get(userLogin: string, id: string): Promise<StrategyProfile | null>;
  /** Case-insensitive, trimmed name lookup. */
  getByName(userLogin: string, name: string): Promise<StrategyProfile | null>;
  /**
   * Replace the spec (and optionally rename) — version + 1, updatedAt
   * refreshed. Returns null when the profile does not exist for the
   * user; throws on a rename that clashes with a DIFFERENT profile.
   */
  update(userLogin: string, id: string, spec: StrategyProfileSpec, name?: string): Promise<StrategyProfile | null>;
  delete(userLogin: string, id: string): Promise<boolean>;
}

export interface StrategyProfileStoreOptions {
  idFactory?: () => string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

const TABLE = "mas_strategy_profiles";

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, user_login TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, spec_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_mas_strategy_profiles_user_name ON ${TABLE} (user_login, name)`;
const INSERT_SQL = `INSERT INTO ${TABLE} (id, user_login, name, version, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const SELECT_BY_USER_SQL = `SELECT id, user_login, name, version, spec_json, created_at, updated_at FROM ${TABLE} WHERE user_login = ?`;
const SELECT_BY_ID_SQL = `SELECT id, user_login, name, version, spec_json, created_at, updated_at FROM ${TABLE} WHERE user_login = ? AND id = ?`;
const UPDATE_SQL = `UPDATE ${TABLE} SET name = ?, version = ?, spec_json = ?, updated_at = ? WHERE user_login = ? AND id = ?`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE user_login = ? AND id = ?`;

interface ProfileRow {
  id: string;
  user_login: string;
  name: string;
  version: number;
  spec_json: string;
  created_at: string;
  updated_at: string;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function duplicateNameError(name: string): Error {
  return new Error(`A profile named "${name.trim()}" already exists`);
}

function compareByName(a: StrategyProfile, b: StrategyProfile): number {
  const keyA = a.name.toLowerCase();
  const keyB = b.name.toLowerCase();
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function rowToProfile(row: ProfileRow): StrategyProfile {
  const spec = JSON.parse(row.spec_json) as StrategyProfileSpec;
  return {
    ...spec,
    id: row.id,
    userLogin: row.user_login,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlStrategyProfileStore implements StrategyProfileStore {
  private readonly sql: ScanSqlExecutor;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private ensured = false;

  constructor(sql: ScanSqlExecutor, options: StrategyProfileStoreOptions = {}) {
    this.sql = sql;
    this.idFactory = options.idFactory ?? (() => `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
    this.now = options.now ?? (() => new Date());
  }

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
    this.ensured = true;
  }

  private listRows(userLogin: string): ProfileRow[] {
    this.ensure();
    return Array.from(this.sql.exec(SELECT_BY_USER_SQL, userLogin) as Iterable<ProfileRow>);
  }

  private getRow(userLogin: string, id: string): ProfileRow | null {
    this.ensure();
    const rows = Array.from(this.sql.exec(SELECT_BY_ID_SQL, userLogin, id) as Iterable<ProfileRow>);
    return rows[0] ?? null;
  }

  async create(userLogin: string, name: string, spec: StrategyProfileSpec): Promise<StrategyProfile> {
    const trimmed = name.trim();
    const key = nameKey(trimmed);
    if (this.listRows(userLogin).some((row) => nameKey(row.name) === key)) {
      throw duplicateNameError(trimmed);
    }
    const id = this.idFactory();
    const stamp = this.now().toISOString();
    this.sql.exec(INSERT_SQL, id, userLogin, trimmed, 1, JSON.stringify(spec), stamp, stamp);
    return { ...spec, id, userLogin, name: trimmed, version: 1, createdAt: stamp, updatedAt: stamp };
  }

  async list(userLogin: string): Promise<StrategyProfile[]> {
    return this.listRows(userLogin).map(rowToProfile).sort(compareByName);
  }

  async get(userLogin: string, id: string): Promise<StrategyProfile | null> {
    const row = this.getRow(userLogin, id);
    return row ? rowToProfile(row) : null;
  }

  async getByName(userLogin: string, name: string): Promise<StrategyProfile | null> {
    const key = nameKey(name);
    const profiles = await this.list(userLogin);
    return profiles.find((profile) => nameKey(profile.name) === key) ?? null;
  }

  async update(userLogin: string, id: string, spec: StrategyProfileSpec, name?: string): Promise<StrategyProfile | null> {
    const existing = this.getRow(userLogin, id);
    if (!existing) return null;
    const nextName = name !== undefined ? name.trim() : existing.name;
    const key = nameKey(nextName);
    const clash = this.listRows(userLogin).some((row) => row.id !== id && nameKey(row.name) === key);
    if (clash) throw duplicateNameError(nextName);
    const stamp = this.now().toISOString();
    const version = existing.version + 1;
    this.sql.exec(UPDATE_SQL, nextName, version, JSON.stringify(spec), stamp, userLogin, id);
    return { ...spec, id, userLogin, name: nextName, version, createdAt: existing.created_at, updatedAt: stamp };
  }

  async delete(userLogin: string, id: string): Promise<boolean> {
    if (!this.getRow(userLogin, id)) return false;
    this.sql.exec(DELETE_SQL, userLogin, id);
    return true;
  }
}

interface MemoryRecord {
  id: string;
  userLogin: string;
  name: string;
  version: number;
  specJson: string;
  createdAt: string;
  updatedAt: string;
}

export class InMemoryStrategyProfileStore implements StrategyProfileStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: StrategyProfileStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
    this.now = options.now ?? (() => new Date());
  }

  private toProfile(record: MemoryRecord): StrategyProfile {
    const spec = JSON.parse(record.specJson) as StrategyProfileSpec;
    return {
      ...spec,
      id: record.id,
      userLogin: record.userLogin,
      name: record.name,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private userRecords(userLogin: string): MemoryRecord[] {
    return Array.from(this.records.values()).filter((record) => record.userLogin === userLogin);
  }

  async create(userLogin: string, name: string, spec: StrategyProfileSpec): Promise<StrategyProfile> {
    const trimmed = name.trim();
    const key = nameKey(trimmed);
    if (this.userRecords(userLogin).some((record) => nameKey(record.name) === key)) {
      throw duplicateNameError(trimmed);
    }
    const id = this.idFactory();
    const stamp = this.now().toISOString();
    const record: MemoryRecord = { id, userLogin, name: trimmed, version: 1, specJson: JSON.stringify(spec), createdAt: stamp, updatedAt: stamp };
    this.records.set(id, record);
    return this.toProfile(record);
  }

  async list(userLogin: string): Promise<StrategyProfile[]> {
    return this.userRecords(userLogin).map((record) => this.toProfile(record)).sort(compareByName);
  }

  async get(userLogin: string, id: string): Promise<StrategyProfile | null> {
    const record = this.records.get(id);
    return record && record.userLogin === userLogin ? this.toProfile(record) : null;
  }

  async getByName(userLogin: string, name: string): Promise<StrategyProfile | null> {
    const key = nameKey(name);
    const profiles = await this.list(userLogin);
    return profiles.find((profile) => nameKey(profile.name) === key) ?? null;
  }

  async update(userLogin: string, id: string, spec: StrategyProfileSpec, name?: string): Promise<StrategyProfile | null> {
    const record = this.records.get(id);
    if (!record || record.userLogin !== userLogin) return null;
    const nextName = name !== undefined ? name.trim() : record.name;
    const key = nameKey(nextName);
    const clash = this.userRecords(userLogin).some((other) => other.id !== id && nameKey(other.name) === key);
    if (clash) throw duplicateNameError(nextName);
    const stamp = this.now().toISOString();
    const updated: MemoryRecord = { ...record, name: nextName, version: record.version + 1, specJson: JSON.stringify(spec), updatedAt: stamp };
    this.records.set(id, updated);
    return this.toProfile(updated);
  }

  async delete(userLogin: string, id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.userLogin !== userLogin) return false;
    this.records.delete(id);
    return true;
  }
}
