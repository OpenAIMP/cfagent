// @vitest-environment node
/**
 * Issue #2303 (#1976 step 1) — CHARACTERIZATION pins for the
 * data-provider platform stores, written against the UNMODIFIED
 * #1116 code before the port cutover. They pin the current
 * behaviour of providerConfigStore + captureStore through their
 * existing public surfaces (the same import paths the cutover
 * turns into delegations/shims):
 *
 *  - seeding: the five owner providers in precedence order, the
 *    five default routes, NOTHING seeded enabled; seeding is
 *    idempotent and never resets an operator's lifecycle state;
 *  - bootstrap: etrade — and only etrade — enabled; a repeat
 *    bootstrap leaves the stored records identical;
 *  - upsert merge rules: omitted fields preserved (incl.
 *    createdAt), an omitted/null credentialRef on upsert KEEPS
 *    the stored reference; the dedicated clear actually clears;
 *  - routes: an omitted minTier on upsert preserves the stored
 *    tier; deprovision-withdrawal semantics (primary rows
 *    deleted, gap-fill slots cleared, counts reported);
 *  - registry resolution inputs: after bootstrap, etrade is
 *    servable for optionsChains; quotes NEVER resolves a
 *    gap-fill (#2144), even when a stored route declares one;
 *  - captures: a payload capture stores blob bytes that read
 *    back byte-for-byte, with sha256 over the payload and the
 *    canonical-JSON digest of the normalized result; a
 *    payload-less fetch records an honest no_payload row; a
 *    failed blob write returns (and persists) a capture_failed
 *    marker — recordCapture never throws; a fetch failure
 *    records a fetch_failed row with a scrubbed, bounded
 *    message; every read is tenant-scoped;
 *  - health inputs: the derivation over a mixed log (captured /
 *    capture_failed / fetch_failed) — which failure kind moves
 *    which rate, the streak rules, and no-data honesty;
 *  - lifecycle: the legal map's spot checks through
 *    transitionProvider, incl. deprovision's side effects
 *    (routes withdrawn, credential reference cleared,
 *    verification evidence dropped) and a rejected move
 *    changing NOTHING while emitting exactly one audit event.
 *
 * These pins must be green before the cutover and green after
 * it, unchanged — that is what makes the cutover a behaviour-
 * preserving move rather than a rewrite.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  bootstrapDataProviders,
  seedProviderConfigs,
  getProviderConfig,
  listProviderConfigs,
  upsertProviderConfig,
  setProviderLifecycleState,
  setProviderEnabled,
  clearProviderCredentialRef,
  getCapabilityRoute,
  listCapabilityRoutes,
  upsertCapabilityRoute,
  deleteCapabilityRoutesForProvider,
  type ProviderConfigRecord,
} from "../src/trading/dataProviders/providerConfigStore";
import {
  recordCapture,
  recordFetchFailure,
  getCaptureById,
  listCapturesByRun,
  listCapturesByProvider,
  listCaptureFailures,
  listFetchFailures,
  readCaptureRaw,
  canonicalJson,
  sha256Hex,
  type CaptureBlobDeps,
} from "../src/trading/dataProviders/captureStore";
import { aggregateProviderHealth } from "../src/trading/dataProviders/providerHealth";
import {
  transitionProvider,
  ProviderLifecycleError,
  type ProviderLifecycleAuditEvent,
} from "../src/trading/dataProviders/lifecycle";
import { DataProviderRegistry } from "../src/trading/dataProviders/registry";
import type { DataProvider } from "../src/trading/dataProviders/contract";

function freshSql(): any {
  return new MockSqlStorage() as any;
}

function fakeBlobStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function blobDeps(storage: any = fakeBlobStorage()): CaptureBlobDeps {
  return { storage, env: {} };
}

/* ------------------------------------------------------------------ */
/* Provider configuration — seeding, bootstrap, merge rules            */
/* ------------------------------------------------------------------ */

