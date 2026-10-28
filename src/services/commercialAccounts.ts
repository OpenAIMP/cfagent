/**
 * Minimal commercial account store (#2015/#2020, tenant ads setting
 * #2022 folded into the store decision).
 *
 * Two layers, mirroring src/payments/ledger.ts:
 *
 * 1. ORM operations (get/upsert/adjust/consume/redeem) — pure
 *    functions over a DatabaseORM. These run on whichever instance
 *    serves the request.
 * 2. A canonical-instance client — the store's source of truth is
 *    the shared orchestrator instance (SHARED_ORCHESTRATOR_INSTANCE),
 *    because each DO instance has isolated storage. Callers that
 *    must read/write the authoritative store (the paid-submission
 *    route, the payment workflow adapter, the ads handler) go
 *    through the client, never through a local ORM read. Direct
 *    endpoint reads on a non-canonical instance see that
 *    instance's store only and are not authoritative.
 *
 * Scope, stated plainly: v1 is operator-managed. There is no
 * subscription purchase flow, no referral-credit earn/vest/redeem
 * rules, and no multi-tenant membership resolution here — those
 * are #1623/#1598 work. One row per user, one tenant per user.
 * Operator writes are gated by the COMMERCIAL_STORE_OPERATORS
 * allowlist env var (comma-separated logins; empty = deny all),
 * the same fail-closed precedent as PAYMENT_ASSURANCE_LIVE_LOGINS.
 */
import type { DatabaseORM } from "../orm";
import type {
  CommercialAccountRecord,
  CreditRedemptionRecord,
  Env,
  TenantSettingsRecord,
  TransactionRecord,
} from "../types";
import type { CommercialAccount } from "./cfpayMonetization";
import {
  getServiceUserLogin,
  SHARED_ORCHESTRATOR_INSTANCE,
} from "../security/serviceIdentity";

export const CFPAY_LEDGER_SESSION_PREFIX = "screener-payment:";
export const COMMERCIAL_STORE_OPERATORS_ENV = "COMMERCIAL_STORE_OPERATORS";

const VALID_TIERS = ["Free", "PayPerUse", "Subscribed"] as const;
export type StoreTier = (typeof VALID_TIERS)[number];

