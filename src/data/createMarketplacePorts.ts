/**
 * src/data/createMarketplacePorts.ts — #2345 (#1976 step 3a,
 * ADR 0022 D-A): the synchronous composition root for the
 * marketplace ports over a DO-SQLite handle — the
 * AGENT_DB-unbound composition (and the shape tests compose
 * directly). For the env-driven production build (D1 when
 * bound), see buildMarketplacePorts.ts.
 *
 * #CDO-mha7
 */
import { createDoMarketplaceAdapters } from "./doSqliteMarketplaceAdapter";
import type { MarketplacePorts } from "./marketplacePorts";
import type { SqlStorage } from "./repositoryPorts";

/** Compose the marketplace ports over one instance's storage. */
export function createMarketplacePorts(sql: SqlStorage): MarketplacePorts {
  return createDoMarketplaceAdapters(sql);
}
