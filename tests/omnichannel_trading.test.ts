import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { ETradeEmailTradingService } from "../src/trading/email/agent";
import {
  ETradeSlackTradingService,
  verifySlackSignature,
  timingSafeEqual,
} from "../src/trading/slack/agent";
import type { Env, InboundEmailPayload } from "../src/types";

describe("Cloudflare Email & Slack Trading Agents (Omnichannel E*TRADE)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const sessionId = "omnichannel_test_session";

  const mockEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    SEARCH_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
    EMAIL_AGENT_ADDRESS: "trade@agent.openaimp.com",
    SLACK_SIGNING_SECRET: "test_slack_signing_secret_12345",
    SLACK_BOT_TOKEN: "xoxb-test-mock-token",
  };

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    DynamicMarketScreener.setTestListingsFixture(MOCK_TEST_UNIVERSE.map((stock) => ({
      symbol: stock.symbol,
      companyName: stock.companyName,
      exchange: "nasdaq" as const,
      lastPrice: stock.lastPrice,
      change: stock.change,
      changePercent: stock.changePercent,
      marketCap: (stock.marketCap || 0) * 1e9,
    })));
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    DynamicMarketScreener.setTestListingsFixture(null);
  });

  // =========================================================================
  // 1. Cloudflare Email Trading Agent Tests
  // =========================================================================
  describe("ETradeEmailTradingService", () => {
    it("sends report workbooks as MIME attachments", async () => {
      let sentMessage = "";
      const emailEnv: Env = {
        ...mockEnv,
        EMAIL: {
          send: vi.fn(async (message: ReadableStream<Uint8Array>) => {
            sentMessage = await new Response(message).text();
          }),
        },
      };
      const emailService = new ETradeEmailTradingService(emailEnv, orm, sessionId);

      const sent = await emailService.sendOutboundEmail(
        "analyst@example.com",
        "Research report: NVDA",
        "<p>Attached</p>",
        "Attached",
        {
          fileName: "nvda.xlsx",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          contentBase64: "UEsDBA==",
        },
      );

      expect(sent).toBe(true);
      expect(sentMessage).toContain("multipart/mixed");
      expect(sentMessage).toContain('filename="nvda.xlsx"');
      expect(sentMessage).toContain("UEsDBA==");
    });

    it("handles real-time stock quote inquiries via email", async () => {
      const emailService = new ETradeEmailTradingService(mockEnv, orm, sessionId);
      const payload: InboundEmailPayload = {
        from: "trader@example.com",
        to: "trade@agent.openaimp.com",
        subject: "Quote: NVDA",
        text: "Please provide the latest price and quote for NVDA",
      };

      const result = await emailService.processInboundEmail(payload);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("quote");
      expect(result.to).toBe("trader@example.com");
      expect(result.responseSubject).toContain("NVDA");
      expect(result.responseText).toContain("NVDA");
      expect(result.responseText).toContain("Bid/Ask");
      expect(result.responseHtml).toContain("NVIDIA Corporation");
      expect(result.responseHtml).toContain("52-Week Range");
      expect(result.responseHtml).toContain("did:agent:openaimp:trading");
    });

    it("handles market screening requests via email", async () => {
      const emailService = new ETradeEmailTradingService(mockEnv, orm, sessionId);
      const payload: InboundEmailPayload = {
        from: "portfolio-manager@fund.com",
        to: "trade@agent.openaimp.com",
        subject: "Market Screener",
         text: "Please screen stocks priced between $20 and $200",
      };

      const result = await emailService.processInboundEmail(payload);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("screener");
      expect(result.responseSubject).toContain("E*TRADE Screener");
      expect(result.responseText).toContain("Market cap");
      expect(result.responseHtml).toContain("<table");
      expect(result.responseHtml).toContain("Exchange");
    });

    it("handles portfolio balance inquiries via email", async () => {
      const emailService = new ETradeEmailTradingService(mockEnv, orm, sessionId);
      const payload: InboundEmailPayload = {
        from: "investor@example.com",
        to: "trade@agent.openaimp.com",
        subject: "Portfolio status",
        text: "What is my current portfolio balance and available cash?",
      };

      const result = await emailService.processInboundEmail(payload);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("portfolio");
      expect(result.responseSubject).toContain("Portfolio");
      expect(result.responseText).toContain("Reconciled Total Value");
      expect(result.responseHtml).toContain("E*TRADE Brokerage Account Overview");
    });

    it("generates Human-in-the-Loop (HITL) order preview emails with Agent DID attestation", async () => {
      const emailService = new ETradeEmailTradingService(mockEnv, orm, sessionId);
      const payload: InboundEmailPayload = {
        from: "human.trader@example.com",
        to: "trade@agent.openaimp.com",
        subject: "Trade Order Request",
        text: "Buy 10 shares of NVDA at market",
      };

      const result = await emailService.processInboundEmail(payload);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("preview");
      expect(result.orderId).toBeDefined();
      expect(result.responseSubject).toContain("HITL Action Required");
      expect(result.responseHtml).toContain("Order Preview Awaiting Human Authorization");
      expect(result.responseHtml).toContain("APPROVE " + result.orderId);
      expect(result.responseHtml).toContain("Review & Approve on Trading Hub");
      expect(result.responseHtml).toContain("did:agent:openaimp:trading");

      // Verify the order was drafted in the ORM SQLite ledger in 'previewed' status
      const savedTrade = orm.trades.findById(result.orderId!);
      expect(savedTrade).toBeDefined();
      expect(savedTrade?.status).toBe("previewed");
      expect(savedTrade?.symbol).toBe("NVDA");
      expect(savedTrade?.quantity).toBe(10);
      expect(savedTrade?.action).toBe("BUY");
    });

    it("executes order upon receiving human approval email reply 'APPROVE <orderId>'", async () => {
      const emailService = new ETradeEmailTradingService(mockEnv, orm, sessionId);

      // 1. Create a pending draft order in the ledger
      const draftOrderId = "ord_email_test_12345";
      orm.trades.create({
        id: draftOrderId,
        sessionId,
        symbol: "AAPL",
        action: "BUY",
        orderType: "MARKET",
        quantity: 5,
        price: 225.5,
        totalValue: 1127.5,
        status: "previewed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // 2. Simulate human sending approval email
      const approvalPayload: InboundEmailPayload = {
        from: "human.trader@example.com",
        to: "trade@agent.openaimp.com",
        subject: `Re: HITL Action Required: Preview BUY 5 AAPL [${draftOrderId}]`,
        text: `APPROVE ${draftOrderId}`,
      };

      const result = await emailService.processInboundEmail(approvalPayload);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("approval");
      expect(result.orderId).toBe(draftOrderId);
      expect(result.responseSubject).toContain("E*TRADE Order Executed");
      expect(result.responseText).toContain("routed to E*TRADE");
      expect(result.responseHtml).toContain("Broker Ref");
      expect(result.responseHtml).toContain("AAPL");

      // Verify status in ledger transitioned to 'executed'
      const updatedTrade = orm.trades.findById(draftOrderId);
      expect(updatedTrade?.status).toBe("executed");
    });

    it("cancels draft order upon receiving human rejection email 'CANCEL <orderId>'", async () => {
      const emailService = new ETradeEmailTradingService(mockEnv, orm, sessionId);

      const draftOrderId = "ord_email_cancel_999";
      orm.trades.create({
        id: draftOrderId,
        sessionId,
        symbol: "MSFT",
        action: "SELL",
        orderType: "LIMIT",
        quantity: 10,
        price: 450.0,
        totalValue: 4500.0,
        status: "previewed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const cancelPayload: InboundEmailPayload = {
        from: "human.trader@example.com",
        to: "trade@agent.openaimp.com",
        subject: `Re: Cancel order [${draftOrderId}]`,
        text: `CANCEL ${draftOrderId}`,
      };

      const result = await emailService.processInboundEmail(cancelPayload);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("rejection");
      expect(result.orderId).toBe(draftOrderId);
      expect(result.responseSubject).toContain("E*TRADE Order Cancelled");

      const cancelledTrade = orm.trades.findById(draftOrderId);
      expect(cancelledTrade?.status).toBe("rejected");
    });

    it("rejects approval gracefully when no pending preview exists", async () => {
      const emailService = new ETradeEmailTradingService(mockEnv, orm, sessionId);

      const invalidPayload: InboundEmailPayload = {
        from: "human.trader@example.com",
        to: "trade@agent.openaimp.com",
        subject: "Re: Approve",
        text: "APPROVE ord_non_existent_id",
      };

      const result = await emailService.processInboundEmail(invalidPayload);

      expect(result.success).toBe(false);
      expect(result.actionType).toBe("approval");
      expect(result.responseSubject).toContain("Approval Failed");
      expect(result.responseText).toContain("No pending order preview found");
    });
  });

  // =========================================================================
  // 2. Cloudflare Slack Trading Agent Tests
  // =========================================================================
  describe("ETradeSlackTradingService", () => {
    it("timingSafeEqual accurately checks equal and non-equal strings", () => {
      expect(timingSafeEqual("hello_world", "hello_world")).toBe(true);
      expect(timingSafeEqual("hello_world", "hello_worle")).toBe(false);
      expect(timingSafeEqual("short", "longer_string")).toBe(false);
      expect(timingSafeEqual("", "")).toBe(true);
    });

    it("verifies Slack HMAC-SHA256 signatures with replay protection", async () => {
      const secret = "test_signing_secret_xyz";
      const nowSec = Math.floor(Date.now() / 1000).toString();
      const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc" });

      // Generate valid HMAC signature
      const base = `v0:${nowSec}:${rawBody}`;
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(base));
      const hexSig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const validSigHeader = `v0=${hexSig}`;

      // 1. Valid signature passes
      const isValid = await verifySlackSignature(secret, nowSec, rawBody, validSigHeader);
      expect(isValid).toBe(true);

      // 2. Tampered signature fails
      const isTamperedValid = await verifySlackSignature(secret, nowSec, rawBody, "v0=0000000000000000");
      expect(isTamperedValid).toBe(false);

      // 3. Expired timestamp (> 300 seconds) fails replay guard
      const expiredTimestamp = (Math.floor(Date.now() / 1000) - 301).toString();
      const isExpiredValid = await verifySlackSignature(secret, expiredTimestamp, rawBody, validSigHeader);
      expect(isExpiredValid).toBe(false);

      // 4. Missing parameters fail
      expect(await verifySlackSignature("", nowSec, rawBody, validSigHeader)).toBe(false);
      expect(await verifySlackSignature(secret, null, rawBody, validSigHeader)).toBe(false);
    });

    it("responds to Slack url_verification challenge handshake", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, orm, sessionId);
      const challengePayload = {
        type: "url_verification",
        token: "verification_token",
        challenge: "test_challenge_token_string_12345",
      };

      const result = await slackService.processSlackEvent(challengePayload);

      expect(result.handled).toBe(true);
      expect(result.actionType).toBe("challenge");
      expect(result.challenge).toBe("test_challenge_token_string_12345");
    });

    it("handles Slack app_mention quote command returning Block Kit card", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, orm, sessionId);
      const mentionPayload = {
        type: "event_callback",
        event: {
          type: "app_mention",
          user: "U998877",
          text: "<@U0ETRADE> quote AAPL",
          channel: "C12345",
          ts: "1727800000.000100",
        },
      };

      const result = await slackService.processSlackEvent(mentionPayload);

      expect(result.handled).toBe(true);
      expect(result.actionType).toBe("quote");
      expect(result.response?.blocks).toBeDefined();
      expect(result.response?.blocks?.length).toBeGreaterThan(1);

      // Verify Header Block
      const headerBlock = result.response?.blocks?.find((b: any) => b.type === "header");
      expect(headerBlock?.text?.text).toContain("AAPL");

      // Verify Context DID
      const contextBlock = result.response?.blocks?.find((b: any) => b.type === "context");
      expect(contextBlock?.elements?.[0]?.text).toContain("did:agent:openaimp:trading");
    });

    it("handles Slack app_mention market screener command returning Block Kit card", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, orm, sessionId);
      const mentionPayload = {
        type: "event_callback",
        event: {
          type: "app_mention",
          user: "U998877",
          text: "<@U0ETRADE> screen stocks",
          channel: "C12345",
          ts: "1727800000.000200",
        },
      };

      const result = await slackService.processSlackEvent(mentionPayload);

      expect(result.handled).toBe(true);
      expect(result.actionType).toBe("screener");
      expect(result.response?.blocks).toBeDefined();

      const headerBlock = result.response?.blocks?.find((b: any) => b.type === "header");
      expect(headerBlock?.text?.text).toContain("Live Stock Listings");
    });

    it("drafts order and sends Slack Block Kit card with interactive approval buttons", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, orm, sessionId);
      const mentionPayload = {
        type: "event_callback",
        event: {
          type: "app_mention",
          user: "U998877",
          text: "<@U0ETRADE> buy 20 TSLA limit 215.00",
          channel: "C12345",
          ts: "1727800000.000300",
        },
      };

      const result = await slackService.processSlackEvent(mentionPayload);

      expect(result.handled).toBe(true);
      expect(result.actionType).toBe("preview");
      expect(result.orderId).toBeDefined();
      expect(result.response?.blocks).toBeDefined();

      // Find the interactive action buttons block
      const actionsBlock = result.response?.blocks?.find((b: any) => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements).toHaveLength(2);

      // Verify Approve button
      const approveBtn = actionsBlock.elements.find((el: any) => el.action_id === "etrade_approve_order");
      expect(approveBtn).toBeDefined();
      expect(approveBtn.value).toBe(result.orderId);
      expect(approveBtn.style).toBe("primary");

      // Verify Cancel button
      const cancelBtn = actionsBlock.elements.find((el: any) => el.action_id === "etrade_cancel_order");
      expect(cancelBtn).toBeDefined();
      expect(cancelBtn.value).toBe(result.orderId);
      expect(cancelBtn.style).toBe("danger");

      // Verify the order exists in ORM in 'previewed' state
      const drafted = orm.trades.findById(result.orderId!);
      expect(drafted?.status).toBe("previewed");
      expect(drafted?.symbol).toBe("TSLA");
      expect(drafted?.quantity).toBe(20);
    });

    it("handles interactive button click 'etrade_approve_order' to execute order", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, orm, sessionId);

      // Create draft order
      const draftOrderId = "ord_slack_click_456";
      orm.trades.create({
        id: draftOrderId,
        sessionId,
        symbol: "NVDA",
        action: "BUY",
        orderType: "MARKET",
        quantity: 10,
        price: 130.0,
        totalValue: 1300.0,
        status: "previewed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Simulate Slack interaction payload when human clicks [✓ Approve & Submit]
      const interactionPayload = {
        type: "block_actions",
        user: { id: "U998877", username: "trader_bob" },
        team: { id: "T12345" },
        channel: { id: "C12345" },
        actions: [
          {
            action_id: "etrade_approve_order",
            value: draftOrderId,
            type: "button",
          },
        ],
      };

      const result = await slackService.processSlackInteraction(interactionPayload);

      expect(result.success).toBe(true);
      expect(result.status).toBe("executed");
      expect(result.orderId).toBe(draftOrderId);
      expect(result.replacementBlocks).toBeDefined();

      // Check header indicates executed
      const headerBlock = result.replacementBlocks?.find((b: any) => b.type === "header");
      expect(headerBlock?.text?.text).toContain("ORDER EXECUTED ON E*TRADE");

      // Check ORM status updated to executed
      const tradeInOrm = orm.trades.findById(draftOrderId);
      expect(tradeInOrm?.status).toBe("executed");
    });

    it("handles interactive button click 'etrade_cancel_order' to cancel draft order", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, orm, sessionId);

      const draftOrderId = "ord_slack_cancel_789";
      orm.trades.create({
        id: draftOrderId,
        sessionId,
        symbol: "AMZN",
        action: "SELL",
        orderType: "MARKET",
        quantity: 5,
        price: 180.0,
        totalValue: 900.0,
        status: "previewed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const interactionPayload = {
        type: "block_actions",
        user: { id: "U998877", username: "trader_bob" },
        team: { id: "T12345" },
        channel: { id: "C12345" },
        actions: [
          {
            action_id: "etrade_cancel_order",
            value: draftOrderId,
            type: "button",
          },
        ],
      };

      const result = await slackService.processSlackInteraction(interactionPayload);

      expect(result.success).toBe(true);
      expect(result.status).toBe("rejected");
      expect(result.orderId).toBe(draftOrderId);

      const headerBlock = result.replacementBlocks?.find((b: any) => b.type === "header");
      expect(headerBlock?.text?.text).toContain("DRAFT CANCELLED");

      const tradeInOrm = orm.trades.findById(draftOrderId);
      expect(tradeInOrm?.status).toBe("rejected");
    });

    it("generates OAuth install URL for multi-tenant workspace distribution", () => {
      const url = ETradeSlackTradingService.getInstallUrl(
        "client_id_123",
        "https://agent.openaimp.com/slack/oauth_callback"
      );
      expect(url).toContain("https://slack.com/oauth/v2/authorize");
      expect(url).toContain("client_id=client_id_123");
      expect(url).toContain("scope=");
      expect(url).toContain("redirect_uri=");
    });
  });
});
