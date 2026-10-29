/**
 * src/data/canonicalReportPorts.ts — #2345 (#1976 step 3a,
 * ADR 0022 D-A): the mas_reports port — the canonical report
 * store. DO residency (D-0 (a),(b),(e)).
 *
 * THE COMPLETED CONTRACT (audit V-5): the pre-port ORM
 * repository carried a stale 8-column map, so user_login and
 * body_r2_key — written by the canonical store seam
 * (services/scheduledReports.ts, the table's single writer
 * contract) — leaked through reads unmapped under snake_case
 * keys and the typed record hid the owner entirely. This
 * port's record completes the map: CanonicalReportRecord is
 * ScheduledReportRecord + userLogin + bodyR2Key, and adapters
 * map both columns. The write side does NOT move: the door
 * stays storeReportAtGeneration (one writer, generation-id
 * idempotency), reached through the facade's
 * storeCanonicalReport exactly as before; the fan-out's leg
 * outcomes are step 3c (#2347), untouched here.
 *
 * #2347 update (step 3c): the fan-out contract landed — the
 * record gains fanoutOutcome (the fanout_outcome column's raw
 * JSON; parse with parseFanoutOutcome in
 * services/scheduledReports.ts), recorded by the one seam at
 * store time. The write side still does not move.
 *
 * #CDO-mha7
 */
import type { ScheduledReportRecord } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

/** A mas_reports row with the completed column map. */
export interface CanonicalReportRecord extends ScheduledReportRecord {
  /** Owning tenant login (mas_reports.user_login, #584). */
  userLogin?: string;
  /** R2 object key of the report body, when stored out-of-line. */
  bodyR2Key?: string;
  /** Recorded fan-out outcome JSON (#2347), when the seam recorded one. */
  fanoutOutcome?: string;
}

export interface CanonicalReportPort
  extends RepositoryPort<CanonicalReportRecord> {}
