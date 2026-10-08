import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { BrowserAgent } from "../src/agents/browserAgent";
import { SlackAgent } from "../src/agents/slackAgent";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { AGENT_DIDS } from "../src/agents/did";
import type { Env, TransactionSnapData } from "../src/types";

describe("Cloudflare Browser Agent & Independent Slack Agent", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const teamId = "T0123456789";

  const mockEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    SEARCH_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
    SLACK_SIGNING_SECRET: "test_slack_signing_secret_999",
    SLACK_BOT_TOKEN: "xoxb-test-bot-token-999",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T00/B00/X00",
  };

  const createMockCtx = (idString = teamId) => ({
    id: { toString: () => idString },
    storage: { sql },
    waitUntil: vi.fn(),
  });

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(`slack_${teamId}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Cloudflare Browser Agent
  // =========================================================================
  describe("BrowserAgent: Transaction Snapshot & Receipt Generation", () => {
    it("generates an official SVG transaction receipt and delivers it to Slack via Webhook", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as any);

      const browserAgent = new BrowserAgent(createMockCtx() as any, mockEnv);

      const tx: TransactionSnapData = {
        transactionId: "TX_1001_AAPL",
        symbol: "AAPL",
        action: "BUY",
        quantity: 10,
        price: 185.5,
        orderType: "LIMIT",
        status: "EXECUTED",
        totalValue: 1855.0,
        environment: "sandbox",
        commission: 0.0,
        notes: "Automated limit buy order executed by AI Desk",
      };

      const result = await browserAgent.sendTransactionSnapToSlack(tx, {
        webhookUrl: "https://hooks.slack.com/services/CUSTOM/TEST/HOOK",
        channel: "C_TRADING_FLOOR",
        caption: "Confirmed fill on NASDAQ for AAPL",
      });

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe("TX_1001_AAPL");
      expect(result.symbol).toBe("AAPL");
      expect(result.screenshotBase64).toBeDefined();

      // Verify the generated SVG receipt content
      const decodedSvg = Buffer.from(result.screenshotBase64!, "base64").toString("utf-8");
      expect(decodedSvg).toContain("OFFICIAL TRANSACTION RECEIPT");
      expect(decodedSvg).toContain("AAPL");
      expect(decodedSvg).toContain("BUY");
      expect(decodedSvg).toContain("EXECUTED");
      expect(decodedSvg).toContain("10 units");
      expect(decodedSvg).toContain("$185.50");
      expect(decodedSvg).toContain("$1,855.00");
      expect(decodedSvg).toContain(AGENT_DIDS.BROWSER);

      // Verify fetch dispatch to Slack webhook
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe("https://hooks.slack.com/services/CUSTOM/TEST/HOOK");
      expect(calledInit?.method).toBe("POST");

      const body = JSON.parse(calledInit?.body as string);
      expect(body.channel).toBe("C_TRADING_FLOOR");
      expect(body.blocks).toBeDefined();
      expect(body.blocks.some((b: any) => b.type === "header")).toBe(true);
      expect(body.blocks.some((b: any) => b.type === "context")).toBe(true);
    });

    it("handles multi-leg options strategy transactions in receipt and Block Kit", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
      } as any);

      const browserAgent = new BrowserAgent(createMockCtx() as any, mockEnv);

      const tx: TransactionSnapData = {
        transactionId: "TX_OPT_SPY_SPREAD",
        symbol: "SPY",
        action: "BUY_TO_OPEN",
        quantity: 2,
        price: 3.25,
        orderType: "NET_DEBIT",
        status: "FILLED",
        totalValue: 650.0,
        environment: "live",
        legs: [
          { symbol: "SPY261016C00580000", action: "BUY_TO_OPEN", strike: 580, expiry: "2026-10-16" },
          { symbol: "SPY261016C00590000", action: "SELL_TO_OPEN", strike: 590, expiry: "2026-10-16" },
        ],
        notes: "Bull Call Vertical Spread on SPY",
      };

      const result = await browserAgent.sendTransactionSnapToSlack(tx);

      expect(result.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0];
      const payload = JSON.parse(init?.body as string);

      // Verify legs block
      const legsBlock = payload.blocks.find((b: any) => b.text?.text?.includes("Multi-Leg Strategy Structure"));
      expect(legsBlock).toBeDefined();
      expect(legsBlock.text.text).toContain("SPY261016C00580000");
      expect(legsBlock.text.text).toContain("SPY261016C00590000");
      expect(legsBlock.text.text).toContain("@ $580");
    });

    it("falls back to Slack Bot Token if webhookUrl is omitted and bot token is present", async () => {
      const envWithoutWebhook: Env = {
        ...mockEnv,
        SLACK_WEBHOOK_URL: undefined,
        SLACK_BOT_TOKEN: "xoxb-fallback-bot-token",
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
      } as any);

      const browserAgent = new BrowserAgent(createMockCtx() as any, envWithoutWebhook);

      const result = await browserAgent.sendTransactionSnapToSlack({
        transactionId: "TX_FALLBACK_NVDA",
        symbol: "NVDA",
        action: "SELL",
        quantity: 5,
        price: 130.0,
      });

      expect(result.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe("https://slack.com/api/chat.postMessage");
      expect(calledInit?.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer xoxb-fallback-bot-token",
        })
      );
    });

    it("responds to Browser Agent HTTP lifecycle routes (/health, /snap/transaction)", async () => {
      const browserAgent = new BrowserAgent(createMockCtx() as any, mockEnv);

      // Health endpoint
      const healthReq = new Request("https://agent.internal/browser/health", { method: "GET" });
      const healthRes = await browserAgent.onRequest(healthReq);
      expect(healthRes.status).toBe(200);
      const healthJson = await healthRes.json() as any;
      expect(healthJson.agent).toBe("BrowserAgent");
      expect(healthJson.status).toBe("active");
      expect(healthJson.did).toBe(AGENT_DIDS.BROWSER);

      // Snap transaction HTTP POST endpoint
      vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200 } as any);
      const snapReq = new Request("https://agent.internal/browser/snap/transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction: {
            transactionId: "TX_HTTP_001",
            symbol: "MSFT",
            action: "BUY",
            quantity: 4,
            price: 420.0,
          },
        }),
      });

      const snapRes = await browserAgent.onRequest(snapReq);
      expect(snapRes.status).toBe(200);
      const snapJson = await snapRes.json() as any;
      expect(snapJson.success).toBe(true);
      expect(snapJson.symbol).toBe("MSFT");
    });
  });

  // =========================================================================
  // 2. Independent Cloudflare Slack Agent
  // =========================================================================
  describe("SlackAgent: Slash Commands, State & Browser Agent Coordination", () => {
    it("handles /help slash command and returns command usage guide", async () => {
      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const formData = new FormData();
      formData.append("command", "/help");
      formData.append("text", "");
      formData.append("user_id", "U12345");
      formData.append("channel_id", "C999");

      const response = await slackAgent.handleSlashCommand(formData);
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      expect(json.text).toContain("E*TRADE Slack Trading Agent Commands");
      expect(json.text).toContain("/snap");
      expect(json.text).toContain("/trade");
      expect(json.text).toContain("/quote");
    });

    it("handles /trade slash command, creates draft preview, and renders HITL buttons", async () => {
      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const formData = new FormData();
      formData.append("command", "/trade");
      formData.append("text", "buy 25 NVDA at market");
      formData.append("user_id", "U_TRADER_1");
      formData.append("channel_id", "C_TRADES");

      const response = await slackAgent.handleSlashCommand(formData);
      expect(response.status).toBe(200);
      const json = await response.json() as any;

      expect(json.blocks).toBeDefined();
      const actionBlock = json.blocks.find((b: any) => b.type === "actions");
      expect(actionBlock).toBeDefined();

      const buttonActionIds = actionBlock.elements.map((el: any) => el.action_id);
      expect(buttonActionIds).toContain("approve_trade");
      expect(buttonActionIds).toContain("reject_trade");
      expect(buttonActionIds).toContain("snap_trade");
    });

    it("handles /snap for an existing order and dispatches snapshot to Slack via webhook", async () => {
      // Seed a trade record in SQLite ORM using repository method
      orm.trades.create({
        id: "ord_test_888",
        sessionId: `slack_${teamId}`,
        symbol: "TSLA",
        action: "BUY",
        orderType: "MARKET",
        quantity: 15,
        price: 240.0,
        totalValue: 3600.0,
        status: "executed",
        proposerDid: AGENT_DIDS.SLACK,
        proofSignature: "proof_sig_888",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as any);

      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const formData = new FormData();
      formData.append("command", "/snap");
      formData.append("text", "ord_test_888");
      formData.append("user_id", "U_SNAP_USER");
      formData.append("channel_id", "C_CHANNEL_SNAP");

      const response = await slackAgent.handleSlashCommand(formData);
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      expect(json.text).toContain("TSLA");
      expect(json.text).toContain("Posted to Slack");

      // Verify that BrowserAgent was called to send the webhook
      expect(fetchSpy).toHaveBeenCalled();
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe(mockEnv.SLACK_WEBHOOK_URL);
      const payload = JSON.parse(calledInit?.body as string);
      expect(payload.text).toContain("TSLA");
    });

    it("interactively approves trade and automatically dispatches transaction snap via BrowserAgent", async () => {
      // Seed trade in ORM
      orm.trades.create({
        id: "ord_approve_999",
        sessionId: `slack_${teamId}`,
        symbol: "AMD",
        action: "BUY",
        orderType: "LIMIT",
        quantity: 50,
        price: 160.0,
        totalValue: 8000.0,
        status: "previewed",
        proposerDid: AGENT_DIDS.SLACK,
        proofSignature: "proof_sig_999",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as any);

      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const interactionPayload = {
        type: "block_actions",
        user: { id: "U_APPROVER", username: "alice_trader" },
        channel: { id: "C_FLOOR" },
        actions: [
          {
            action_id: "approve_trade",
            value: "ord_approve_999",
          },
        ],
      };

      const response = await slackAgent.handleInteraction(interactionPayload);
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      expect(json.replace_original).toBe(true);

      // Verify trade status updated in DB
      const trade = orm.trades.findById("ord_approve_999");
      expect(trade?.status).toBe("executed");

      // Verify BrowserAgent dispatched the official snap receipt to Slack
      expect(fetchSpy).toHaveBeenCalled();
      const snapCall = fetchSpy.mock.calls.find((c: any) =>
        typeof c[1]?.body === "string" && c[1].body.includes("Official execution confirmation snap for AMD")
      );
      expect(snapCall).toBeDefined();
    });

    it("handles snap_trade interactive button click and generates ephemeral response", async () => {
      orm.trades.create({
        id: "ord_snap_btn_1",
        sessionId: `slack_${teamId}`,
        symbol: "GOOGL",
        action: "BUY",
        orderType: "MARKET",
        quantity: 8,
        price: 175.0,
        totalValue: 1400.0,
        status: "executed",
        proposerDid: AGENT_DIDS.SLACK,
        proofSignature: "proof_sig_btn",
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as any);

      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const interactionPayload = {
        type: "block_actions",
        user: { id: "U_SNAPPER" },
        channel: { id: "C_SNAPS" },
        actions: [{ action_id: "snap_trade", value: "ord_snap_btn_1" }],
      };

      const response = await slackAgent.handleInteraction(interactionPayload);
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      expect(json.response_type).toBe("ephemeral");
      expect(json.text).toContain("Posted to Slack!");
    });

    it("responds to SlackAgent HTTP request routing (/health, URL verification challenge)", async () => {
      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      // Health endpoint
      const healthReq = new Request("https://agent.internal/slack/health", { method: "GET" });
      const healthRes = await slackAgent.onRequest(healthReq);
      expect(healthRes.status).toBe(200);
      const healthJson = await healthRes.json() as any;
      expect(healthJson.agent).toBe("SlackAgent");
      expect(healthJson.status).toBe("active");
      expect(healthJson.capabilities).toContain("browser_agent_snaps");

      // URL Verification challenge from Slack Events API
      const challengeReq = new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "url_verification",
          challenge: "3eZbrAqvmAVdaMnujKqCnhPdAUpeA7nmBIKN1",
        }),
      });

      const challengeRes = await slackAgent.onRequest(challengeReq);
      expect(challengeRes.status).toBe(200);
      const challengeJson = await challengeRes.json() as any;
      expect(challengeJson.challenge).toBe("3eZbrAqvmAVdaMnujKqCnhPdAUpeA7nmBIKN1");
    });
  });

  // =========================================================================
  // 3. Human-in-the-Loop Pre-Trade Authorization & Trading via Slack
  // =========================================================================
  describe("HITL Pre-Trade Authorization & Conversational Trading via Slack", () => {
    it("dispatches Pre-Trade Approval Ticket with Block Kit action buttons via dual delivery", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as any);

      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const ticketResult = await slackAgent.sendPreTradeApprovalTicket({
        orderId: "ord_pretrade_101",
        symbol: "NVDA",
        action: "BUY",
        quantity: 20,
        orderType: "LIMIT",
        limitPrice: 128.5,
        estimatedPrice: 128.5,
        estimatedTotal: 2570.0,
        proposerDid: AGENT_DIDS.TRADING,
        notes: "Limit buy order drafted by AI Trading Desk",
      });

      expect(ticketResult.orderId).toBe("ord_pretrade_101");
      expect(ticketResult.payload.blocks).toBeDefined();

      // Check header
      const headerBlock = ticketResult.payload.blocks?.find((b: any) => b.type === "header");
      expect(headerBlock?.text?.text).toContain("Pre-Trade Authorization Required: BUY NVDA");

      // Check HITL Safety Guarantee
      const safetyBlock = ticketResult.payload.blocks?.find((b: any) => b.text?.text?.includes("Agentic HITL Safety Guarantee"));
      expect(safetyBlock).toBeDefined();
      expect(safetyBlock?.text?.text).toContain("Autonomous trade execution is strictly blocked");

      // Check interactive buttons
      const actionsBlock = ticketResult.payload.blocks?.find((b: any) => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
      expect(actionIds).toContain("etrade_approve_order");
      expect(actionIds).toContain("etrade_cancel_order");
      expect(actionIds).toContain("snap_trade");

      // Verify delivery to Slack webhook
      expect(fetchSpy).toHaveBeenCalled();
      const webhookCall = fetchSpy.mock.calls.find((c: any) => c[0] === mockEnv.SLACK_WEBHOOK_URL);
      expect(webhookCall).toBeDefined();
    });

    it("handles conversational order approval in Slack, executes on E*TRADE, and posts visual snap", async () => {
      // Seed a previewed draft in ORM
      orm.trades.create({
        id: "ord_conv_approve_777",
        sessionId: `slack_${teamId}`,
        symbol: "MSFT",
        action: "BUY",
        orderType: "LIMIT",
        quantity: 10,
        price: 430.0,
        totalValue: 4300.0,
        status: "previewed",
        proposerDid: AGENT_DIDS.TRADING,
        proofSignature: "sig_777",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as any);

      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      // Inbound Slack event: user says "approve ord_conv_approve_777"
      const eventReq = new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event: {
            type: "app_mention",
            user: "U_HUMAN_APPROVER",
            text: "<@U_BOT> approve ord_conv_approve_777",
            channel: "C_TRADING_ROOM",
            ts: "1728364800.000100",
          },
        }),
      });

      const eventRes = await slackAgent.onRequest(eventReq);
      expect(eventRes.status).toBe(200);
      const resJson = await eventRes.json() as any;

      expect(resJson.handled).toBe(true);
      expect(resJson.actionType).toBe("approval");
      expect(resJson.orderId).toBe("ord_conv_approve_777");
      expect(resJson.authorizerDid).toBe("did:user:slack:U_HUMAN_APPROVER");

      // Verify trade updated to executed in SQLite DB
      const updatedTrade = orm.trades.findById("ord_conv_approve_777");
      expect(updatedTrade?.status).toBe("executed");
      expect(updatedTrade?.authorizerDid).toBe("did:user:slack:U_HUMAN_APPROVER");

      // Verify delivery of snap confirmation receipt to Slack
      const snapReceiptCall = fetchSpy.mock.calls.find((c: any) =>
        typeof c[1]?.body === "string" && c[1].body.includes("MSFT") && c[1].body.includes("EXECUTED")
      );
      expect(snapReceiptCall).toBeDefined();
    });

    it("handles conversational order cancellation in Slack and updates ledger status to rejected", async () => {
      orm.trades.create({
        id: "ord_conv_cancel_555",
        sessionId: `slack_${teamId}`,
        symbol: "TSLA",
        action: "SELL",
        orderType: "MARKET",
        quantity: 5,
        price: 250.0,
        totalValue: 1250.0,
        status: "previewed",
        proposerDid: AGENT_DIDS.TRADING,
        proofSignature: "sig_555",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as any);

      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const eventReq = new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event: {
            type: "message",
            user: "U_TRADER_BOB",
            text: "cancel ord_conv_cancel_555",
            channel: "C_PRIVATE_DM",
            ts: "1728364900.000200",
          },
        }),
      });

      const eventRes = await slackAgent.onRequest(eventReq);
      expect(eventRes.status).toBe(200);
      const resJson = await eventRes.json() as any;

      expect(resJson.handled).toBe(true);
      expect(resJson.actionType).toBe("rejection");
      expect(resJson.orderId).toBe("ord_conv_cancel_555");

      // Verify trade status marked rejected in DB
      const cancelledTrade = orm.trades.findById("ord_conv_cancel_555");
      expect(cancelledTrade?.status).toBe("rejected");
    });

    it("handles conversational snap command in Slack for an existing trade", async () => {
      orm.trades.create({
        id: "ord_conv_snap_333",
        sessionId: `slack_${teamId}`,
        symbol: "AMZN",
        action: "BUY",
        orderType: "LIMIT",
        quantity: 12,
        price: 180.0,
        totalValue: 2160.0,
        status: "executed",
        proposerDid: AGENT_DIDS.TRADING,
        proofSignature: "sig_333",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ ok: true }),
      } as any);

      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const eventReq = new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event: {
            type: "message",
            user: "U_SNAP_REQUESTER",
            text: "snap ord_conv_snap_333",
            channel: "C_SNAPS",
            ts: "1728365000.000300",
          },
        }),
      });

      const eventRes = await slackAgent.onRequest(eventReq);
      expect(eventRes.status).toBe(200);
      const resJson = await eventRes.json() as any;

      expect(resJson.handled).toBe(true);
      expect(resJson.actionType).toBe("snap");
      expect(resJson.orderId).toBe("ord_conv_snap_333");

      // Check delivery to Slack
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("safely rejects conversational approval when order is already in executed status", async () => {
      orm.trades.create({
        id: "ord_already_executed",
        sessionId: `slack_${teamId}`,
        symbol: "AAPL",
        action: "BUY",
        orderType: "MARKET",
        quantity: 10,
        price: 220.0,
        totalValue: 2200.0,
        status: "executed",
        proposerDid: AGENT_DIDS.TRADING,
        proofSignature: "sig_exec",
      });

      const slackAgent = new SlackAgent(createMockCtx() as any, mockEnv);

      const eventReq = new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          event: {
            type: "message",
            user: "U_TRADER",
            text: "approve ord_already_executed",
            channel: "C_TRADES",
          },
        }),
      });

      const eventRes = await slackAgent.onRequest(eventReq);
      expect(eventRes.status).toBe(200);
      const resJson = await eventRes.json() as any;

      expect(resJson.handled).toBe(true);
      expect(resJson.actionType).toBe("rejection");
      expect(resJson.response?.text).toContain("already in *EXECUTED* status");
    });
  });
});
