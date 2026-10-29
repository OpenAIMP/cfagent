/**
 * Issue #2288 (#1976 step 0, ADR 0022 D-F2) — work-item event
 * port.
 *
 * The work-item projection: GitHub issues, pull requests, and
 * check-runs as substrate events — the record the Sentinel
 * (#2279) literally reads to "learn from its own issues".
 * GitHub stays the system of record; this family is the
 * queryable copy on the published plane, so a consumer never
 * scrapes the API (or an agent's storage) to reconstruct what
 * happened.
 *
 * Redelivery-safe by construction: the natural key is
 * (source, externalId) — the migration-0003 idempotency
 * pattern — and an upsert of an existing key UPDATES the
 * projected state (an issue that closed since first delivery
 * shows closed) while reporting `inserted: false`, so a
 * consumer can tell a first sighting from a redelivery.
 * createdAtMs is the first-delivery time and never moves;
 * updatedAtMs tracks the latest delivery.
 *
 * Port-first (ADR 0002 R1/R2): record types, the port
 * interface, and pure helpers ONLY; no store client, no env
 * binding, no SQL.
 */

/** The work-item kinds the projection carries. */
export type WorkItemKind = "issue" | "pull_request" | "check_run";

/** One projected work-item event (current state per external id). */
export interface WorkItemEvent {
  /** Origin system, e.g. "github". */
  source: string;
  /** The origin's id for the item, e.g. "issue:2281", "pr:2282". */
  externalId: string;
  kind: WorkItemKind;
  /** The item's state at latest delivery, e.g. "open", "closed", "success". */
  state: string;
  /** The actor responsible for the latest state; null when unknown. */
  actor: string | null;
  /** Epoch milliseconds of the item's latest state change upstream. */
  occurredAtMs: number;
  /** Digest of the upstream payload this projection was built from. */
  payloadDigest: string;
}

/** A stored work-item event, with projection bookkeeping. */
export interface WorkItemEventRow extends WorkItemEvent {
  /** First-delivery time (epoch ms); never moves on redelivery. */
  createdAtMs: number;
  /** Latest-delivery time (epoch ms). */
  updatedAtMs: number;
}

/** The work-item event store surface. */
export interface WorkItemEventStore {
  /**
   * Insert or update one projected event by its natural key.
   * Returns inserted: true on first sighting, false on a
   * redelivery (which still refreshes the projected state).
   */
  upsertWorkItemEvent(
    event: WorkItemEvent,
    deliveredAtMs?: number,
  ): Promise<{ inserted: boolean }>;
  /** One projected event by natural key, or null. */
  getWorkItemEvent(
    source: string,
    externalId: string,
  ): Promise<WorkItemEventRow | null>;
  /** Projected events, optionally filtered to one kind, newest first. */
  listWorkItemEvents(kind?: WorkItemKind): Promise<WorkItemEventRow[]>;
}