describe("#2303 characterization — provider config seeding + bootstrap", () => {
  it("seeds the five owner providers in precedence order, none enabled, public merely registered", () => {
    const sql = freshSql();
    const configs = seedProviderConfigs(sql);
    expect(configs.map((c) => c.id)).toEqual([
      "etrade",
      "public",
      "yahoo",
      "nasdaq",
      "alpaca",
    ]);
    expect(configs.every((c) => !c.enabled)).toBe(true);
    expect(configs.find((c) => c.id === "etrade")?.lifecycleState).toBe("configured");
    expect(configs.find((c) => c.id === "public")?.lifecycleState).toBe("registered");
    expect(configs.find((c) => c.id === "etrade")?.credentialRef).toBe(
      "sessionstore:etrade:token"
    );
  });

  it("seeds the five default routes with quotes on etrade and no news route", () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const routes = listCapabilityRoutes(sql);
    expect(routes.map((r) => r.capability)).toEqual([
      "fundamentals",
      "historicalBars",
      "optionsChains",
      "quotes",
      "screenUniverse",
    ]);
    const quotes = getCapabilityRoute(sql, "quotes");
    expect(quotes?.primaryProviderId).toBe("etrade");
    expect(quotes?.gapFillProviderId).toBeNull();
    expect(quotes?.minTier).toBe("freemium");
    expect(getCapabilityRoute(sql, "news")).toBeNull();
  });

  it("seeding is idempotent and never resets an operator's lifecycle state", () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    setProviderLifecycleState(sql, "yahoo", "verified");
    setProviderEnabled(sql, "yahoo", true);
    const before = listProviderConfigs(sql);
    seedProviderConfigs(sql);
    expect(listProviderConfigs(sql)).toEqual(before);
    expect(getProviderConfig(sql, "yahoo")?.lifecycleState).toBe("verified");
  });

  it("bootstrap enables etrade only; a repeat bootstrap changes nothing", () => {
    const sql = freshSql();
    const first = bootstrapDataProviders(sql);
    const etrade = first.find((c) => c.id === "etrade");
    expect(etrade?.lifecycleState).toBe("enabled");
    expect(etrade?.enabled).toBe(true);
    for (const other of first.filter((c) => c.id !== "etrade")) {
      expect(other.enabled).toBe(false);
      expect(other.lifecycleState).not.toBe("enabled");
    }
    const second = bootstrapDataProviders(sql);
    expect(second).toEqual(first);
  });
});

describe("#2303 characterization — upsert merge rules + setters", () => {
  it("a partial upsert preserves lifecycle, enabled flag, credential ref, config and createdAt", () => {
    const sql = freshSql();
    const created = upsertProviderConfig(sql, {
      id: "yahoo",
      adapterKind: "yahoo-finance",
      lifecycleState: "verified",
      enabled: true,
      precedence: 3,
      credentialRef: "env:YAHOO_KEY",
      config: { region: "us" },
    });
    const updated = upsertProviderConfig(sql, {
      id: "yahoo",
      adapterKind: "yahoo-finance",
      precedence: 7,
    });
    expect(updated.precedence).toBe(7);
    expect(updated.lifecycleState).toBe("verified");
    expect(updated.enabled).toBe(true);
    expect(updated.credentialRef).toBe("env:YAHOO_KEY");
    expect(updated.config).toEqual({ region: "us" });
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("an explicit null credentialRef on upsert KEEPS the stored reference; the dedicated clear removes it", () => {
    const sql = freshSql();
    upsertProviderConfig(sql, {
      id: "alpaca",
      adapterKind: "alpaca-market-data",
      precedence: 5,
      credentialRef: "env:ALPACA_API_KEY",
    });
    const kept = upsertProviderConfig(sql, {
      id: "alpaca",
      adapterKind: "alpaca-market-data",
      precedence: 5,
      credentialRef: null,
    });
    expect(kept.credentialRef).toBe("env:ALPACA_API_KEY");
    const cleared = clearProviderCredentialRef(sql, "alpaca");
    expect(cleared?.credentialRef).toBeNull();
    expect(getProviderConfig(sql, "alpaca")?.credentialRef).toBeNull();
  });

  it("setters on an unknown provider return null and write nothing", () => {
    const sql = freshSql();
    expect(setProviderLifecycleState(sql, "nope" as any, "enabled")).toBeNull();
    expect(setProviderEnabled(sql, "nope" as any, true)).toBeNull();
    expect(clearProviderCredentialRef(sql, "nope" as any)).toBeNull();
    expect(listProviderConfigs(sql)).toEqual([]);
  });

  it("a route upsert with omitted minTier preserves the stored tier; an explicit tier replaces it", () => {
    const sql = freshSql();
    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: null,
      minTier: "premium",
    });
    const preserved = upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: "yahoo",
    });
    expect(preserved.minTier).toBe("premium");
    expect(preserved.gapFillProviderId).toBe("yahoo");
    const replaced = upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: null,
      minTier: "freemium",
    });
    expect(replaced.minTier).toBe("freemium");
  });

  it("route withdrawal deletes primary rows and clears gap-fill slots, reporting both counts", () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    upsertCapabilityRoute(sql, {
      capability: "fundamentals",
      primaryProviderId: "yahoo",
      gapFillProviderId: "etrade",
    });
    const result = deleteCapabilityRoutesForProvider(sql, "etrade");
    // etrade is primary on quotes + optionsChains (2 deletes) and
    // gap-fill on fundamentals (1 clear).
    expect(result).toEqual({ deleted: 2, gapFillCleared: 1 });
    expect(getCapabilityRoute(sql, "quotes")).toBeNull();
    expect(getCapabilityRoute(sql, "fundamentals")?.gapFillProviderId).toBeNull();
    expect(getCapabilityRoute(sql, "fundamentals")?.primaryProviderId).toBe("yahoo");
  });
});

