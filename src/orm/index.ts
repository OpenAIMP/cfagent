/**
 * Multi-Agent Studio Database ORM
 * Type-safe, repository-pattern Object-Relational Mapping layer for SQLite running on Durable Objects.
 */

import type {
  CategoryRecord,
  ReferralRecord,
  AdRecord,
  ExternalAdRecord,
  TransactionRecord,
  MessageRecord,
  MemoryRecord,
  AuditEvent,
  RevenueSummary,
} from "../types";

export interface SqlStorage {
  exec: (query: string, ...args: unknown[]) => Iterable<unknown>;
}

export interface QueryOptions {
  where?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export interface TableMetadata {
  name: string;
  description: string;
  rowCount: number;
  columns: Array<{ name: string; type: string; isPrimary: boolean }>;
}

export class Repository<T extends Record<string, any>> {
  constructor(
    protected sql: SqlStorage,
    public readonly tableName: string,
    protected idField: string = "id",
    protected columnMap: Record<keyof T & string, string>
  ) {}

  private toDbCol(key: string): string {
    return this.columnMap[key] || key;
  }

  private fromDbRow(row: any): T {
    const obj: any = {};
    const reverseMap: Record<string, string> = {};
    for (const [prop, col] of Object.entries(this.columnMap)) {
      reverseMap[col] = prop;
    }

    for (const [key, val] of Object.entries(row)) {
      const propName = reverseMap[key] || key;
      // Handle boolean SQLite mapping (0/1 to boolean)
      if (typeof val === "number" && (key.startsWith("is_") || key === "is_active")) {
        obj[propName] = Boolean(val);
      } else {
        obj[propName] = val;
      }
    }
    return obj as T;
  }

  findMany(options: QueryOptions = {}): T[] {
    const clauses: string[] = [];
    const args: unknown[] = [];

    if (options.where) {
      for (const [key, val] of Object.entries(options.where)) {
        if (val !== undefined && val !== null) {
          clauses.push(`${this.toDbCol(key)} = ?`);
          args.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
        }
      }
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderClause = options.orderBy ? `ORDER BY ${options.orderBy}` : "";
    const limitClause = options.limit ? `LIMIT ${options.limit}` : "";
    const offsetClause = options.offset ? `OFFSET ${options.offset}` : "";

    const query = `SELECT * FROM ${this.tableName} ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim();
    const rows = Array.from(this.sql.exec(query, ...args)) as any[];
    return rows.map((r) => this.fromDbRow(r));
  }

  findById(id: string): T | null {
    const query = `SELECT * FROM ${this.tableName} WHERE ${this.idField} = ? LIMIT 1`;
    const rows = Array.from(this.sql.exec(query, id)) as any[];
    if (rows.length === 0) return null;
    return this.fromDbRow(rows[0]);
  }

  findOne(where: Record<string, unknown>): T | null {
    const results = this.findMany({ where, limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  create(record: T): T {
    const cols: string[] = [];
    const placeholders: string[] = [];
    const values: unknown[] = [];

    for (const [prop, val] of Object.entries(record)) {
      cols.push(this.toDbCol(prop));
      placeholders.push("?");
      values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
    }

    const query = `INSERT INTO ${this.tableName} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
    this.sql.exec(query, ...values);
    return record;
  }

  update(id: string, updates: Partial<T>): T | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [prop, val] of Object.entries(updates)) {
      if (prop !== this.idField && val !== undefined) {
        sets.push(`${this.toDbCol(prop)} = ?`);
        values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
      }
    }

    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const query = `UPDATE ${this.tableName} SET ${sets.join(", ")} WHERE ${this.idField} = ?`;
    this.sql.exec(query, ...values);
    return this.findById(id);
  }

  delete(id: string): boolean {
    const query = `DELETE FROM ${this.tableName} WHERE ${this.idField} = ?`;
    this.sql.exec(query, id);
    return true;
  }

  count(where?: Record<string, unknown>): number {
    const clauses: string[] = [];
    const args: unknown[] = [];

    if (where) {
      for (const [key, val] of Object.entries(where)) {
        if (val !== undefined && val !== null) {
          clauses.push(`${this.toDbCol(key)} = ?`);
          args.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
        }
      }
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const query = `SELECT COUNT(*) AS count FROM ${this.tableName} ${whereClause}`;
    const raw = Array.from(this.sql.exec(query, ...args)) as Array<{ count: number }>;
    return Number(raw[0]?.count || 0);
  }
}

export class DatabaseORM {
  public categories: Repository<CategoryRecord>;
  public referrals: Repository<ReferralRecord>;
  public ads: Repository<AdRecord>;
  public externalAds: Repository<ExternalAdRecord>;
  public transactions: Repository<TransactionRecord>;
  public messages: Repository<MessageRecord>;
  public memory: Repository<MemoryRecord>;
  public events: Repository<AuditEvent>;

