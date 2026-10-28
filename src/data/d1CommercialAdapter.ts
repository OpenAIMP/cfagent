/**
 * Issues #2015/#2020/#2022 — Drizzle D1 adapter for the commercial
 * store port. This module is the ONLY place commercial-store code
 * touches a store client: all SQL-adjacent code (the Drizzle query
 * builder) lives here, behind the port interface.
 *
 * Transactions: every operation is a single statement (one INSERT,
 * one SELECT, one UPDATE), which is atomic on any store. No
 * multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's `db.transaction()`
 * is sequential BEGIN/COMMIT, not Postgres-equivalent atomicity on
 * D1). The redemption claim is a single PK insert: the loser of a
 * race gets a UNIQUE violation and re-checks, never a double spend.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  agentCommercialAccounts,
  agentCreditClaims,
  agentCreditRedemptions,
  agentTenantSettings,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0007_COMMERCIAL_STORE,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertIncludedRuns,
  assertNonNegativeCredits,
  assertStoreTier,
  round2,
  type CommercialAccountRecord,
  type CommercialStore,
  type CreditClaimRecord,
  type CreditRedemptionRecord,
  type TenantSettingsRecord,
} from "./commercialPorts";

/** Drizzle D1 database object carrying the commercial schema. */
export type CommercialDb = DrizzleD1Database<{
  agentCommercialAccounts: typeof agentCommercialAccounts;
  agentTenantSettings: typeof agentTenantSettings;
  agentCreditClaims: typeof agentCreditClaims;
  agentCreditRedemptions: typeof agentCreditRedemptions;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1CommercialDb(d1: D1Database): CommercialDb {
  return drizzle(d1, {
    schema: {
      agentCommercialAccounts,
      agentTenantSettings,
      agentCreditClaims,
      agentCreditRedemptions,
    },
  });
}

/** Idempotent schema-ensure: applies migration 0007 if unapplied. */
export async function ensureCommercialSchema(db: CommercialDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0007_COMMERCIAL_STORE]);
}

function toAccount(raw: typeof agentCommercialAccounts.$inferSelect): CommercialAccountRecord {
  return {
    id: raw.id,
    tenantId: raw.tenantId,
    tier: assertStoreTier(raw.tier),
    creditsUSD: raw.creditsUSD,
    includedRuns: raw.includedRuns,
    updatedAtMs: raw.updatedAtMs,
  };
}

/** Commercial store over D1 via Drizzle. */
export class D1CommercialAdapter implements CommercialStore {
  constructor(readonly db: CommercialDb) {}

  async getAccount(userId: string): Promise<CommercialAccountRecord | null> {
    const rows = await this.db
      .select()
      .from(agentCommercialAccounts)
      .where(eq(agentCommercialAccounts.id, userId))
      .limit(1);
    return rows.length === 0 ? null : toAccount(rows[0]);
  }

  async upsertAccount(input: {
    userId: string;
    tenantId: string;
    tier: unknown;
    creditsUSD?: unknown;
    includedRuns?: unknown;
  }): Promise<CommercialAccountRecord> {
    if (!input.userId || !input.tenantId) {
      throw new Error("userId and tenantId are required.");
    }
    const record: CommercialAccountRecord = {
      id: input.userId,
      tenantId: input.tenantId,
      tier: assertStoreTier(input.tier),
      creditsUSD: input.creditsUSD === undefined ? 0 : assertNonNegativeCredits(input.creditsUSD),
      includedRuns: input.includedRuns === undefined ? 0 : assertIncludedRuns(input.includedRuns),
      updatedAtMs: Date.now(),
    };
    await this.db
      .insert(agentCommercialAccounts)
      .values({
        id: record.id,
        tenantId: record.tenantId,
        tier: record.tier,
        creditsUSD: record.creditsUSD,
        includedRuns: record.includedRuns,
        updatedAtMs: record.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentCommercialAccounts.id,
        set: {
          tenantId: record.tenantId,
          tier: record.tier,
          creditsUSD: record.creditsUSD,
          includedRuns: record.includedRuns,
          updatedAtMs: record.updatedAtMs,
        },
      });
    return record;
  }

