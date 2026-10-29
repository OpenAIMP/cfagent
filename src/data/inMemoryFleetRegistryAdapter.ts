/**
 * Issue #2288 (#1976 step 0) — in-memory fleet-registry store.
 *
 * A test double with the same port semantics as the D1 adapter:
 * the conformance suite runs unchanged against both. It is NOT a
 * production store and NOT a second source of truth.
 */
import type {
  ConformanceCell,
  FleetAgentRecord,
  FleetRegistryStore,
} from "./fleetRegistryPorts";

function cloneAgent(record: FleetAgentRecord): FleetAgentRecord {
  return {
    ...record,
    operations: [...record.operations],
    identity: record.identity ? { ...record.identity } : null,
  };
}

export class InMemoryFleetRegistryAdapter implements FleetRegistryStore {
  private agents = new Map<string, FleetAgentRecord>();
  private cells = new Map<string, ConformanceCell>();

  private cellKey(cell: ConformanceCell): string {
    return `${cell.agentKey}::${cell.dimension}`;
  }

  async upsertAgent(record: FleetAgentRecord): Promise<void> {
    this.agents.set(record.agentKey, cloneAgent(record));
  }

  async getAgent(agentKey: string): Promise<FleetAgentRecord | null> {
    const row = this.agents.get(agentKey);
    return row ? cloneAgent(row) : null;
  }

  async listAgents(): Promise<FleetAgentRecord[]> {
    return [...this.agents.values()]
      .sort((a, b) => (a.agentKey < b.agentKey ? -1 : a.agentKey > b.agentKey ? 1 : 0))
      .map(cloneAgent);
  }

  async upsertCell(cell: ConformanceCell): Promise<void> {
    this.cells.set(this.cellKey(cell), { ...cell });
  }

  async listCells(agentKey: string): Promise<ConformanceCell[]> {
    return [...this.cells.values()]
      .filter((c) => c.agentKey === agentKey)
      .sort((a, b) =>
        a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0,
      )
      .map((c) => ({ ...c }));
  }

  async listMatrix(): Promise<ConformanceCell[]> {
    return [...this.cells.values()]
      .sort((a, b) => {
        if (a.agentKey !== b.agentKey)
          return a.agentKey < b.agentKey ? -1 : 1;
        return a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0;
      })
      .map((c) => ({ ...c }));
  }
}