function nowIso(): string {
  return new Date().toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function assertStoreTier(tier: unknown): StoreTier {
  if (typeof tier !== "string" || !(VALID_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`Invalid tier: ${String(tier)} (expected Free, PayPerUse, or Subscribed).`);
  }
  return tier as StoreTier;
}

function assertNonNegative(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a finite number >= 0.`);
  }
  return n;
}

/** Operator allowlist: empty (or unset) denies every operator write. */
export function isStoreOperator(env: Env, login: string | null): boolean {
  if (!login) return false;
  const raw = (env as unknown as Record<string, unknown>)[COMMERCIAL_STORE_OPERATORS_ENV];
  if (typeof raw !== "string") return false;
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.length > 0 && allowed.includes(login);
}

/** A caller may read/write only their own account, unless operator. */
export function canAccessAccount(env: Env, login: string | null, userId: string): boolean {
  if (!login) return false;
  return login === userId || isStoreOperator(env, login);
}

// ---------------------------------------------------------------- ORM ops

export function getCommercialAccount(
  orm: DatabaseORM,
  userId: string,
): CommercialAccountRecord | null {
  return orm.commercialAccounts.findOne({ id: userId });
}

export function upsertCommercialAccount(
  orm: DatabaseORM,
  input: {
    userId: string;
    tenantId: string;
    tier: unknown;
    creditsUSD?: unknown;
    includedRuns?: unknown;
  },
): CommercialAccountRecord {
  if (!input.userId || !input.tenantId) {
    throw new Error("upsertCommercialAccount requires userId and tenantId.");
  }
  const tier = assertStoreTier(input.tier);
  const creditsUSD = round2(assertNonNegative(input.creditsUSD ?? 0, "creditsUSD"));
  const includedRuns = Math.floor(assertNonNegative(input.includedRuns ?? 0, "includedRuns"));
  const record: CommercialAccountRecord = {
    id: input.userId,
    tenantId: input.tenantId,
    tier,
    creditsUSD,
    includedRuns,
    updatedAt: nowIso(),
  };
  return orm.commercialAccounts.upsert(record);
}

export function adjustCommercialCredits(
  orm: DatabaseORM,
  userId: string,
  deltaUSD: number,
): CommercialAccountRecord {
  const record = getCommercialAccount(orm, userId);
  if (!record) throw new Error(`No commercial account for user ${userId}.`);
  const next = round2(record.creditsUSD + deltaUSD);
  if (next < 0) throw new Error(`Credit adjustment would take ${userId} below zero.`);
  return orm.commercialAccounts.update(userId, { creditsUSD: next, updatedAt: nowIso() }) ?? record;
}

export function consumeIncludedRun(
  orm: DatabaseORM,
  userId: string,
): CommercialAccountRecord {
  const record = getCommercialAccount(orm, userId);
  if (!record) throw new Error(`No commercial account for user ${userId}.`);
  if (record.includedRuns <= 0) throw new Error(`No included runs remaining for ${userId}.`);
  return (
    orm.commercialAccounts.update(userId, {
      includedRuns: record.includedRuns - 1,
      updatedAt: nowIso(),
    }) ?? record
  );
}

export function consumeCredits(
  orm: DatabaseORM,
  userId: string,
  amountUSD: number,
): CommercialAccountRecord {
  const record = getCommercialAccount(orm, userId);
  if (!record) throw new Error(`No commercial account for user ${userId}.`);
  if (record.creditsUSD < amountUSD) {
    throw new Error(`Insufficient credits for ${userId}: ${record.creditsUSD} < ${amountUSD}.`);
  }
  return (
    orm.commercialAccounts.update(userId, {
      creditsUSD: round2(record.creditsUSD - amountUSD),
      updatedAt: nowIso(),
    }) ?? record
  );
}

/** Gate-shape account: a stored record, or a Free default for the run's tenant. */
export function toCommercialAccount(
  userId: string,
  record: CommercialAccountRecord | null,
  email: string,
  fallbackTenantId: string,
): CommercialAccount {
  if (!record) {
    return {
      userId,
      email,
      tenantId: fallbackTenantId,
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    };
  }
  return {
    userId: record.id,
    email,
    tenantId: record.tenantId,
    tier: record.tier,
    creditsUSD: record.creditsUSD,
    includedRunsRemaining: record.includedRuns,
  };
}

// ------------------------------------------------------------ tenant settings

/** Absent = ads enabled (the tier rule governs). */
export function getTenantAdsEnabled(
  orm: DatabaseORM,
  tenantId: string,
): boolean {
  const record = orm.tenantSettings.findOne({ tenantId });
  return record ? record.adsEnabled : true;
}

export function setTenantAdsEnabled(
  orm: DatabaseORM,
  tenantId: string,
  adsEnabled: boolean,
): TenantSettingsRecord {
  return orm.tenantSettings.upsert({ tenantId, adsEnabled, updatedAt: nowIso() });
}

// ---------------------------------------------------------------- redemption

function parseAuditPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function creditRowRunId(row: TransactionRecord): string | null {
  const sessionId = String(row.sessionId ?? "");
  return sessionId.startsWith(CFPAY_LEDGER_SESSION_PREFIX)
    ? sessionId.slice(CFPAY_LEDGER_SESSION_PREFIX.length)
    : null;
}

/**
 * Oldest unredeemed failure credit for (user, family), or null.
 * Family comes from the payment.failure_credit_issued audit payload
 * joined on run id — never from parsing ledger note text. Credits
 * whose audit row carries no family (pre-amendment rows) are NOT
 * auto-redeemable; that is the safe direction, and operator
 * re-issue is the fallback for those.
 */
export function findUnredeemedCredit(
  orm: DatabaseORM,
  userId: string,
  family: string,
): { creditRunId: string; amountUSD: number } | null {
  const redeemed = new Set(
    orm.creditRedemptions.findMany().map((r) => r.creditRunId),
  );
  const familyByRun = new Map<string, string>();
  for (const event of orm.events.findMany({ where: { type: "payment.failure_credit_issued" } })) {
    const payload = parseAuditPayload((event as { payload?: unknown }).payload);
    const run = typeof payload["runRequestId"] === "string" ? (payload["runRequestId"] as string) : "";
    const fam = typeof payload["family"] === "string" ? (payload["family"] as string) : "";
    if (run && fam) familyByRun.set(run, fam);
  }
  const candidates = orm.transactions
    .findMany()
    .filter(
      (t) =>
        // "credit" is not in main's TransactionRecord action union
        // yet (it arrives with #2019/#2089); compare as a string so
        // this branch typechecks on main today and matches the rows
        // once they exist.
        (t.action as string) === "credit" &&
        t.customer === userId &&
        creditRowRunId(t) !== null &&
        !redeemed.has(creditRowRunId(t) as string) &&
        familyByRun.get(creditRowRunId(t) as string) === family,
    )
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const first = candidates[0];
  if (!first) return null;
  return { creditRunId: creditRowRunId(first) as string, amountUSD: Number(first.amount) || 0 };
}

/**
 * Claim a credit. The primary key makes a second redemption
 * impossible; a concurrent claim surfaces as AlreadyRedeemed, never
 * as a second spend.
 */
export function redeemCredit(
  orm: DatabaseORM,
  creditRunId: string,
  redeemedByRunId: string,
): CreditRedemptionRecord {
  const existing = orm.creditRedemptions.findById(creditRunId);
  if (existing) throw new Error(`Credit ${creditRunId} was already redeemed.`);
  try {
    return orm.creditRedemptions.create({
      creditRunId,
      redeemedByRunId,
      redeemedAt: nowIso(),
    });
  } catch (err) {
    // Lost race: someone claimed it between the check and the insert.
    if (orm.creditRedemptions.findById(creditRunId)) {
      throw new Error(`Credit ${creditRunId} was already redeemed.`);
    }
    throw err;
  }
}

// ------------------------------------------------------- canonical-instance client

function canonicalStub(env: Env): { fetch(input: Request): Promise<Response> } {
  const agent = (env as unknown as { SEARCH_AGENT?: { idFromName(n: string): unknown; get(id: unknown): { fetch(input: Request): Promise<Response> } } }).SEARCH_AGENT;
  if (!agent || typeof agent.idFromName !== "function" || typeof agent.get !== "function") {
    throw new Error("Commercial store owner is not bound (SEARCH_AGENT).");
  }
  return agent.get(agent.idFromName(SHARED_ORCHESTRATOR_INSTANCE));
}

function serviceLogin(env: Env): string {
  const login = getServiceUserLogin(env);
  if (!login) throw new Error("Commercial store service identity is not configured.");
  return login;
}

async function callStore(
  env: Env,
  path: string,
  method: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const stub = canonicalStub(env);
  const res = await stub.fetch(
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        "x-user-login": serviceLogin(env),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Commercial store ${method} ${path} failed (${res.status}): ${typeof data["error"] === "string" ? (data["error"] as string) : "unknown error"}`,
    );
  }
  return data;
}

