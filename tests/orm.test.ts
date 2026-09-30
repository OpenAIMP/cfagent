import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

describe("DatabaseORM & Repositories", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
  });

  describe("Categories Repository", () => {
    it("seeds default referral categories", () => {
      const categories = orm.categories.findMany();
      expect(categories.length).toBeGreaterThanOrEqual(5);

      const aiCat = categories.find((c) => c.name === "AI & Dev Tools");
      expect(aiCat).toBeDefined();
      expect(aiCat?.icon).toBe("🤖");
      expect(aiCat?.isActive).toBe(true);
    });

    it("creates, finds, updates, and deletes a category", () => {
      const now = new Date().toISOString();
      const created = orm.categories.create({
        id: "cat_test_web3",
        name: "Web3 & Blockchain",
        slug: "web3-blockchain",
        description: "Crypto and decentralized tooling",
        icon: "⚡",
        isActive: true,
        sortOrder: 99,
        createdAt: now,
        updatedAt: now,
      });

      expect(created.id).toBe("cat_test_web3");

      const found = orm.categories.findById("cat_test_web3");
      expect(found).toBeDefined();
      expect(found?.name).toBe("Web3 & Blockchain");

      const updated = orm.categories.update("cat_test_web3", {
        name: "Web3 & Zero-Knowledge",
        description: "Updated description",
      });
      expect(updated?.name).toBe("Web3 & Zero-Knowledge");

      const deleted = orm.categories.delete("cat_test_web3");
      expect(deleted).toBe(true);

      const notFound = orm.categories.findById("cat_test_web3");
      expect(notFound).toBeNull();
    });
  });

  describe("External Ads & Monetization Repository", () => {
    it("seeds default external ad placements", () => {
      const ads = orm.externalAds.findMany();
      expect(ads.length).toBeGreaterThanOrEqual(3);

      const ethicalAd = ads.find((a) => a.network === "ethicalads");
      expect(ethicalAd).toBeDefined();
      expect(ethicalAd?.cpmRate).toBe(18.5);
    });

    it("tracks impressions and calculates CPM earnings correctly", () => {
      const ad = orm.externalAds.findById("ext_ethicalads_dev")!;
      const initialImpressions = ad.impressions;
      const initialEarnings = ad.earnings;

      const incremental = ad.cpmRate / 1000;
      const updated = orm.externalAds.update(ad.id, {
        impressions: initialImpressions + 1,
        earnings: Math.round((initialEarnings + incremental) * 1000) / 1000,
      });

      expect(updated?.impressions).toBe(initialImpressions + 1);
      expect(updated?.earnings).toBeGreaterThan(initialEarnings);
    });

    it("tracks clicks and calculates CPC earnings correctly", () => {
      const ad = orm.externalAds.findById("ext_carbon_infra")!;
      const initialClicks = ad.clicks;
      const initialEarnings = ad.earnings;

      const incremental = ad.cpcRate;
      const updated = orm.externalAds.update(ad.id, {
        clicks: initialClicks + 1,
        earnings: Math.round((initialEarnings + incremental) * 100) / 100,
      });

      expect(updated?.clicks).toBe(initialClicks + 1);
      expect(updated?.earnings).toBe(initialEarnings + incremental);
    });
  });

  describe("Transactions Ledger Repository", () => {
    it("creates a transaction record with DID signatures", () => {
      const now = new Date().toISOString();
      const tx = orm.transactions.create({
        id: "pay_test_unit",
        sessionId: "user_test",
        action: "charge",
        amount: 50.0,
        currency: "USD",
        customer: "Acme Enterprise",
        gateway: "stripe",
        gatewayRef: "cs_test_stripe_ref",
        status: "completed",
        checkoutUrl: "https://checkout.stripe.com/pay_test",
        proposerDid: "did:agent:openaimp:payments",
        authorizerDid: "did:user:github:mubasher",
        proofSignature: "0x_sig_test_proof",
        note: "500,000 AI Token Credits",
        createdAt: now,
        updatedAt: now,
      });

      expect(tx.id).toBe("pay_test_unit");
      expect(tx.amount).toBe(50.0);

      const found = orm.transactions.findById("pay_test_unit");
      expect(found).toBeDefined();
      expect(found?.status).toBe("completed");
      expect(found?.authorizerDid).toBe("did:user:github:mubasher");
    });
  });

  describe("Schema Introspection & Querying", () => {
    it("listTables() returns all 9 relational tables with descriptions and column types", () => {
      const tables = orm.listTables();
      expect(tables.length).toBe(9);

      const catTable = tables.find((t) => t.name === "mas_categories");
      expect(catTable).toBeDefined();
      expect(catTable?.columns.length).toBeGreaterThan(5);
      expect(catTable?.columns.some((c) => c.name === "id" && c.isPrimary)).toBe(true);

      const tradesTable = tables.find((t) => t.name === "mas_trades");
      expect(tradesTable).toBeDefined();
      expect(tradesTable?.columns.some((c) => c.name === "symbol")).toBe(true);
      expect(tradesTable?.columns.some((c) => c.name === "proposer_did")).toBe(true);

      const extTable = tables.find((t) => t.name === "mas_external_ads");
      expect(extTable).toBeDefined();
      expect(extTable?.columns.some((c) => c.name === "cpm_rate")).toBe(true);
    });

    it("getTableData() retrieves records with pagination and search", () => {
      const data = orm.getTableData("mas_categories", { limit: 2 });
      expect(data.tableName).toBe("mas_categories");
      expect(data.rows.length).toBe(2);
      expect(data.total).toBeGreaterThanOrEqual(5);

      const searchResult = orm.getTableData("mas_categories", { search: "Cloud" });
      expect(searchResult.rows.some((r) => r.name.includes("Cloud"))).toBe(true);
    });
  });

  describe("Platform Revenue Calculation", () => {
    it("getRevenueSummary() accurately computes multi-stream platform financials", () => {
      const summary = orm.getRevenueSummary();

      expect(summary.grossRevenue).toBeGreaterThan(0);
      expect(summary.adNetworkRevenue).toBeGreaterThan(0);
      expect(summary.marketplaceRevenue).toBeGreaterThan(0);
      expect(summary.paymentPlatformFees).toBeGreaterThanOrEqual(0);
      expect(summary.netRevenue).toBeGreaterThanOrEqual(0);
      expect(summary.totalImpressions).toBeGreaterThan(0);
      expect(summary.averageRPM).toBeGreaterThan(0);
    });
  });
});
