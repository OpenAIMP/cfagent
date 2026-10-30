/**
 * Issue #2362 (#1976 step 4f) — composition root for the
 * resource rollup store port: the ONLY module that maps a D1
 * binding to the port implementation for this family.
 * Domain code imports this helper and the port types, never
 * a store client.
 */
import { D1ResourceRollupStore } from "./d1ResourceRollupAdapter";
import type { ResourceD1Db } from "./d1ResourceUsageAdapter";
import type { ResourceRollupStorePort } from "./resourceRollupPorts";

export function createResourceRollupStore(db: ResourceD1Db): ResourceRollupStorePort {
  return new D1ResourceRollupStore(db);
}

export type { AlertState, ResourceRollupStorePort } from "./resourceRollupPorts";
export type { ResourceD1Db } from "./d1ResourceUsageAdapter";