  constructor(private sql: SqlStorage) {
    this.categories = new Repository<CategoryRecord>(sql, "mas_categories", "id", {
      id: "id",
      name: "name",
      slug: "slug",
      description: "description",
      icon: "icon",
      isActive: "is_active",
      sortOrder: "sort_order",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });

    this.referrals = new Repository<ReferralRecord>(sql, "mas_referrals", "id", {
      id: "id",
      userLogin: "session_id",
      title: "title",
      url: "url",
      category: "category",
      rewardText: "reward_text",
      clicks: "clicks",
      signups: "signups",
      createdAt: "created_at",
    });

    this.ads = new Repository<AdRecord>(sql, "mas_ads", "id", {
      id: "id",
      title: "title",
      tagline: "tagline",
      sponsor: "sponsor",
      badge: "badge",
      url: "url",
      ctaText: "cta_text",
      accentColor: "accent_color",
      impressions: "impressions",
      clicks: "clicks",
      createdAt: "created_at",
    });

    this.externalAds = new Repository<ExternalAdRecord>(sql, "mas_external_ads", "id", {
      id: "id",
      name: "name",
      network: "network",
      placement: "placement",
      title: "title",
      tagline: "tagline",
      ctaText: "cta_text",
      targetUrl: "target_url",
      bannerImageUrl: "banner_image_url",
      cpmRate: "cpm_rate",
      cpcRate: "cpc_rate",
      impressions: "impressions",
      clicks: "clicks",
      earnings: "earnings",
      isActive: "is_active",
      createdAt: "created_at",
    });

    this.transactions = new Repository<TransactionRecord>(sql, "mas_transactions", "id", {
      id: "id",
      sessionId: "session_id",
      action: "action",
      amount: "amount",
      currency: "currency",
      customer: "customer",
      gateway: "gateway",
      gatewayRef: "gateway_ref",
      status: "status",
      checkoutUrl: "checkout_url",
      proposerDid: "proposer_did",
      authorizerDid: "authorizer_did",
      proofSignature: "proof_signature",
      note: "note",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });

    this.messages = new Repository<MessageRecord>(sql, "mas_messages", "id", {
      id: "id",
      sessionId: "session_id",
      role: "role",
      content: "content",
      agent: "agent",
      createdAt: "created_at",
    });

    this.memory = new Repository<MemoryRecord>(sql, "mas_memory", "key", {
      key: "key",
      value: "value",
      updatedAt: "updated_at",
    });

    this.events = new Repository<AuditEvent>(sql, "mas_events", "id", {
      id: "id",
      sessionId: "session_id",
      type: "type",
      agent: "agent",
      payload: "payload",
      createdAt: "created_at",
    });
  }

  /**
   * Initializes all SQLite tables and seeds initial data using the ORM.
   */
  initializeSchema(sessionId: string): void {
    // 1. Categories Table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL,
        icon TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // 2. Referrals Table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_referrals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        category TEXT NOT NULL,
        reward_text TEXT NOT NULL,
        clicks INTEGER DEFAULT 0,
        signups INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    // 3. Sponsored Marketplace Ads Table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_ads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tagline TEXT NOT NULL,
        sponsor TEXT NOT NULL,
        badge TEXT NOT NULL,
        url TEXT NOT NULL,
        cta_text TEXT NOT NULL,
        accent_color TEXT NOT NULL,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    // 4. External Ads & Network Inventory Table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_external_ads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        network TEXT NOT NULL,
        placement TEXT NOT NULL,
        title TEXT NOT NULL,
        tagline TEXT NOT NULL,
        cta_text TEXT NOT NULL,
        target_url TEXT NOT NULL,
        banner_image_url TEXT,
        cpm_rate REAL DEFAULT 15.0,
        cpc_rate REAL DEFAULT 1.25,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        earnings REAL DEFAULT 0.0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);

