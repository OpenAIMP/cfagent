/**
 * src/data/optionsChainCachePorts.ts — #2345 (#1976 step 3a,
 * ADR 0022 D-A): the mas_options_chain_cache port (id field
 * = upper-cased symbol). DO residency (D-0 (a),(b),(e)).
 * The facade's getOptionsChain/setOptionsChain helpers
 * compose over this port unchanged (TTL checked on read).
 *
 * #CDO-mha7
 */
import type { OptionsChainCacheRecord } from "../types";
import type { RepositoryPort } from "./repositoryPorts";

export interface OptionsChainCachePort
  extends RepositoryPort<OptionsChainCacheRecord> {}
