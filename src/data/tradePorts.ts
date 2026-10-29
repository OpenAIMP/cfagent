/**
 * src/data/tradePorts.ts — #2345 (#1976 step 3a, ADR 0022
 * D-A): the mas_trades port. DO residency (D-0 (a),(b),(e)):
 * order records are per-instance execution state.
 *
 * #CDO-mha7
 */
import type { TradeRecord } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

export interface TradePort extends RepositoryPort<TradeRecord> {}