    // 5. Transactions Table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_transactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        customer TEXT NOT NULL,
        gateway TEXT NOT NULL,
        gateway_ref TEXT,
        status TEXT NOT NULL,
        checkout_url TEXT,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT,
        proof_signature TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // 6. Messages Table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // 7. Memory Table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // 8. Events Table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Seed Categories if table is empty
    if (this.categories.count() === 0) {
      const now = new Date().toISOString();
      const seedCategories: CategoryRecord[] = [
        {
          id: "cat_ai_dev",
          name: "AI & Dev Tools",
          slug: "ai-dev-tools",
          description: "LLM frameworks, vector databases, and autonomous agent tools.",
          icon: "🤖",
          isActive: true,
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "cat_cloud_host",
          name: "Cloud & Hosting",
          slug: "cloud-hosting",
          description: "Edge workers, serverless compute, and distributed storage.",
          icon: "☁️",
          isActive: true,
          sortOrder: 2,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "cat_db_store",
          name: "Database & Storage",
          slug: "database-storage",
          description: "Transactional SQLite, Vectorize, and edge key-value databases.",
          icon: "🗄️",
          isActive: true,
          sortOrder: 3,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "cat_sec_auth",
          name: "Security & Auth",
          slug: "security-auth",
          description: "OAuth 2.0, Agent Decentralized Identifiers (DIDs), and compliance.",
          icon: "🛡️",
          isActive: true,
          sortOrder: 4,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "cat_saas_prod",
          name: "SaaS & Productivity",
          slug: "saas-productivity",
          description: "Developer workstations, IDE assistants, and automation pipelines.",
          icon: "⚡",
          isActive: true,
          sortOrder: 5,
          createdAt: now,
          updatedAt: now,
        },
      ];

      for (const cat of seedCategories) {
        this.categories.create(cat);
      }
    }

    // Seed External Ads if table is empty
    if (this.externalAds.count() === 0) {
      const now = new Date().toISOString();
      const seedExternalAds: ExternalAdRecord[] = [
        {
          id: "ext_ethicalads_dev",
          name: "EthicalAds Developer Network",
          network: "ethicalads",
          placement: "header_leaderboard",
          title: "EthicalAds for AI Engineers",
          tagline: "Privacy-first advertising that funds open-source AI tooling.",
          ctaText: "Advertise on Network →",
          targetUrl: "https://www.ethicalads.io/",
          bannerImageUrl: "",
          cpmRate: 18.5,
          cpcRate: 1.45,
          impressions: 48,
          clicks: 3,
          earnings: 5.24,
          isActive: true,
          createdAt: now,
        },
        {
          id: "ext_carbon_infra",
          name: "Carbon Ads Infra Spot",
          network: "carbon",
          placement: "in_stream",
          title: "Cloudflare Workers AI Serverless GPUs",
          tagline: "Deploy Meta Llama 3.3 and DeepSeek R1 globally in under 60 seconds.",
          ctaText: "Start Free Tier →",
          targetUrl: "https://developers.cloudflare.com/workers-ai/",
          bannerImageUrl: "",
          cpmRate: 22.0,
          cpcRate: 1.8,
          impressions: 112,
          clicks: 8,
          earnings: 16.86,
          isActive: true,
          createdAt: now,
        },
        {
          id: "ext_direct_openaimp",
          name: "OpenAIMP Partner Direct",
          network: "direct",
          placement: "footer_deck",
          title: "Autonomous Agent Orchestration Suite",
          tagline: "Empower your business with multi-agent multi-turn LLM reasoning workflows.",
          ctaText: "Explore Platform →",
          targetUrl: "https://agent.openaimp.com",
          bannerImageUrl: "",
          cpmRate: 25.0,
          cpcRate: 2.0,
          impressions: 85,
          clicks: 6,
          earnings: 14.13,
          isActive: true,
          createdAt: now,
        },
      ];

      for (const extAd of seedExternalAds) {
        this.externalAds.create(extAd);
      }
    }

    // Seed Sponsored Marketplace Ads if table is empty
    if (this.ads.count() === 0) {
      const now = new Date().toISOString();
      const seedAds: AdRecord[] = [
        {
          id: "ad_workers_ai",
          title: "Workers AI Edge GPUs",
          tagline: "Run DeepSeek R1 & Llama 3.3 serverless models globally at the edge.",
          sponsor: "Cloudflare",
          badge: "Featured Partner",
          url: "https://developers.cloudflare.com/workers-ai/",
          ctaText: "Build Free",
          accentColor: "#f38020",
          impressions: 420,
          clicks: 34,
          createdAt: now,
        },
        {
          id: "ad_stripe_payments",
          title: "Autonomous Agent Checkout",
          tagline: "Accept payments with Stripe, PayPal, and DID signature verification.",
          sponsor: "Stripe Connect",
          badge: "Verified Gateway",
          url: "https://stripe.com",
          ctaText: "Integrate Now",
          accentColor: "#635bff",
          impressions: 215,
          clicks: 18,
          createdAt: now,
        },
      ];

      for (const ad of seedAds) {
        this.ads.create(ad);
      }
    }
  }

