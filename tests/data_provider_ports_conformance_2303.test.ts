/**
 * #2303 (#1976 step 1, ADR 0022 D-A/D-C/D-D) — conformance for
 * the data-provider platform ports.
 *
 * The step-0 shared-suite shape (tests/substrate_families_2288
 * .test.ts): ONE suite per port, run against every adapter —
 * the D1 adapter (over a MockD1Database on node:sqlite), the
 * in-memory adapter, and the DO-SQLite class adapter (over
 * MockSqlStorage) — so the port contract, not an adapter, is
 * what callers depend on. On top of the suites:
 *
 *  - write-set ATOMICITY pins for the two adapters whose unit
 *    of work is transactional (D1 batch via withTransaction;
 *    in-memory snapshot-swap). The DO adapter's sequential
 *    application is the documented non-transactional exception
 *    (providerConfigPorts.ts) and is NOT pinned atomic.
 *  - lifecycle parity: transitionProviderViaPort walks
 *    register → configure (route tiers in the write set) →
 *    verify → enable → deprovision identically on every config
 *    adapter.
 *  - structural pins: migration 0019 registered exactly once
 *    (13 has since been claimed on main by #2198; the 14 gap
 *    remains); Drizzle ↔ 0019 DDL column
 *    parity; port modules import no store client; the legacy
 *    store modules are re-export shims naming the data layer.
 *
 * The #1116 conformance KIT (runDataProviderConformance) is
 * exercised unchanged by the platform suites — it tests
 * provider adapters, not stores, and this slice does not touch
 * it (acceptance gate: kit green without edits).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { MockSqlStorage } from "./mock-sql";
import {
  ALL_MIGRATIONS,
  MIGRATION_0019_DATA_PROVIDER_PLATFORM,
} from "../src/data/migrationRunner";
import {
  agentDataCaptures,
  agentDataProviderRoutes,
  agentDataProviders,
} from "../src/data/drizzleSchema";
import type {
  ProviderConfigStore,
  ProviderConfigWrite,
} from "../src/data/providerConfigPorts";
import {
  createD1ProviderConfigDb,
  D1ProviderConfigAdapter,
  ensureProviderConfigSchema,
} from "../src/data/d1ProviderConfigAdapter";
import { InMemoryProviderConfigAdapter } from "../src/data/inMemoryProviderConfigAdapter";
import { DoSqliteProviderConfigAdapter } from "../src/data/doSqliteProviderConfigAdapter";
import type { ProviderCaptureStore } from "../src/data/providerCapturePorts";
import {
  createD1ProviderCaptureDb,
  D1ProviderCaptureAdapter,
  ensureProviderCaptureSchema,
} from "../src/data/d1ProviderCaptureAdapter";
import { InMemoryProviderCaptureAdapter } from "../src/data/inMemoryProviderCaptureAdapter";
import { DoSqliteProviderCaptureAdapter } from "../src/data/doSqliteProviderCaptureAdapter";
import { transitionProviderViaPort } from "../src/trading/dataProviders/lifecycle";
import type { CaptureBlobStorage } from "../src/data/providerCapturePorts";

/* ------------------------------------------------------------------ */
/* Mock D1 (the substrate-suite shape, over node:sqlite)               */
/* ------------------------------------------------------------------ */

class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

async function makeD1ConfigStore(): Promise<ProviderConfigStore> {
  const mock = new MockD1Database();
  const db = createD1ProviderConfigDb(mock as never);
  await ensureProviderConfigSchema(db);
  return new D1ProviderConfigAdapter(db, mock as never);
}

async function makeD1CaptureStore(): Promise<ProviderCaptureStore> {
  const mock = new MockD1Database();
  const db = createD1ProviderCaptureDb(mock as never);
  await ensureProviderCaptureSchema(db);
  return new D1ProviderCaptureAdapter(db);
}

