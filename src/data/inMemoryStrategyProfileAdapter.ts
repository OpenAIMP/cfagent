/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the strategy-profile port, with semantics identical to the
 * DO-SQLite adapter (name uniqueness is enforced synchronously
 * inside each method, so the check-then-write is atomic by
 * construction here). Moved from
 * src/trading/options/strategyProfileStore.ts (now a shim).
 */
import type {
  StrategyProfile,
  StrategyProfileSpec,
} from "../trading";
import type {
  StrategyProfileStore,
  StrategyProfileStoreOptions,
} from "./strategyProfilePorts";

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
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