  /**
   * Introspects database schema and returns metadata for all tables.
   */
  listTables(): TableMetadata[] {
    const tableDescriptions: Record<string, string> = {
      mas_categories: "Referral categories taxonomy for partner links",
      mas_referrals: "User-submitted affiliate and community referral links",
      mas_ads: "Direct sponsored offers and partner marketplace promotions",
      mas_external_ads: "External ad network inventory, placements, and live earnings",
      mas_transactions: "Financial ledger with Agent DID signatures across Stripe, PayPal, Lemon Squeezy",
      mas_messages: "Persistent conversation history and multi-turn prompt transcripts",
      mas_memory: "Session facts and long-term user preferences key-value store",
      mas_events: "Real-time audit log of router decisions, HITL approvals, and agent executions",
    };

    const tables = Object.keys(tableDescriptions);
    const result: TableMetadata[] = [];

    for (const tbl of tables) {
      try {
        const countRaw = Array.from(this.sql.exec(`SELECT COUNT(*) AS count FROM ${tbl}`)) as Array<{ count: number }>;
        const rowCount = countRaw[0]?.count ?? 0;

        const infoRaw = Array.from(this.sql.exec(`PRAGMA table_info(${tbl})`)) as Array<{
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: any;
          pk: number;
        }>;

        const columns = infoRaw.map((col) => ({
          name: col.name,
          type: col.type,
          isPrimary: Boolean(col.pk),
        }));

        result.push({
          name: tbl,
          description: tableDescriptions[tbl],
          rowCount,
          columns,
        });
      } catch {
        // Table may not exist yet
      }
    }

    return result;
  }

  /**
   * Reads raw table data with optional limit, offset, and keyword filter.
   */
  getTableData(tableName: string, options: { limit?: number; offset?: number; search?: string } = {}): {
    tableName: string;
    total: number;
    rows: any[];
  } {
    const cleanTable = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    const limit = Math.min(Math.max(options.limit || 50, 1), 200);
    const offset = Math.max(options.offset || 0, 0);

    const countRaw = Array.from(this.sql.exec(`SELECT COUNT(*) AS count FROM ${cleanTable}`)) as Array<{ count: number }>;
    const total = countRaw[0]?.count ?? 0;

    let query = `SELECT * FROM ${cleanTable}`;
    const args: unknown[] = [];

    if (options.search && options.search.trim()) {
      // Find text columns to filter
      const infoRaw = Array.from(this.sql.exec(`PRAGMA table_info(${cleanTable})`)) as Array<{ name: string; type: string }>;
      const textCols = infoRaw.filter((c) => c.type.toUpperCase().includes("CHAR") || c.type.toUpperCase().includes("TEXT"));

      if (textCols.length > 0) {
        const searchClauses = textCols.map((c) => `lower(${c.name}) LIKE ?`);
        query += ` WHERE ${searchClauses.join(" OR ")}`;
        for (let i = 0; i < textCols.length; i++) {
          args.push(`%${options.search.trim().toLowerCase()}%`);
        }
      }
    }

    query += ` LIMIT ${limit} OFFSET ${offset}`;
    const rows = Array.from(this.sql.exec(query, ...args)) as any[];

    return {
      tableName: cleanTable,
      total,
      rows,
    };
  }

  /**
   * Computes comprehensive platform revenue analytics across all streams.
   */
  getRevenueSummary(): RevenueSummary {
    const extAds = this.externalAds.findMany();
    const adNetworkRevenue = extAds.reduce((sum, ad) => sum + (ad.earnings || 0), 0);
    const totalImpressions = extAds.reduce((sum, ad) => sum + (ad.impressions || 0), 0);
    const totalAdClicks = extAds.reduce((sum, ad) => sum + (ad.clicks || 0), 0);

    const marketplaceAds = this.ads.findMany();
    // Marketplace revenue: $20 fixed listing fee + $0.50 per verified click
    const marketplaceRevenue = marketplaceAds.length * 20.0 + marketplaceAds.reduce((sum, a) => sum + a.clicks * 0.5, 0);

    const txs = this.transactions.findMany();
    const settledGross = txs
      .filter((t) => t.status === "completed" || t.status === "authorized")
      .reduce((sum, t) => sum + (t.action === "charge" ? t.amount : 0), 0);

    // Platform processing fee: 2.5% on transaction volume
    const paymentPlatformFees = settledGross * 0.025;

    const referrals = this.referrals.findMany();
    // Referral payouts: $10 per referred signup
    const referralPayouts = referrals.reduce((sum, r) => sum + (r.signups || 0) * 10.0, 0);

    const grossRevenue = adNetworkRevenue + marketplaceRevenue + paymentPlatformFees;
    const netRevenue = Math.max(0, grossRevenue - referralPayouts);
    const averageRPM = totalImpressions > 0 ? (adNetworkRevenue / totalImpressions) * 1000 : 18.5;

    return {
      grossRevenue,
      adNetworkRevenue,
      marketplaceRevenue,
      paymentPlatformFees,
      referralPayouts,
      netRevenue,
      totalImpressions,
      totalAdClicks,
      averageRPM,
    };
  }
}