/* ------------------------------------------------------------------ */
/* Registry resolution inputs                                          */
/* ------------------------------------------------------------------ */

function stubProvider(id: string, capabilities: string[]): DataProvider {
  return { id: id as any, capabilities: capabilities as any } as DataProvider;
}

describe("#2303 characterization — registry resolution over the seeded store", () => {
  it("before bootstrap nothing resolves; after bootstrap etrade serves optionsChains", () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const registry = new DataProviderRegistry();
    registry.register(stubProvider("etrade", ["optionsChains", "quotes"]));
    expect(() =>
      registry.resolveRoute(
        "optionsChains",
        listProviderConfigs(sql),
        listCapabilityRoutes(sql)
      )
    ).toThrow(/No enabled data provider/);
    bootstrapDataProviders(sql);
    const assignment = registry.resolveRoute(
      "optionsChains",
      listProviderConfigs(sql),
      listCapabilityRoutes(sql)
    );
    expect(assignment.primary.id).toBe("etrade");
  });

  it("quotes never resolves a gap-fill (#2144), even when the stored route declares one", () => {
    const sql = freshSql();
    bootstrapDataProviders(sql);
    setProviderLifecycleState(sql, "yahoo", "enabled");
    setProviderEnabled(sql, "yahoo", true);
    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: "yahoo",
    });
    const registry = new DataProviderRegistry();
    registry.register(stubProvider("etrade", ["quotes"]));
    registry.register(stubProvider("yahoo", ["quotes"]));
    const assignment = registry.resolveRoute(
      "quotes",
      listProviderConfigs(sql),
      listCapabilityRoutes(sql)
    );
    expect(assignment.primary.id).toBe("etrade");
    expect(assignment.gapFill).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Captures                                                            */
/* ------------------------------------------------------------------ */

describe("#2303 characterization — capture records", () => {
  it("a payload capture stores bytes that read back exactly, with payload sha + canonical digest", async () => {
    const sql = freshSql();
    const deps = blobDeps();
    const raw = { QuoteResponse: { QuoteData: [{ symbol: "AAPL" }] } };
    const normalized = { symbol: "AAPL", lastPrice: 232.5 };
    const record = await recordCapture(sql, deps, {
      providerId: "etrade",
      capability: "quotes",
      requestParams: { symbol: "AAPL" },
      runId: "run-1",
      tenantId: "default",
      userLogin: "alice",
      rawPayload: raw,
      rawKind: "provider-response",
      normalizedResult: normalized,
    });
    expect(record.status).toBe("captured");
    expect(record.rawKind).toBe("provider-response");
    expect(record.retentionClass).toBe("retained-365d");
    const expectedBytes = new TextEncoder().encode(JSON.stringify(raw));
    expect(record.rawByteSize).toBe(expectedBytes.byteLength);
    expect(record.rawSha256).toBe(await sha256Hex(expectedBytes));
    expect(record.normalizedDigest).toBe(
      await sha256Hex(canonicalJson(normalized))
    );
    const read = await readCaptureRaw(sql, deps, "default", record.id);
    expect(read?.rawBytes).toEqual(expectedBytes);
    expect(listCapturesByRun(sql, "default", "run-1").map((r) => r.id)).toEqual([
      record.id,
    ]);
  });

  it("a payload-less fetch records an honest no_payload row, not a fabricated raw", async () => {
    const sql = freshSql();
    const record = await recordCapture(sql, blobDeps(), {
      providerId: "etrade",
      capability: "optionsChains",
      requestParams: { symbol: "AAPL" },
      runId: "run-2",
      tenantId: "default",
    });
    expect(record.status).toBe("no_payload");
    expect(record.rawBlobRef).toBeNull();
    expect(record.failureError).toMatch(/no payload/i);
    const read = await readCaptureRaw(sql, blobDeps(), "default", record.id);
    expect(read?.rawBytes).toBeNull();
  });

  it("a failed blob write returns and persists a capture_failed marker — recordCapture never throws", async () => {
    const sql = freshSql();
    const failing = {
      get: async (_k: string) => undefined,
      put: async (_k: string, _v: unknown) => {
        throw new Error("forced blob put failure");
      },
    };
    const record = await recordCapture(sql, blobDeps(failing), {
      providerId: "yahoo",
      capability: "historicalBars",
      requestParams: { symbol: "AAPL" },
      runId: "run-3",
      tenantId: "default",
      rawPayload: { bars: [] },
    });
    expect(record.status).toBe("capture_failed");
    expect(record.failureError).toMatch(/forced blob put failure/);
    expect(record.rawBlobRef).toBeNull();
    expect(listCaptureFailures(sql, "default").map((r) => r.id)).toEqual([
      record.id,
    ]);
  });

  it("a fetch failure records a fetch_failed row with the message scrubbed and bounded", async () => {
    const sql = freshSql();
    const secret = ["sk", "live", "abcdef0123456789"].join("-");
    const record = await recordFetchFailure(sql, {
      providerId: "etrade",
      capability: "quotes",
      requestParams: { symbol: "AAPL" },
      runId: "run-4",
      tenantId: "default",
      kind: "auth",
      message: `401 from upstream with key ${secret} ${"x".repeat(400)}`,
    });
    expect(record.status).toBe("fetch_failed");
    expect(record.failureKind).toBe("auth");
    expect(record.failureMessage).not.toContain(secret);
    expect((record.failureMessage ?? "").length).toBeLessThanOrEqual(200);
    expect(listFetchFailures(sql, "default").map((r) => r.id)).toEqual([
      record.id,
    ]);
  });

  it("every capture read is tenant-scoped: a cross-tenant read returns nothing", async () => {
    const sql = freshSql();
    const record = await recordCapture(sql, blobDeps(), {
      providerId: "etrade",
      capability: "quotes",
      requestParams: {},
      runId: "run-5",
      tenantId: "tenant-a",
      rawPayload: { ok: true },
    });
    expect(getCaptureById(sql, "tenant-b", record.id)).toBeNull();
    expect(listCapturesByRun(sql, "tenant-b", "run-5")).toEqual([]);
    expect(listCapturesByProvider(sql, "tenant-b", "etrade")).toEqual([]);
    expect(
      await readCaptureRaw(sql, blobDeps(), "tenant-b", record.id)
    ).toBeNull();
  });

  it("resolveRunContext-free inputs keep caller attribution verbatim (run/tenant/login)", async () => {
    const sql = freshSql();
    const record = await recordCapture(sql, blobDeps(), {
      providerId: "nasdaq",
      capability: "screenUniverse",
      requestParams: {},
      runId: "run-6",
      tenantId: "tenant-x",
      userLogin: "bob",
      rawPayload: [{ symbol: "AAPL" }],
    });
    expect(record.runId).toBe("run-6");
    expect(record.tenantId).toBe("tenant-x");
    expect(record.userLogin).toBe("bob");
    expect(record.requestParams).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* Health derivation inputs                                            */
/* ------------------------------------------------------------------ */

describe("#2303 characterization — health aggregation over the capture log", () => {
  const T0 = Date.parse("2026-10-29T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  async function seedLog(sql: any) {
    const deps = blobDeps();
    const base = {
      providerId: "etrade" as const,
      capability: "quotes" as const,
      requestParams: {},
      tenantId: "default",
    };
    await recordCapture(sql, deps, { ...base, runId: "r1", fetchedAt: iso(T0), rawPayload: { a: 1 } });
    await recordFetchFailure(sql, { ...base, runId: "r2", fetchedAt: iso(T0 + 1000), kind: "upstream", message: "boom" });
    await recordFetchFailure(sql, { ...base, runId: "r3", fetchedAt: iso(T0 + 2000), kind: "upstream", message: "boom" });
    await recordFetchFailure(sql, { ...base, runId: "r4", fetchedAt: iso(T0 + 3000), kind: "timeout", message: "slow" });
  }

  it("an empty log is no-data with zeroed aggregates, never an invented green", () => {
    const sql = freshSql();
    const health = aggregateProviderHealth(sql, "default", "etrade", T0);
    expect(health.status).toBe("no-data");
    expect(health.totalCaptures).toBe(0);
  });

  it("three consecutive failures derive down; capture and fetch failure rates stay separate", async () => {
    const sql = freshSql();
    await seedLog(sql);
    const health = aggregateProviderHealth(sql, "default", "etrade", T0 + 4000);
    expect(health.totalCaptures).toBe(4);
    expect(health.capturedCount).toBe(1);
    // failureRate counts capture_failed ONLY (none here)…
    expect(health.failedCount).toBe(0);
    expect(health.failureRate).toBe(0);
    // …while the fetch dimension counts the three fetch_failed rows.
    expect(health.fetchFailures).toBe(3);
    expect(health.fetchFailureRate).toBe(0.75);
    expect(health.consecutiveFailures).toBe(3);
    expect(health.latestFetchFailureKind).toBe("timeout");
    expect(health.status).toBe("down");
    expect(health.byCapability.quotes?.totalCaptures).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle transitions                                               */
/* ------------------------------------------------------------------ */

describe("#2303 characterization — lifecycle transitions + side effects", () => {
  it("walks register → configure → verify → enable with one audit event per attempt", async () => {
    const sql = freshSql();
    const events: ProviderLifecycleAuditEvent[] = [];
    const audit = (e: ProviderLifecycleAuditEvent) => events.push(e);
    await transitionProvider(sql, "acme", "register", "op", {
      audit,
      register: { adapterKind: "acme-feed", precedence: 9 },
    });
    await transitionProvider(sql, "acme", "configure", "op", {
      audit,
      configure: { credentialRef: "env:ACME_KEY" },
    });
    const verified = await transitionProvider(sql, "acme", "verify", "op", {
      audit,
      verifier: async () => ({ ok: true, summary: "probe ok" }),
    });
    expect(verified.config.verification).toMatchObject({ verifiedBy: "op" });
    const enabled = await transitionProvider(sql, "acme", "enable", "op", { audit });
    expect(enabled.lifecycleState).toBe("enabled");
    expect(enabled.enabled).toBe(true);
    expect(events.map((e) => `${e.action}:${e.outcome}`)).toEqual([
      "register:accepted",
      "configure:accepted",
      "verify:accepted",
      "enable:accepted",
    ]);
  });

  it("an illegal move throws, changes NOTHING, and still emits exactly one (rejected) audit event", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    const before: ProviderConfigRecord[] = listProviderConfigs(sql);
    const events: ProviderLifecycleAuditEvent[] = [];
    await expect(
      transitionProvider(sql, "yahoo", "enable", "op", {
        audit: (e) => events.push(e),
      })
    ).rejects.toMatchObject({
      name: "ProviderLifecycleError",
      code: "illegal_transition",
    });
    expect(listProviderConfigs(sql)).toEqual(before);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("rejected");
  });

  it("deprovision withdraws routes, clears the credential reference and drops verification evidence", async () => {
    const sql = freshSql();
    seedProviderConfigs(sql);
    await transitionProvider(sql, "etrade", "configure", "op", {
      configure: { credentialRef: "sessionstore:etrade:token" },
    });
    await transitionProvider(sql, "etrade", "verify", "op", {
      verifier: async () => ({ ok: true, summary: "ok" }),
    });
    const gone = await transitionProvider(sql, "etrade", "deprovision", "op", {});
    expect(gone.lifecycleState).toBe("deprovisioned");
    expect(gone.enabled).toBe(false);
    expect(gone.credentialRef).toBeNull();
    expect(gone.config.verification).toBeUndefined();
    expect(getCapabilityRoute(sql, "quotes")).toBeNull();
    expect(getCapabilityRoute(sql, "optionsChains")).toBeNull();
  });
});