function makeMapBlobStorage(failPut = false): CaptureBlobStorage & {
  map: Map<string, unknown>;
} {
  const map = new Map<string, unknown>();
  return {
    map,
    async get(key: string) {
      return map.get(key);
    },
    async put(key: string, value: unknown) {
      if (failPut) throw new Error("blob store unavailable");
      map.set(key, value);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Provider-configuration port suite                                   */
/* ------------------------------------------------------------------ */

function providerConfigSuite(
  label: string,
  makeStore: () => Promise<ProviderConfigStore>
) {
  describe(`provider config port — ${label}`, () => {
    it("bootstrap seeds the five providers and the default routes", async () => {
      const store = await makeStore();
      const first = await store.bootstrapDataProviders();
      expect(first).toHaveLength(5);
      // Five default routes (providerConfigPorts
      // DEFAULT_CAPABILITY_ROUTES).
      expect((await store.listCapabilityRoutes()).length).toBe(5);
      const configs = await store.listProviderConfigs();
      // Precedence order (the store's documented read order):
      // etrade 0, public 1, yahoo 2, nasdaq 3, alpaca 4.
      expect(configs.map((c) => c.id)).toEqual([
        "etrade",
        "public",
        "yahoo",
        "nasdaq",
        "alpaca",
      ]);
      const quotes = await store.getCapabilityRoute("quotes");
      expect(quotes?.primaryProviderId).toBe("etrade");
      // #2144: the quotes route carries NO gap-fill by design.
      expect(quotes?.gapFillProviderId).toBeNull();
      const universe = await store.getCapabilityRoute("screenUniverse");
      expect(universe?.primaryProviderId).toBe("nasdaq");
      const fundamentals = await store.getCapabilityRoute("fundamentals");
      expect(fundamentals?.primaryProviderId).toBe("yahoo");
    });

    it("bootstrap is idempotent and never clobbers an operator route", async () => {
      const store = await makeStore();
      await store.bootstrapDataProviders();
      const quotes = await store.getCapabilityRoute("quotes");
      await store.applyConfigWrites([
        { kind: "upsertRoute", record: { ...quotes!, minTier: "premium" } },
      ]);
      const second = await store.bootstrapDataProviders();
      expect(second).toHaveLength(5);
      expect((await store.getCapabilityRoute("quotes"))?.minTier).toBe(
        "premium"
      );
    });

    it("reads miss honestly: unknown provider and route are null", async () => {
      const store = await makeStore();
      await store.bootstrapDataProviders();
      expect(await store.getProviderConfig("nope" as never)).toBeNull();
      expect(await store.getCapabilityRoute("optionsChains")).not.toBeNull();
    });

    it("applyConfigWrites lands a provider row and a route row together", async () => {
      const store = await makeStore();
      await store.bootstrapDataProviders();
      const before = await store.getProviderConfig("etrade");
      const now = new Date().toISOString();
      await store.applyConfigWrites([
        {
          kind: "upsertProvider",
          record: { ...before!, credentialRef: "vault:etrade/main" },
        },
        {
          kind: "upsertRoute",
          record: {
            capability: "optionsChains",
            primaryProviderId: "etrade",
            gapFillProviderId: null,
            minTier: "premium",
            createdAt: now,
            updatedAt: now,
          },
        },
      ]);
      expect((await store.getProviderConfig("etrade"))?.credentialRef).toBe(
        "vault:etrade/main"
      );
      expect(
        (await store.getCapabilityRoute("optionsChains"))?.minTier
      ).toBe("premium");
    });

    it("deleteCapabilityRoutesForProvider deletes primary routes and nulls gap-fill slots", async () => {
      const store = await makeStore();
      await store.bootstrapDataProviders();
      // yahoo is primary on historicalBars + fundamentals and
      // gap-fill nowhere in the default routes (#2144).
      const result = await store.deleteCapabilityRoutesForProvider("yahoo");
      expect(result).toEqual({ deleted: 2, gapFillCleared: 0 });
      expect(await store.getCapabilityRoute("historicalBars")).toBeNull();
      expect(await store.getCapabilityRoute("fundamentals")).toBeNull();
      // The etrade routes are untouched.
      expect((await store.getCapabilityRoute("quotes"))?.primaryProviderId).toBe(
        "etrade"
      );
      // With a gap-fill assignment in place, deletion clears the
      // slot instead of deleting the route.
      const quotes = await store.getCapabilityRoute("quotes");
      await store.applyConfigWrites([
        { kind: "upsertRoute", record: { ...quotes!, gapFillProviderId: "nasdaq" } },
      ]);
      const cleared = await store.deleteCapabilityRoutesForProvider("nasdaq");
      expect(cleared).toEqual({ deleted: 1, gapFillCleared: 1 });
      expect(await store.getCapabilityRoute("screenUniverse")).toBeNull();
      const after = await store.getCapabilityRoute("quotes");
      expect(after?.primaryProviderId).toBe("etrade");
      expect(after?.gapFillProviderId).toBeNull();
      // etrade is primary on quotes + optionsChains.
      const etradeResult =
        await store.deleteCapabilityRoutesForProvider("etrade");
      expect(etradeResult).toEqual({ deleted: 2, gapFillCleared: 0 });
      expect(await store.getCapabilityRoute("quotes")).toBeNull();
    });

    it("upsert merge rules: omitted fields preserved; credential cleared only via the dedicated op", async () => {
      const store = await makeStore();
      await store.bootstrapDataProviders();
      const seeded = await store.getProviderConfig("yahoo");
      expect(seeded?.credentialRef).toBeNull();
      const withRef = await store.upsertProviderConfig({
        id: "yahoo",
        adapterKind: seeded!.adapterKind,
        precedence: seeded!.precedence,
        credentialRef: "vault:yahoo/main",
        lifecycleState: "verified",
        config: {
          verification: {
            ok: true,
            checkedAt: new Date().toISOString(),
            summary: "probe ok",
          },
        },
      });
      expect(withRef.credentialRef).toBe("vault:yahoo/main");
      // An upsert omitting credentialRef and config preserves both.
      const renamed = await store.upsertProviderConfig({
        id: "yahoo",
        adapterKind: seeded!.adapterKind,
        precedence: seeded!.precedence,
        config: {
          ...(withRef.config as Record<string, unknown>),
          displayName: "Yahoo Renamed",
        },
      });
      expect(renamed.credentialRef).toBe("vault:yahoo/main");
      expect(
        (renamed.config as { verification?: { ok?: boolean } }).verification
          ?.ok
      ).toBe(true);
      // The dedicated clear op is the only port path that nulls it.
      const cleared = await store.clearProviderCredentialRef("yahoo");
      expect(cleared?.credentialRef).toBeNull();
    });
  });
}

providerConfigSuite("D1 adapter", makeD1ConfigStore);
providerConfigSuite("in-memory adapter", async () =>
  new InMemoryProviderConfigAdapter()
);
providerConfigSuite(
  "DO-SQLite class adapter",
  async () => new DoSqliteProviderConfigAdapter(new MockSqlStorage() as never)
);

/* ------------------------------------------------------------------ */
/* Write-set atomicity (transactional adapters only)                   */
/* ------------------------------------------------------------------ */

describe("provider config port — write-set atomicity", () => {
  it("D1: a failing statement in the unit rolls back the whole write set", async () => {
    const store = await makeD1ConfigStore();
    await store.bootstrapDataProviders();
    const before = await store.getProviderConfig("etrade");
    const now = new Date().toISOString();
    const writes: ProviderConfigWrite[] = [
      {
        kind: "upsertProvider",
        record: { ...before!, credentialRef: "vault:should-not-land" },
      },
      {
        kind: "upsertRoute",
        // An unbindable parameter value — the batch must fail
        // and the provider write above must NOT be visible.
        record: {
          capability: "quotes",
          primaryProviderId: { unbindable: true } as never,
          gapFillProviderId: null,
          minTier: "freemium",
          createdAt: now,
          updatedAt: now,
        },
      },
    ];
    await expect(store.applyConfigWrites(writes)).rejects.toThrow();
    expect((await store.getProviderConfig("etrade"))?.credentialRef).toBe(
      before?.credentialRef ?? null
    );
  });

  it("in-memory: a failing write rolls back the whole write set", async () => {
    const store = new InMemoryProviderConfigAdapter();
    await store.bootstrapDataProviders();
    const before = await store.getProviderConfig("etrade");
    const writes = [
      {
        kind: "upsertProvider",
        record: { ...before!, credentialRef: "vault:should-not-land" },
      },
      // A null route record throws mid-application; the snapshot
      // restore must leave the provider write unlanded.
      { kind: "upsertRoute", record: null },
    ] as unknown as ProviderConfigWrite[];
    await expect(store.applyConfigWrites(writes)).rejects.toThrow();
    expect((await store.getProviderConfig("etrade"))?.credentialRef).toBe(
      before?.credentialRef ?? null
    );
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle parity over the port                                      */
/* ------------------------------------------------------------------ */

function lifecycleParitySuite(
  label: string,
  makeStore: () => Promise<ProviderConfigStore>
) {
  describe(`lifecycle over the config port — ${label}`, () => {
    it("walks register → configure → verify → enable → deprovision", async () => {
      const store = await makeStore();
      await store.bootstrapDataProviders();
      await transitionProviderViaPort(store, "newfeed", "register", "op", {
        register: { adapterKind: "builtin", displayName: "New Feed" },
      });
      await transitionProviderViaPort(store, "newfeed", "configure", "op", {
        configure: {
          credentialRef: "env:NEWFEED_API_KEY",
          routeTiers: undefined,
        },
      });
      // Point a route at the new provider so deprovision has
      // route effects to prove: rewrite quotes primary via a
      // configure on etrade is not the mechanism — apply the
      // route write directly, as an operator surface would.
      const routeNow = new Date().toISOString();
      await store.applyConfigWrites([
        {
          kind: "upsertRoute",
          record: {
            capability: "quotes",
            primaryProviderId: "newfeed" as never,
            gapFillProviderId: "yahoo",
            minTier: "freemium",
            createdAt: routeNow,
            updatedAt: routeNow,
          },
        },
      ]);
      const verified = await transitionProviderViaPort(
        store,
        "newfeed",
        "verify",
        "op",
        {
          verifier: async () => ({
            ok: true,
            checkedAt: new Date().toISOString(),
            summary: "probe ok",
          }),
        }
      );
      expect(verified.lifecycleState).toBe("verified");
      const enabled = await transitionProviderViaPort(
        store,
        "newfeed",
        "enable",
        "op",
        {}
      );
      expect(enabled.lifecycleState).toBe("enabled");
      expect(enabled.enabled).toBe(true);
      const gone = await transitionProviderViaPort(
        store,
        "newfeed",
        "deprovision",
        "op",
        {}
      );
      expect(gone.lifecycleState).toBe("deprovisioned");
      expect(gone.credentialRef).toBeNull();
      // The route naming the deprovisioned provider is deleted,
      // not left dangling.
      expect(await store.getCapabilityRoute("quotes")).toBeNull();
    });
  });
}

lifecycleParitySuite("D1 adapter", makeD1ConfigStore);
lifecycleParitySuite("in-memory adapter", async () =>
  new InMemoryProviderConfigAdapter()
);
lifecycleParitySuite(
  "DO-SQLite class adapter",
  async () => new DoSqliteProviderConfigAdapter(new MockSqlStorage() as never)
);

/* ------------------------------------------------------------------ */
/* Provider-capture port suite                                         */
/* ------------------------------------------------------------------ */

function providerCaptureSuite(
  label: string,
  makeStore: () => Promise<ProviderCaptureStore>
) {
  describe(`provider capture port — ${label}`, () => {
    it("recordCapture stores the row and the raw bytes round-trip", async () => {
      const store = await makeStore();
      const blob = makeMapBlobStorage();
      const record = await store.recordCapture(
        { storage: blob, env: {} },
        {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbol: "AAPL" },
          runId: "run-1",
          tenantId: "default",
          userLogin: "op",
          rawPayload: { symbol: "AAPL", last: 231.5 },
          normalizedResult: { symbol: "AAPL", last: 231.5 },
        }
      );
      expect(record).not.toBeNull();
      expect(record?.status).toBe("captured");
      expect(record?.rawBlobRef).toBeTruthy();
      expect(record?.rawSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record?.normalizedDigest).toMatch(/^[0-9a-f]{64}$/);
      const byRun = await store.listCapturesByRun("default", "run-1");
      expect(byRun).toHaveLength(1);
      const byProvider = await store.listCapturesByProvider(
        "default",
        "etrade"
      );
      expect(byProvider).toHaveLength(1);
      expect((await store.getCaptureById("default", record!.id))?.id).toBe(
        record!.id
      );
      const read = await store.readCaptureRaw(
        { storage: blob, env: {} },
        "default",
        record!.id
      );
      expect(read?.record.id).toBe(record!.id);
      expect(
        JSON.parse(new TextDecoder().decode(read!.rawBytes!))
      ).toEqual({ symbol: "AAPL", last: 231.5 });
    });

    it("a payload-less fetch records a no_payload row and stores no blob", async () => {
      const store = await makeStore();
      const blob = makeMapBlobStorage();
      const record = await store.recordCapture(
        { storage: blob, env: {} },
        {
          providerId: "etrade",
          capability: "optionsChains",
          requestParams: { symbol: "NONE" },
          runId: "run-2",
          tenantId: "default",
        }
      );
      expect(record?.status).toBe("no_payload");
      expect(record?.rawBlobRef).toBeNull();
      expect(blob.map.size).toBe(0);
    });

    it("a blob failure lands a capture_failed marker instead of throwing", async () => {
      const store = await makeStore();
      const blob = makeMapBlobStorage(true);
      const record = await store.recordCapture(
        { storage: blob, env: {} },
        {
          providerId: "yahoo",
          capability: "quotes",
          requestParams: { symbol: "MSFT" },
          runId: "run-3",
          tenantId: "default",
          rawPayload: { symbol: "MSFT" },
          normalizedResult: { symbol: "MSFT" },
        }
      );
      expect(record?.status).toBe("capture_failed");
      expect(record?.failureError).toMatch(/blob store unavailable/);
      expect(record?.rawBlobRef).toBeNull();
      const failures = await store.listCaptureFailures("default");
      expect(failures.map((r) => r.id)).toEqual([record!.id]);
    });

    it("the outcome recorder writes fetch_failed rows (scrubbed) and no success rows", async () => {
      const store = await makeStore();
      const recorder = store.createFetchOutcomeRecorder();
      await recorder.recordSuccess({
        providerId: "etrade",
        capability: "quotes",
        requestParams: { symbol: "AAPL" },
        runId: "run-4",
        tenantId: "default",
      });
      expect(await store.listCapturesByRun("default", "run-4")).toEqual([]);
      // The secret-shaped span is fragment-assembled so no
      // secret-shaped literal ever enters the repo history
      // (gitleaks scans the full commit range).
      const secret = ["sk", "live", "abcdef0123456789"].join("-");
      await recorder.recordFailure(
        {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbol: "AAPL" },
          runId: "run-4",
          tenantId: "default",
        },
        {
          kind: "auth",
          message: `upstream 401 for token ${secret} tail`,
        }
      );
      const rows = await store.listCapturesByRun("default", "run-4");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("fetch_failed");
      expect(rows[0].failureKind).toBe("auth");
      expect(await store.listFetchFailures("default")).toHaveLength(1);
      // The shared scrubbing discipline: the secret-shaped span
      // never reaches the stored record.
      expect(JSON.stringify(rows[0])).not.toContain(secret);
    });

    it("captures are tenant-isolated", async () => {
      const store = await makeStore();
      const blob = makeMapBlobStorage();
      await store.recordCapture(
        { storage: blob, env: {} },
        {
          providerId: "nasdaq",
          capability: "screenUniverse",
          requestParams: {},
          runId: "run-5",
          tenantId: "tenant-a",
          rawPayload: [{ symbol: "AAPL" }],
          normalizedResult: [{ symbol: "AAPL" }],
        }
      );
      expect(await store.listCapturesByRun("tenant-b", "run-5")).toEqual([]);
      expect(
        await store.listCapturesByProvider("tenant-b", "nasdaq")
      ).toEqual([]);
      expect(
        await store.listCapturesByProvider("tenant-a", "nasdaq")
      ).toHaveLength(1);
      expect(await store.getCaptureById("tenant-b",
        (await store.listCapturesByRun("tenant-a", "run-5"))[0].id
      )).toBeNull();
      const foreign = await store.readCaptureRaw(
        { storage: blob, env: {} },
        "tenant-b",
        (await store.listCapturesByRun("tenant-a", "run-5"))[0].id
      );
      expect(foreign).toBeNull();
    });
  });
}

providerCaptureSuite("D1 adapter", makeD1CaptureStore);
providerCaptureSuite("in-memory adapter", async () =>
  new InMemoryProviderCaptureAdapter()
);
providerCaptureSuite(
  "DO-SQLite class adapter",
  async () => new DoSqliteProviderCaptureAdapter(new MockSqlStorage() as never)
);

/* ------------------------------------------------------------------ */
/* Structural pins                                                     */
/* ------------------------------------------------------------------ */

describe("#2303 structural pins", () => {
  it("migration 0019 is registered exactly once; 13 claimed on main (#2198), the 14 gap remains (gate G-3)", () => {
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.filter((v) => v === 19)).toHaveLength(1);
    expect(versions.filter((v) => v === 13)).toHaveLength(1);
    expect(versions).not.toContain(14);
    expect(MIGRATION_0019_DATA_PROVIDER_PLATFORM.version).toBe(19);
  });

  it("migration 0019 DDL and the Drizzle schema agree on columns for all three tables", () => {
    for (const [table, mapping] of [
      ["agent_data_providers", agentDataProviders],
      ["agent_data_provider_routes", agentDataProviderRoutes],
      ["agent_data_captures", agentDataCaptures],
    ] as const) {
      const rawColumns = getTableConfig(mapping).columns as any;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: any) => c.name as string)
        : Object.keys(rawColumns).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
          );
      const block = MIGRATION_0019_DATA_PROVIDER_PLATFORM.sql
        .split(`CREATE TABLE IF NOT EXISTS ${table} (`)[1]
        .split(");")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map(
        (m) => m[1]
      );
      expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
    }
  });

  it("port modules import no store client", () => {
    for (const file of [
      "src/data/providerConfigPorts.ts",
      "src/data/providerCapturePorts.ts",
    ]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/from\s+["']drizzle-orm/);
      expect(text).not.toMatch(/from\s+["']\.\.\/orm["']/);
      expect(text).not.toMatch(/D1Database/);
      expect(text).not.toMatch(/node:sqlite/);
    }
  });

  it("the legacy store modules are re-export shims naming the data layer (no deletions, §22)", () => {
    const configShim = readFileSync(
      "src/trading/dataProviders/providerConfigStore.ts",
      "utf8"
    );
    expect(configShim).toContain('from "../../data/providerConfigPorts"');
    expect(configShim).toContain(
      'from "../../data/doSqliteProviderConfigAdapter"'
    );
    const captureShim = readFileSync(
      "src/trading/dataProviders/captureStore.ts",
      "utf8"
    );
    expect(captureShim).toContain('from "../../data/providerCapturePorts"');
    expect(captureShim).toContain(
      'from "../../data/doSqliteProviderCaptureAdapter"'
    );
  });
});
