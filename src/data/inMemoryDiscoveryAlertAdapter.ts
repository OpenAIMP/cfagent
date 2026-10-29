/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the discovery-alert port.
 *
 * PORT CONTRACT CHANGE (step-2 audit §2.4, disclosed on
 * #2337): the legacy in-memory store accepted a duplicate
 * record and relied on the dispatcher's hasAlerted check; the
 * port makes dedupe a store-level invariant on every adapter,
 * so this adapter rejects a duplicate (scope, symbol, thesis,
 * day) record with an error — matching the SQL adapter's
 * UNIQUE constraint. No production caller constructs this
 * store; the change is confined to the test double's fidelity.
 */
import type {
  DiscoveryAlertRecord,
  DiscoveryAlertRecordInput,
  DiscoveryAlertStore,
} from "./discoveryAlertPorts";
import type { OptionThesis } from "../trading";

function sameKey(a: DiscoveryAlertRecordInput, b: DiscoveryAlertRecordInput): boolean {
  return (
    a.scopeKey === b.scopeKey &&
    a.symbol === b.symbol &&
    a.thesis === b.thesis &&
    a.day === b.day
  );
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
    if (this.records.some((r) => sameKey(r, input))) {
      throw new Error(
        `duplicate discovery alert for ${input.scopeKey}/${input.symbol}/${input.thesis}/${input.day} — dedupe is a store-level invariant (port contract)`,
      );
    }
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
