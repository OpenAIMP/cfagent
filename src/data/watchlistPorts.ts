/**
 * src/data/watchlistPorts.ts — #2345 (#1976 step 3a, ADR 0022
 * D-A): the mas_watchlists port. DO residency (D-0 (a),(b),
 * (e),(f)): per-user watchlists are tenant state of the
 * owning instance. The facade's saveWatchlist/getWatchlists
 * helpers compose over this port unchanged.
 *
 * #CDO-mha7
 */
import type { WatchlistRecord } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

export interface WatchlistPort extends RepositoryPort<WatchlistRecord> {}
