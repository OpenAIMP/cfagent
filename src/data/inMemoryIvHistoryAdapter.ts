/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the IV-history port, with semantics identical to the
 * DO-SQLite and D1 adapters (first-write-wins per (symbol,
 * date)). Moved from src/trading/options/ivHistoryStore.ts
 * (now a shim).
 */
import {
  computeIvStats,
  type IvHistoryCoverage,
  type IvHistoryRecord,
  type IvHistoryStore,
  type IvStats,
} from "./ivHistoryPorts";

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

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