export async function fetchStoreAccount(
  env: Env,
  userId: string,
): Promise<CommercialAccountRecord | null> {
  const data = await callStore(env, `/payments/agentic/commercial/account?userId=${encodeURIComponent(userId)}`, "GET");
  return (data["record"] as CommercialAccountRecord | null) ?? null;
}

export async function upsertStoreAccount(
  env: Env,
  input: { userId: string; tenantId: string; tier: string; creditsUSD?: number; includedRuns?: number },
): Promise<CommercialAccountRecord> {
  const data = await callStore(env, "/payments/agentic/commercial/account", "POST", input);
  return data["record"] as CommercialAccountRecord;
}

export async function adjustStoreCredits(
  env: Env,
  userId: string,
  deltaUSD: number,
): Promise<CommercialAccountRecord> {
  const data = await callStore(env, "/payments/agentic/commercial/account/credits", "POST", { userId, deltaUSD });
  return data["record"] as CommercialAccountRecord;
}

/** kind "included" consumes one included run; kind "credits" consumes amountUSD of credits. */
export async function consumeStoreCoverage(
  env: Env,
  userId: string,
  kind: "included" | "credits",
  amountUSD?: number,
): Promise<CommercialAccountRecord> {
  const data = await callStore(env, "/payments/agentic/commercial/account/consume", "POST", { userId, kind, amountUSD });
  return data["record"] as CommercialAccountRecord;
}

export async function fetchStoreTenantAdsEnabled(
  env: Env,
  tenantId: string,
): Promise<boolean> {
  const data = await callStore(env, `/payments/agentic/commercial/tenant-settings?tenantId=${encodeURIComponent(tenantId)}`, "GET");
  return data["adsEnabled"] === false ? false : true;
}

export async function setStoreTenantAdsEnabled(
  env: Env,
  tenantId: string,
  adsEnabled: boolean,
): Promise<TenantSettingsRecord> {
  const data = await callStore(env, "/payments/agentic/commercial/tenant-settings", "POST", { tenantId, adsEnabled });
  return data["record"] as TenantSettingsRecord;
}

export async function fetchStoreUnredeemedCredit(
  env: Env,
  userId: string,
  family: string,
): Promise<{ creditRunId: string; amountUSD: number } | null> {
  const data = await callStore(
    env,
    `/payments/agentic/commercial/unredeemed-credit?userId=${encodeURIComponent(userId)}&family=${encodeURIComponent(family)}`,
    "GET",
  );
  return (data["credit"] as { creditRunId: string; amountUSD: number } | null) ?? null;
}

export async function redeemStoreCredit(
  env: Env,
  creditRunId: string,
  redeemedByRunId: string,
): Promise<CreditRedemptionRecord> {
  const data = await callStore(env, "/payments/agentic/commercial/redeem-credit", "POST", { creditRunId, redeemedByRunId });
  return data["redemption"] as CreditRedemptionRecord;
}
