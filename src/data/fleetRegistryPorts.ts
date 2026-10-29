/**
 * Issue #2288 (#1976 step 0, ADR 0022 D-F.5) — fleet-registry
 * port.
 *
 * The fleet registry and conformance matrix as DATA: until now
 * they existed only as code and test-time artifacts (the A2A
 * resolution map, agent cards, wrangler bindings, source-scan
 * pins — survey §5.5), so neither the UI nor the intelligence
 * loop could read "which agents exist, with which bindings,
 * migrations, and conformance status" at runtime. This family
 * is the read model they will read.
 *
 * THIS SLICE BUILDS TABLES + PORTS ONLY. There is deliberately
 * NO production writer: which job populates the registry
 * (deploy-time seed vs scheduled sync) is gate G-6, still open.
 * The upsert methods exist so the conformance suite can prove
 * the port contract end-to-end and so the G-6 writer, when
 * ruled, has its surface ready — nothing in production calls
 * them in this slice.
 *
 * Port-first (ADR 0002 R1/R2): record types, the port
 * interface, and pure helpers ONLY; no store client, no env
 * binding, no SQL.
 */

/** One registry record per agent. */
export interface FleetAgentRecord {
  /** Stable agent key, e.g. "orchestrator" (the registry's PK). */
  agentKey: string;
  /** The agent class name, e.g. "OrchestratorAgent". */
  className: string;
  /** The wrangler DO binding name, e.g. "ORCHESTRATOR_AGENT". */
  binding: string;
  /** How instances are addressed, e.g. "per-login" / "singleton". */
  instanceScheme: string;
  /** DO migration tag for the agent's namespace; null if none. */
  migrationTag: string | null;
  /** The operations the agent serves (A2A card operations). */
  operations: string[];
  /** The G14 identity record; null until the agent has one. */
  identity: Record<string, unknown> | null;
  /**
   * The agent's per-instance DO schema version (reported via
   * src/data/doSchemaMarker.ts); null when unreported.
   */
  doSchemaVersion: number | null;
  updatedAtMs: number;
}

/** Per-cell conformance status (ADR 0022 D-F.5 vocabulary). */
export type ConformanceStatus = "IMPLEMENTED" | "NOT-APPLICABLE" | "GAP";

/** One cell of the conformance matrix: agent × dimension. */
export interface ConformanceCell {
  agentKey: string;
  /** The conformance dimension, e.g. "state", "scheduling". */
  dimension: string;
  status: ConformanceStatus;
  /** Slice/issue reference for the cell (the GAP's slice, typically). */
  reference: string | null;
  updatedAtMs: number;
}

/** The fleet-registry store surface (read model + writer surface for G-6). */
export interface FleetRegistryStore {
  /** Insert or replace one agent record (idempotent by agentKey). */
  upsertAgent(record: FleetAgentRecord): Promise<void>;
  /** One agent record by key, or null. */
  getAgent(agentKey: string): Promise<FleetAgentRecord | null>;
  /** All agent records, ordered by agentKey. */
  listAgents(): Promise<FleetAgentRecord[]>;
  /** Insert or replace one matrix cell (idempotent by agentKey + dimension). */
  upsertCell(cell: ConformanceCell): Promise<void>;
  /** One agent's matrix cells, ordered by dimension. */
  listCells(agentKey: string): Promise<ConformanceCell[]>;
  /** The whole matrix, ordered by agentKey then dimension. */
  listMatrix(): Promise<ConformanceCell[]>;
}