  async adjustCredits(userId: string, deltaUSD: number): Promise<CommercialAccountRecord> {
    const account = await this.getAccount(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    const next = round2(account.creditsUSD + deltaUSD);
    if (next < 0) throw new Error("Credits cannot go below zero.");
    await this.db
      .update(agentCommercialAccounts)
      .set({ creditsUSD: next, updatedAtMs: Date.now() })
      .where(eq(agentCommercialAccounts.id, userId));
    return { ...account, creditsUSD: next, updatedAtMs: Date.now() };
  }

  async consumeIncludedRun(userId: string): Promise<CommercialAccountRecord> {
    const account = await this.getAccount(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    if (account.includedRuns <= 0) throw new Error("No included runs remaining.");
    await this.db
      .update(agentCommercialAccounts)
      .set({ includedRuns: account.includedRuns - 1, updatedAtMs: Date.now() })
      .where(eq(agentCommercialAccounts.id, userId));
    return { ...account, includedRuns: account.includedRuns - 1, updatedAtMs: Date.now() };
  }

  async consumeCredits(userId: string, amountUSD: number): Promise<CommercialAccountRecord> {
    const account = await this.getAccount(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    const amount = round2(amountUSD);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("amountUSD must be a positive finite number.");
    }
    if (account.creditsUSD < amount) throw new Error("Insufficient credits.");
    await this.db
      .update(agentCommercialAccounts)
      .set({ creditsUSD: round2(account.creditsUSD - amount), updatedAtMs: Date.now() })
      .where(eq(agentCommercialAccounts.id, userId));
    return { ...account, creditsUSD: round2(account.creditsUSD - amount), updatedAtMs: Date.now() };
  }

  async getTenantAdsEnabled(tenantId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(agentTenantSettings)
      .where(eq(agentTenantSettings.tenantId, tenantId))
      .limit(1);
    return rows.length === 0 ? true : rows[0].adsEnabled === 1;
  }

  async setTenantAdsEnabled(tenantId: string, adsEnabled: boolean): Promise<TenantSettingsRecord> {
    const record: TenantSettingsRecord = { tenantId, adsEnabled, updatedAtMs: Date.now() };
    await this.db
      .insert(agentTenantSettings)
      .values({ tenantId, adsEnabled: adsEnabled ? 1 : 0, updatedAtMs: record.updatedAtMs })
      .onConflictDoUpdate({
        target: agentTenantSettings.tenantId,
        set: { adsEnabled: adsEnabled ? 1 : 0, updatedAtMs: record.updatedAtMs },
      });
    return record;
  }

  async recordCreditClaim(claim: {
    creditRunId: string;
    userId: string;
    family: string;
    amountUSD: number;
  }): Promise<CreditClaimRecord> {
    const record: CreditClaimRecord = {
      creditRunId: claim.creditRunId,
      userId: claim.userId,
      family: claim.family,
      amountUSD: round2(claim.amountUSD),
      createdAtMs: Date.now(),
    };
    // INSERT OR IGNORE: re-recording the same claim is a no-op.
    await this.db
      .insert(agentCreditClaims)
      .values({
        creditRunId: record.creditRunId,
        userId: record.userId,
        family: record.family,
        amountUSD: record.amountUSD,
        createdAtMs: record.createdAtMs,
      })
      .onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(agentCreditClaims)
      .where(eq(agentCreditClaims.creditRunId, record.creditRunId))
      .limit(1);
    return {
      creditRunId: rows[0].creditRunId,
      userId: rows[0].userId,
      family: rows[0].family,
      amountUSD: rows[0].amountUSD,
      createdAtMs: rows[0].createdAtMs,
    };
  }

  async findUnredeemedCredit(
    userId: string,
    family: string,
  ): Promise<{ creditRunId: string; amountUSD: number } | null> {
    const rows = await this.db
      .select({
        creditRunId: agentCreditClaims.creditRunId,
        amountUSD: agentCreditClaims.amountUSD,
      })
      .from(agentCreditClaims)
      .leftJoin(
        agentCreditRedemptions,
        eq(agentCreditRedemptions.creditRunId, agentCreditClaims.creditRunId),
      )
      .where(
        and(
          eq(agentCreditClaims.userId, userId),
          eq(agentCreditClaims.family, family),
          isNull(agentCreditRedemptions.creditRunId),
        ),
      )
      .orderBy(asc(agentCreditClaims.createdAtMs), asc(agentCreditClaims.creditRunId))
      .limit(1);
    return rows.length === 0 ? null : { creditRunId: rows[0].creditRunId, amountUSD: rows[0].amountUSD };
  }

  async redeemCredit(creditRunId: string, redeemedByRunId: string): Promise<CreditRedemptionRecord> {
    const record: CreditRedemptionRecord = {
      creditRunId,
      redeemedByRunId,
      redeemedAtMs: Date.now(),
    };
    try {
      await this.db.insert(agentCreditRedemptions).values({
        creditRunId: record.creditRunId,
        redeemedByRunId: record.redeemedByRunId,
        redeemedAtMs: record.redeemedAtMs,
      });
    } catch {
      // A PK violation means the credit was already claimed — by a
      // concurrent submission or a replay. Re-check before reporting.
      const existing = await this.db
        .select()
        .from(agentCreditRedemptions)
        .where(eq(agentCreditRedemptions.creditRunId, creditRunId))
        .limit(1);
      if (existing.length > 0) throw new Error(`Credit ${creditRunId} already redeemed.`);
      throw new Error(`Failed to redeem credit ${creditRunId}.`);
    }
    return record;
  }
}
