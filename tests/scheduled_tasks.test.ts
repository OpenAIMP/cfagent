import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { planNLQ, executeNLQQuery } from "../src/agents/nlq";
import { ETradeService } from "../src/services/etrade";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import type { Env, AgentScheduleItem } from "../src/types";

// In-memory KV mock for testing token storage
class MockKVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    return item.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe("Cloudflare Agents: Task Scheduling & Durable Timers", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  let mockKv: MockKVNamespace;
  let env: Env;
  const sessionId = "scheduler_test_trader";

  beforeEach(() => {
    vi.restoreAllMocks();
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    mockKv = new MockKVNamespace();

    env = {
      APP_ENV: "TEST",
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_KV: mockKv as any,
      SESSIONS: mockKv as any,
      SEARCH_AGENT: {} as any,
    } as Env;
  });

  // =========================================================================
  // 1. ScheduledTasksService Domain Tests
  // =========================================================================
  describe("ScheduledTasksService", () => {
    it("handles E*TRADE token auto-renewal when no tokens exist gracefully", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autoRenewETradeTokens("new_user_without_tokens");

      expect(res.success).toBe(true);
      expect(res.taskType).toBe("etrade_token_renewal");
      expect(res.data?.renewed).toBe(false);
      expect(res.data?.message).toContain("No active E*TRADE tokens found");
    });

    it("successfully auto-renews valid E*TRADE access tokens and records audit event", async () => {
      // Store a renewable token in mock KV
      await storeAccessTokens(env, sessionId, "mock_token_abc", "mock_secret_xyz", "TEST");

      // Mock upstream renew_access_token endpoint
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("oauth_token=renewed_tok_123&oauth_token_secret=renewed_sec_456", { status: 200 })
      );

      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autoRenewETradeTokens(sessionId, "TEST");

      expect(res.success).toBe(true);
      expect(res.data?.renewed).toBe(true);
      expect(res.data?.userLogin).toBe(sessionId);

      // Verify audit event in mas_events
      const auditEvents = orm.events.findMany({ where: { type: "etrade.token_auto_renewed" } });
      expect(auditEvents.length).toBe(1);

      fetchSpy.mockRestore();
    });

    it("runs autonomous market screen and identifies standout opportunities", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autonomousMarketScreen({ sector: "Technology", maxItems: 3 });

      expect(res.success).toBe(true);
      expect(res.taskType).toBe("market_screen");
      expect(res.data?.totalScanned).toBeGreaterThan(0);
      expect(Array.isArray(res.data?.opportunities)).toBe(true);

      // Verify audit event in mas_events if opportunities detected
      const events = orm.events.findMany({ where: { type: "screener.opportunities_detected" } });
      if (res.data?.opportunities && res.data.opportunities.length > 0) {
        expect(events.length).toBeGreaterThan(0);
      }
    });

    it("automatically expires a stale order draft after 15m HITL window", async () => {
      const orderId = "ord_test_stale_101";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "NVDA",
        action: "BUY",
        orderType: "MARKET",
        quantity: 10,
        price: 228.38,
        totalValue: 2283.8,
        status: "previewed",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "did:key:user123",
        proofSignature: "sig_0x123",
        previewNotes: "Previewed via Voice Agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.expireStaleOrderDraft(orderId);

      expect(res.success).toBe(true);
      expect(res.taskType).toBe("order_expiration");
      expect(res.data?.expired).toBe(true);
      expect(res.data?.previousStatus).toBe("previewed");

      // Verify updated status in SQLite
      const updatedTrade = orm.trades.findById(orderId);
      expect(updatedTrade?.status).toBe("expired");
      expect(updatedTrade?.previewNotes).toContain("Auto-expired");

      // Verify audit event
      const auditEvents = orm.events.findMany({ where: { type: "order.auto_expired" } });
      expect(auditEvents.length).toBe(1);
    });

    it("HITL Safety Boundary: blocks execution of an expired order draft", async () => {
      const orderId = "ord_test_expired_block";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "MSFT",
        action: "BUY",
        orderType: "MARKET",
        quantity: 5,
        price: 400.0,
        totalValue: 2000.0,
        status: "expired",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "did:key:user123",
        proofSignature: "sig_0x123",
        previewNotes: "[Auto-expired: 15-minute HITL window elapsed]",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const etrade = new ETradeService(orm, env, sessionId, "sandbox");
      expect(() => {
        etrade.executeOrder(orderId, "did:key:user123", "approved");
      }).toThrow(/cannot be executed.*current status is 'expired'/i);
    });

    it("does not overwrite already executed or rejected orders upon expiration timer firing", async () => {
      const orderId = "ord_test_already_executed";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "AAPL",
        action: "BUY",
        orderType: "MARKET",
        quantity: 20,
        price: 240.0,
        totalValue: 4800.0,
        status: "executed",
        orderRef: "exec_broker_999",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "did:key:user123",
        proofSignature: "sig_0x123",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.expireStaleOrderDraft(orderId);

      expect(res.success).toBe(true);
      expect(res.data?.expired).toBe(false);
      expect(res.data?.previousStatus).toBe("executed");

      const trade = orm.trades.findById(orderId);
      expect(trade?.status).toBe("executed");
    });

    it("dispatches scheduled user reminders and records message to assistant history", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.dispatchReminder("rem_456", "Review AAPL quarterly earnings release");

      expect(res.success).toBe(true);
      expect(res.taskType).toBe("reminder");
      expect(res.data?.reminderId).toBe("rem_456");

      // Verify audit event
      const auditEvents = orm.events.findMany({ where: { type: "reminder.dispatched" } });
      expect(auditEvents.length).toBe(1);

      // Verify message in ORM
      const messages = orm.messages.findMany({ where: { sessionId } });
      expect(messages.some(m => m.content.includes("Review AAPL quarterly earnings"))).toBe(true);
    });

    it("runs autonomous options analysis across symbols and records audit events", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autonomousOptionsAnalysis({
        symbols: ["AAPL", "MSFT"],
        thesis: "bullish",
        pushToSlack: false,
      });

      expect(res.success).toBe(true);
      expect(res.taskType).toBe("options_analysis");
      expect(res.data?.symbols).toEqual(["AAPL", "MSFT"]);
      expect(res.data?.summary).toBeTruthy();

      // Verify audit event
      const auditEvents = orm.events.findMany({ where: { type: "options.scheduled_analysis_completed" } });
      expect(auditEvents.length).toBe(1);

      // Verify assistant message record
      const messages = orm.messages.findMany({ where: { sessionId } });
      expect(messages.some(m => m.content.includes("Scheduled Options Intelligence"))).toBe(true);
    });
  });

  // =========================================================================
  // 2. Cloudflare Agent Scheduling Engine Primitives
  // =========================================================================
  describe("Agent Scheduling Lifecycle & Timers", () => {
    // Simulator for the Cloudflare Agent scheduler methods
    class AgentSchedulerHarness {
      schedules: AgentScheduleItem[] = [];

      async schedule(when: any, callback: string, payload?: any, options?: any): Promise<AgentScheduleItem> {
        const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const type = typeof when === "number" ? "delayed" : typeof when === "string" ? "cron" : "scheduled";
        const item: AgentScheduleItem = {
          id,
          callback,
          payload,
          type,
          time: typeof when === "number" ? Math.floor(Date.now() / 1000) + when : Math.floor(Date.now() / 1000) + 3600,
          cron: typeof when === "string" ? when : undefined,
          delayInSeconds: typeof when === "number" ? when : undefined,
        };
        this.schedules.push(item);
        return item;
      }

      async scheduleEvery(intervalSeconds: number, callback: string, payload?: any): Promise<AgentScheduleItem> {
        const id = `sched_every_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const item: AgentScheduleItem = {
          id,
          callback,
          payload,
          type: "interval",
          intervalSeconds,
          time: Math.floor(Date.now() / 1000) + intervalSeconds,
        };
        this.schedules.push(item);
        return item;
      }

      async listSchedules(criteria?: { type?: string }): Promise<AgentScheduleItem[]> {
        if (!criteria?.type) return this.schedules;
        return this.schedules.filter(s => s.type === criteria.type);
      }

      async getScheduleById(id: string): Promise<AgentScheduleItem | undefined> {
        return this.schedules.find(s => s.id === id);
      }

      async cancelSchedule(id: string): Promise<boolean> {
        const idx = this.schedules.findIndex(s => s.id === id);
        if (idx !== -1) {
          this.schedules.splice(idx, 1);
          return true;
        }
        return false;
      }
    }

    it("registers baseline cron and interval tasks on initialization", async () => {
      const harness = new AgentSchedulerHarness();

      // Simulate onStart baseline registration
      await harness.schedule("0 23 * * *", "autoRenewETradeTokens", { userLogin: sessionId }, { idempotent: true });
      await harness.scheduleEvery(300, "autonomousMarketScreen", { sector: "Technology" });

      const all = await harness.listSchedules();
      expect(all.length).toBe(2);

      const cron = await harness.listSchedules({ type: "cron" });
      expect(cron.length).toBe(1);
      expect(cron[0].callback).toBe("autoRenewETradeTokens");
      expect(cron[0].cron).toBe("0 23 * * *");

      const interval = await harness.listSchedules({ type: "interval" });
      expect(interval.length).toBe(1);
      expect(interval[0].callback).toBe("autonomousMarketScreen");
      expect(interval[0].intervalSeconds).toBe(300);
    });

    it("schedules 15m expiration timer on order preview and cancels on user decision", async () => {
      const harness = new AgentSchedulerHarness();

      // 1. Preview order -> schedule 15m timer
      const expTimer = await harness.schedule(900, "expireStaleOrderDraft", { orderId: "ord_flow_123" });
      expect(expTimer.id).toBeDefined();
      expect(expTimer.type).toBe("delayed");
      expect(expTimer.delayInSeconds).toBe(900);

      // Verify timer is listed
      const found = await harness.getScheduleById(expTimer.id);
      expect(found).toBeDefined();

      // 2. User confirms or rejects order -> cancels timer
      const cancelled = await harness.cancelSchedule(expTimer.id);
      expect(cancelled).toBe(true);

      const afterCancel = await harness.getScheduleById(expTimer.id);
      expect(afterCancel).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. Natural Language Query (NLQ) Scheduling Intents Tests
  // =========================================================================
  describe("NLQ Scheduling Intent Integration", () => {
    it("plans schedule list intent from natural language query", async () => {
      const plan = await planNLQ(env, "show all active schedules and alarms");
      expect(plan.domain).toBe("scheduling");
      expect(plan.scheduleData?.action).toBe("list");
    });

    it("plans schedule cancellation intent with target schedule ID", async () => {
      const plan = await planNLQ(env, "cancel schedule sched_abc123");
      expect(plan.domain).toBe("scheduling");
      expect(plan.scheduleData?.action).toBe("cancel");
      expect(plan.scheduleData?.scheduleId).toBe("sched_abc123");
    });

    it("plans delayed reminder intent with parsed duration", async () => {
      const plan = await planNLQ(env, "remind me to check NVDA in 15 minutes");
      expect(plan.domain).toBe("scheduling");
      expect(plan.scheduleData?.action).toBe("create");
      expect(plan.scheduleData?.scheduleType).toBe("delayed");
      expect(plan.scheduleData?.delayInSeconds).toBe(900);
      expect(plan.scheduleData?.description).toContain("check NVDA");
    });

    it("plans interval market screen intent with parsed frequency", async () => {
      const plan = await planNLQ(env, "schedule market screen every 5 minutes");
      expect(plan.domain).toBe("scheduling");
      expect(plan.scheduleData?.action).toBe("create");
      expect(plan.scheduleData?.scheduleType).toBe("interval");
      expect(plan.scheduleData?.intervalSeconds).toBe(300);
    });

    it("executes scheduling plan in executeNLQQuery and records audit event", async () => {
      // 1. Create reminder plan execution
      const createPlan = await planNLQ(env, "remind me to check AAPL in 10 minutes");
      const createResult = executeNLQQuery(orm, sessionId, createPlan, env);

      expect(createResult.domain).toBe("scheduling");
      expect(createResult.count).toBe(1);
      expect(createResult.summary).toContain("Task scheduled successfully");

      // 2. List schedules plan execution
      const listPlan = await planNLQ(env, "list all scheduled tasks");
      const listResult = executeNLQQuery(orm, sessionId, listPlan, env);

      expect(listResult.domain).toBe("scheduling");
      expect(listResult.count).toBeGreaterThanOrEqual(2); // baseline cron + interval
      expect(listResult.rows.some((r: any) => r.callback === "autoRenewETradeTokens")).toBe(true);
      expect(listResult.rows.some((r: any) => r.callback === "autonomousMarketScreen")).toBe(true);

      // 3. Cancel schedule plan execution
      const cancelPlan = await planNLQ(env, "cancel schedule sched_delayed_test");
      const cancelResult = executeNLQQuery(orm, sessionId, cancelPlan, env);

      expect(cancelResult.domain).toBe("scheduling");
      expect(cancelResult.summary).toContain("sched_delayed_test");
    });
  });
});
