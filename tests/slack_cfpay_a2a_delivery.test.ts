import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deliverScreenerToSlack,
  deliverScreenerToSlackA2A,
  deliverScreenerToSlackDirect,
} from "../src/services/screenerSlackDelivery";
import * as slackFiles from "../src/services/slackFiles";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { ETradeBrowserService } from "../src/services/browserAgent";
import * as cfpayA2A from "../src/services/cfpayA2A";

describe("Omnichannel Slack Delivery over cfpay A2A", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("deliverScreenerToSlackA2A", () => {
    it("returns error when CFPAY_A2A_TOKEN is not configured", async () => {
      const res = await deliverScreenerToSlackA2A({}, { text: "hello" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("CFPAY_A2A_TOKEN is not configured");
    });

    it("delivers text via cfpayPostToSlack over A2A when no PDF is provided", async () => {
      const spyPost = vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({ ok: true });

      const env = { CFPAY_A2A_TOKEN: "test-a2a-token", SLACK_CHANNEL: "#trading-desk" };
      const res = await deliverScreenerToSlackA2A(env, {
        text: "Market screen completed: 5 opportunities",
      });

      expect(res.ok).toBe(true);
      expect(spyPost).toHaveBeenCalledWith(
        expect.objectContaining({ token: "test-a2a-token" }),
        "Market screen completed: 5 opportunities",
        "#trading-desk"
      );
    });

    it("uploads PDF file via cfpayPostFileToSlack over A2A when PDF and channel are present", async () => {
      const spyFile = vi.spyOn(cfpayA2A, "cfpayPostFileToSlack").mockResolvedValue({ ok: true });

      const env = { CFPAY_A2A_TOKEN: "test-a2a-token" };
      const pdfBytes = new Uint8Array([1, 2, 3, 4]);
      const res = await deliverScreenerToSlackA2A(env, {
        text: "Market screen completed",
        channel: "#options-alerts",
        pdf: {
          bytes: pdfBytes,
          fileName: "market-screen.pdf",
          title: "Market Screen Report",
          comment: "Here is the PDF report",
        },
      });

      expect(res.ok).toBe(true);
      expect(spyFile).toHaveBeenCalledWith(
        expect.objectContaining({ token: "test-a2a-token" }),
        expect.objectContaining({
          channel: "#options-alerts",
          filename: "market-screen.pdf",
          title: "Market Screen Report",
          initial_comment: "Here is the PDF report",
        })
      );
    });

    it("falls back to cfpayPostToSlack text over A2A when PDF is present but channel is omitted", async () => {
      const spyFile = vi.spyOn(cfpayA2A, "cfpayPostFileToSlack");
      const spyText = vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({ ok: true });

      const env = { CFPAY_A2A_TOKEN: "test-a2a-token" }; // No SLACK_CHANNEL in env
      const pdfBytes = new Uint8Array([1, 2, 3, 4]);
      const res = await deliverScreenerToSlackA2A(env, {
        text: "Market screen completed (no channel)",
        pdf: {
          bytes: pdfBytes,
          fileName: "report.pdf",
          title: "Report",
          comment: "Comment",
        },
      });

      expect(res.ok).toBe(true);
      expect(spyFile).not.toHaveBeenCalled();
      expect(spyText).toHaveBeenCalledWith(
        expect.objectContaining({ token: "test-a2a-token" }),
        "Market screen completed (no channel)",
        undefined
      );
    });

    it("falls back to cfpayPostToSlack text over A2A if PDF file upload fails", async () => {
      vi.spyOn(cfpayA2A, "cfpayPostFileToSlack").mockResolvedValue({ ok: false, error: "not_in_channel" });
      const spyText = vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({ ok: true });

      const env = { CFPAY_A2A_TOKEN: "test-a2a-token" };
      const pdfBytes = new Uint8Array([1, 2, 3, 4]);
      const res = await deliverScreenerToSlackA2A(env, {
        text: "Screen completed",
        channel: "#private-desk",
        pdf: {
          bytes: pdfBytes,
          fileName: "report.pdf",
          title: "Report",
          comment: "Comment",
        },
      });

      expect(res.ok).toBe(true);
      expect(spyText).toHaveBeenCalledWith(
        expect.objectContaining({ token: "test-a2a-token" }),
        "Screen completed",
        "#private-desk"
      );
    });
  });

  describe("deliverScreenerToSlack (Master Slack Delivery with Direct Preservation)", () => {
    it("delivers directly using postFilesToSlack when bot token is configured and A2A is not configured", async () => {
      const spyFiles = vi.spyOn(slackFiles, "postFilesToSlack").mockResolvedValue({
        configured: true,
        posted: 1,
      });

      const env = { SLACK_BOT_TOKEN: "xoxb-test-bot-token", SLACK_CHANNEL: "#trading-desk" };
      const res = await deliverScreenerToSlack(env, {
        text: "Direct Slack screen completed",
        pdf: {
          bytes: new Uint8Array([1, 2, 3]),
          fileName: "direct-report.pdf",
          title: "Direct Report",
          comment: "Here is the direct PDF",
        },
      });

      expect(res.ok).toBe(true);
      expect(res.method).toBe("direct");
      expect(spyFiles).toHaveBeenCalled();
    });

    it("tries A2A first and automatically falls back to direct Slack if A2A fails", async () => {
      vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({ ok: false, error: "A2A agent offline" });
      const spyFiles = vi.spyOn(slackFiles, "postFilesToSlack").mockResolvedValue({
        configured: true,
        posted: 1,
      });

      const env = {
        CFPAY_A2A_TOKEN: "test-a2a-token",
        SLACK_BOT_TOKEN: "xoxb-test-bot-token",
        SLACK_CHANNEL: "#trading-desk",
      };
      const res = await deliverScreenerToSlack(env, {
        text: "Screen completed with A2A fallback",
        pdf: {
          bytes: new Uint8Array([1, 2, 3]),
          fileName: "report.pdf",
          title: "Report",
          comment: "Comment",
        },
      });

      expect(res.ok).toBe(true);
      expect(res.method).toBe("direct");
      expect(spyFiles).toHaveBeenCalled();
    });
  });


  describe("ETradeSlackTradingService.postSlackMessage over cfpay A2A", () => {
    it("delivers over cfpay A2A when only CFPAY_A2A_TOKEN is configured", async () => {
      const spyPost = vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({ ok: true });

      const env: any = {
        CFPAY_A2A_TOKEN: "test-a2a-token",
        SLACK_CHANNEL: "#trading-channel",
      };
      const service = new ETradeSlackTradingService(env);
      const delivered = await service.postSlackMessage({
        text: "Order #456 filled: BUY 100 AAPL @ $220.00",
      });

      expect(delivered).toBe(true);
      expect(spyPost).toHaveBeenCalledWith(
        expect.objectContaining({ token: "test-a2a-token" }),
        "Order #456 filled: BUY 100 AAPL @ $220.00",
        "#trading-channel"
      );
    });

    it("returns false when neither direct tokens nor cfpay A2A are configured", async () => {
      const service = new ETradeSlackTradingService({} as any);
      const delivered = await service.postSlackMessage({
        text: "Hello",
      });
      expect(delivered).toBe(false);
    });
  });

  describe("ETradeBrowserService.deliverToSlack over cfpay A2A", () => {
    it("delivers browser inspect alerts over cfpay A2A when CFPAY_A2A_TOKEN is configured", async () => {
      const spyPost = vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({ ok: true });

      const env: any = {
        CFPAY_A2A_TOKEN: "test-a2a-token",
      };
      const service = new ETradeBrowserService(env);
      vi.spyOn(service, "inspectPage").mockResolvedValue({
        success: true,
        url: "https://finance.yahoo.com/quote/AAPL",
        title: "Apple Inc.",
        status: 200,
        timestamp: "2026-10-21T12:00:00Z",
        text: "Apple Inc. (AAPL) stock summary",
        screenshotKind: "real",
      });

      const res = await service.captureAndSendToSlack(
        "https://finance.yahoo.com/quote/AAPL",
        { channel: "#desk-alerts" }
      );

      expect(res.success).toBe(true);
      expect(spyPost).toHaveBeenCalledWith(
        expect.objectContaining({ token: "test-a2a-token" }),
        expect.stringContaining("https://finance.yahoo.com/quote/AAPL"),
        "#desk-alerts"
      );
    });
  });
});
